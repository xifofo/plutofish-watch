/** 复用现有发布协议、分片和保留引擎；本地文件默认保留，显式开启后才定期清理。 */
import { PublisherError, retryableError, retryDelay } from '../../vendor/publisher/src/integrations/plutofish/retry'
import { publicationFailure } from '../../vendor/publisher/src/integrations/plutofish/publication-error'
import { basename, extname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { PublicationState } from '../../vendor/publisher/src/integrations/plutofish/publication-state'
import type { PublicationDraft } from '../../vendor/publisher/src/integrations/plutofish/publication-types'
import { PublicationWorker } from '../../vendor/publisher/src/integrations/plutofish/publication-worker'
import type { OSSFactory } from '../../vendor/publisher/src/integrations/plutofish/oss-upload'
import { PlutoFishConnection } from '../../vendor/publisher/src/integrations/plutofish/connection'
import { fingerprint } from '../../vendor/publisher/src/integrations/plutofish/upload-file'
import type { WatchJob, WatchRoot } from '../shared/model'
import { WatchStore } from './store'
import { automaticReleaseKey, releaseKey, stableKey, targetKey } from './bindings'
import { safeWatchFile, sameSignature, watchPathFor } from './files'
import { validateRetention } from '../shared/retention'
import { findProbe, probeFile } from './probe'
import { watchVersionChoices } from './versions'
import { matchMeasuredRelease, measuredReleaseVersion } from '../../vendor/publisher/src/integrations/plutofish/release-selection'
import { tierHeight } from '../../vendor/publisher/src/lib/name'
import { releaseSource, sourceReviewReason, normalizeRange } from '../../vendor/publisher/src/integrations/plutofish/release-specs'
import { actualVersionSummary } from '../../vendor/publisher/src/lib/actual-version'
import type { RetentionOptions } from '../../vendor/publisher/src/integrations/plutofish/publication-retention'
import { OneTimeBatches } from './one-time'
import { resolveJobEpisode } from './job-episode'

export class WatchPublisher {
  readonly worker: PublicationWorker
  private preparing?: { jobId: string; abort: AbortController; promise: Promise<void> }
  private closed = false
  private fatalError = false
  private timer?: ReturnType<typeof setInterval>
  private batches: OneTimeBatches
  constructor(
    private store: WatchStore, private connection: PlutoFishConnection, directory: string,
    private changed: () => void, private fatal: (error: unknown) => void,
    private retryOptions: { now?: () => number; baseMs?: number; maxMs?: number; factory?: OSSFactory; compute?: RetentionOptions['compute'] } = {},
  ) {
    this.batches = new OneTimeBatches(store, changed, root => {
      if (!this.eligible(root)) return false
      try { this.connection.assertBinding(root.binding); return true } catch { return false }
    }, () => this.now())
    this.worker = new PublicationWorker(connection, (draft, transient) => this.update(draft, transient), {
      probeMedia: async (path, signal = new AbortController().signal) => {
        const file = await lstat(path)
        return (await probeFile(findProbe(this.store.data.ffprobe), path, file.size, signal)).media
      },
      directory: join(directory, 'publications'), factory: retryOptions.factory, manual: true, now: retryOptions.now, retention: {
        compute: retryOptions.compute,
        now: retryOptions.now,
        settings: () => {
          const policy = validateRetention(this.store.data.retention)
          return { hours: policy.enabled ? policy.days * 24 : 0 }
        },
        canDelete: state => this.canDelete(state),
      },
    })
  }

  start(): void {
    // 发布清单可能先于监控记录落盘；启动先把未完成任务全部置为暂停，核对文件后再恢复。
    const restored = this.worker.restored()
    for (const draft of restored) {
      const job = this.store.data.jobs.find(j => j.fileKey === draft.fileKey)
      if (!job) {
        if (draft.progress?.stage !== 'completed') this.worker.control(draft.fileKey, 'pause')
        continue
      }
      if (draft.progress?.stage !== 'completed') {
        if (job.changed || job.status === 'cancelled') {
          this.worker.control(draft.fileKey, 'cancel')
          continue
        }
        if (job.status === 'failed') {
          this.worker.control(draft.fileKey, 'pause')
          continue
        }
        this.worker.control(draft.fileKey, 'pause')
        job.status = job.manuallyPaused ? 'paused' : 'queued'
      }
    }
    this.store.save()
    this.timer = setInterval(() => { void this.tick().catch(this.fatal) }, 1000)
  }

  private update(draft: PublicationDraft, transient = false): void {
    const job = this.store.data.jobs.find(j => j.fileKey === draft.fileKey && !j.changed)
    if (!job || !draft.progress) return
    const progress = draft.progress
    // 两份记录可能在异常退出时先后落盘。旧进度不能撤销已保存的取消或失败决定；
    // 恢复只能从显式入队开始，已完成的上传回执仍按事实接收。
    if (job.status === 'cancelled' && progress.stage !== 'completed') { delete job.retry; return }
    if (job.status === 'failed' && !['failed', 'completed', 'cancelled'].includes(progress.stage)) return
    // 恢复与重试先核对文件；旧暂停/失败快照的同步回执不能吞掉待核对队列。
    if (!job.preparationError && !(['paused', 'failed'].includes(progress.stage) && ['queued', 'preparing'].includes(job.status) && !job.manuallyPaused)) {
      job.status = job.manuallyPaused && !['completed', 'cancelled'].includes(progress.stage) ? 'paused' : progress.stage as WatchJob['status']
    }
    job.percent = progress.uploadPercent; job.phase = progress.phase
    job.uploadedBytes = progress.uploadedBytes
    job.transfer = job.status === 'uploading' && job.phase === 'uploading' ? progress.transfer : undefined
    if (transient) { this.changed(); return }
    job.synced = progress.synced
    job.ed2k = draft.ed2k ? structuredClone(draft.ed2k) : undefined
    job.ed2kSaved = draft.retention?.ed2kSaved ?? false
    job.retention = draft.retention ? structuredClone(draft.retention) : undefined
    job.error = job.preparationError || progress.error || (progress.stage === 'completed' && !progress.synced ? '上传完成，等待任务状态同步' : '')
    if (!job.preparationError) job.errorDetails = progress.errorDetails
    if (!job.preparationError && progress.stage === 'failed' && job.status === 'failed') {
      if (progress.failure?.retryable) this.scheduleRetry(job, progress.failure.retryAfterMs, progress.failure.id)
      else delete job.retry
    } else if (!job.preparationError && ['completed', 'cancelled'].includes(progress.stage)) delete job.retry
    job.updatedAt = new Date().toISOString()
    try { this.store.save(); this.changed() }
    catch (error) {
      this.fatalError = true
      this.preparing?.abort.abort()
      this.fatal(error)
      throw error
    }
  }

  private now(): number { return (this.retryOptions.now ?? Date.now)() }
  private canDelete(state: PublicationState): boolean {
    const job = this.store.data.jobs.find(j => j.fileKey === state.draft.fileKey)
    const root = this.store.data.watches.find(w => w.id === job?.watchId)
    const directory = root && job ? watchPathFor(root, job.path) : undefined
    if (!job || !root || root.mode === 'once' || !this.eligible(root) || job.status !== 'completed' || job.changed || job.manuallyPaused
      || !job.synced || !job.ed2kSaved || job.path !== state.draft.output || !directory) return false
    // 监控根目录或中间目录被改成链接时，不能沿旧路径清理其他目录里的文件。
    try { return realpathSync(directory) === directory && realpathSync(job.path) === resolve(job.path) }
    catch { return false }
  }
  private scheduleRetry(job: WatchJob, retryAfterMs = 0, failureId?: string): void {
    if (job.manuallyPaused || job.changed || (failureId && job.retry?.failureId === failureId)) return
    const attempt = (job.retry?.attempt ?? 0) + 1
    // 保留失败身份及次数，后续进度同步不能重新开启耗尽的自动重试。
    if (attempt > 8) {
      job.retry = { attempt, failureId }
      return
    }
    job.retry = { attempt, failureId, nextAt: this.now() + Math.max(retryDelay(attempt, this.retryOptions.baseMs, this.retryOptions.maxMs), retryAfterMs) }
  }

  private eligible(root?: WatchRoot): boolean {
    return !!root?.enabled && !!this.store.data.watches.find(w => w.id === root.id)?.enabled && !this.store.data.uploadsPaused && this.connection.ready && !this.closed && !this.fatalError && !this.worker.uploadPaused(root.binding)
  }

  /** 只有正在发布的原任务可以让同内容副本等待；失败、暂停及旧重复记录不占位。 */
  private publishing(job?: WatchJob): boolean {
    return !!job?.fileKey && !job.changed && !job.manuallyPaused && ['processing', 'uploading'].includes(job.status)
      && this.eligible(this.store.rootFor(job))
  }

  private waitingForDuplicate(job: WatchJob): boolean {
    if (job.fileKey || !job.duplicateOf || !job.targetKey || !job.sha1) return false
    const original = this.store.data.jobs.find(other => other.id === job.duplicateOf)
    return this.publishing(original) && original!.targetKey === job.targetKey && original!.sha1 === job.sha1
      && original!.signature.size === job.signature.size
  }

  /** 升级后只重查旧客户端自行拦截的任务；服务端失败及用户的暂停、取消决定保留。 */
  private recoverLocalDuplicates(): void {
    let changed = false
    for (const job of this.store.data.jobs) {
      if (job.changed || job.manuallyPaused || !this.eligible(this.store.rootFor(job))) continue
      const oldConflict = job.status === 'failed' && job.error === '同一版本已有该集或电影的其他内容，请使用另一个版本绑定'
      const original = job.status === 'duplicate' && !job.fileKey
        ? this.store.data.jobs.find(other => other.id === job.duplicateOf) : undefined
      const abandonedDuplicate = job.status === 'duplicate' && !job.fileKey
        && !(original && !original.changed && (original.status === 'completed' || this.publishing(original)))
      if (!oldConflict && !abandonedDuplicate) continue
      job.status = 'queued'; job.error = ''
      delete job.retry; delete job.preparationError; delete job.errorDetails
      if (!job.fileKey) {
        delete job.duplicateOf; delete job.reused; delete job.ed2k; delete job.ed2kSaved
      }
      job.updatedAt = new Date().toISOString()
      changed = true
    }
    if (changed) { this.store.save(); this.changed() }
  }

  async tick(): Promise<void> {
    if (this.closed || this.fatalError || !this.connection.ready) return
    this.registerBatchDeletions()
    await this.worker.tick()
    this.recoverLocalDuplicates()
    this.batches.tick()
    this.registerBatchDeletions()
    for (const job of this.store.data.jobs) {
      if (job.status === 'failed' && job.retry?.nextAt !== undefined && job.retry.nextAt <= this.now()
        && !job.manuallyPaused && !job.changed && this.eligible(this.store.data.watches.find(w => w.id === job.watchId))) {
        job.status = 'queued'; delete job.retry.nextAt
      }
    }
    if (this.preparing || this.store.data.uploadsPaused) return
    // 两个传输和两个已准备文件足够衔接；长队列逐步处理，避免反复淘汰摘要缓存或持续抢磁盘。
    if (this.store.data.jobs.filter(j => ['processing', 'uploading'].includes(j.status) && this.eligible(this.store.rootFor(j))).length >= 4) return
    const job = this.store.data.jobs.find(j => j.status === 'queued' && !this.waitingForDuplicate(j)
      && this.eligible(this.store.data.watches.find(w => w.id === j.watchId)))
    if (!job) return
    // 旧版已缓存版本的文件也需核对季号；已登记的发布清单始终沿用原季。
    if (job.seasonNumber === undefined && !job.fileKey) {
      resolveJobEpisode(this.store.data.watches.find(w => w.id === job.watchId)!, job)
      if (job.seasonReview) {
        job.status = 'review'; job.error = job.seasonReview; this.store.save(); this.changed()
        return
      }
    }
    const root = this.store.rootFor(job)!
    const abort = new AbortController()
    const promise = this.prepare(root, job, abort.signal).finally(() => { this.preparing = undefined })
    this.preparing = { jobId: job.id, abort, promise }
    await promise
  }

  private registerBatchDeletions(): void {
    this.worker.localFilesDeleted(this.store.data.jobs.filter(job => job.fileKey &&
      this.store.data.watches.some(root => root.id === job.watchId && root.mode === 'once' && root.batch?.deletedAt !== undefined)).map(job => job.fileKey!))
  }

  private async prepare(root: WatchRoot, job: WatchJob, signal: AbortSignal): Promise<void> {
    delete job.preparationError
    delete job.errorDetails
    job.status = 'preparing'; job.error = ''; this.store.save(); this.changed()
    try {
      this.connection.assertBinding(root.binding)
      const before = await safeWatchFile(root, job.path)
      if (!sameSignature(before, job.signature)) throw new Error('文件已改变，等待目录重新扫描')
      const measured = await probeFile(findProbe(this.store.data.ffprobe), job.path, before.size, signal)
      if (!job.release || (!job.release.id && job.release.key)) {
        if (root.versionMode === 'auto') {
          const preset = job.sourceOverride ?? root.sourcePreset
          const source = releaseSource(basename(job.path, extname(job.path)), preset)
          const valid = matchMeasuredRelease([], measured.media, job.path, preset)
          const version = job.release?.version ?? (valid.canCreate ? measuredReleaseVersion(measured.media, job.path, root.seasonNumber, preset) : undefined)
          const key = job.release?.key ?? (version ? automaticReleaseKey(root, version) : undefined)
          const catalog = await watchVersionChoices(this.connection, root, signal, key)
          const choices = catalog.items.filter(row => row.status !== 'unpublished')
          const match = matchMeasuredRelease(catalog.items, measured.media, job.path, preset)
          const bound = catalog.match === 'binding' ? catalog.items.find(row => row.id === catalog.matchedId) : undefined
          const selected = valid.canCreate && bound?.status !== 'unpublished'
            ? bound ?? choices.find(row => row.id === match.matchedId) : undefined
          // 下架绑定、同名但资料冲突的版本不能通过自动新建绕过。
          const nameExists = version && catalog.items.some(row => row.name.toUpperCase() === version.name.toUpperCase())
          if (!selected && (!match.canCreate || !version || !key || bound || nameExists)) {
            job.versionReview = { reason: match.reason, detected: actualVersionSummary(measured), choices, source, sourceRequired: !!sourceReviewReason(source) }
            if (bound || nameExists) job.versionReview.reason = '已有版本不可自动复用，请确认版本'
            job.status = 'review'; job.error = job.versionReview.reason
            return
          }
          signal.throwIfAborted()
          job.release = selected ? { id: selected.id, name: selected.name, key, version }
            : { name: version!.name, key: key!, version: version! }
          // 新版本登记后查得目录 ID，将先前同键任务归一，避免跨目录/重命名绕过去重。
          if (selected && key) for (const previous of this.store.data.jobs) {
            const previousRoot = this.store.rootFor(previous)
            if (previous.release?.key !== key || !previousRoot) continue
            previous.release.id = selected.id
            previous.targetKey = targetKey(previousRoot, previous.episodeNumber, selected.id)
          }
        } else job.release = { id: root.releaseId, name: root.releaseName, version: root.releaseVersion }
        delete job.versionReview
        this.store.save()
      }
      // 显式选择和旧固定版本也沿用已确认名称，不走下载器的 WEB-DL 回退命名。
      job.release.version ??= { name: job.release.name, resolution: `${tierHeight(measured.media.width ?? 0, measured.media.height ?? 0)}p`, dynamicRange: normalizeRange(measured.media.dynamicRange) ?? 'Unknown' }
      const releaseId = job.release.id
      const releaseIdentity = releaseId ?? job.release.key!
      const hash = await fingerprint(job.path, signal)
      const after = await safeWatchFile(root, job.path)
      if (!sameSignature(before, after)) throw new Error('文件在检测期间改变，等待重新扫描')
      signal.throwIfAborted()
      if (!this.eligible(root) || job.status !== 'preparing') return
      job.targetKey = targetKey(root, job.episodeNumber, releaseIdentity)
      const key = job.fileKey ?? stableKey('gvs-f1', [root.binding.publisherId, job.targetKey, hash.sha1, hash.size, job.id])
      // 续传必须沿用自己的发布清单，不能被其他任务截成重复而遗留上传断点。
      if (!job.fileKey) { delete job.duplicateOf; delete job.reused }
      // 本地只合并完整内容相同的副本；不同内容是否占用同集由服务端按首次 ready 决定。
      const sameTarget = (j: WatchJob) => {
        const bound = this.store.rootFor(j)
        const id = j.release?.id ?? j.release?.key ?? bound?.releaseId
        return (j.targetKey ?? (bound && id ? targetKey(bound, j.episodeNumber, id) : undefined)) === job.targetKey
      }
      const other = !job.fileKey && this.store.data.jobs.find(j => j.id !== job.id && sameTarget(j) && j.sha1 === hash.sha1
        && j.signature.size === hash.size && j.fileKey && !j.changed && !j.manuallyPaused
        && (j.status === 'completed' || this.publishing(j)))
      if (other) {
        const oldRoot = this.store.rootFor(other)
        const available = oldRoot?.enabled && await safeWatchFile(oldRoot, other.path).then(sig => sameSignature(sig, other.signature)).catch(() => false)
        signal.throwIfAborted()
        if (!this.eligible(root) || job.status !== 'preparing') return
        if (available && (other.status === 'completed' || this.publishing(other))) {
          job.sha1 = hash.sha1; job.duplicateOf = other.id
          // 原任务尚未成功时保持排队，后续 tick 会跳过等待项，不阻塞其他集准备。
          if (other.status !== 'completed') { job.status = 'queued'; return }
          job.status = 'duplicate'; job.error = '相同内容已处理'
          job.ed2k = other.ed2k; job.ed2kSaved = other.ed2kSaved
          return
        }
      }
      // 中断续传沿用原发布清单。新发现的成品先查服务端，覆盖其他客户端上传和本地记录丢失的情况。
      if (!job.fileKey && releaseId) {
        job.phase = 'checking'; this.changed()
        const result = await this.connection.request<{ status: string; fileId?: string; ed2k?: string }>(root.binding, 'files/check', {
          sourceAccount: root.binding.sourceAccount.alias, releaseId, episodeNumber: job.episodeNumber,
          sha1: hash.sha1, sizeBytes: hash.size,
        }, signal)
        signal.throwIfAborted()
        if (!sameSignature(await safeWatchFile(root, job.path), before)) throw new Error('文件在查重期间改变，等待重新扫描')
        if (!result || !['missing', 'existing', 'conflict'].includes(result.status)) throw new Error('PlutoFish 查重结果无效，已停止上传')
        if (result.status === 'conflict') throw new Error('此版本的同一集或电影已有其他内容，请检查版本绑定')
        if (result.status === 'existing') {
          if (!result.fileId || !/^[a-f0-9]{32}$/.test(result.fileId)) throw new Error('PlutoFish 查重结果无效，已停止上传')
          // existing 也可能是不同内容的先到剧集；沿用共享登记流程，由服务端隔离 ED2K 和本地校验资格。
          job.reused = true; job.duplicateOf = result.fileId
        }
      }
      job.fileKey = key; job.sha1 = hash.sha1
      this.store.save()
      const draft: PublicationDraft = {
        schemaVersion: 1, binding: root.binding, releaseKey: job.release.key ?? releaseKey(root, releaseId), fileKey: key, existingReleaseId: releaseId,
        version: job.release.version,
        workTarget: root.work, title: root.title, categoryLabel: root.work.category, kind: 'video',
        directoryId: root.directoryId, directoryPath: root.directoryPath, seasonNumber: root.seasonNumber,
        episodeNumber: job.episodeNumber, episodeTitle: root.work.mediaType === 'tv' ? `第 ${job.episodeNumber} 集` : undefined,
        output: job.path, measured, updatedAt: new Date().toISOString(),
      }
      this.worker.register(draft)
      this.worker.control(key, 'resume', true)
      this.worker.event(draft, { id: 0, status: '本地文件已就绪', pct: 1, log: '', err: '', done: true, completedMedia: measured })
    } catch (error) {
      if (!signal.aborted && job.status === 'preparing') {
        job.status = 'failed'
        if (retryableError(error)) this.scheduleRetry(job, error instanceof PublisherError ? error.retryAfterMs : undefined)
        else delete job.retry
        const failure = publicationFailure(error, '检测与校验')
        job.error = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : failure.message
        job.errorDetails = failure.diagnostic
        if (job.fileKey) job.preparationError = job.error
      }
    } finally {
      // 另一文件触发账号暂停时，本文件可能还在探测或计算摘要；准备已结束，不能滞留 preparing。
      if (!signal.aborted && job.status === 'preparing') { job.status = 'queued'; job.phase = undefined }
      if (job.phase === 'checking') job.phase = undefined
      job.updatedAt = new Date().toISOString()
      this.store.save(); this.changed()
    }
  }

  async stopJob(job: WatchJob, action: 'pause' | 'cancel'): Promise<void> {
    if (this.preparing?.jobId === job.id) {
      this.preparing.abort.abort()
      await this.preparing.promise
    }
    if (job.fileKey) await this.worker.stop(job.fileKey, action)
  }

  async pause(rootId?: string): Promise<void> {
    for (const job of this.store.data.jobs.filter(j => !rootId || j.watchId === rootId)) {
      if (['processing', 'uploading', 'preparing'].includes(job.status)) {
        await this.stopJob(job, 'pause')
        job.status = 'paused'
      }
    }
    this.store.save()
  }

  resume(rootId?: string): void {
    for (const job of this.store.data.jobs) {
      if ((!rootId || job.watchId === rootId) && job.status === 'paused' && !job.manuallyPaused && !job.changed && this.eligible(this.store.data.watches.find(w => w.id === job.watchId))) job.status = 'queued'
    }
    this.store.save()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.preparing?.abort.abort()
    await this.preparing?.promise
    await this.worker.close()
  }
}
