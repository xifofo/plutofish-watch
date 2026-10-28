/** 成品完成后并行计算 ED2K，发布后补记资源，再按配置清理；不验证云下载可用性。 */
import { lstatSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { ed2kFile } from '../../lib/ed2k.ts'
import { lockLocalFileDeletion, useLocalFile } from '../../lib/local-file-use.ts'
import type { PlutoFishConnection } from './connection.ts'
import type { PublicationState } from './publication-state.ts'
import type { RetentionProgress } from './publication-types.ts'
import { loadRetentionSettings, type RetentionSettings } from './retention-settings.ts'

export type ED2KResult = Awaited<ReturnType<typeof ed2kFile>>
export type RetentionOptions = {
  settings?: () => RetentionSettings
  /** 宿主在同步删除前检查自己的暂停、目录归属及路径边界；不得在此执行异步操作。 */
  canDelete?: (state: PublicationState) => boolean
  compute?: (path: string, signal: AbortSignal, progress?: (done: number, total: number) => void) => Promise<ED2KResult>
  now?: () => number
}
const completed = (state: PublicationState) => state.snapshot.stage === 'completed' &&
  state.acknowledged >= state.snapshot.sequence && !!state.checkpoint?.resource && !!state.draft.output

export class PublicationRetention {
  private running?: Promise<void>
  private runningKey?: string
  private runningAbort?: AbortController
  private readonly retryAt = new Map<string, number>()
  private nextScan = 0
  private queue: string[] = []
  private readonly now: () => number
  private hours = 24

  constructor(private readonly connection: PlutoFishConnection, private readonly save: (state: PublicationState) => void,
    private readonly changed: (state: PublicationState, error?: string) => void,
    private readonly missing: (state: PublicationState) => void,
    private readonly options: RetentionOptions = {}) { this.now = options.now ?? Date.now }

  /** 成品完成事件立即启动空闲计算槽，不等待快照网络请求或清理周期。 */
  start(states: Map<string, PublicationState>, signal: AbortSignal): void {
    if (this.running || signal.aborted || !this.connection.ready) return
    const state = [...states.values()].find(s => {
      if (!['processing', 'uploading', 'completed'].includes(s.snapshot.stage) || !s.draft.output ||
        (s.retention?.ed2k && (!completed(s) || s.retention.acknowledged)) || (this.retryAt.get(s.draft.fileKey) ?? 0) > this.now()) return false
      try { this.connection.assertBinding(s.draft.binding); return true } catch { return false }
    })
    if (!state) return
    this.runningKey = state.draft.fileKey
    this.runningAbort = new AbortController()
    const recordSignal = AbortSignal.any([signal, this.runningAbort.signal])
    this.running = this.record(state, recordSignal).then(() => { this.retryAt.delete(state.draft.fileKey) }).catch(() => {
      this.retryAt.set(state.draft.fileKey, this.now() + 60_000)
      if (!recordSignal.aborted) this.changed(state, 'ED2K 保存未完成，保留本地成品并稍后重试')
    }).finally(() => { this.running = undefined; this.runningKey = undefined; this.runningAbort = undefined })
  }

  /** 一次只计算一个 ED2K，长计算独立运行，上传和两路片段校验可继续推进。 */
  tick(states: Map<string, PublicationState>, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.connection.ready) return
    let hours: number
    try { hours = (this.options.settings ?? loadRetentionSettings)().hours }
    catch (error) {
      for (const state of states.values()) if (state.draft.output) this.status(state, 'policy_error')
      throw error
    }
    this.hours = hours
    const candidates = [...states.values()].filter(state => {
      if (!['processing', 'uploading', 'completed'].includes(state.snapshot.stage) || !state.draft.output) return false
      try { this.connection.assertBinding(state.draft.binding); return true } catch { return false }
    })
    const eligible = candidates.filter(completed)
    for (const state of eligible) {
      if (state.completedAt === undefined) { state.completedAt = this.now(); this.save(state) }
    }
    for (const state of candidates) this.status(state)
    this.start(states, signal)
    if (!this.queue.length && this.now() >= this.nextScan) {
      this.queue = eligible.map(state => state.draft.fileKey)
      this.nextScan = this.now() + 60_000
    }
    for (const key of this.queue.splice(0, 50)) {
      const state = states.get(key)
      if (!state || !completed(state)) continue
      const due = (s: PublicationState) => hours > 0 && s.completedAt !== undefined && Number.isFinite(s.completedAt) &&
        this.now() >= s.completedAt + hours * 3_600_000 && s.retention?.acknowledged === true && !!s.retention.ed2k && !!s.retention.file
      // 改为关闭或延长保留时恢复本地校验资格；未向服务端提交忘记操作。
      if (!due(state)) {
        if (state.retention?.retiring) { state.retention.retiring = false; this.save(state) }
        continue
      }
      if (this.options.canDelete && !this.options.canDelete(state)) {
        if (state.retention?.retiring) { state.retention.retiring = false; this.save(state) }
        this.status(state, 'busy')
        continue
      }
      const path = resolve(state.draft.output)
      if ([...states.values()].some(other => other !== state && other.draft.output && resolve(other.draft.output) === path &&
        (!completed(other) || !due(other) || (this.options.canDelete && !this.options.canDelete(other))))) {
        this.status(state, 'busy')
        continue
      }
      state.retention!.retiring = true
      this.save(state)
      const release = lockLocalFileDeletion(path)
      if (!release) { this.status(state, 'busy'); continue }
      try {
        signal.throwIfAborted()
        this.connection.assertBinding(state.draft.binding)
        const file = lstatSync(path), expected = state.retention!.file!
        if (!file.isFile() || (Object.keys(expected) as Array<keyof typeof expected>).some(field => file[field] !== expected[field])) {
          state.retention!.retiring = false
          this.save(state)
          this.status(state, 'changed')
          this.changed(state, '本地成品已改变，跳过自动删除')
          continue
        }
        // 身份检查与 unlink 之间不让出事件循环；只删除这一个普通文件，不递归清理目录。
        unlinkSync(path)
        this.deleted(state)
        this.missing(state)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.deleted(state); this.missing(state) }
        else if (!signal.aborted) {
          state.retention!.retiring = false
          this.save(state)
          this.status(state, 'failed')
          this.changed(state, '本地成品清理失败，稍后重试')
        }
      } finally { release() }
    }
  }

  private async record(state: PublicationState, signal: AbortSignal): Promise<void> {
    const path = state.draft.output
    const release = useLocalFile(path)
    try {
      if (!state.retention?.ed2k) {
        state.draft.ed2k = { state: 'running', pct: 0, link: '' }
        this.changed(state)
        const progress = (done: number, total: number) => {
          if (signal.aborted || path !== state.draft.output || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return
          const pct = Math.max(0, Math.min(1, done / total))
          // 按真实读取量更新；同一整数百分比不重复推送，也不逐块落盘。
          if (Math.floor(pct * 100) === Math.floor((state.draft.ed2k?.pct ?? 0) * 100)) return
          state.draft.ed2k = { state: 'running', pct, link: '' }
          this.changed(state)
        }
        const result = await (this.options.compute ?? ((path, abort, progress) => ed2kFile(path, progress, abort)))(path, signal, progress)
        signal.throwIfAborted()
        if (path !== state.draft.output) throw new Error('成品路径已经改变')
        const file = state.checkpoint?.file
        if (file && (result.sha1 !== file.sha1 || result.size !== file.size)) throw new Error('成品内容已经改变')
        state.retention = { ed2k: result.link, sha1: result.sha1, file: result.file, acknowledged: false }
        state.draft.ed2k = { state: 'done', pct: 1, link: result.link }
        this.save(state)
        this.status(state)
        this.changed(state)
      }
      // 不占住上传等待 ED2K，也不在资源登记之前发送补记请求。
      if (!completed(state)) return
      const file = state.checkpoint!.file
      if (state.retention.sha1 !== file.sha1 || state.retention.file?.size !== file.size) throw new Error('成品内容已经改变')
      const result = await this.connection.request<{ accepted: boolean }>(state.draft.binding, 'files/ed2k',
        { taskKey: state.draft.fileKey, sha1: file.sha1, sizeBytes: file.size, ed2k: state.retention.ed2k }, signal)
      signal.throwIfAborted()
      if (result.accepted !== true) throw new Error('PlutoFish ED2K 保存未确认')
      state.retention.acknowledged = true
      this.save(state)
      this.status(state)
      this.changed(state)
    } catch (error) {
      if (!state.retention?.ed2k) {
        state.draft.ed2k = signal.aborted ? { state: 'queued', pct: 0, link: '' } :
          { state: 'failed', pct: 0, link: '', message: 'ED2K 计算未完成，稍后自动重试' }
        this.changed(state)
      }
      throw error
    } finally { release() }
  }

  async close(): Promise<void> { await this.running }

  /** 重新关联文件前停止旧路径的校验，避免迟到的结果覆盖新成品。 */
  async stop(key: string): Promise<void> {
    if (this.runningKey === key) { this.runningAbort?.abort(); await this.running }
    this.retryAt.delete(key)
  }

  /** 已确认本地文件消失后先发布展示状态，清单删除前由桌面端把它同步到历史。 */
  deleted(state: PublicationState): void {
    state.retention ??= {}
    state.retention.deletedAt ??= this.now()
    this.save(state)
    this.status(state)
  }

  private status(state: PublicationState, reason?: RetentionProgress['state']): void {
    const ed2kSaved = state.retention?.acknowledged === true
    const deleteAt = this.hours > 0 && state.completedAt !== undefined ? state.completedAt + this.hours * 3_600_000 : undefined
    const status: RetentionProgress['state'] = state.retention?.deletedAt !== undefined ? 'deleted'
      : reason ?? (this.hours === 0 ? 'disabled' : !completed(state) ? 'waiting_publish'
        : !state.retention?.ed2k ? 'waiting_ed2k' : !ed2kSaved ? 'waiting_save'
          : deleteAt !== undefined && deleteAt <= this.now() ? 'due' : 'retained')
    const next = { state: status, ed2kSaved, deleteAt }
    // 具体失败原因保留到下一次路径复查，不能被每两秒的普通状态刷新抹掉。
    if (!reason && status === 'due' && ['busy', 'changed', 'failed'].includes(state.draft.retention?.state ?? '')) return
    if (JSON.stringify(state.draft.retention) === JSON.stringify(next)) return
    state.draft.retention = next
    this.changed(state)
  }
}
