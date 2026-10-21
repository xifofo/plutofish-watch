export function asString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v === '<nil>' || v === 'null' ? '' : v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

export function anyInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
  return false
}

export function firstStr(m: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const s = asString(m[k])
    if (s) return s
  }
  return ''
}

export function human(n: number): string {
  const k = 1024
  if (n >= k * k * k) return `${(n / (k * k * k)).toFixed(1)} GB`
  if (n >= k * k) return `${(n / (k * k)).toFixed(1)} MB`
  if (n >= k) return `${(n / k).toFixed(1)} KB`
  return `${Math.trunc(n)} B`
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('aborted'))
    return promise
  }
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(t)
    reject(signal.reason ?? new Error('aborted'))
  }, { once: true })
  return promise
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `signal` plus a timeout; aborts when either the caller stops or time runs out. */
export function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timer]) : timer
}
