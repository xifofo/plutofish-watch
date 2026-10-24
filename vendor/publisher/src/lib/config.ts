import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export type FileConfig = {
  host: string
  key: string
  /** Optional HTTP(S) proxy for gateway API requests. */
  gatewayProxy?: string
  /** Desktop service proxy override; empty follows the system proxy. Independent of TUI routing. */
  desktopProxy?: string
  outDir: string
  releaseGroup: string
  /** Legacy task/short-video naming preference; current movie/series templates omit episode titles. */
  includeEpisodeTitle?: boolean
  tmdbKey: string
  tmdbLang: string
  /** Optional HTTP(S) proxy used only for TMDB requests. */
  tmdbProxy?: string
  /** @deprecated yk_sign 由网关按 API key 绑定；字段仅作启动迁移读取，成功推送后清空。 */
  youkuSign: string
  tencentMode?: "cookie" | "web" | "app" | "tv"
  /** Bind TV operations and record real client metrics locally on the gateway. */
  tencentObservations?: boolean
  /** Actual native producer JSONL; read only in the TUI/Electron main process. */
  tencentNativeEventFile?: string
  /** Mirrored App events remain preview-only even when this is send. */
  tencentNativeEventMode?: 'off' | 'preview' | 'send'
  /** off=disabled; fixture=phone-free local templates; file=external JSONL producer (research/phone). */
  tencentNativeEventCollect?: 'off' | 'fixture' | 'file'
  /** Crunchyroll：调用方自持的 refresh_token（网关不落盘；play/manifest/license 逐次携带）。 */
  crunchyrollToken?: string
  /** Hami Web and TV are separate gateway sessions. */
  hamiClient?: 'tv' | 'web'
  tencentTVDevice?: string
  tencentTVQUA?: string
  tencentTVVersion?: string
  /** @deprecated 瘦客户端：凭证由网关加密托管；字段仅作启动迁移读取，成功推送后清空。 */
  tencentCookie: string
  /** @deprecated 抖音网页 Cookie 改由网关号池托管；随请求的 Dy-Cookie 头仍支持外部脚本。 */
  douyinCookie?: string
  /** @deprecated IQ Cookie 改由网关按 API key 持久化。 */
  iqCookie?: string
  /** Advanced source deviceId + certificate digest; server certificate normally supplies it. */
  iqProfile?: string
  /** Official IQ CDN preference; never fabricates a host or signed URL. */
  iqCdn?: 'auto' | 'akamai' | 'bscloud' | 'zenlayer'
  /** Opt-in: probe play with encode=all (风控敏感，默认关) */
  tencentEncodeAll?: boolean
  /** Opt-in: catalog probe with source=1 / 原画 (默认关，易触发权益锁) */
  tencentProbeSource?: boolean
  /** Opt-in: catalog probe with caption=all (默认关；默认只探 soft) */
  tencentCaptionAll?: boolean
  hongguoMerge: boolean
  hongguoNfo: boolean
  hongguoFmt: string
  /** 黄果（HLS + AES-128）输出：是否写 NFO、封装容器。 */
  huangguoNfo: boolean
  huangguoFmt: string
  /** Parallel connections per download (分片并发 / Range 并发). */
  threads: number
  /**
   * Per-job working folder for .partN / RE scratch / decrypt intermediates.
   * Empty means `join(outDir, '.gvs-tmp')` — i.e. keep the bytes on the same
   * volume as the library instead of the system temp drive.
   */
  tmpDir: string
  /** Desktop app UI preferences (sidebar, provider order/visibility, recent searches). Ignored by the TUI. */
  desktopUi?: Record<string, unknown>
}

export const MIN_THREADS = 1
export const MAX_THREADS = 16

export function clampThreads(n: unknown): number {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 4
  return Math.min(MAX_THREADS, Math.max(MIN_THREADS, v))
}

export type DriveFree = { root: string; free: number }

/** Untouched historical default. Relative to the process cwd, so an installed app writes onto C:. */
export function isLegacyDownloads(p: string): boolean {
  const n = p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n === 'downloads' || n === './downloads'
}

/**
 * Prefer the fixed drive with the most free space that is not the system drive.
 * Falls back to the user's Videos folder when that is the only disk.
 */
export function chooseOutDir(opts: {
  platform: string
  home: string
  systemDrive: string
  drives: DriveFree[]
}): string {
  if (opts.platform === 'win32') {
    const sys = opts.systemDrive.replace(/[\\/]+$/, '').toUpperCase()
    const best = opts.drives
      .filter((d) => d.free > 0 && d.root.replace(/[\\/]+$/, '').toUpperCase() !== sys)
      .sort((a, b) => b.free - a.free)[0]
    if (best) return `${best.root.replace(/[\\/]+$/, '')}\\GVS`
  }
  return join(opts.home, 'Videos', 'GVS')
}

function windowsFixedDrives(): DriveFree[] {
  try {
    const text = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $_.DeviceID + "|" + [int64]$_.FreeSpace }',
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    const drives = text.split(/\r?\n/).flatMap((line) => {
      const [id, free] = line.trim().split('|')
      if (!id || !/^[A-Za-z]:$/.test(id)) return []
      return [{ root: `${id}\\`, free: Number(free) || 0 }]
    })
    if (drives.length) return drives
  } catch {
    // statfs fallback below
  }
  const found: DriveFree[] = []
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`
    try {
      const s = statfsSync(root)
      const free = Number(s.bavail) * Number(s.bsize)
      if (free > 0) found.push({ root, free })
    } catch {
      // drive letter is empty
    }
  }
  return found
}

let cachedOutDir: string | undefined

/** Absolute default library folder. Cached for the process. */
export function preferredOutDir(): string {
  if (cachedOutDir) return cachedOutDir
  const home = homedir()
  if (process.platform !== 'win32') {
    cachedOutDir = join(home, 'Videos', 'GVS')
    return cachedOutDir
  }
  cachedOutDir = chooseOutDir({
    platform: 'win32',
    home,
    systemDrive: process.env.SystemDrive || 'C:',
    drives: windowsFixedDrives(),
  })
  return cachedOutDir
}

/** Store an absolute directory. Empty input stays empty so the caller can reject it. */
export function normalizeOutDir(input: string): string {
  const v = input.trim()
  return v ? resolve(v) : ''
}

/**
 * Fill a missing or legacy `./downloads` with the preferred absolute folder.
 * A relative path the user typed is resolved once so later launches do not follow cwd back onto C:.
 * Returns whether `outDir` changed.
 */
export function ensureOutDir(cfg: { outDir: string }, fallback?: string): boolean {
  const cur = (cfg.outDir || '').trim()
  if (cur && !isLegacyDownloads(cur)) {
    if (!isAbsolute(cur)) {
      cfg.outDir = resolve(cur)
      return cfg.outDir !== cur
    }
    if (cfg.outDir !== cur) {
      cfg.outDir = cur
      return true
    }
    return false
  }
  cfg.outDir = fallback ?? preferredOutDir()
  return true
}

export function defaultConfig(): FileConfig {
  return {
    host: 'http://127.0.0.1:8080',
    key: '',
    gatewayProxy: '',
    desktopProxy: '',
    outDir: '',
    releaseGroup: 'PFWEB',
    includeEpisodeTitle: true,
    tmdbKey: '',
    tmdbLang: 'zh-CN',
    tmdbProxy: '',
    youkuSign: '',
    tencentCookie: '',
    hongguoMerge: true,
    hongguoNfo: true,
    hongguoFmt: 'mkv',
    huangguoNfo: true,
    huangguoFmt: 'mkv',
    threads: 4,
    tmpDir: '',
  }
}

export function configPath(): string {
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'gvs', 'tui.json')
}

export function loadConfig(): FileConfig {
  const cfg = defaultConfig()
  let existed = true
  try {
    Object.assign(cfg, JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<FileConfig>)
  } catch {
    existed = false
  }
  delete (cfg as unknown as Record<string, unknown>).iqKeys
  // Point a single run somewhere else without touching the saved config, e.g.
  // `GVS_HOST=http://127.0.0.1:8080 bun run dev` against a local gateway build.
  if (process.env.GVS_HOST) cfg.host = process.env.GVS_HOST
  if (process.env.GVS_KEY) cfg.key = process.env.GVS_KEY
  if (process.env.GVS_TENCENT_OBSERVE) cfg.tencentObservations = process.env.GVS_TENCENT_OBSERVE === '1'
  if (process.env.GVS_TENCENT_NATIVE_COLLECT === 'off' || process.env.GVS_TENCENT_NATIVE_COLLECT === 'fixture' || process.env.GVS_TENCENT_NATIVE_COLLECT === 'file') {
    cfg.tencentNativeEventCollect = process.env.GVS_TENCENT_NATIVE_COLLECT
  }
  cfg.host = (cfg.host || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  const outChanged = ensureOutDir(cfg)
  if (!cfg.releaseGroup) cfg.releaseGroup = 'PFWEB'
  cfg.includeEpisodeTitle = cfg.includeEpisodeTitle !== false
  if (!cfg.hongguoFmt) cfg.hongguoFmt = 'mkv'
  if (!cfg.huangguoFmt) cfg.huangguoFmt = 'mkv'
  delete (cfg as unknown as Record<string, unknown>).ffmpeg
  if (!cfg.tmdbLang) cfg.tmdbLang = 'zh-CN'
  cfg.threads = clampThreads(cfg.threads)
  // '' keeps the default (outDir/.gvs-tmp); anything the user typed is stored
  // absolute so a later launch does not resolve it against the process cwd.
  cfg.tmpDir = typeof cfg.tmpDir === 'string' ? normalizeOutDir(cfg.tmpDir) : ''
  // Remember the resolved folder. An existing absolute outDir is left untouched.
  if (outChanged && existed) {
    try { saveConfig(cfg) } catch { /* keep the in-memory path */ }
  }
  return cfg
}

export function saveConfig(cfg: FileConfig): void {
  const p = configPath()
  mkdirSync(join(p, '..'), { recursive: true })
  const current = { ...cfg } as unknown as Record<string, unknown>
  delete current.iqKeys
  writeFileSync(p, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
}
