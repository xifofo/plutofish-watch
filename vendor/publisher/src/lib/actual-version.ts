import { human } from './util'

/** Only stable, serializable identifiers belong here; never signed URLs or gateway payloads. */
export type StreamVersion = {
  stream?: string; formatId?: string; persona?: string; caption?: string
  /** Tencent's numeric definition code is not a named quality or a format ID. */
  definitionCode?: string
  width?: number; height?: number; fps?: number; codec?: string; estimatedBytes?: number
}
export type ActualVersion = {
  schemaVersion: 1; provider: 'tencent'; vid: string
  selected: StreamVersion; actual: StreamVersion | null
  status: 'confirmed' | 'unknown'
  matchesSelection: 'same' | 'different' | 'unknown'
  addressSource: 'format' | 'default' | 'other'
  evidence: 'format_url' | 'video_metadata' | 'format_filename' | 'ambiguous' | 'unknown'
  recordedAt: string; refreshes: number
  file?: { size: number; fingerprint: { algorithm: 'sha256-samples-v1'; value: string } }
  media?: MediaSpecs
}
export type MediaSpecs = {
  status: 'probed' | 'unavailable'; width?: number; height?: number; codec?: string
  fps?: number; durationSeconds?: number; videoBitrate?: number; dynamicRange?: string
  /** Only the default audio retained in the completed container, never the highest codec in the catalog. */
  audio?: {
    status: 'confirmed' | 'ambiguous' | 'none'; index?: number; trackId?: number
    codec?: string; channels?: number; atmos?: boolean
    evidence?: 'container' | 'mp4_enabled' | 'mux_order' | 'single_track'
  }
}
/** Measured file information shared by providers, without Tencent rendition identity. */
export type CompletedMedia = { media: MediaSpecs; file: { size: number } }
type FileMedia = { media?: MediaSpecs; file?: { size: number } }
export type GVSActualRecord = ActualVersion & {
  file: { size: number; fingerprint: { algorithm: 'sha256-samples-v1'; value: string } }
  media: MediaSpecs
}

type Raw = Record<string, unknown>
const obj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const identifier = (v: unknown): string => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  return /^[\w\u4e00-\u9fff.+|-]{1,96}$/u.test(s) ? s : ''
}
const positive = (v: unknown): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
const caption = (v: unknown): string => {
  const s = identifier(v).toLowerCase()
  return ['硬', '硬字幕', 'hard', 'burn'].includes(s) ? 'hard' : ['软', '软字幕', 'soft', 'srt'].includes(s) ? 'soft' : s
}

function version(raw: Raw, video = false): StreamVersion {
  const result: StreamVersion = {}
  const defn = identifier(raw.defn || raw.name).toLowerCase()
  const fields = {
    stream: /^\d+$/.test(defn) ? '' : defn,
    definitionCode: /^\d+$/.test(defn) ? defn : '',
    formatId: identifier(raw.format_id || raw.formatId || (!video ? raw.id : '')),
    persona: identifier(raw.persona), caption: caption(raw.caption), codec: identifier(raw.vencoding || raw.codec || raw.profile),
  }
  for (const [key, value] of Object.entries(fields)) if (value) (result as Raw)[key] = value
  const numbers = { width: positive(raw.width), height: positive(raw.height), fps: positive(raw.vfps || raw.fps), estimatedBytes: positive(raw.fs || raw.size) }
  for (const [key, value] of Object.entries(numbers)) if (value) (result as Raw)[key] = value
  return result
}

function identity(v: StreamVersion): string {
  // Some catalogs list uhd and suhd as aliases of the same physical format.
  const stream = v.formatId && ['uhd', 'suhd'].includes(v.stream || '') ? 'uhd/suhd' : v.stream
  return JSON.stringify([v.formatId || '', v.persona || '', stream || '', v.caption || '', v.definitionCode || '',
    v.width || 0, v.height || 0, v.fps || 0, v.codec || '', v.estimatedBytes || 0])
}

function sameField(key: 'formatId' | 'persona' | 'stream' | 'caption', a: StreamVersion, b: StreamVersion): boolean {
  if (a[key]?.toLowerCase() === b[key]?.toLowerCase()) return true
  return key === 'stream' && !!a.formatId && a.formatId === b.formatId &&
    ['uhd', 'suhd'].includes(a.stream || '') && ['uhd', 'suhd'].includes(b.stream || '')
}

function compare(selected: StreamVersion, actual: StreamVersion | null): ActualVersion['matchesSelection'] {
  if (!actual) return 'unknown'
  const fields = ['formatId', 'persona', 'stream', 'caption'] as const
  let missing = false, compared = false
  for (const key of fields) {
    if (!selected[key]) continue
    if (!actual[key]) { missing = true; continue }
    compared = true
    if (!sameField(key, selected, actual)) return 'different'
  }
  return compared && !missing ? 'same' : 'unknown'
}

/** Infer identity from the URL actually picked, never from the requested ID or catalog presence alone. */
export function tencentActualVersion(
  data: Raw, url: string, source: ActualVersion['addressSource'],
  selected: StreamVersion, vid: string, refreshes = 0,
): ActualVersion {
  selected = version({ defn: selected.stream, format_id: selected.formatId, persona: selected.persona, caption: selected.caption })
  const rows = Array.isArray(data.formats) ? data.formats.filter(obj) : []
  const video = obj(data.video) ? data.video : {}
  const explicit = version(video, true)
  const videoMatches = !!url && (video.url === url || video.playlist_url === url || (Array.isArray(video.urls) && video.urls.includes(url)))
  let actual: StreamVersion | null = null
  let evidence: ActualVersion['evidence'] = 'unknown'
  const adopt = (candidates: Raw[], via: ActualVersion['evidence']): boolean => {
    if (!candidates.length) return false
    const versions = candidates.map(row => version(row))
    if (new Set(versions.map(identity)).size > 1) { evidence = 'ambiguous'; return true }
    actual = versions[0]!
    evidence = via
    return true
  }
  if (url && !adopt(rows.filter(row => row.url === url || row.playlist_url === url), 'format_url')) {
    if (videoMatches && (explicit.formatId || explicit.stream || explicit.definitionCode)) {
      actual = explicit
      if (explicit.formatId && !explicit.stream) {
        const streams = [...new Set(rows.map(row => version(row)).filter(v => v.formatId === explicit.formatId).map(v => v.stream).filter(Boolean))]
        if (streams.length === 1) actual = { ...explicit, stream: streams[0] }
        else if (streams.length === 2 && streams.every(s => ['uhd', 'suhd'].includes(s!))) actual = { ...explicit, stream: 'uhd' }
      }
      evidence = 'video_metadata'
    } else {
      // A catalog filename must occur as a complete URL path component; numeric substrings are insufficient.
      let components: string[] = []
      try { components = new URL(url).pathname.split('/').map(decodeURIComponent) } catch { /* opaque address */ }
      adopt(rows.filter(row => typeof row.fname === 'string' && row.fname && components.includes(row.fname)), 'format_filename')
    }
  }
  if (actual && videoMatches && (explicit.formatId || explicit.stream) &&
    (['formatId', 'persona', 'stream', 'caption'] as const).some(key =>
      actual![key] && explicit[key] && !sameField(key, actual!, explicit))) {
    actual = null
    evidence = 'ambiguous'
  }
  return {
    schemaVersion: 1, provider: 'tencent', vid: identifier(vid), selected,
    actual, status: actual?.formatId ? 'confirmed' : 'unknown',
    matchesSelection: compare(selected, actual), addressSource: source, evidence,
    recordedAt: new Date().toISOString(), refreshes,
  }
}

export function actualVersionText(record: ActualVersion): string {
  if (record.status !== 'confirmed' || !record.actual?.formatId) return '实际版本未确认'
  const v = record.actual!
  const label = [v.stream, v.formatId ? `格式 ${v.formatId}` : '', v.persona].filter(Boolean).join(' · ')
  const match = record.matchesSelection === 'different' ? '与所选版本不同' : record.matchesSelection === 'same' ? '与所选版本一致' : '未确认是否与所选版本一致'
  return `实际版本：${label}；${match}`
}

/** Download rows show measured file specs; rendition identity stays in the diagnostic record. */
export function actualVersionSummary<T extends FileMedia>(record: T): string {
  const media = record.media
  const specs = media?.status === 'probed' ? [media.width && media.height ? `${media.width}×${media.height}` : '',
    media.codec?.toUpperCase(), media.fps ? `${Number(media.fps.toFixed(2))}fps` : '', media.dynamicRange,
    media.videoBitrate ? `视频 ${(media.videoBitrate / 1_000_000).toFixed(2)} Mbps` : ''] : []
  if (record.file && Number.isFinite(record.file.size) && record.file.size > 0) specs.push(human(record.file.size))
  return specs.filter(Boolean).join(' · ')
}

export function actualVersionDetail<T extends FileMedia>(record: T): string {
  const details = [actualVersionSummary(record)]
  if (record.media?.status === 'probed') details.push('视频规格由本机读取。')
  if (record.file && Number.isFinite(record.file.size) && record.file.size > 0) details.push('大小为封装完成后的文件大小，包含已保留的音轨和字幕。')
  return details.filter(Boolean).join('\n')
}
