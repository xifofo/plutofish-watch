/** 文件系统通知负责及时性，完整补扫负责恢复性；任何入队先保存本地记录。 */
import { watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import { sameSignature, scanTree, within, requiredWatchPath, safeFile, canonicalRoot } from './files'
import { resolveJobEpisode } from './job-episode'
import { initializedWatchPaths, watchPaths } from '../shared/watch-paths'
import { WatchStore } from './store'
import type { WatchJob, WatchRoot } from '../shared/model'

export class DirectoryWatcher {
  private handles = new Map<string, FSWatcher>()
  private scanning = new Map<string, Promise<void>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollTimer?: ReturnType<typeof setTimeout>
  private started = false
  private scanPass?: Promise<void>
  private scanQueue = Promise.resolve()
  private finished = new Map<string, number>()
  private abort = new AbortController()
  constructor(
    readonly store: WatchStore,
    private changed: () => void,
    private invalidated: (job: WatchJob) => Promise<void>,
    private fatal: (error: unknown) => void,
    private now = Date.now,
    private timing = { pollMs: 30_000, eventMs: 500, minGapMs: 3000 },
  ) {}

  start(): void {
    if (this.started || this.abort.signal.aborted) return
    this.started = true
    void this.scan().catch(this.fatal).finally(() => this.schedulePoll())
  }

  /** 从补扫完成后计时，慢盘扫描期间不积压定时器或重复遍历其他根目录。 */
  private schedulePoll(): void {
    if (this.abort.signal.aborted) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.scan().catch(this.fatal).finally(() => this.schedulePoll())
    }, this.timing.pollMs)
  }

  refresh(): void {
    if (this.abort.signal.aborted) return
    const active = new Map(this.store.data.watches.filter(w => w.enabled && w.mode !== 'once')
      .flatMap(root => watchPaths(root).map(path => [JSON.stringify([root.id, path]), { root, path }] as const)))
    for (const [key, handle] of this.handles) {
      if (!active.has(key)) { handle.close(); this.handles.delete(key) }
    }
    for (const [key, { root, path }] of active) {
      if (this.handles.has(key)) continue
      try {
        const handle = watch(path, { recursive: true }, () => this.scheduleEvent(root))
        handle.on('error', () => { handle.close(); this.handles.delete(key) })
        this.handles.set(key, handle)
      } catch { /* 不支持原生递归通知或根目录暂不可访问时，保留周期补扫。 */ }
    }
  }

  private scheduleEvent(root: WatchRoot): void {
    if (!root.enabled || this.abort.signal.aborted || this.timers.has(root.id)) return
    const delay = Math.max(this.timing.eventMs, (this.finished.get(root.id) ?? -Infinity) + this.timing.minGapMs - this.now())
    this.timers.set(root.id, setTimeout(() => {
      // 扫描中收到的事件保留一次后续补扫，扫描结束后重新计算间隔。
      const running = this.scanning.get(root.id)
      if (running) {
        void running.then(() => {
          this.timers.delete(root.id)
          this.scheduleEvent(root)
        }).catch(this.fatal)
        return
      }
      this.timers.delete(root.id)
      if ((this.finished.get(root.id) ?? -Infinity) + this.timing.minGapMs > this.now()) this.scheduleEvent(root)
      else void this.scanOne(root).catch(this.fatal)
    }, delay))
  }

  scan(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    if (this.scanPass) return this.scanPass
    this.refresh()
    this.scanPass = (async () => {
      for (const root of this.store.data.watches) {
        if (this.abort.signal.aborted) break
        if (root.enabled) await this.scanOne(root)
      }
    })().finally(() => { this.scanPass = undefined })
    return this.scanPass
  }

  /** 将首次扫描明确忽略的历史文件补入队列；保留已完成、失败及手动取消的任务决定。only 只补其中符合条件的文件。 */
  async backfill(id: string, only?: (path: string) => boolean): Promise<number> {
    const root = this.store.data.watches.find(w => w.id === id)
    if (root?.mode === 'once') throw new Error('一次性上传不补扫新增文件，请重新创建任务')
    if (!root?.enabled || this.abort.signal.aborted) throw new Error('请先恢复目录监控')
    await this.scanOne(root)
    if (root.error) throw new Error(root.error)
    if (!root.enabled || this.abort.signal.aborted) throw new Error('目录监控已停止')
    const now = this.now(), date = new Date(now).toISOString()
    let count = 0
    for (const [path, observation] of Object.entries(this.store.data.observations[id] ?? {})) {
      if (!observation.ignored || (only && !only(path))) continue
      const job: WatchJob = {
        id: randomUUID(), watchId: id, path, relativePath: relative(requiredWatchPath(root, path), path), signature: observation.signature,
        status: 'waiting', percent: 0, error: '', createdAt: date, updatedAt: date,
      }
      observation.ignored = false; observation.stableSince = now; observation.jobId = job.id
      this.store.data.jobs.push(job); count++
    }
    this.store.save(); this.changed()
    return count
  }

  scanOne(root: WatchRoot): Promise<void> {
    if (this.abort.signal.aborted || !root.enabled || (root.mode === 'once' && root.batch?.completedAt !== undefined)) return Promise.resolve()
    const running = this.scanning.get(root.id)
    if (running) return running
    // 文件事件、手动补扫和周期补扫共用同一串行通道，多个目录不会并行冲击磁盘。
    const promise = this.scanQueue.then(() => {
      if (!this.abort.signal.aborted && root.enabled && !(root.mode === 'once' && root.batch?.completedAt !== undefined)) return this.perform(root)
    }).finally(() => {
      this.scanning.delete(root.id)
      this.finished.set(root.id, this.now())
    })
    this.scanQueue = promise.catch(() => {})
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
    const initialized = new Set(initializedWatchPaths(root)), failures: string[] = []
    let changed = false
    for (const directory of watchPaths(root)) {
      if (!root.enabled || this.abort.signal.aborted) return
      let files: Awaited<ReturnType<typeof scanTree>>
      try {
        if (root.mode === 'once') {
          if (await canonicalRoot(directory) !== directory) throw new Error('一次性目录路径已变化')
          files = new Map()
          for (const path of root.batch!.files) {
            if (!root.enabled || this.abort.signal.aborted) return
            if (root.batch!.releasedFiles?.includes(path)) continue
            try { files.set(path, await safeFile(directory, path)) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              failures.push(path)
            }
          }
        } else files = await scanTree(directory, this.abort.signal)
      }
      catch { failures.push(directory); continue }
      if (!root.enabled || this.abort.signal.aborted) return
      const dirty = await this.observe(root, directory, files, initialized.has(directory)) || !initialized.has(directory)
      if (!root.enabled || this.abort.signal.aborted) return
      initialized.add(directory)
      root.initializedPaths = [...initialized]
      root.lastScan = new Date(this.now()).toISOString()
      // 每个成功目录单独落盘，其他目录失联不能让它在重启后重建首次基线。
      if (dirty) { this.store.save(); changed = true }
    }
    if (!root.enabled || this.abort.signal.aborted) return
    const ready = watchPaths(root).every(path => initialized.has(path))
    const error = failures.length ? `${root.mode === 'once' ? '本次文件已变化或暂不可访问，请检查文件队列' : '目录或子目录暂不可访问，已保留记录；恢复后会自动补扫'}：${failures.join('、')}` : ''
    const dirty = root.initialized !== ready || (root.error ?? '') !== error
    root.initializedPaths = [...initialized]; root.initialized = ready; root.error = error
    if (dirty) { this.store.save(); changed = true }
    // 空闲扫描只更新内存中的时间，不重写主记录和备份，不广播整份历史。
    if (changed) this.changed()
  }

  private async observe(root: WatchRoot, directory: string, files: Awaited<ReturnType<typeof scanTree>>, initialized: boolean): Promise<boolean> {
    if (!root.enabled || this.abort.signal.aborted) return false
    const observations = this.store.data.observations[root.id] ??= {}
    const jobs = new Map(this.store.data.jobs.map(job => [job.id, job]))
    const timestamp = this.now(), date = new Date(timestamp).toISOString()
    let dirty = false
    for (const [path, sig] of files) {
      if (!root.enabled || this.abort.signal.aborted) return dirty
      let previous = observations[path]
      if (!previous || !sameSignature(previous.signature, sig)) {
        dirty = true
        if (previous?.jobId) {
          const old = jobs.get(previous.jobId)
          if (old && !['completed', 'duplicate', 'cancelled'].includes(old.status)) {
            old.changed = true
            await this.invalidated(old)
            old.status = 'cancelled'; old.error = '文件发生变化，旧任务已停止；新内容重新等待稳定'
          }
        }
        const ignored = !initialized && !root.includeExisting
        previous = observations[path] = { signature: sig, stableSince: timestamp, ignored }
        if (!ignored) {
          const job: WatchJob = {
            id: randomUUID(), watchId: root.id, path, relativePath: relative(directory, path), signature: sig,
            status: 'waiting', createdAt: date, updatedAt: date, percent: 0, error: '',
          }
          previous.jobId = job.id
          this.store.data.jobs.push(job)
          jobs.set(job.id, job)
        }
      }
      if (previous.ignored || !previous.jobId) continue
      const job = jobs.get(previous.jobId)
      // 升级前因季号错配卡住的任务也可恢复；已确认、暂停及已开始发布的任务不自动重绑。
      const retryEpisode = job?.status === 'review' && !job.versionReview && !job.release && !job.fileKey
        && !job.manuallyPaused && !job.changed
      if (!job || (job.status !== 'waiting' && !retryEpisode) || sig.size < 1 || timestamp - previous.stableSince < root.stableSeconds * 1000) continue
      const before = JSON.stringify(job)
      resolveJobEpisode(root, job)
      job.status = job.seasonReview || job.versionReview || (root.work.mediaType === 'tv' && job.episodeNumber === undefined) ? 'review' : 'queued'
      job.error = job.seasonReview || job.versionReview?.reason || (job.status === 'review' ? '无法确定集号，请确认后入队' : '')
      if (JSON.stringify(job) !== before) { job.updatedAt = date; dirty = true }
    }
    for (const [path, previous] of Object.entries(observations)) {
      if (!within(directory, path) || files.has(path)) continue
      const job = previous.jobId ? jobs.get(previous.jobId) : undefined
      if (job && !['completed', 'duplicate', 'cancelled'].includes(job.status)) {
        job.changed = true
        await this.invalidated(job)
        job.status = 'cancelled'; job.error = '文件已移走，原任务停止'
        dirty = true
      }
      // 一次性清单保留缺失项，文件重新出现也不能重复入队。
      if (root.mode !== 'once') { delete observations[path]; dirty = true }
    }
    return dirty
  }

  async close(): Promise<void> {
    this.abort.abort()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const handle of this.handles.values()) handle.close()
    this.timers.clear(); this.handles.clear()
    await Promise.allSettled(this.scanning.values())
    await this.scanPass?.catch(() => {})
    this.finished.clear()
  }
}
