/** Bun caches HTTP(S)_PROXY at process start. Runtime delete / per-request
 * `{ proxy: '' }` cannot undo that, so CDN fetch keeps going through Clash.
 * Strip the env and re-exec once; keep the original URL in GVS_PROXY for
 * gateway/TMDB only. */

import { isLocalGateway } from './gateway-route.ts'

/** Local media transport; desktop replaces this with its system-proxy stack. */
export function fetchMediaProbe(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}

/** Binary parts need a streaming response rather than a bounded manifest read. */
export function fetchMediaSegment(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}

/** Side media files (e.g. Crunchyroll subtitles) follow the same route as the media itself. */
export function fetchMediaPart(url: string, init: RequestInit, proxy = ''): Promise<Response> {
  return proxy ? fetch(url, { ...init, proxy } as RequestInit & { proxy: string }) : fetch(url, init)
}

const PROXY_KEYS: Record<string, true> = {
  http_proxy: true,
  https_proxy: true,
  all_proxy: true,
}

export function isProxyEnvKey(key: string): boolean {
  return PROXY_KEYS[key.toLowerCase()] === true
}

export function normalizeHttpProxy(value: string): string {
  const proxy = value.trim()
  if (!proxy) return ''
  try {
    const url = new URL(proxy)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid proxy')
    return url.href.replace(/\/$/, '')
  } catch {
    throw new Error('请填写 HTTP/HTTPS 代理地址，如 http://127.0.0.1:7897；留空使用默认网络')
  }
}

/** Explicit media exception for providers that require the service's exit IP. */
export function mediaDownloadProxy(savedProxy = ''): string {
  return normalizeHttpProxy(process.env.GVS_PROXY?.trim() || savedProxy)
}

/** Saved gateway routing is separate from TMDB and media downloads. The tunnel reads the same proxy itself. */
export async function fetchGateway(url: string, init: RequestInit, savedProxy = ''): Promise<Response> {
  if (isLocalGateway(url)) return fetch(url, init)
  const proxy = normalizeHttpProxy(process.env.GVS_PROXY?.trim() || savedProxy)
  if (!proxy) return fetch(url, init)
  try {
    return await fetch(url, { ...init, proxy } as RequestInit & { proxy: string })
  } catch (e) {
    if (init.signal?.aborted || (e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name))) throw e
    // Do not silently change the gateway's exit IP or expose proxy credentials.
    throw new Error('无法通过代理连接网关，请检查代理是否运行及分流规则（F4 → 连接 → 网关代理）')
  }
}

/** Empty when already re-exec'd (`GVS_PROXY`) or no proxy env is set. */
export function inheritedProxyUrl(env: NodeJS.Dict<string> = process.env): string {
  if (env.GVS_PROXY?.trim()) return ''
  for (const [k, v] of Object.entries(env)) {
    if (!v?.trim() || !isProxyEnvKey(k)) continue
    return v.trim()
  }
  return ''
}

export function envWithoutProxy(
  env: NodeJS.Dict<string> = process.env,
  proxy: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isProxyEnvKey(k)) continue
    out[k] = v
  }
  out.GVS_PROXY = proxy
  return out
}

/** Gateway / TMDB: explicit proxy, fall back to direct. CDN must not call this. */
export async function fetchRemote(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = process.env.GVS_PROXY?.trim() ?? ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* treat as remote */
  }
  if (!proxy || host === '127.0.0.1' || host === 'localhost' || host === '::1') return fetch(url, init)
  try {
    return await fetch(url, { ...init, proxy } as RequestInit & { proxy: string })
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e
    return fetch(url, init)
  }
}

/** An explicit TMDB proxy must never fall back to a direct request. */
export function fetchTmdb(url: string, init: RequestInit & { proxy?: string } = {}): Promise<Response> {
  return init.proxy ? fetch(url, init) : fetchRemote(url, init)
}

/** Returns after a no-op. Re-exec path never returns: it exits with the child. */
export async function reexecWithoutProxy(): Promise<void> {
  const found = inheritedProxyUrl()
  if (!found) return
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: envWithoutProxy(process.env, found),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit((await child.exited) ?? 0)
}
