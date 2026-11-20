/** 原子持久化监控与文件发现记录；读取损坏时停止，不能用空状态重复上传。 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiskState, WatchJob, WatchRoot } from '../shared/model'
import { defaultRetention, validateRetention } from '../shared/retention'
import { validateWatchPaths } from '../shared/watch-paths'
import { releaseCancelledOneTimeFiles, validateOneTimeRoot } from './one-time'
import { jobTarget } from '../shared/job-target'

export function atomicJSON(path: string, data: unknown): void {
  atomicBytes(path, JSON.stringify(data) + '\n')
}

/** rename 只能保证替换时不会读到半份文件；先刷盘才能降低断电后全零文件的风险。 */
function atomicBytes(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const descriptor = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) }
    finally { closeSync(descriptor) }
    renameSync(temporary, path)
    // Windows 不支持以相同方式打开目录刷盘，不能把成功写入误报成失败。
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

const damagedState = () => new Error('监控记录损坏，原文件已保留，请从备份恢复。')

function parseState(bytes: Buffer): DiskState {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as DiskState
    if (value?.schemaVersion !== 1 || !Array.isArray(value.watches) || !Array.isArray(value.jobs)
      || !value.observations || typeof value.observations !== 'object' || Array.isArray(value.observations)
      || typeof value.uploadsPaused !== 'boolean' || typeof value.ffprobe !== 'string'
      || value.watches.some(w => !w || typeof w.id !== 'string' || !w.id || typeof w.enabled !== 'boolean')
      || value.jobs.some(j => !j || typeof j.id !== 'string' || !j.id)
      || new Set(value.watches.map(w => w.id)).size !== value.watches.length
      || new Set(value.jobs.map(j => j.id)).size !== value.jobs.length) throw damagedState()
    value.retention = value.retention === undefined ? defaultRetention() : validateRetention(value.retention)
    for (const root of [...value.watches, ...value.jobs.flatMap(job => job.watchSnapshot ? [job.watchSnapshot] : [])]) {
      validateOneTimeRoot(root)
      const paths = validateWatchPaths(root)
      if (root.initializedPaths !== undefined && (!Array.isArray(root.initializedPaths)
        || root.initializedPaths.some(path => typeof path !== 'string' || !paths.includes(path)))) throw damagedState()
    }
    for (const job of value.jobs) {
      if (job.seasonNumber !== undefined && (!Number.isInteger(job.seasonNumber) || job.seasonNumber < 0 || job.seasonNumber > 10000)) throw damagedState()
    }
    return value
  } catch { throw damagedState() }
}

function readOptional(path: string): Buffer | undefined {
  try { return readFileSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class WatchStore {
  readonly data: DiskState
  readonly recovery?: { backupPath: string; preservedPath?: string }
  onError?: (error: unknown) => void
  constructor(readonly path: string) {
    const original = readOptional(path)
    const backupPath = `${path}.bak`
    if (original === undefined && !existsSync(backupPath)) {
      this.data = { schemaVersion: 1, watches: [], jobs: [], observations: {}, uploadsPaused: false, ffprobe: '', retention: defaultRetention() }
      return
    }
    let value: DiskState
    try {
      if (original === undefined) throw damagedState()
      value = parseState(original)
    } catch {
      const backup = readOptional(backupPath)
      if (backup === undefined) throw damagedState()
      value = parseState(backup)
      // 旧备份的扫描基线可能落后；必须由用户检查后主动恢复监控和上传。
      value.uploadsPaused = true
      for (const root of [...value.watches, ...value.jobs.flatMap(job => job.watchSnapshot ? [job.watchSnapshot] : [])]) {
        root.enabled = false
        if (root.cleanup) root.cleanup.enabled = false
      }
      value.retention.enabled = false
      const preservedPath = original === undefined ? undefined : `${path}.corrupt-${randomUUID()}`
      if (preservedPath) atomicBytes(preservedPath, original!)
      atomicJSON(path, value)
      this.recovery = { backupPath, preservedPath }
    }
    this.data = value
    // 中断的本地探测重新开始；已有上传清单另由发布器恢复。
    for (const job of value.jobs) {
      delete job.transfer
      if (job.status === 'preparing') job.status = 'queued'
    }
    // 升级前已取消的一次性文件也释放路径；以该路径最后一条任务为准。
    for (const root of value.watches) releaseCancelledOneTimeFiles(root, value.jobs)
  }
  save(): void {
    try {
      const snapshot = parseState(Buffer.from(JSON.stringify({ ...this.data, jobs: this.data.jobs.map(({ transfer: _transfer, ...job }) => job) })))
      const serialized = Buffer.from(JSON.stringify(snapshot) + '\n')
      const previous = readOptional(this.path)
      // 外部损坏不能用当前内存状态覆盖，也不能污染最后一份有效备份。
      if (previous !== undefined) parseState(previous)
      atomicBytes(`${this.path}.bak`, previous ?? serialized)
      atomicBytes(this.path, serialized)
    }
    catch (error) { this.onError?.(error); throw error }
  }

  /** 任务归属固定，暂停与恢复仍由当前目录控制。移除目录后不再恢复上传。 */
  rootFor(job?: WatchJob): WatchRoot | undefined {
    const root = this.data.watches.find(w => w.id === job?.watchId)
    if (!root || !job) return undefined
    return jobTarget(root, job)
  }
}
