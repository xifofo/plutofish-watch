/** 桌面应用服务：绑定校验、本地状态与发布器生命周期统一由主进程管理。 */
import { randomUUID } from 'node:crypto'
import { basename, extname, join, relative } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { releaseSource, sourceReviewReason } from '../../vendor/publisher/src/integrations/plutofish/release-specs'
import { releaseChoices } from '../../vendor/publisher/src/integrations/plutofish/release-selection'
import type { PublicationDraft } from '../../vendor/publisher/src/integrations/plutofish/publication-types'
import type { Release, Snapshot, WatchInput, WatchAPI, OneTimeBatch } from '../shared/model'
import { validateRetention } from '../shared/retention'
import { watchPaths } from '../shared/watch-paths'
import { bindingFor, stableKey, validateInput, validateWork, validateSource } from './bindings'
import { canonicalRoot, episodeFromName, safeWatchFile, sameSignature, within, requiredWatchPath, selectedVideoFiles } from './files'
import { atomicJSON, WatchStore } from './store'
import { DirectoryWatcher } from './watcher'
import { WatchPublisher } from './publisher'
import { findProbe, probeAvailable } from './probe'
import { WatchConnection, validateWatchedFile } from './connection'
import { searchWorks } from './work-search'
import { recognitionSample, recognizeFile } from './recognition'
import { applyWatchEdit } from './watch-edit'
import { watchVersionChoices } from './versions'
import { createOneTimeBatch } from './one-time'
import type { RetentionOptions } from '../../vendor/publisher/src/integrations/plutofish/publication-retention'

/** 首次扫描忽略的历史文件按 PlutoFish 进度核对的间隔 */
export const HISTORY_SYNC_MS = 6 * 3600_000

export class WatchService {
  readonly store: WatchStore
  readonly connection: WatchConnection
  readonly publisher: WatchPublisher
  readonly watcher: DirectoryWatcher
  private fatalError = ''
  private ffprobeAvailable = false
  private stopped = false
  private historyTimer?: ReturnType<typeof setInterval>

  constructor(private directory: string, private changed: () => void, compute?: RetentionOptions['compute']) {
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
    this.publisher = new WatchPublisher(this.store, this.connection, directory, changed, error => this.fail(error), { compute })
    this.watcher = new DirectoryWatcher(this.store, changed, job => this.publisher.stopJob(job, 'cancel'), error => this.fail(error))
    this.store.onError = error => this.fail(error)
  }

  async start(): Promise<void> {
    this.ffprobeAvailable = await probeAvailable(findProbe(this.store.data.ffprobe))
    if (this.stopped) return
    this.publisher.start()
    this.watcher.start()
    this.historyTimer = setInterval(() => { void this.syncHistory().catch(() => {}) }, 60_000)
    // 窗口先于视频检测就绪；用户已发起连接时，不再用启动校验取消新连接或查询。
    const connection = this.connection.view()
    if (connection.hasKey && connection.status === 'idle') {
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

  async recognitionSample(path: string) {
    return recognitionSample(path)
  }

  async recognizeFile(input: Parameters<WatchAPI['recognizeFile']>[0]) {
    const binding = bindingFor(this.connection.view(), input?.sourceAccountId)
    return recognizeFile(this.connection, binding, input?.fileName)
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
    if (this.store.data.watches.length >= 100) throw new Error('最多支持 100 个目录任务，请移除已完成任务后再添加')
    const input = validateInput(raw, this.connection.view())
    const paths = await this.localPaths(input)
    if (input.selectedFiles) {
      const selection = await selectedVideoFiles(input.selectedFiles)
      if (selection.path !== paths[0]) throw new Error('所选文件不属于本次目录，请重新选择')
      input.selectedFiles = selection.files
    }
    const batch = input.mode === 'once' ? await createOneTimeBatch(paths[0], input.cleanup!, input.selectedFiles) : undefined
    this.checkLocalOverlap({ ...input, path: paths[0], additionalPaths: paths.slice(1) }, batch)
    const releases = await this.releases(input)
    const release = releases.find(r => r.id === input.releaseId)
    if (input.versionMode !== 'auto' && !release) throw new Error('版本已变化，请重新查询并选择')
    const binding = bindingFor(this.connection.view(), input.sourceAccountId)
    this.store.data.watches.push({
      ...input, batch, path: paths[0], additionalPaths: paths.slice(1), binding, id: randomUUID(), releaseName: input.versionMode === 'auto' ? '自动归类' : release!.name,
      releaseVersion: release ? { name: release.name, resolution: release.resolution, dynamicRange: release.dynamicRange } : undefined,
      enabled: true, initialized: false, createdAt: new Date().toISOString(),
    })
    try { this.store.save() } catch (error) { this.fail(error); throw error }
    this.watcher.refresh()
    await this.watcher.scan()
    this.changed()
  }

  private async localPaths(input: WatchInput): Promise<string[]> {
    const paths: string[] = []
    for (const raw of watchPaths(input)) {
      const path = await canonicalRoot(raw)
      if ((!input.selectedFiles && within(path, this.directory)) || within(this.directory, path)) throw new Error('不能监控应用自身的数据目录或其父目录')
      if (paths.some(other => within(other, path) || within(path, other))) throw new Error('监控目录不能重复或互相嵌套')
      paths.push(path)
    }
    return paths
  }

  private checkLocalOverlap(input: WatchInput, batch?: OneTimeBatch, excludingId?: string): void {
    // 固定文件清单只占用本次文件；持续监控和整目录清理仍占用完整目录。
    const filesOnly = (root: WatchInput) => root.mode === 'once' && (root.selectedFiles !== undefined || !root.cleanup?.enabled)
    const existing = this.store.data.watches.filter(w => w.id !== excludingId && !w.batch?.deletedAt)
    const directories = existing.filter(w => !filesOnly(w)).flatMap(watchPaths)
    const files = new Set(existing.filter(filesOnly).flatMap(w => w.batch!.files))
    const overlap = filesOnly(input)
      ? batch!.files.some(path => files.has(path) || directories.some(directory => within(directory, path)))
      : watchPaths(input).some(path => directories.some(other => within(other, path) || within(path, other)) || [...files].some(file => within(path, file)))
    if (overlap) {
      throw new Error(input.mode === 'once' ? '所选文件或目录与现有任务重叠，请选择其他文件或先移除原任务' : '监控目录不能重复或互相嵌套')
    }
  }

  async backfill(id: string): Promise<number> {
    if (this.fatalError) throw new Error(this.fatalError)
    return this.watcher.backfill(id)
  }

  /**
   * 追更进度以 PlutoFish 为准：固定版本的剧集目录里首次扫描忽略的历史文件，对应集号在版本里还没有就绪的
   * （从版本第一集起）自动补入队列；换电脑重新添加目录或首次不补传时，也不会漏下中间缺的集。
   * 版本里已有的集保持忽略。每个目录每 6 小时核对一次，改了版本、季或账号后重新核对；查询失败下次再试。
   */
  async syncHistory(now = Date.now()): Promise<number> {
    if (this.fatalError || this.stopped || !this.connection.ready) return 0
    let restored = 0, checked = false
    for (const root of this.store.data.watches) {
      if (root.mode === 'once' || !root.enabled || !root.initialized || root.work.mediaType !== 'tv' || (root.versionMode ?? 'fixed') !== 'fixed' || !root.releaseId) continue
      if (now - (root.progressAt ?? 0) < HISTORY_SYNC_MS) continue
      checked = true
      if (!Object.values(this.store.data.observations[root.id] ?? {}).some(o => o.ignored)) { root.progressAt = now; continue }
      try {
        const choices = await watchVersionChoices(this.connection, root, AbortSignal.timeout(30_000))
        const release = choices.items.find(r => r.id === root.releaseId) as Release | undefined
        root.progressAt = now
        if (!release || !Array.isArray(release.episodes) || !release.episodes.length) continue
        const have = new Set(release.episodes), from = Math.min(...release.episodes)
        restored += await this.watcher.backfill(root.id, path => {
          const episode = episodeFromName(relative(requiredWatchPath(root, path), path), root.seasonNumber!)
          return episode !== undefined && episode >= from && !have.has(episode)
        })
      } catch { /* 网络或服务端暂不可用、目录暂不可访问时下次再核对。 */ }
    }
    if (checked && !this.stopped && !this.fatalError) { this.store.save(); if (restored) this.changed() }
    return restored
  }

  async updateWatch(raw: Parameters<WatchAPI['updateWatch']>[0]): Promise<void> {
    if (this.fatalError || this.stopped) throw new Error(this.fatalError || '客户端已停止')
    const root = this.store.data.watches.find(w => w.id === raw?.id)
    if (!root) throw new Error('监控目录不存在')
    if (root.mode === 'once' || raw.watch?.mode === 'once') throw new Error('一次性任务的目录和发布配置已固定，请移除后重新创建')
    const input = validateInput(raw.watch, this.connection.view())
    const paths = await this.localPaths(input)
    this.checkLocalOverlap({ ...input, path: paths[0], additionalPaths: paths.slice(1) }, undefined, root.id)
    const releases = await this.releases(input)
    const release = releases.find(r => r.id === input.releaseId)
    if (input.versionMode !== 'auto' && !release) throw new Error('版本已变化，请重新查询并选择')
    const binding = bindingFor(this.connection.view(), input.sourceAccountId)
    const enabled = root.enabled
    const next = { ...root, ...input, path: paths[0], additionalPaths: paths.slice(1), binding, enabled,
      includeExisting: paths.every(path => watchPaths(root).includes(path)) ? root.includeExisting : input.includeExisting,
      releaseName: input.versionMode === 'auto' ? '自动归类' : release!.name,
      releaseVersion: release ? { name: release.name, resolution: release.resolution, dynamicRange: release.dynamicRange } : undefined }
    // 先完成验证，再停止旧扫描和读文件操作；保存期间不允许新任务取得一半更新的配置。
    root.enabled = false
    try {
      await this.watcher.quiesce(root.id)
      await this.publisher.pause(root.id)
      applyWatchEdit(this.store, root, next)
    } finally {
      if (!this.fatalError) {
        root.enabled = enabled
        this.store.save()
        if (enabled) this.publisher.resume(root.id)
        this.watcher.refresh(); this.changed()
      }
    }
    if (enabled) await this.watcher.scanOne(root)
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
    const root = this.store.rootFor(job)
    if (input.action === 'pause' && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
      job.manuallyPaused = true
      job.status = 'paused'; this.store.save()
      await this.publisher.stopJob(job, 'pause')
    } else if (input.action === 'cancel' && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
      job.status = 'cancelled'; job.manuallyPaused = true; delete job.retry
      this.store.save()
      await this.publisher.stopJob(job, 'cancel')
    } else if (input.action === 'confirmSource') {
      if (!root || root.versionMode !== 'auto' || job.changed || job.fileKey || job.status !== 'review' || !job.versionReview?.sourceRequired) throw new Error('此任务无需确认来源')
      if (!sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
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
      if (!sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
      if (input.action === 'selectVersion') {
        const choices = await this.releases(root)
        const selected = choices.find(row => row.id === input.releaseId)
        if (!selected) throw new Error('版本已变化，请刷新并重新选择')
        // 异步查询期间文件可能被替换；再次确认后才固定人工选择。
        if (job.changed || !sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
        job.release = { id: selected.id, name: selected.name, version: { name: selected.name, resolution: selected.resolution, dynamicRange: selected.dynamicRange } }
      } else delete job.release
      delete job.versionReview
      job.status = 'queued'; job.manuallyPaused = false; job.error = ''
    } else if (['resume', 'confirm'].includes(input.action)) {
      if (!root || job.changed || !['failed', 'paused', 'review'].includes(job.status)) throw new Error('当前任务不能恢复，请重新扫描')
      if (!sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('文件已变化，请重新扫描')
      if (root.work.mediaType === 'tv') {
        const episode = input.episodeNumber ?? job.episodeNumber
        if ((episode !== undefined || input.action === 'confirm' || job.fileKey)
          && (!Number.isInteger(episode) || episode! < 0 || episode! > 100000)) throw new Error('请填写 0–100000 的集号')
        if (job.fileKey && episode !== job.episodeNumber) throw new Error('已登记任务不能修改集号')
        job.episodeNumber = episode
      }
      this.publisher.worker.resumeAccount(root.binding)
      delete job.retry
      job.status = job.fileKey ? 'queued' : 'waiting'; job.manuallyPaused = false; job.error = ''
      // 尚未登记的文件仍需通过当前稳定窗口；季号变化后可回到人工集号确认。
      if (!job.fileKey && root.enabled) await this.watcher.scanOne(root)
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

  async cancelCleanup(id: string): Promise<void> {
    if (this.fatalError || this.stopped) throw new Error(this.fatalError || '客户端已停止')
    const root = this.store.data.watches.find(w => w.id === id)
    if (root?.mode !== 'once' || !root.cleanup || !root.batch || root.batch.deletedAt) throw new Error('此任务没有待取消的目录清理')
    root.cleanup.enabled = false
    delete root.batch.deleteAt
    this.store.save(); this.changed()
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.historyTimer) clearInterval(this.historyTimer)
    await this.watcher.close()
    await this.publisher.close()
    this.connection.close()
  }
}
