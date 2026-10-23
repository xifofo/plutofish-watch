/** 文件系统通知负责及时性，完整补扫负责恢复性；任何入队先保存本地记录。 */
import { watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import { episodeFromName, sameSignature, scanTree } from './files'
import { WatchStore } from './store'
import type { WatchJob, WatchRoot } from '../shared/model'

export class DirectoryWatcher {
  private handles = new Map<string, FSWatcher>()
  private scanning = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private interval?: ReturnType<typeof setInterval>
  private abort = new AbortController()
  constructor(
    readonly store: WatchStore,
    private changed: () => void,
    private invalidated: (job: WatchJob) => Promise<void>,
    private fatal: (error: unknown) => void,
    private now = Date.now,
  ) {}

  start(): void {
    this.refresh()
    this.interval = setInterval(() => { void this.scan().catch(this.fatal) }, 3000)
    void this.scan().catch(this.fatal)
  }

  refresh(): void {
    for (const [id, handle] of this.handles) {
      if (!this.store.data.watches.some(w => w.id === id && w.enabled)) { handle.close(); this.handles.delete(id) }
    }
    for (const root of this.store.data.watches.filter(w => w.enabled)) {
      if (this.handles.has(root.id)) continue
      try {
        const handle = watch(root.path, { recursive: true }, () => {
          if (this.timers.has(root.id)) return
          this.timers.set(root.id, setTimeout(() => {
            this.timers.delete(root.id)
            void this.scanOne(root).catch(this.fatal)
          }, 500))
        })
        handle.on('error', () => { handle.close(); this.handles.delete(root.id) })
        this.handles.set(root.id, handle)
      } catch { /* 不支持原生递归通知或根目录暂不可访问时，保留周期补扫。 */ }
    }
  }

  async scan(): Promise<void> {
    if (this.abort.signal.aborted) return
    this.refresh()
    for (const root of this.store.data.watches) if (root.enabled) await this.scanOne(root)
  }

  /** 将首次扫描明确忽略的历史文件补入队列；保留已完成、失败及手动取消的任务决定。 */
  async backfill(id: string): Promise<number> {
    const root = this.store.data.watches.find(w => w.id === id)
    if (!root?.enabled || this.abort.signal.aborted) throw new Error('请先恢复目录监控')
    await this.scanOne(root)
    if (root.error) throw new Error(root.error)
    if (!root.enabled || this.abort.signal.aborted) throw new Error('目录监控已停止')
    const now = this.now(), date = new Date(now).toISOString()
    let count = 0
    for (const [path, observation] of Object.entries(this.store.data.observations[id] ?? {})) {
      if (!observation.ignored) continue
      const job: WatchJob = {
        id: randomUUID(), watchId: id, path, relativePath: relative(root.path, path), signature: observation.signature,
        status: 'waiting', percent: 0, error: '', createdAt: date, updatedAt: date,
      }
      observation.ignored = false; observation.stableSince = now; observation.jobId = job.id
      this.store.data.jobs.push(job); count++
    }
    this.store.save(); this.changed()
    return count
  }

  scanOne(root: WatchRoot): Promise<void> {
    if (this.abort.signal.aborted || !root.enabled) return Promise.resolve()
    const running = this.scanning.get(root.id)
    if (running) return running
    const promise = this.perform(root).finally(() => { this.scanning.delete(root.id) })
    this.scanning.set(root.id, promise)
    return promise
  }

  /** 移除监控前等当前扫描落定，避免扫描完成后重新写入已删除的目录记录。 */
  async quiesce(id: string): Promise<void> {
    this.refresh()
    const timer = this.timers.get(id)
    if (timer) { clearTimeout(timer); this.timers.delete(id) }
    await this.scanning.get(id)
  }

  private async perform(root: WatchRoot): Promise<void> {
    let files: Awaited<ReturnType<typeof scanTree>>
    try { files = await scanTree(root.path, this.abort.signal) }
    catch {
      if (!this.abort.signal.aborted) {
        root.error = '目录或子目录暂不可访问，已保留记录；恢复后会自动补扫'
        this.store.save(); this.changed()
      }
      return
    }
    if (!root.enabled || this.abort.signal.aborted) return
    const observations = this.store.data.observations[root.id] ??= {}
    const jobs = new Map(this.store.data.jobs.map(job => [job.id, job]))
    const timestamp = this.now(), date = new Date(timestamp).toISOString()
    for (const [path, sig] of files) {
      if (!root.enabled || this.abort.signal.aborted) return
      let previous = observations[path]
      if (!previous || !sameSignature(previous.signature, sig)) {
        if (previous?.jobId) {
          const old = jobs.get(previous.jobId)
          if (old && !['completed', 'duplicate', 'cancelled'].includes(old.status)) {
            old.changed = true
            await this.invalidated(old)
            old.status = 'cancelled'; old.error = '文件发生变化，旧任务已停止；新内容重新等待稳定'
          }
        }
        const ignored = !root.initialized && !root.includeExisting
        previous = observations[path] = { signature: sig, stableSince: timestamp, ignored }
        if (!ignored) {
          const job: WatchJob = {
            id: randomUUID(), watchId: root.id, path, relativePath: relative(root.path, path), signature: sig,
            status: 'waiting', createdAt: date, updatedAt: date, percent: 0, error: '',
          }
          previous.jobId = job.id
          this.store.data.jobs.push(job)
          jobs.set(job.id, job)
        }
      }
      if (previous.ignored || !previous.jobId) continue
      const job = jobs.get(previous.jobId)
      if (!job || job.status !== 'waiting' || sig.size < 1 || timestamp - previous.stableSince < root.stableSeconds * 1000) continue
      job.episodeNumber = root.work.mediaType === 'tv' ? job.episodeNumber ?? episodeFromName(relative(root.path, path), root.seasonNumber!) : undefined
      job.status = job.versionReview || (root.work.mediaType === 'tv' && job.episodeNumber === undefined) ? 'review' : 'queued'
      job.error = job.versionReview?.reason || (job.status === 'review' ? '无法确定本季集号，请确认后入队' : '')
      job.updatedAt = date
    }
    for (const [path, previous] of Object.entries(observations)) {
      if (files.has(path)) continue
      const job = previous.jobId ? jobs.get(previous.jobId) : undefined
      if (job && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
        job.changed = true
        await this.invalidated(job)
        job.status = 'cancelled'; job.error = '文件已移走，原任务停止'
      }
      delete observations[path]
    }
    root.initialized = true; root.lastScan = date; root.error = ''
    this.store.save()
    this.changed()
  }

  async close(): Promise<void> {
    this.abort.abort()
    if (this.interval) clearInterval(this.interval)
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const handle of this.handles.values()) handle.close()
    await Promise.allSettled(this.scanning.values())
  }
}
