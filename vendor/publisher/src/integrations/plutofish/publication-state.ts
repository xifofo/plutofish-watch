/** 发布 Outbox 与分片回执原子落盘；独占租约防止同一配置被桌面端和 TUI 同时续传。 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PublicationDraft } from './publication-types.ts'
import type { UploadCheckpoint } from './upload-types.ts'
import type { FailureDetails } from './retry'

export type TaskSnapshot = {
  taskKey: string; releaseKey: string; sourceAccount: string; workTarget: PublicationDraft['workTarget']; title: string
  seasonNumber?: number; episodeNumber?: number; episodeTitle?: string
  attempt: number; sequence: number; stage: 'queued' | 'downloading' | 'processing' | 'uploading' | 'paused' | 'failed' | 'cancelled' | 'completed'
  downloadPercent: number; uploadPercent: number; sizeBytes: number; uploadedBytes: number; errorMessage?: string; errorDetails?: FailureDetails
}
export type PublicationState = {
  draft: PublicationDraft; snapshot: TaskSnapshot;
  /** 失败快照按顺序补报，不能被后续重试或完成状态覆盖。 */
  pendingFailures?: TaskSnapshot[]; acknowledged: number; checkpoint?: UploadCheckpoint
  /** 首次发布成功的时间不随重试、校验、重启刷新；旧清单首次升级时起算。 */
  completedAt?: number
  failure?: { retryable: boolean; retryAfterMs?: number; diagnostic?: FailureDetails }
  retention?: {
    ed2k?: string; sha1?: string; acknowledged?: boolean; retiring?: boolean
    deletedAt?: number
    /** 计算 ED2K 时核对同一份内容，清理前要求路径仍是这一个普通文件。 */
    file?: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
  }
}

export class PublicationStore {
  private leased = false
  constructor(readonly directory: string) {}
  lease(): void {
    if (this.leased) return
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const lock = join(this.directory, '.worker-lock')
    try { mkdirSync(lock, { mode: 0o700 }) }
    catch {
      let stale = false
      try {
        const owner = Number(readFileSync(join(lock, 'pid'), 'utf8'))
        if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('invalid lock')
        try { process.kill(owner, 0) } catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      } catch { stale = Date.now() - statSync(lock).mtimeMs > 60_000 }
      if (!stale) throw new Error('另一发布器正在使用此配置，请先关闭它')
      rmSync(lock, { recursive: true, force: true }); mkdirSync(lock, { mode: 0o700 })
    }
    writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
    this.leased = true
  }
  load(): PublicationState[] {
    this.lease()
    return readdirSync(this.directory).filter(n => /^gvs-f1-[a-f0-9]{64}\.state\.json$/.test(n)).map(n => {
      const state = JSON.parse(readFileSync(join(this.directory, n), 'utf8')) as PublicationState
      if (this.name(state.draft.fileKey) !== n || state.snapshot.taskKey !== state.draft.fileKey) throw new Error('发布清单身份损坏，请保留文件后检查')
      return state
    })
  }
  private name(key: string): string {
    if (!/^gvs-f1:[a-f0-9]{64}$/.test(key)) throw new Error('发布文件标识无效')
    return `${key.replace(':', '-')}.state.json`
  }
  save(state: PublicationState): void {
    this.lease()
    const target = join(this.directory, this.name(state.draft.fileKey)), tmp = `${target}.${randomUUID()}.tmp`
    try { writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, target) }
    finally { rmSync(tmp, { force: true }) }
  }
  /** 仅用于已上报完成且服务端确认清理的成品；先删草稿再删续办状态，失败可重试。 */
  removeCompleted(state: PublicationState): void {
    if (state.snapshot.stage !== 'completed' || state.pendingFailures?.length || state.acknowledged < state.snapshot.sequence || !state.checkpoint?.resource) throw new Error('未完成发布不能清理续办记录')
    this.lease()
    const name = this.name(state.draft.fileKey)
    rmSync(join(this.directory, name.replace('.state.json', '.json')), { force: true })
    rmSync(join(this.directory, name), { force: true })
  }
  close(): void {
    if (this.leased) rmSync(join(this.directory, '.worker-lock'), { recursive: true, force: true })
    this.leased = false
  }
}
