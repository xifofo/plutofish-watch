/** 下载器与目录监控器共用的来源标签、规格解析和候选匹配。 */
import type { ReleaseOption } from './release-selection'

export type ReleaseSource = { platform?: string; type?: string }
export const releaseTypes = ['WEB-DL', 'WEBRip', 'BluRay', 'REMUX', 'HDTV', 'DVD'] as const
const platforms: Record<string, string> = {
  YK: 'YOUKU', YOUKU: 'YOUKU', 优酷: 'YOUKU', TENCENT: 'TX', 腾讯: 'TX', TX: 'TX',
  IQ: 'IQ', IQIYI: 'IQIYI', 爱奇艺: 'IQIYI', BILIBILI: 'BILI', BILI: 'BILI',
  MGTV: 'MGTV', 芒果: 'MGTV', MIGU: 'MIGU', HG: 'HG', HGO: 'HGO', DY: 'DY',
  MEWATCH: 'MEWATCH', HAMI: 'HAMI', FRIDAY: 'FRIDAY', LINETV: 'LINETV', DSNP: 'DSNP',
  NETFLIX: 'NF', NF: 'NF', AMAZON: 'AMZN', AMZN: 'AMZN', ATVP: 'ATVP', HBO: 'HBO', WEB: 'WEB',
}
export const normalizePlatform = (value = '') => platforms[value.trim().toUpperCase()] ?? value.trim().toUpperCase()
export const normalizeRange = (value = '') => ({ SDR: 'SDR', HDR: 'HDR10', HDR10: 'HDR10', HLG: 'HLG', DV: 'DV', DOVI: 'DV', DOLBYVISION: 'DV' } as Record<string, string>)[value.toUpperCase()]
export const videoCodec = (value = '') => ({ H264: 'AVC', X264: 'AVC', AVC: 'AVC', H265: 'HEVC', X265: 'HEVC', HEVC: 'HEVC', AV1: 'AV1', VP9: 'VP9' } as Record<string, string>)[value.toUpperCase().replace('.', '')]
export const audioCodec = (value = '') => ({ AAC: 'AAC', AC3: 'DD', DD: 'DD', EAC3: 'DDP', 'E-AC3': 'DDP', DDP: 'DDP', DCA: 'DTS', DTS: 'DTS', TRUEHD: 'TRUEHD', MLP: 'TRUEHD', FLAC: 'FLAC' } as Record<string, string>)[value.toUpperCase()]

/** 只在技术规格之后识别制作组，保留大小写、点号和横线；技术标签里的横线不是组名边界。 */
export function splitReleaseGroup(name: string): { specs: string; group: string } {
  const resolution = [...name.matchAll(/(?:^|[. _])(\d{3,4}p)(?=[. _-]|$)/gi)].at(-1)
  const marker = /(?:^|[. _])(WEB[ ._-]?(?:DL|RIP)|BLU[ ._-]?RAY|REMUX|HDTV|DVD|AVC|HEVC|H\.?26[45]|X26[45]|AV1|VP9)(?=[. _-]|$)/i.exec(name)
  const start = resolution?.index ?? marker?.index
  if (start === undefined) return { specs: name, group: '' }
  const technical = name.slice(start).replace(/WEB[ ._-]?(?:DL|RIP)|BLU-RAY|DTS-(?:HD|X)|E-?AC-?3|AC-3/gi, tag => tag.replace(/-/g, '.'))
  const dash = technical.indexOf('-')
  if (dash < 0 || !name.slice(start + dash + 1).trim()) return { specs: name, group: '' }
  return { specs: name.slice(0, start + dash), group: name.slice(start + dash + 1).trim() }
}

function normalize(name: string) {
  return name.toUpperCase().replace(/H\.?264|X264/g, 'AVC').replace(/H\.?265|X265/g, 'HEVC')
    .replace(/WEB[ ._-]?DL/g, 'WEB-DL').replace(/WEB[ ._-]?RIP/g, 'WEBRIP').replace(/BLU[ ._-]?RAY/g, 'BLURAY')
    .replace(/HDR10\+/g, 'HDR10PLUS').replace(/DD\+/g, 'DDP').replace(/E-?AC-?3/g, 'EAC3').replace(/DTS-HD/g, 'DTS.HD')
    .replace(/[ _\[\]()]+/g, '.').replace(/^\.+|\.+$/g, '')
}
function technical(name: string) {
  const { specs, group } = splitReleaseGroup(name)
  const text = normalize(specs)
  const resolution = [...text.matchAll(/(?:^|\.)(\d{3,4})P(?=\.|$)/g)].at(-1)
  const tail = resolution ? text.slice(resolution.index! + resolution[0].length).replace(/^\./, '') : text
  return { resolution, text, tail, group }
}

/** 文件中的明确声明优先；预设只补缺失字段，绝不隐式推断 WEB-DL。 */
export function releaseSource(name: string, preset: ReleaseSource = {}): ReleaseSource {
  const { tail, resolution, text } = technical(name)
  const marker = /(?:^|\.)(WEB-DL|WEBRIP|BLURAY|HDTV|DVD|REMUX)(?=\.|$)/.exec(tail)
  const type = marker?.[1] ?? /(?:^|\.)(WEB-DL|WEBRIP|BLURAY|HDTV|DVD|REMUX)(?=\.|$)/.exec(text)?.[1]
  const prefix = marker ? tail.slice(0, marker.index).split('.').filter(Boolean) : []
  const adjacent = prefix.at(-1)
  // 未知平台只接受分辨率后紧邻 WEB 标记的位置，避免把片名当平台。
  const explicit = adjacent && /^WEB/.test(type ?? '') && (platforms[adjacent] || (resolution && /^[A-Z][A-Z0-9]{0,19}$/.test(adjacent) && !videoCodec(adjacent) && !normalizeRange(adjacent))) ? adjacent : undefined
  const known = text.split('.').find(token => platforms[token])
  const resolvedType = type ?? (preset.type ? normalize(preset.type) : undefined)
  const platform = /^WEB/.test(resolvedType ?? '') || !resolvedType ? normalizePlatform(explicit ?? known ?? preset.platform) : undefined
  return { platform: platform || undefined, type: releaseTypes.find(t => t.toUpperCase() === resolvedType) }
}

export function sourceReviewReason(source: ReleaseSource): string {
  if (!source.type) return '来源类型不明，请确认来源'
  if (/^WEB/i.test(source.type) && !source.platform) return '来源平台不明，请确认来源'
  return ''
}

export function parseReleaseSpecs(name: string, fallbackHeight?: number) {
  const { tail, resolution, group } = technical(name)
  const marker = /(?:^|\.)(WEB-DL|WEBRIP|BLURAY|HDTV|DVD|REMUX)(?=\.|$)/.exec(tail)
  if (!resolution && (!fallbackHeight || !marker)) return null
  // 无分辨率的文件仍可保留来源标记之后的技术信息；片名不进入特殊规格。
  const text = resolution ? tail : tail.slice(marker!.index + (marker![0].startsWith('.') ? 1 : 0))
  const source = releaseSource(name)
  const codec = /(?:^|\.)(AVC|HEVC|AV1|VP9)(?=\.|$)/.exec(text)?.[1]
  const audio = /(?:^|\.)(AAC|AC3|EAC3|DDP|DD|DTS|TRUEHD|FLAC)(?:\.(\d)\.(\d))?(?=\.|$)/.exec(text)
  const dynamic = /(?:^|\.)(SDR|HDR10|HDR|HLG|DV|DOVI)(?=\.|$)/.exec(text)?.[1]
  const fps = /(?:^|\.)(\d+(?:\.\d+)?)FPS(?=\.|$)/.exec(text)?.[1]
  let rest = text.split('.').filter(token => !source.platform || normalizePlatform(token) !== source.platform).join('.')
  for (const pattern of [
    /(?:^|\.)(WEB-DL|WEBRIP|BLURAY|HDTV|DVD)(?=\.|$)/g,
    /(?:^|\.)(AVC|HEVC|AV1|VP9|SDR|HDR10|HDR|HLG|DV|DOVI)(?=\.|$)/g,
    /(?:^|\.)(AAC|AC3|EAC3|DDP|DD|DTS|TRUEHD|FLAC)(?:\.\d\.\d)?(?=\.|$)/g,
    /(?:^|\.)(\d+(?:\.\d+)?)FPS(?=\.|$)/g,
  ]) rest = rest.replace(pattern, '.')
  const extras = rest.split('.').filter(t => t && !(source.type === 'REMUX' && t === 'REMUX')).sort().join('.')
  return { height: resolution ? Number(resolution[1]) : fallbackHeight!, codec, ...source, group, audio: audio ? audioCodec(audio[1]) : undefined,
    channels: audio?.[2] ? Number(audio[2]) + Number(audio[3]) : undefined,
    range: dynamic ? normalizeRange(dynamic) : undefined, rangeTag: dynamic, fps: fps ? Math.round(Number(fps)) : undefined, extras }
}

/** 两端共用同一匹配规则；下载前预览可缺少编码，成品仍要求完整编码，已知差异始终保留。 */
export function matchingReleases(items: ReleaseOption[], name: string, options: { allowMissingCodec?: boolean } = {}): ReleaseOption[] {
  const expected = parseReleaseSpecs(name)
  if (!expected?.type || (!expected.codec && !options.allowMissingCodec)) return []
  return items.filter(row => {
    if (row.status === 'unpublished') return false
    const actual = parseReleaseSpecs(row.name)
    if (!actual?.codec || actual.height !== expected.height || (expected.codec && actual.codec !== expected.codec) || actual.platform !== expected.platform
      || actual.type !== expected.type || actual.extras !== expected.extras || actual.fps !== expected.fps
      || actual.group.toUpperCase() !== expected.group.toUpperCase()) return false
    const resolution = /^(\d{3,4})p$/i.exec(row.resolution.trim())
    if (resolution && Number(resolution[1]) !== expected.height) return false
    const range = normalizeRange(row.dynamicRange) ?? actual.range ?? 'SDR'
    if (range !== (expected.range ?? 'SDR') || (actual.range && actual.range !== range && !(actual.rangeTag === 'HDR' && range === 'HLG'))) return false
    return (!actual.audio || !expected.audio || actual.audio === expected.audio)
      && (!actual.channels || !expected.channels || actual.channels === expected.channels)
  })
}
