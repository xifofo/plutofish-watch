/** Retry both the request and the complete body: socket resets often happen
 * after a successful HTTP response while a large tool archive is downloading.
 */
export async function fetchToolBytes(url: string, options: {
  label: string
  accept?: string
  signal?: AbortSignal
  note?: (message: string) => void
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}): Promise<Buffer> {
  const attempts = 5
  const wait = options.wait ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已取消')); return }
    const abort = () => { clearTimeout(timer); reject(new Error('已取消')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  }))
  let last = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error('已取消工具下载')
    let retryable = true
    let retryAfter = 0
    try {
      const timeout = AbortSignal.timeout(180_000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await (options.fetcher ?? fetch)(url, {
        headers: { 'User-Agent': 'gvs-tui', Accept: options.accept ?? 'application/octet-stream' },
        redirect: 'follow', signal,
      })
      if (!response.ok) {
        retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
          || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
        retryAfter = Math.min(10_000, Math.max(0, Number(response.headers.get('retry-after') ?? 0) * 1000)) || 0
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const expected = response.headers.get('content-length')
      if (!bytes.length || (!response.headers.get('content-encoding') && expected !== null && bytes.length !== Number(expected))) {
        throw new Error('下载不完整')
      }
      return bytes
    } catch (e) {
      if (options.signal?.aborted) throw new Error('已取消工具下载')
      // Keep error text brief; signed redirects and verbose socket dumps do
      // not help the setup screen and may include temporary download tokens.
      last = (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '[下载地址]').split('\n')[0]!.slice(0, 180)
      if (!retryable || attempt === attempts) break
      const delay = Math.max(retryAfter, Math.min(1000 * 2 ** (attempt - 1), 8000))
      options.note?.(`${options.label} 连接中断或服务暂不可用，${delay / 1000} 秒后重试 (${attempt}/${attempts - 1})`)
      await wait(delay, options.signal)
    }
  }
  throw new Error(`${options.label} 下载失败：${last}。请检查 GitHub 连接后运行 bun run tools:prepare 重试`)
}
