/** 桌面应用服务：绑定校验、本地状态与发布器生命周期统一由主进程管理。 */
import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { releaseSource, sourceReviewReason } from '../../vendor/publisher/src/integrations/plutofish/release-specs'
import { releaseChoices } from '../../vendor/publisher/src/integrations/plutofish/release-selection'
import type { PublicationDraft } from '../../vendor/publisher/src/integrations/plutofish/publication-types'
import type { Snapshot, WatchInput, WatchAPI } from '../shared/model'
import { validateRetention } from '../shared/retention'
import { bindingFor, stableKey, validateInput, validateWork, validateSource } from './bindings'
import { canonicalRoot, safeFile, sameSignature, within } from './files'
import { atomicJSON, WatchStore } from './store'
import { DirectoryWatcher } from './watcher'
import { WatchPublisher } from './publisher'
import { findProbe, probeAvailable } from './probe'
import { WatchConnection, validateWatchedFile } from './connection'
import { searchWorks } from './work-search'

export class WatchService {
  readonly store: WatchStore
  readonly connection: WatchConnection
  readonly publisher: WatchPublisher
  readonly watcher: DirectoryWatcher
  private fatalError = ''
  private ffprobeAvailable = false
  private stopped = false

  constructor(private directory: string, private changed: () => void) {
    this.store = new WatchStore(join(directory, 'watch-state.json'))
    const credentials = join(directory, 'connection.json')
    let wasReady = false
    this.connection = new WatchConnection({
      load: () => {
        if (!existsSync(credentials)) return { url: '', key: '' }
        const saved = JSON.parse(readFileSync(credentials, 'utf8'))
        return { url: saved.url, key: safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64')) }
      },
      save: input => {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
          throw new Error('系统凭据加密不可用，请启用系统密钥环')
        }
        atomicJSON(credentials, { url: input.url, encryptedKey: safeStorage.encryptString(input.key).toString('base64') })
      },
      changed: () => {
        const ready = this.connection.ready
        if (ready && !wasReady && this.publisher && !this.stopped && !this.store.data.uploadsPaused) this.publisher.resume()
        wasReady = ready
        changed()
      },
    })
    this.connection.validateFile = validateWatchedFile(this.store)
    this.publisher = new WatchPublisher(this.store, this.connection, directory, changed, error => this.fail(error))
    this.watcher = new DirectoryWatcher(this.store, changed, job => this.publisher.stopJob(job, 'cancel'), error => this.fail(error))
    this.store.onError = error => this.fail(error)
  }

  async start(): Promise<void> {
    this.ffprobeAvailable = await probeAvailable(findProbe(this.store.data.ffprobe))
    this.publisher.start()
    this.watcher.start()
    if (this.connection.view().hasKey) {
      try { await this.connection.verify(); this.connection.monitor() } catch { /* 登录失败仍可查看本地任务。 */ }
    }
    this.changed()
  }

  private fail(_error: unknown): void {
    if (this.fatalError || this.stopped) return
    this.fatalError = '本地记录无法保存，已停止监控和上传。请检查应用数据目录的磁盘空间及权限，然后重新启动。'
    this.store.data.uploadsPaused = true
    this.connection.close()
    void this.watcher.close()
    void this.publisher.close().catch(() => {})
    this.changed()
  }

  snapshot(): Snapshot {
    const { watches, jobs, uploadsPaused, ffprobe, retention } = this.store.data
    return structuredClone({ connection: this.connection.view(), watches, jobs, uploadsPaused, retention,
      ffprobe: findProbe(ffprobe), ffprobeAvailable: this.ffprobeAvailable, fatalError: this.fatalError })
  }

  async connect(input: { url: string; key: string }): Promise<void> {
    if (!input || typeof input.url !== 'string' || typeof input.key !== 'string' || input.key.length > 8192) throw new Error('连接参数无效')
    // 更换连接前暂停当前操作；旧任务始终使用创建时的服务和账号绑定。
    await this.publisher.pause()
    await this.connection.verify(input)
    this.connection.monitor()
    this.publisher.resume()
    this.changed()
  }

  async searchWorks(input: Parameters<WatchAPI['searchWorks']>[0]) {
    const binding = bindingFor(this.connection.view(), input?.sourceAccountId)
    return searchWorks(this.connection, binding, input)
  }

  async releases(input: Parameters<WatchAPI['releases']>[0]) {
    const work = validateWork(input?.work, input?.seasonNumber)
    const view = this.connection.view(), binding = bindingFor(view, input.sourceAccountId)
    const draft: PublicationDraft = {
      schemaVersion: 1, binding, workTarget: work, seasonNumber: work.mediaType === 'tv' ? input.seasonNumber : undefined,
      releaseKey: stableKey('gvs-r1', [binding, work, input.seasonNumber]), fileKey: '', title: '', categoryLabel: '',
      kind: 'video', output: '', updatedAt: new Date().toISOString(),
    }
    return (await releaseChoices(this.connection, [draft], '')).items.filter(r => r.status !== 'unpublished')
  }

  async add(raw: WatchInput): Promise<void> {
    if (this.fatalError) throw new Error(this.fatalError)
    if (this.store.data.watches.length >= 100) throw new Error('最多支持 100 个监控目录')
    const input = validateInput(raw, this.connection.view())
    const path = await canonicalRoot(input.path)
    if (within(path, this.directory) || within(this.directory, path)) throw new Error('不能监控应用自身的数据目录或其父目录')
    if (this.store.data.watches.some(w => within(w.path, path) || within(path, w.path))) throw new Error('监控目录不能重复或互相嵌套')
    const releases = await this.releases(input)
    const release = releases.find(r => r.id === input.releaseId)
    if (input.versionMode !== 'auto' && !release) throw new Error('版本已变化，请重新查询并选择')
    const binding = bindingFor(this.connection.view(), input.sourceAccountId)
    this.store.data.watches.push({
      ...input, path, binding, id: randomUUID(), releaseName: input.versionMode === 'auto' ? '自动归类' : release!.name,
      releaseVersion: release ? { name: release.name, resolution: release.resolution, dynamicRange: release.dynamicRange } : undefined,
      enabled: true, initialized: false, createdAt: new Date().toISOString(),
    })
    try { this.store.save() } catch (error) { this.fail(error); throw error }
    this.watcher.refresh()
    await this.watcher.scan()
    this.changed()
  }

  async backfill(id: string): Promise<number> {
    if (this.fatalError) throw new Error(this.fatalError)
    return this.watcher.backfill(id)
  }

  async setSourcePreset(input: Parameters<WatchAPI['setSourcePreset']>[0]): Promise<void> {
    if (this.fatalError) throw new Error(this.fatalError)
    const root = this.store.data.watches.find(w => w.id === input?.id)
    if (!root || root.versionMode !== 'auto') throw new Error('仅自动归类目录可预设来源')
    root.sourcePreset = validateSource(input.source)
    // 只重试缺少来源的待确认任务；已固定的版本和正在上传的任务保持原归属。
    for (const job of this.store.data.jobs) {
      if (job.watchId !== root.id || job.status !== 'review' || !job.versionReview?.sourceRequired || job.release || job.fileKey || job.changed) continue
      delete job.versionReview
      job.status = 'queued'; job.error = ''
    }
    this.store.save(); this.changed()
  }

  async toggleWatch(id: string): Promise<void> {
    const root = this.store.data.watches.find(w => w.id === id)
    if (!root) throw new Error('监控目录不存在')
    root.enabled = !root.enabled
    this.store.save()
    if (!root.enabled) {
      await this.watcher.quiesce(id)
      await this.publisher.pause(id)
    }
    else this.publisher.resume(id)
    this.watcher.refresh(); this.changed()
    if (root.enabled) await this.watcher.scanOne(root)
  }

  async removeWatch(id: string): Promise<void> {
    const root = this.store.data.watches.find(w => w.id === id)
    if (!root) return
    root.enabled = false
    this.store.save()
    await this.watcher.quiesce(id)
    await this.publisher.pause(id)
    // 保留历史和发布清单，以支持已上传文件的后续本地片段校验。
    for (const job of this.store.data.jobs.filter(j => j.watchId === id)) {
      if (!['completed', 'duplicate', 'cancelled'].includes(job.status)) {
        await this.publisher.stopJob(job, 'cancel')
        job.status = 'cancelled'; job.error = '已移除监控目录'
      }
    }
    this.store.data.watches = this.store.data.watches.filter(w => w.id !== id)
    delete this.store.data.observations[id]
    this.store.save(); this.changed()
  }

  async pauseAll(): Promise<void> {
    this.store.data.uploadsPaused = !this.store.data.uploadsPaused
    this.store.save()
    if (this.store.data.uploadsPaused) await this.publisher.pause()
    else this.publisher.resume()
    this.changed()
  }

  async job(input: Parameters<WatchAPI['job']>[0]): Promise<void> {
    const job = this.store.data.jobs.find(j => j.id === input?.id)
    if (!job) throw new Error('任务不存在')
    const root = this.store.data.watches.find(w => w.id === job.watchId)
    if (input.action === 'pause' && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
      job.manuallyPaused = true
      await this.publisher.stopJob(job, 'pause')
      job.status = 'paused'
    } else if (input.action === 'cancel' && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
      await this.publisher.stopJob(job, 'cancel')
      job.status = 'cancelled'; job.manuallyPaused = true; delete job.retry
    } else if (input.action === 'confirmSource') {
      if (!root || root.versionMode !== 'auto' || job.changed || job.fileKey || job.status !== 'review' || !job.versionReview?.sourceRequired) throw new Error('此任务无需确认来源')
      if (!sameSignature(await safeFile(root.path, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
      const source = validateSource(input.source)
      const reason = sourceReviewReason(releaseSource(basename(job.path, extname(job.path)), source))
      if (reason) throw new Error(reason)
      job.sourceOverride = source
      delete job.release; delete job.versionReview
      job.status = 'queued'; job.manuallyPaused = false; job.error = ''
    } else if (input.action === 'selectVersion' || input.action === 'refreshVersion') {
      if (!root || root.versionMode !== 'auto' || job.changed || job.fileKey || job.status !== 'review' || !job.versionReview) {
        throw new Error('此任务不能重新选择版本')
      }
      if (!sameSignature(await safeFile(root.path, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
      if (input.action === 'selectVersion') {
        const choices = await this.releases(root)
        const selected = choices.find(row => row.id === input.releaseId)
        if (!selected) throw new Error('版本已变化，请刷新并重新选择')
        // 异步查询期间文件可能被替换；再次确认后才固定人工选择。
        if (job.changed || !sameSignature(await safeFile(root.path, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
        job.release = { id: selected.id, name: selected.name, version: { name: selected.name, resolution: selected.resolution, dynamicRange: selected.dynamicRange } }
      } else delete job.release
      delete job.versionReview
      job.status = 'queued'; job.manuallyPaused = false; job.error = ''
    } else if (['resume', 'confirm'].includes(input.action)) {
      if (!root || job.changed || !['failed', 'paused', 'review'].includes(job.status)) throw new Error('当前任务不能恢复，请重新扫描')
      if (!sameSignature(await safeFile(root.path, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
      if (job.versionReview) throw new Error('请先选择版本或刷新版本列表')
      if (root.work.mediaType === 'tv') {
        const episode = input.episodeNumber ?? job.episodeNumber
        if (!Number.isInteger(episode) || episode! < 0 || episode! > 100000) throw new Error('请填写 0–100000 的集号')
        job.episodeNumber = episode
      }
      if (job.retry) delete job.retry.nextAt
      job.status = 'queued'; job.manuallyPaused = false; job.error = ''
    } else throw new Error('此状态不支持该操作')
    this.store.save(); this.changed()
  }

  async setProbe(path: string): Promise<void> {
    if (!await probeAvailable(path)) throw new Error('所选程序无法作为 ffprobe 运行')
    this.store.data.ffprobe = path; this.ffprobeAvailable = true
    this.store.save(); this.changed()
  }

  async setRetention(input: Parameters<WatchAPI['setRetention']>[0]): Promise<void> {
    if (this.fatalError || this.stopped) throw new Error(this.fatalError || '客户端已停止')
    this.store.data.retention = validateRetention(input)
    this.store.save(); this.changed()
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.watcher.close()
    await this.publisher.close()
    this.connection.close()
  }
}
