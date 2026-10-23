/** 原子持久化监控与文件发现记录；读取损坏时停止，不能用空状态重复上传。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiskState, WatchJob, WatchRoot } from '../shared/model'
import { defaultRetention, validateRetention } from '../shared/retention'

export function atomicJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export class WatchStore {
  readonly data: DiskState
  onError?: (error: unknown) => void
  constructor(readonly path: string) {
    if (!existsSync(path)) {
      this.data = { schemaVersion: 1, watches: [], jobs: [], observations: {}, uploadsPaused: false, ffprobe: '', retention: defaultRetention() }
      return
    }
    const value = JSON.parse(readFileSync(path, 'utf8')) as DiskState
    if (value?.schemaVersion !== 1 || !Array.isArray(value.watches) || !Array.isArray(value.jobs)
      || !value.observations || typeof value.observations !== 'object' || Array.isArray(value.observations)
      || typeof value.uploadsPaused !== 'boolean' || typeof value.ffprobe !== 'string'
      || new Set(value.watches.map(w => w.id)).size !== value.watches.length
      || new Set(value.jobs.map(j => j.id)).size !== value.jobs.length) {
      throw new Error('监控记录损坏，请保留数据文件后修复')
    }
    value.retention = value.retention === undefined ? defaultRetention() : validateRetention(value.retention)
    this.data = value
    // 中断的本地探测重新开始；已有上传清单另由发布器恢复。
    for (const job of value.jobs) if (job.status === 'preparing') job.status = 'queued'
  }
  save(): void {
    try { atomicJSON(this.path, this.data) }
    catch (error) { this.onError?.(error); throw error }
  }

  /** 任务归属固定，暂停与恢复仍由当前目录控制。移除目录后不再恢复上传。 */
  rootFor(job?: WatchJob): WatchRoot | undefined {
    const root = this.data.watches.find(w => w.id === job?.watchId)
    if (!root || !job) return undefined
    return job.watchSnapshot ? { ...job.watchSnapshot, enabled: root.enabled } : root
  }
}
