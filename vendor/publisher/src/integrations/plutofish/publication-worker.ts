/** 持久化任务快照 Outbox；两路上传与单路预处理独立运行，退出不丢分片。 */
import { PublisherError, type FailureDetails } from './retry'
import { publicationFailure } from './publication-error'
import { UploadPauses, UploadRateLimitError, uploadRateLimited } from './upload-pause'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { UploadBudget, type UploadTransfer } from './upload-traffic.ts'
import type { JobEvt } from '../../lib/job-event.ts'
import { PlutoFishConnection } from './connection.ts'
import { publicationDirectory } from './publication-store.ts'
import { PublicationStore, type PublicationState, type TaskSnapshot } from './publication-state.ts'
import { publicationMissing, type PublicationDraft } from './publication-types.ts'
import { fingerprint, challengeHash } from './upload-file.ts'
import { uploadParts, type OSSFactory } from './oss-upload.ts'
import type { UploadReply } from './upload-types.ts'
import { publicationVersion } from './publication-version.ts'
import { PublicationProofs } from './publication-proofs.ts'
import { PublicationCleanup } from './publication-cleanup.ts'
import { PublicationRetention, type RetentionOptions } from './publication-retention.ts'
import { localFileInUse } from '../../lib/local-file-use.ts'

const eligible = (draft: PublicationDraft) => !publicationMissing(draft).length
const safeError = (error: unknown) => publicationFailure(error, '发布任务').message

/** 本地监控没有分集标题时使用集号；不覆盖下载器提供的正式标题。 */
function episodeTitle(draft: PublicationDraft): string | undefined {
  if (draft.workTarget.mediaType !== 'tv' || !Number.isInteger(draft.episodeNumber)) return draft.episodeTitle
  return draft.episodeTitle?.trim() || `第 ${draft.episodeNumber} 集`
}

export class PublicationWorker {
  private readonly proofs: PublicationProofs
  private readonly cleanup: PublicationCleanup
  private readonly retention: PublicationRetention
  private readonly store: PublicationStore
  private readonly uploadPauses: UploadPauses
  private readonly states = new Map<string, PublicationState>()
  private loaded = false
  private timer?: ReturnType<typeof setInterval>
  private syncing = false
  private proofRunning?: Promise<void>
  private readonly running = new Map<string, { abort: AbortController; promise: Promise<void>; grouped: boolean }>()
  private preparing?: { key: string; abort: AbortController; promise: Promise<void> }
  private readonly prepared = new Set<string>()
  private readonly transfers = new Map<string, UploadTransfer>()
  private readonly budgets = new Map<string, UploadBudget>()
  private readonly clientId = randomUUID()
  private closed = false
  private readonly syncAbort = new AbortController()
  private readonly retryAt = new Map<string, number>()
  private readonly failureRetryAt = new Map<string, number>()
  private readonly syncErrors = new Map<string, PublisherError>()

  constructor(private readonly connection: PlutoFishConnection, private readonly changed: (draft: PublicationDraft, transient?: boolean) => void,
    options: { directory?: string; factory?: OSSFactory; manual?: boolean; beforeCleanup?: () => void; now?: () => number; retention?: RetentionOptions } = {}) {
    this.store = new PublicationStore(options.directory ?? publicationDirectory())
    this.uploadPauses = new UploadPauses(this.store.directory, options.now)
    this.factory = options.factory
    this.cleanup = new PublicationCleanup(connection, state => {
      if (this.states.get(state.draft.fileKey) !== state || this.running.has(state.draft.fileKey) || this.preparing?.key === state.draft.fileKey || this.proofs.isUsing(state) || localFileInUse(state.draft.output)) return
      this.store.removeCompleted(state)
      this.states.delete(state.draft.fileKey)
      this.retryAt.delete(state.draft.fileKey)
      this.failureRetryAt.delete(state.draft.fileKey)
      this.syncErrors.delete(state.draft.fileKey)
    }, options.beforeCleanup, state => this.retention.deleted(state))
    this.proofs = new PublicationProofs(connection, (state, message) => this.publish(state, message), state => this.store.save(state), state => this.cleanup.missing(state))
    this.retention = new PublicationRetention(connection, state => this.store.save(state), (state, message) => this.publish(state, message), state => this.cleanup.missing(state), options.retention)
    if (!options.manual) { this.timer = setInterval(() => { void this.tick() }, 2000); this.timer.unref?.() }
  }
  private readonly factory?: OSSFactory

  private load(): void {
    if (this.loaded) return
    for (const state of this.store.load()) {
      // 旧监控清单漏传必填集标题。沿用任务身份和上传断点，用新序号补报，不重建任务。
      if (state.snapshot.stage !== 'completed' && state.draft.workTarget.mediaType === 'tv') {
        const title = state.snapshot.episodeTitle?.trim() || episodeTitle(state.draft)
        if (title && (!state.draft.episodeTitle?.trim() || !state.snapshot.episodeTitle?.trim())) {
          state.draft.episodeTitle = title
          if (!state.snapshot.episodeTitle?.trim()) {
            state.snapshot.episodeTitle = title
            state.snapshot.sequence++
          }
          this.store.save(state)
        }
      }
      // 计算线程不能跨进程续跑；已落盘摘要由 publish 恢复，其余重新排队。
      state.draft.ed2k = undefined
      this.states.set(state.draft.fileKey, state)
    }
    this.loaded = true
  }
  /** 入队只保存本地快照，上传必须等待下载器给出已探测成品。 */
  register(draft: PublicationDraft): void {
    if (this.closed || !eligible(draft)) return
    draft = { ...draft, episodeTitle: episodeTitle(draft) }
    this.load()
    let state = this.states.get(draft.fileKey)
    if (!state) {
      // 桌面下载历史会在启动时重新 register；已完成并同步的旧条目不能复活已清理的发布清单。
      if (draft.progress?.stage === 'completed' && draft.progress.synced) return
      state = { draft: structuredClone(draft), acknowledged: 0, snapshot: {
        taskKey: draft.fileKey, releaseKey: draft.releaseKey, sourceAccount: draft.binding.sourceAccount!.alias,
        workTarget: structuredClone(draft.workTarget), title: draft.title,
        seasonNumber: draft.seasonNumber, episodeNumber: draft.episodeNumber, episodeTitle: draft.episodeTitle,
        attempt: 1, sequence: 1, stage: 'queued', downloadPercent: 0, uploadPercent: 0, sizeBytes: 0, uploadedBytes: 0,
      } }
      this.states.set(draft.fileKey, state)
      this.store.save(state)
    }
    this.publish(state)
  }

  /** 重启后恢复已下载成品的操作入口；原下载任务不能只靠发布快照重新下载。 */
  restored(): PublicationDraft[] {
    this.load()
    for (const state of this.states.values()) this.publish(state)
    return [...this.states.values()].filter(s => s.draft.output).map(s => structuredClone(s.draft))
  }

  private publish(state: PublicationState, error = '', transient = false): void {
    const p = state.snapshot
    const syncError = this.syncErrors.get(state.draft.fileKey)
    const message = error || p.errorMessage || syncError?.message || ''
    if (state.retention?.ed2k) state.draft.ed2k = { state: 'done', pct: 1, link: state.retention.ed2k }
    else if (state.draft.output && ['processing', 'uploading', 'completed'].includes(p.stage)) {
      state.draft.ed2k ??= { state: 'queued', pct: 0, link: '' }
    }
    state.draft.progress = { stage: p.stage, phase: state.draft.progress?.phase, downloadPercent: p.downloadPercent, uploadPercent: p.uploadPercent,
      uploadedBytes: p.uploadedBytes, sizeBytes: p.sizeBytes, error: message, synced: state.acknowledged >= p.sequence,
      errorDetails: !error && p.stage === 'failed' && p.errorMessage ? state.failure?.diagnostic : message === syncError?.message ? syncError?.diagnostic : undefined,
      failure: p.stage === 'failed' && state.failure ? { ...state.failure, id: `${p.attempt}:${p.sequence}` } : undefined }
    const view = structuredClone(state.draft)
    // 发送中的字节未获 OSS 确认，仅通过内存视图推送；快照序号和断点仍按整片回执落盘。
    const transfer = this.transfers.get(state.draft.fileKey)
    if (transfer && p.stage === 'uploading' && view.progress?.phase === 'uploading') view.progress.transfer = { ...transfer }
    this.changed(view, transient)
  }

  private update(state: PublicationState, patch: Partial<TaskSnapshot>): void {
    if (patch.stage && patch.stage !== state.snapshot.stage && state.draft.progress) state.draft.progress.phase = undefined
    if (patch.stage && patch.stage !== 'failed') state.failure = undefined
    Object.assign(state.snapshot, patch, { sequence: state.snapshot.sequence + 1 })
    if (patch.stage === 'failed') {
      state.snapshot.errorDetails = { ...(state.failure?.diagnostic ?? { stage: '发布任务' }), occurredAt: new Date().toISOString() }
      ;(state.pendingFailures ??= []).push(structuredClone(state.snapshot))
    } else if (state.snapshot.stage !== 'failed') delete state.snapshot.errorDetails
    this.store.save(state)
    this.publish(state)
  }

  private phase(state: PublicationState, phase: NonNullable<PublicationDraft['progress']>['phase']): void {
    if (state.draft.progress) state.draft.progress.phase = phase
    this.publish(state)
  }

  /** 下载阶段保留真实事件百分比；失败原文可能有外部地址，只上报安全摘要。 */
  event(draft: PublicationDraft, event: JobEvt): void {
    if (this.closed || !eligible(draft)) return
    draft = { ...draft, episodeTitle: episodeTitle(draft) }
    this.register(draft)
    const state = this.states.get(draft.fileKey)
    if (!state || state.snapshot.stage === 'completed') return
    state.draft = structuredClone(draft)
    if (!event.done) { state.draft.output = ''; state.draft.measured = undefined }
    const stage = event.stopped === 'pause' ? 'paused' : event.stopped === 'cancel' ? 'cancelled' : event.err ? 'failed'
      : event.done ? 'processing' : /封装|解密|校验|音轨/.test(event.status) ? 'processing' : 'downloading'
    const downloadPercent = Math.max(state.snapshot.downloadPercent, Math.min(100, Math.max(0, Number.isFinite(event.pct) ? event.pct * 100 : 0)))
    // 高频百分比合并到 0.1%，阶段变化立即落盘。快照序号先落盘后发送，崩溃重放仍幂等。
    if (!event.done && stage === state.snapshot.stage && Math.floor(downloadPercent * 10) === Math.floor(state.snapshot.downloadPercent * 10)) return
    this.update(state, { stage, downloadPercent: event.done && !event.err && !event.stopped ? 100 : downloadPercent,
      sizeBytes: draft.measured?.file.size ?? 0, errorMessage: event.err ? '下载失败，请在下载器检查并重试' : '' })
    if (event.done && !event.err && !event.stopped) this.retention.start(this.states, this.syncAbort.signal)
  }

  control(key: string, action: 'pause' | 'resume' | 'cancel' | 'download', automatic = false): void {
    if (this.closed) return
    this.load()
    const state = this.states.get(key)
    if (!state || state.snapshot.stage === 'completed') return
    if (action === 'resume' && !automatic) this.resumeAccount(state.draft.binding)
    this.running.get(key)?.abort.abort()
    if (this.preparing?.key === key) this.preparing.abort.abort()
    this.prepared.delete(key)
    this.transfers.delete(key)
    if (action === 'pause' || action === 'cancel') this.update(state, { stage: action === 'pause' ? 'paused' : 'cancelled', errorMessage: '' })
    else {
      this.retryAt.delete(key)
      if (action === 'download') {
        state.draft.output = ''
        state.draft.measured = undefined
      }
      // 增加尝试允许重新核对分片后的字节下降，不改已绑定的作品或文件身份。
      this.update(state, { attempt: state.snapshot.attempt + 1, stage: action === 'download' ? 'queued' : 'processing', errorMessage: '', ...(action === 'download' ? { downloadPercent: 0, uploadPercent: 0, uploadedBytes: 0, sizeBytes: 0 } : {}) })
    }
  }

  /** 账号暂停独立于单文件失败；自动重连不得调用 resumeAccount。 */
  uploadPaused(binding: PublicationDraft['binding']): boolean { this.load(); return this.uploadPauses.paused(binding) }
  resumeAccount(binding: PublicationDraft['binding']): void { this.load(); this.uploadPauses.resume(binding) }

  private pauseAccount(binding: PublicationDraft['binding'], diagnostic?: FailureDetails): void {
    try { this.uploadPauses.block(binding) }
    finally {
      // 即使暂停记录无法落盘，也先中止同账号已经在途的另一路上传。
      for (const state of this.states.values()) {
        if (this.uploadPauses.paused(state.draft.binding)) this.running.get(state.draft.fileKey)?.abort.abort(Object.assign(new UploadRateLimitError(), { diagnostic }))
      }
    }
    for (const state of this.states.values()) {
      if (!this.uploadPauses.paused(state.draft.binding) || ['completed', 'cancelled'].includes(state.snapshot.stage)) continue
      if (state.draft.output) {
        state.failure = { retryable: false, diagnostic }
        this.update(state, { stage: 'failed', errorMessage: new UploadRateLimitError().message })
      }
    }
  }

  /** 可由测试主动驱动；后台重连后重放最新快照，离线期间不丢任务。 */
  async tick(): Promise<void> {
    if (this.closed || this.syncing || !this.connection.ready) return
    this.syncing = true
    try {
      this.load()
      // 校验收件循环独立等待；上传快照、清单清理和新上传不会被 25 秒长轮询阻塞。
      this.proofRunning ??= this.proofs.run(() => [...this.states.values()], this.syncAbort.signal)
      for (const state of this.states.values()) {
        if (this.closed) return
        if ((!state.pendingFailures?.length && state.acknowledged >= state.snapshot.sequence) || (this.retryAt.get(state.draft.fileKey) ?? 0) > Date.now()) continue
        // 历史补报单独退避，不能因旧失败回执暂不可用而阻塞已经恢复的上传。
        const pending = state.pendingFailures ?? []
        const historyReady = (this.failureRetryAt.get(state.draft.fileKey) ?? 0) <= Date.now()
        const reports = historyReady ? pending.map(snapshot => ({ snapshot: structuredClone(snapshot), historical: true })) : []
        if (state.acknowledged < state.snapshot.sequence && !pending.some(item => item.sequence === state.snapshot.sequence)) {
          reports.push({ snapshot: structuredClone(state.snapshot), historical: false })
        }
        let historyBlocked = false
        for (const { snapshot, historical } of reports) {
          if (historical && historyBlocked) continue
          if (this.connection.view().identity?.capabilities?.taskDiagnostics !== true) delete snapshot.errorDetails
          try {
            const result = await this.connection.request<{ outcome: string }>(state.draft.binding, 'tasks/report', snapshot, this.syncAbort.signal)
            if (!['applied', 'duplicate', 'ignored'].includes(result.outcome)) throw new Error('PlutoFish 任务回执无效')
            if (result.outcome === 'ignored' && !historical) throw new Error('PlutoFish 任务序号领先本机，请恢复最新发布清单')
            state.acknowledged = Math.max(state.acknowledged, snapshot.sequence)
            state.pendingFailures = state.pendingFailures?.filter(item => item.sequence !== snapshot.sequence || item.attempt !== snapshot.attempt)
            if (historical) this.failureRetryAt.delete(state.draft.fileKey)
            this.syncErrors.delete(state.draft.fileKey)
            this.store.save(state); this.publish(state)
          } catch (error) {
            if (historical) {
              this.failureRetryAt.set(state.draft.fileKey, Date.now() + 15_000)
              historyBlocked = true
            } else this.retryAt.set(state.draft.fileKey, Date.now() + 15_000)
            // ED2K 等后台进度刷新不能清掉仍未成功同步的错误。
            this.syncErrors.set(state.draft.fileKey, publicationFailure(error, '同步任务状态'))
            // 失败上报的临时故障不能覆盖原上传失败原因；待同步标志单独保留。
            this.publish(state)
            if (!historical) break
          }
        }
      }
      try { this.retention.tick(this.states, this.syncAbort.signal) } catch { /* 无法读取策略或保存状态时不删除成品 */ }
      try { await this.cleanup.tick(this.states, this.syncAbort.signal) } catch { /* 清理失败保留原记录，下轮或重启后继续 */ }
      if (!this.closed) {
        const eligible = [...this.states.values()].filter(s => !this.uploadPauses.paused(s.draft.binding) && ['processing', 'uploading'].includes(s.snapshot.stage) && s.draft.output && !this.running.has(s.draft.fileKey) && s.acknowledged >= s.snapshot.sequence && (this.retryAt.get(s.draft.fileKey) ?? 0) <= Date.now())
        for (const state of eligible.filter(s => this.prepared.has(s.draft.fileKey))) {
          const grouped = this.connection.groupedUploads
          // 后台重验可能发现部署或回滚：原上传所有请求保持同一租约协议，排空后再切换。
          if (this.running.size >= (grouped ? 2 : 1) || [...this.running.values()].some(run => run.grouped !== grouped)) break
          const key = state.draft.fileKey
          this.prepared.delete(key)
          const abort = new AbortController()
          const promise = this.upload(state, abort, grouped).catch(() => { this.publish(state, '发布清单保存失败，请检查目录权限') }).finally(() => { this.running.delete(key) })
          this.running.set(key, { abort, promise, grouped })
        }
        // 上传槽之外，提前串行校验最多两个待上传文件；旧协议也能继续准备。
        if (!this.preparing && this.prepared.size < 2) {
          const state = eligible.find(s => !this.running.has(s.draft.fileKey) && !this.prepared.has(s.draft.fileKey))
          if (state) {
            const abort = new AbortController(), key = state.draft.fileKey
            this.phase(state, 'hashing')
            const promise = fingerprint(state.draft.output, abort.signal).then(() => {
              if (!abort.signal.aborted && !this.closed) { this.prepared.add(key); this.phase(state, undefined) }
            }).catch(error => {
              if (!abort.signal.aborted) {
                const failure = publicationFailure(error, '读取本地文件')
                state.failure = { retryable: failure.retryable, diagnostic: failure.diagnostic }
                this.update(state, { stage: 'failed', errorMessage: failure.message })
              }
            }).finally(() => { this.preparing = undefined })
            this.preparing = { key, abort, promise }
          }
        }
      }
    } catch (error) {
      for (const state of this.states.values()) this.publish(state, safeError(error))
    } finally { this.syncing = false }
  }

  private async upload(state: PublicationState, abort: AbortController, grouped: boolean): Promise<void> {
    const signal = abort.signal
    const draft = state.draft
    const client = grouped ? { clientId: this.clientId } : {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let pulse: Promise<void> | undefined
    let heartbeatError: unknown
    const request = async (action: string, extra = {}) => {
      this.uploadPauses.assert(draft.binding)
      const reply = await this.connection.request<UploadReply>(draft.binding, 'uploads/prepare', { taskKey: draft.fileKey, ...client, action, ...extra }, signal)
      if (!heartbeat) heartbeat = setInterval(() => {
        if (pulse || signal.aborted) return
        pulse = this.connection.request(draft.binding, 'uploads/prepare', { taskKey: draft.fileKey, ...client, action: 'heartbeat' }, signal)
          .then(() => {}).catch(error => { if (!signal.aborted) { heartbeatError = error; abort.abort() } }).finally(() => { pulse = undefined })
      }, 20_000)
      return reply
    }
    try {
      const measured = draft.measured
      if (measured?.media.status !== 'probed' || !measured.media.width || !measured.media.height || !measured.media.codec || !measured.file.size) throw new Error('成品媒体规格待检查，尚未上传')
      this.phase(state, 'hashing')
      const file = await fingerprint(draft.output, signal)
      if (file.size !== measured.file.size) throw new Error('成品大小与检测记录不一致')
      if (state.checkpoint && (state.checkpoint.file.sha1 !== file.sha1 || state.checkpoint.file.size !== file.size)) throw new Error('成品已改变，不能复用原上传断点')
      state.checkpoint ??= { file, partSize: Math.max(16 * 1024 * 1024, Math.ceil(file.size / 10000 / (1024 * 1024)) * 1024 * 1024), parts: [] }
      state.checkpoint.file = file
      this.store.save(state)
      const cp = state.checkpoint
      this.update(state, { attempt: state.snapshot.attempt + 1, stage: 'uploading', downloadPercent: 100, sizeBytes: file.size, errorMessage: '' })
      this.phase(state, 'uploading')
      const rememberReady = (dispatch: UploadReply['dispatch']) => {
        if (dispatch.status !== 'ready') throw new PublisherError('115 文件仍待核验', true)
        if (!dispatch.fileId || !dispatch.pickCode) throw new Error('115 文件核验响应无效')
        cp.resource = { fileId: dispatch.fileId, pickCode: dispatch.filePickCode || dispatch.pickCode, preId: file.preId }
        this.store.save(state)
      }
      const ready = async () => { rememberReady((await request('verify')).dispatch) }
      if (!cp.resource) {
        // Complete 响应丢失或进程退出时，先查 115 文件身份，禁止盲目重传完整文件。
        let recoverLegacyUpload = false
        if (cp.completing) {
          try { await ready() } catch (error) {
            signal.throwIfAborted()
            const notReady = error instanceof Error && ['115 文件尚未就绪，请重试原任务完成核验', '115 文件仍待核验'].includes(error.message)
            if (!notReady) throw error
            recoverLegacyUpload = !cp.sequential
          }
        }
        if (!cp.resource) {
          const init = { name: basename(draft.output), sizeBytes: file.size, sha1: file.sha1, preId: file.preId, directoryId: draft.directoryId ?? '0' }
          let result = await request('start', init)
          for (let i = 0; result.dispatch.status === 'challenge'; i++) {
            if (i >= 3 || !result.dispatch.signKey || !result.dispatch.signCheck) throw new Error('115 范围校验未通过')
            const signValue = await challengeHash(draft.output, result.dispatch.signCheck, file, signal)
            result = await request('start', { ...init, signKey: result.dispatch.signKey, signValue })
          }
          if (result.dispatch.status === 'ready') rememberReady(result.dispatch)
          else {
            await uploadParts({ path: draft.output, dispatch: result.dispatch, checkpoint: cp, signal, factory: this.factory, recoverLegacyUpload,
              authorize: () => { this.connection.assertBinding(draft.binding); this.uploadPauses.assert(draft.binding) },
              credentials: async () => { const reply = await request('credentials'); if (!reply.credentials) throw new Error('115 未返回临时凭据'); return reply.credentials },
              save: () => this.store.save(state), progress: bytes => this.update(state, { uploadedBytes: bytes, uploadPercent: bytes / file.size * 100 }),
              budgetFor: credentials => {
                const key = `${draft.binding.url}:${credentials.rateScope || draft.binding.sourceAccount!.id}`
                let budget = this.budgets.get(key)
                if (!budget) { budget = new UploadBudget(); this.budgets.set(key, budget) }
                return budget
              },
              transfer: value => {
                if (value) this.transfers.set(draft.fileKey, value)
                else this.transfers.delete(draft.fileKey)
                this.publish(state, '', true)
              },
            })
          }
        }
      }
      this.phase(state, 'verifying')
      if (!cp.resource) await ready()
      signal.throwIfAborted()
      const version = publicationVersion(draft)
      this.phase(state, 'reporting')
      await this.connection.request(draft.binding, 'files/report', {
        releaseTarget: { releaseKey: draft.releaseKey, existingReleaseId: draft.existingReleaseId, workTarget: draft.workTarget, seasonNumber: draft.seasonNumber, ...version, autoPublish: true },
        episodeNumber: draft.episodeNumber, episodeTitle: draft.episodeTitle, fileKey: draft.fileKey, name: basename(draft.output), kind: draft.kind,
        sizeBytes: file.size, downloadedBytes: file.size, uploadedBytes: file.size, status: 'ready', sha1: file.sha1, deduplicate: true,
        provider: '115', sourceAccount: draft.binding.sourceAccount!.alias, resource: cp.resource, attempt: 1, sequence: 1,
      }, signal)
      state.completedAt ??= Date.now()
      this.update(state, { stage: 'completed', uploadedBytes: file.size, uploadPercent: 100, errorMessage: '' })
    } catch (error) {
      if (uploadRateLimited(error) || uploadRateLimited(signal.reason)) {
        this.pauseAccount(draft.binding, publicationFailure(uploadRateLimited(error) ? error : signal.reason, '上传文件').diagnostic)
      } else if (!signal.aborted && error instanceof Error && error.message === 'PlutoFish 网盘上传排队中') {
        this.retryAt.set(draft.fileKey, Date.now() + 15_000)
        this.update(state, { stage: 'processing', errorMessage: error.message })
      } else if (!signal.aborted || heartbeatError) {
        const stage = ({ hashing: '校验本地文件', uploading: '上传文件', verifying: '核验网盘文件', reporting: '登记资源' } as Record<string, string>)[state.draft.progress?.phase ?? ''] ?? '上传文件'
        const failure = publicationFailure(heartbeatError ?? error, stage)
        state.failure = { retryable: failure.retryable, retryAfterMs: failure.retryAfterMs, diagnostic: failure.diagnostic }
        this.update(state, { stage: 'failed', errorMessage: failure.message })
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      await pulse
      // 当前 PUT 已结束或取消后释放；断网/撤权时让服务端占用自然过期。
      await this.connection.request(draft.binding, 'uploads/prepare', { taskKey: draft.fileKey, ...client, action: 'release' }, AbortSignal.timeout(5000)).catch(() => {})
    }
  }

  async stop(key: string, action: 'pause' | 'cancel'): Promise<void> {
    const running = this.running.get(key)?.promise
    const preparing = this.preparing?.key === key ? this.preparing.promise : undefined
    this.control(key, action)
    await running
    await preparing
  }

  async close(): Promise<void> {
    this.closed = true
    this.syncAbort.abort()
    if (this.timer) clearInterval(this.timer)
    this.preparing?.abort.abort()
    for (const run of this.running.values()) run.abort.abort()
    await Promise.all([...this.running.values()].map(run => run.promise))
    await this.preparing?.promise
    await this.proofRunning
    await this.retention.close()
    // 发送中的快照持久化完成后才释放租约，避免另一个进程拿到旧序号。
    while (this.syncing) await new Promise(resolve => setTimeout(resolve, 25))
    this.store.close()
  }
}
