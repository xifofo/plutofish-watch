/** 115 开放接口访问受限时按绑定暂停；OSS 暂时繁忙仍由原有有限退避处理。 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PublisherError } from './retry'
import type { PublicationDraft } from './publication-types'

export class UploadRateLimitError extends PublisherError {
  constructor() { super('115 已限制访问，同账号上传队列已暂停；请在冷却结束后手动继续', false) }
}

/** 只有服务端明确映射的 115 访问受限才暂停账号，不能混同 OSS SlowDown 或 HTTP 429。 */
export function uploadRateLimited(error: unknown): boolean {
  return error instanceof UploadRateLimitError
}

export class UploadPauses {
  private entries: Record<string, number> = {}
  private loaded = false
  constructor(private directory: string, private now = Date.now) {}
  private key(binding: PublicationDraft['binding']): string { return JSON.stringify([binding.url, binding.sourceAccount?.id]) }
  private load(): void {
    if (this.loaded) return
    try {
      const data: unknown = JSON.parse(readFileSync(join(this.directory, 'upload-pauses.json'), 'utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) throw new Error('上传暂停记录无效，请保留文件并检查')
      this.entries = data as Record<string, number>
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.loaded = true
  }
  private save(entries = this.entries): void {
    const target = join(this.directory, 'upload-pauses.json'), tmp = `${target}.${randomUUID()}.tmp`
    try { writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 }); renameSync(tmp, target) }
    finally { rmSync(tmp, { force: true }) }
  }
  paused(binding: PublicationDraft['binding']): boolean { this.load(); return this.entries[this.key(binding)] !== undefined }
  assert(binding: PublicationDraft['binding']): void { if (this.paused(binding)) throw new UploadRateLimitError() }
  block(binding: PublicationDraft['binding']): void {
    this.load()
    const key = this.key(binding)
    if (this.entries[key] !== undefined) return
    this.entries[key] = this.now() + 15 * 60_000
    this.save()
  }
  resume(binding: PublicationDraft['binding']): void {
    this.load()
    const key = this.key(binding), until = this.entries[key]
    if (until === undefined) return
    if (this.now() < until) throw new PublisherError('115 访问冷却尚未结束，请稍后手动继续', false)
    const next = { ...this.entries }
    delete next[key]
    this.save(next)
    this.entries = next
  }
}
