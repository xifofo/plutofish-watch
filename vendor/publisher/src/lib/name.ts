import { join } from 'node:path'
import type { MediaSpecs } from './actual-version.ts'

export type MediaKind = 'show' | 'movie' | 'short'

export type Naming = {
  kind: MediaKind
  title: string
  nameDots: string
  /** Filename-only TMDB English/Chinese title pinned when the task is created. */
  filenameTitle?: string
  /** Absent on saved legacy queues, which retain their previous filename order. */
  namingOrder?: 'title-year'
  year: number
  season: number
  episode: number
  /** 单集标题，放在季集编号后；电影不使用。 */
  episodeTitle?: string
  height: number
  codec: string
  audio?: string
  /** 电影配音版本，如 英语版 / 国语版。 */
  collection?: string
  edition?: string
  dv?: boolean
  source: string
  group: string
  tmdbId: number
  container: string
}

export function sourceTag(provider: string): string {
  switch (provider) {
    case 'mgtv': return 'MGTV'
    case 'bilibili': return 'BILI'
    case 'migu': return 'MIGU'
    case 'youku': return 'YK'
    case 'tencent': return 'TX'
    case 'iq': return 'IQ'
    case 'hongguo': return 'HG'
    case 'huangguo': return 'HGO'
    case 'douyin': return 'DY'
    case 'iqcn': return 'IQIYI'
    case 'mewatch': return 'MEWATCH'
    case 'hamivideo': return 'HAMI'
    case 'friday': return 'FRIDAY'
    case 'linetv': return 'LINETV'
    case 'dsnp': return 'DSNP'
    default: return provider ? provider.slice(0, 3).toUpperCase() : 'WEB'
  }
}

export function dots(s: string): string {
  let out = ''
  let lastDot = true
  for (const r of s.trim()) {
    if (/[\p{L}\p{N}]/u.test(r)) {
      out += r
      lastDot = false
      continue
    }
    if (!lastDot) {
      out += '.'
      lastDot = true
    }
  }
  out = out.replace(/^\.+|\.+$/g, '')
  return out || 'Untitled'
}

export function sanitizePath(s: string): string {
  let out = ''
  for (const r of s.trim()) {
    if ('/\\:*?"<>|'.includes(r)) out += '_'
    else if (r.charCodeAt(0) >= 32) out += r
  }
  return out.trim()
}

/** Keep a meaningful episode title without repeating the programme name. */
export function episodeTitle(title: string, ...seriesNames: string[]): string {
  const clean = title.trim().replace(/\s+/g, ' ')
  if (!/[\p{L}\p{N}]/u.test(clean)) return ''
  const normalized = dots(clean).toLowerCase()
  return seriesNames.some(name => name.trim() && dots(name).toLowerCase() === normalized) ? '' : clean
}

function fitUtf8(text: string, bytes: number): string {
  let result = ''
  let used = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > bytes) break
    result += ch
    used += size
  }
  return result.replace(/\.+$/, '')
}

/** 本地保存与云端目录创建共用相同的相对目录层级。 */
export function folderSegments(n: Naming): string[] {
  if (n.source === 'HG' || n.source === 'HGO') return [sanitizePath(n.title), `season ${Math.max(n.season, 1)}`]
  if (n.kind === 'short') return [sanitizePath(n.title)]
  let base = n.title.trim() || n.nameDots || 'Untitled'
  if (n.year > 0) base = `${base} (${n.year})`
  if (n.tmdbId > 0) base = `${base} {tmdb-${n.tmdbId}}`
  const parts = [sanitizePath(base)]
  if (n.kind === 'show' && n.season >= 0) parts.push(`Season ${String(n.season).padStart(2, '0')}`)
  if (n.source === 'TX' && n.collection && n.collection !== '正片') parts.push(sanitizePath(n.collection))
  return parts
}

export function folder(n: Naming, outDir: string): string {
  return join(outDir, ...folderSegments(n))
}

/**
 * 真实像素 → 发行命名里的规范档位。片源常见 letterbox / 2:1 画幅，
 * 直接拿高度会写出 `1608p`、`1920p` 这种不存在的档位，所以按长边判：
 * 3840×1920（4K 2:1）/ 2160×3840（竖屏 4K）→ 2160p。
 * 仅有高度时保留旧任务的档位推断。
 */
export function tierHeight(width: number, height: number): number {
  const rawWidth = Number.isFinite(width) ? width : 0
  const h = Number.isFinite(height) ? height : 0
  const w = rawWidth > 0 && h > 0 ? Math.max(rawWidth, h) : rawWidth
  if (w >= 3400) return 2160
  if (w >= 2300) return 1440
  if (w >= 1700) return 1080
  if (w >= 1100) return 720
  if (w >= 750) return 480
  if (w >= 550) return 360
  if (h >= 1600) return 2160
  if (h >= 1300) return 1440
  if (h >= 1000) return 1080
  if (h >= 760) return 1080
  if (h >= 640) return 720
  if (h >= 400) return 480
  if (h > 0) return 360
  return 0
}

export function filename(n: Naming): string {
  const parts: string[] = []
  const subtitle = episodeTitle(n.episodeTitle || '', n.title, n.nameDots, n.filenameTitle || '')
  let subtitleIndex = -1
  const addSubtitle = () => {
    if (!subtitle) return
    subtitleIndex = parts.length
    parts.push(dots(subtitle))
  }
  if (n.kind === 'short') {
    parts.push(n.filenameTitle ? dots(n.filenameTitle) : n.title.trim() || 'episode')
    if (n.season > 0 || n.episode > 0) {
      parts.push(`S${String(Math.max(n.season, 1)).padStart(2, '0')}E${String(Math.max(n.episode, 1)).padStart(2, '0')}`)
      addSubtitle()
    }
  } else {
    parts.push(n.filenameTitle ? dots(n.filenameTitle) : n.nameDots || dots(n.title))
    if (n.namingOrder === 'title-year' && n.year > 0) parts.push(String(n.year))
    if (n.kind === 'show') {
      const season = n.namingOrder === 'title-year' ? Math.max(n.season, 0) : Math.max(n.season, 1)
      parts.push(`S${String(season).padStart(2, '0')}E${String(Math.max(n.episode, 1)).padStart(2, '0')}`)
      addSubtitle()
    }
    if (n.namingOrder !== 'title-year' && n.year > 0) parts.push(String(n.year))
    if (n.kind === 'movie' && n.edition) parts.push(dots(n.edition))
  }
  const tier = tierHeight(0, n.height)
  if (tier > 0) parts.push(`${tier}p`)
  if (n.source) parts.push(n.source)
  parts.push('WEB-DL')
  if (n.codec) parts.push(n.codec)
  if (n.dv) parts.push('DV')
  if (n.audio) parts.push(n.audio)
  const ext = n.container || 'mkv'
  const g = n.group.trim()
  const suffix = `${g ? `-${sanitizePath(g)}` : ''}.${ext}`
  if (subtitleIndex >= 0) {
    // Limit only the added subtitle; reserve room for .timing.json sidecars
    // within the usual 255-byte filename limit, without losing SxxExx or codec.
    const base = sanitizePath(parts.filter((_, i) => i !== subtitleIndex).join('.')) + suffix
    const room = Math.max(0, 240 - Buffer.byteLength(base, 'utf8') - 1)
    const fitted = fitUtf8(parts[subtitleIndex]!, room)
    if (fitted) parts[subtitleIndex] = fitted
    else parts.splice(subtitleIndex, 1)
  }
  if (n.namingOrder === 'title-year') {
    const rest = sanitizePath(parts.slice(1).join('.')) + suffix
    parts[0] = fitUtf8(parts[0]!, Math.max(4, 240 - Buffer.byteLength(rest, 'utf8') - 1))
  }
  const result = sanitizePath(parts.join('.')) + suffix
  if (n.namingOrder === 'title-year' && Buffer.byteLength(result, 'utf8') > 240) throw new Error('文件名过长')
  return result
}

/** 文件名和发布版本共用已确认的动态范围、帧率及音视频规格标签。 */
export function mediaFilenameTags(media: MediaSpecs, options: { preview?: boolean } = {}): string[] {
  const parts: string[] = []
  if (media.dynamicRange === 'DV') parts.push('DV')
  else if (media.dynamicRange === 'HDR' || media.dynamicRange === 'HDR10') parts.push('HDR')
  else if (media.dynamicRange === 'HLG') parts.push('HLG')
  else if (media.dynamicRange === 'SDR') parts.push('SDR')
  const fps = Math.round(media.fps || 0)
  if (fps >= 48) parts.push(`${fps}fps`)
  const codec = (media.codec || '').toLowerCase()
  const videoCodec = ({ h264: 'AVC', h265: 'HEVC', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9' } as Record<string, string>)[codec]
    || (codec && codec !== 'unknown' ? codec.toUpperCase() : '')
  if (videoCodec) parts.push(videoCodec)
  if (media.audio?.codec && (options.preview || (media.audio.status === 'confirmed' && media.audio.channels))) {
    const a = media.audio
    const audioCodec = ({ aac: 'AAC', ac3: 'AC3', eac3: 'DDP', dts: 'DTS', dca: 'DTS', dtsx: 'DTS.X', truehd: 'TrueHD', mlp: 'TrueHD', flac: 'FLAC' } as Record<string, string>)[a.codec!.toLowerCase()] || a.codec!.toUpperCase()
    // A 10-channel DTS:X count does not establish a 10.0 speaker layout.
    const channels = a.channels ? ({ 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' } as Record<number, string>)[a.channels]
      || (a.codec === 'dtsx' ? `${a.channels}ch` : `${a.channels}.0`) : ''
    parts.push([audioCodec, channels, a.atmos ? 'Atmos' : ''].filter(Boolean).join('.'))
  }
  return parts
}

/** New measured outputs use finished specs; the legacy filename remains the failure fallback. */
export function completedFilename(n: Naming, media: MediaSpecs, marker?: 'HQ' | 'MAXPLUS' | 'EDR',
  options: { preview?: boolean } = {}): string {
  const parts = [dots(n.filenameTitle || n.title || n.nameDots)]
  if (n.namingOrder === 'title-year' && n.year > 0) parts.push(String(n.year))
  const subtitle = episodeTitle(n.episodeTitle || '', n.title, n.nameDots, n.filenameTitle || '')
  let subtitleIndex = -1
  if (n.kind === 'show') {
    const season = Number.isSafeInteger(n.season) && n.season >= 0 ? n.season : 1
    parts.push(`S${String(season).padStart(2, '0')}E${String(Math.max(n.episode, 1)).padStart(2, '0')}`)
    if (subtitle) { subtitleIndex = parts.length; parts.push(dots(subtitle)) }
  }
  if (n.namingOrder !== 'title-year' && n.year > 0) parts.push(String(n.year))
  if (n.kind === 'movie' && n.edition) parts.push(dots(n.edition))
  const height = tierHeight(media.width || 0, media.height || 0)
  if (height) parts.push(`${height}p`)
  if (n.source) parts.push(n.source === 'YK' ? 'YOUKU' : n.source)
  parts.push('WEB-DL')
  if (marker) parts.push(marker)
  parts.push(...mediaFilenameTags(media, options))
  const suffix = `${n.group.trim() ? `-${sanitizePath(n.group.trim())}` : ''}.${n.container || 'mkv'}`
  // Reserve space for sidecars and retain the season/episode and technical suffix.
  for (const index of [subtitleIndex, 0]) {
    if (index < 0) continue
    const excess = Buffer.byteLength(parts.join('.') + suffix, 'utf8') - 240
    if (excess <= 0) break
    parts[index] = fitUtf8(parts[index]!, Math.max(index === 0 ? 4 : 0, Buffer.byteLength(parts[index]!, 'utf8') - excess))
  }
  const result = sanitizePath(parts.filter(Boolean).join('.')) + suffix
  if (Buffer.byteLength(result, 'utf8') > 240) throw new Error('文件名过长')
  return result
}
