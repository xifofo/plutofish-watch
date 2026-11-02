/** 应用更新：定时读取发布清单，用户确认后才下载；安装包校验通过后，等退出流程保存任务再交给安装程序。 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { UpdateState } from '../shared/model'
import { compareVersions, parseManifest, type UpdateFile, type UpdateManifest } from '../shared/update'

export type UpdaterOptions = {
  current: string; manifestURL: string; directory: string; enabled: boolean
  platform: NodeJS.Platform; arch: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** 退出流程保存任务后调用：Windows 启动安装程序，macOS 打开安装包。 */
  launch: (file: string) => Promise<void>
  /** Windows 校验完成后自动退出安装；macOS 等用户确认。 */
  quit: () => void
  onChange: (state: UpdateState) => void
  firstCheckMs?: number; intervalMs?: number; stallMs?: number
}

const cancelled = Symbol('cancelled')
const message = (error: unknown, fallback: string) => error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : fallback

export class WatchUpdater {
  private release?: UpdateManifest
  private file?: UpdateFile
  private dismissedVersion?: string
  private checking = false
  private checkedAt?: number
  private checkError?: string
  private download?: NonNullable<UpdateState['download']>
  private controller?: AbortController
  private installer?: string
  private pending?: string
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private emittedAt = 0

  constructor(private readonly options: UpdaterOptions) {}

  /** 启动稍后首次检查并清理上次留下的安装包，之后每 6 小时检查一次。 */
  start(): void {
    if (!this.options.enabled) return
    const { directory, firstCheckMs = 8_000, intervalMs = 6 * 60 * 60_000 } = this.options
    this.timers.push(
      setTimeout(() => void rm(directory, { recursive: true, force: true }).catch(() => {}).then(() => this.check()), firstCheckMs),
      setInterval(() => void this.check(), intervalMs),
    )
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer)
    if (this.download?.status === 'downloading') this.controller?.abort(cancelled)
  }

  state(): UpdateState {
    const { release, file } = this
    return {
      current: this.options.current, enabled: this.options.enabled, checking: this.checking, checkedAt: this.checkedAt, checkError: this.checkError,
      release: release && { version: release.version, publishedAt: release.publishedAt, notes: release.notes, page: release.page,
        size: file?.size ?? 0, mode: !file ? 'page' : this.options.platform === 'win32' ? 'install' : 'open' },
      dismissed: !!release && this.dismissedVersion === release.version,
      download: this.download && { ...this.download },
    }
  }

  /** 自动检查失败保持安静；手动检查显示错误，并重新弹出已暂缓的版本。 */
  async check(manual = false): Promise<void> {
    if (!this.options.enabled || this.checking || this.busy()) return
    this.checking = true
    if (manual) this.checkError = undefined
    this.emit()
    try {
      const response = await this.options.fetch(this.options.manifestURL, { signal: AbortSignal.timeout(20_000), cache: 'no-store' })
      // 没有附带清单的旧发布返回 404，视为没有可用更新。
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
      const manifest = response.ok ? parseManifest(await response.json()) : undefined
      if (this.busy()) return
      if (!manifest || compareVersions(manifest.version, this.options.current) <= 0) this.select(undefined)
      else if (manifest.version !== this.release?.version) this.select(manifest)
      if (manual) this.dismissedVersion = undefined
      this.checkedAt = Date.now(); this.checkError = undefined
    } catch {
      if (manual) this.checkError = '检查更新失败，请检查网络后重试'
    } finally {
      this.checking = false
      this.emit()
    }
  }

  async startDownload(): Promise<void> {
    const file = this.file
    if (!this.release || !file || this.busy() || this.download?.status === 'ready') return
    const controller = new AbortController(), target = join(this.options.directory, file.name), part = `${target}.part`
    let received = 0, stall: ReturnType<typeof setTimeout> | undefined
    const idle = () => {
      clearTimeout(stall)
      stall = setTimeout(() => controller.abort(new Error('下载长时间没有进度，请检查网络后重试')), this.options.stallMs ?? 60_000)
    }
    this.controller = controller; this.dismissedVersion = undefined; this.installer = undefined
    this.download = { status: 'downloading', received: 0, total: file.size }
    this.emit()
    try {
      await rm(this.options.directory, { recursive: true, force: true }).catch(() => {})
      await mkdir(this.options.directory, { recursive: true })
      idle()
      const response = await this.options.fetch(file.url, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），请稍后重试`)
      const hash = createHash('sha256')
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
        received += chunk.length
        if (received > file.size) return done(new Error('安装包大小与发布信息不一致，已停止下载'))
        hash.update(chunk); idle()
        if (this.download) this.download.received = received
        if (Date.now() - this.emittedAt >= 200) this.emit()
        done(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body as unknown as ReadableStream), meter, createWriteStream(part), { signal: controller.signal })
      if (received !== file.size || hash.digest('hex') !== file.sha256) throw new Error('安装包校验失败，已删除，请重新下载')
      await rename(part, target)
      this.installer = target
      if (this.options.platform === 'win32') {
        this.pending = target
        this.download = { status: 'installing', received, total: file.size }
        // 留出片刻显示“正在安装”，再走正常退出保存任务。
        setTimeout(() => this.options.quit(), 800)
      } else this.download = { status: 'ready', received, total: file.size }
    } catch (error) {
      await rm(part, { force: true }).catch(() => {})
      const reason = controller.signal.aborted ? controller.signal.reason : error
      this.download = reason === cancelled ? undefined : { status: 'failed', received, total: file.size, error: message(reason, '下载失败，请检查网络后重试') }
    } finally {
      clearTimeout(stall)
      if (this.controller === controller) this.controller = undefined
      this.emit()
    }
  }

  cancel(): void {
    if (this.download?.status === 'downloading') this.controller?.abort(cancelled)
  }

  dismiss(): void {
    if (!this.release || this.busy()) return
    this.dismissedVersion = this.release.version
    if (this.download?.status === 'failed') this.download = undefined
    this.emit()
  }

  reopen(): void {
    this.dismissedVersion = undefined
    this.emit()
  }

  /** macOS 用户确认后标记待打开的安装包；返回 true 时由入口退出应用。 */
  requestInstall(): boolean {
    if (this.download?.status !== 'ready' || !this.installer) return false
    this.pending = this.installer
    this.download = { ...this.download, status: 'installing' }
    this.emit()
    return true
  }

  /** 退出流程保存任务后调用，未确认安装时什么也不做。 */
  async launchPending(): Promise<void> {
    const file = this.pending
    this.pending = undefined
    if (file) await this.options.launch(file).catch(() => {})
  }

  private busy(): boolean {
    return this.download?.status === 'downloading' || this.download?.status === 'installing'
  }

  private select(manifest?: UpdateManifest): void {
    this.release = manifest
    this.file = manifest?.files.find(file => file.platform === this.options.platform && file.arch === this.options.arch
      && (file.platform === 'win32' || file.platform === 'darwin'))
    this.download = undefined; this.installer = undefined
  }

  private emit(): void {
    this.emittedAt = Date.now()
    this.options.onChange(this.state())
  }
}
