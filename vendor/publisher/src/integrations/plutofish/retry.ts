/** 重试依据结构化错误，不依赖展示文案，也不保存供应商原始错误。 */
export class PublisherError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'PublisherError'
  }
}

export function retryDelay(attempt: number, base = 5000, maximum = 300_000): number {
  return Math.min(maximum, base * 2 ** Math.min(20, Math.max(0, attempt - 1)))
}

export function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86400_000) : undefined
}

export function retryableHTTP(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
}

export function retryableError(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false
  seen.add(error)
  if (error instanceof PublisherError) return error.retryable
  const e = error as { name?: string; code?: string; status?: number; cause?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(e.code ?? '')) return false
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'RequestTimeout', 'ConnectionTimeout', 'TimeoutError', 'SlowDown', 'ServiceUnavailable'].includes(e.code ?? '')) return true
  if (['TimeoutError', 'ConnectionTimeoutError', 'ResponseTimeoutError'].includes(e.name ?? '')) return true
  if (e.status && retryableHTTP(e.status)) return true
  return !!e.cause && retryableError(e.cause, seen)
}

/** 只在网络调用边界使用；无明确系统码的 fetch TypeError 也视为可恢复。 */
export function transportError(error: unknown, signal?: AbortSignal): PublisherError {
  if (signal?.aborted) throw signal.reason
  const cause = (error as { cause?: unknown })?.cause
  return new PublisherError('PlutoFish 网络连接中断，请等待重连或稍后重试',
    retryableError(error) || (error instanceof TypeError && !cause))
}
