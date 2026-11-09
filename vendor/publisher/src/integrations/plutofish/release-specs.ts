/** 下载器与目录监控器共用的来源标签、规格解析和候选匹配。 */
import type { ReleaseOption } from './release-selection'
import { audioCodecCode, releaseAudioTokens, releaseVideoTokens, videoCodecCode } from '../../lib/media-codec'

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
export const videoCodec = (value = '') => videoCodecCode(value)
// 实测编码与发布名写法共用 media-codec 的编码表；表外的实测编码按编码名保留。
export const audioCodec = (value = '') => audioCodecCode(value)

/** DTS 子格式在版本名中的写法；横线写法由 splitReleaseGroup 识别为规格，不当作制作组分隔。 */
export const dtsLabel = (variant: string) => variant === 'X' ? 'DTS.X' : `DTS-${variant}`

const audioTokens = releaseAudioTokens.join('|')
const dtsVariants = 'HD\\.MA|HD\\.HRA|HD|X|ES'
// 编码后可跟 DTS 子格式与声道：DDP.5.1、DTS.HD.MA.5.1、DTS.X.10CH。
const audioSource = `(?:^|\\.)(?:(DTS)(?:\\.(${dtsVariants}))?|(${audioTokens}))(?:\\.(\\d)\\.(\\d)|\\.(\\d{1,2})CH)?(?=\\.|$)`
const audioPattern = new RegExp(audioSource)
const videoSource = `(?:^|\\.)(${releaseVideoTokens.join('|')})(?=\\.|$)`
// 发布名常把声道连在编码后（DDP5.1、Opus2.0、DTS-HD.MA5.1），先拆成 DDP.5.1 再识别。
const gluedAudio = new RegExp(`(^|\\.)(DTS\\.(?:${dtsVariants})|${audioTokens})(\\d)\\.(\\d)(?=\\.|$)`, 'g')
// 旧版本名里被拆散的声道碎片（DDP5、单独的 1）不算特殊规格。
const audioFragment = new RegExp(`^(?:\\d+|(?:${audioTokens})\\d)$`)

/** 只在技术规格之后识别制作组，保留大小写、点号和横线；技术标签里的横线不是组名边界。 */
export function splitReleaseGroup(name: string): { specs: string; group: string } {
  const resolution = [...name.matchAll(/(?:^|[. _])(\d{3,4}[pi])(?=[. _-]|$)/gi)].at(-1)
  const marker = /(?:^|[. _])(WEB[ ._-]?(?:DL|RIP)|BLU[ ._-]?RAY|REMUX|HDTV|DVD|AVC|HEVC|H\.?26[456]|X26[456]|AV1|VP[89]|VVC|MPEG-?[12]|XVID|DIVX|VC-?1)(?=[. _-]|$)/i.exec(name)
  const start = resolution?.index ?? marker?.index
  if (start === undefined) return { specs: name, group: '' }
  const technical = name.slice(start).replace(/WEB[ ._-]?(?:DL|RIP)|BLU-RAY|DTS-(?:HD|X|ES)|E-?AC-?3|AC-3|HE-AAC|MPEG-[124H]|VC-1/gi, tag => tag.replace(/-/g, '.'))
  const dash = technical.indexOf('-')
  if (dash < 0 || !name.slice(start + dash + 1).trim()) return { specs: name, group: '' }
  return { specs: name.slice(0, start + dash), group: name.slice(start + dash + 1).trim() }
}

function normalize(name: string) {
  return name.toUpperCase().replace(/H\.?264|X264/g, 'AVC').replace(/H\.?265|X265/g, 'HEVC').replace(/H\.?266|X266/g, 'VVC')
    .replace(/MPEG-([124H])/g, 'MPEG$1').replace(/VC-1/g, 'VC1')
    .replace(/WEB[ ._-]?DL/g, 'WEB-DL').replace(/WEB[ ._-]?RIP/g, 'WEBRIP').replace(/BLU[ ._-]?RAY/g, 'BLURAY')
    .replace(/HDR10\+/g, 'HDR10PLUS').replace(/DD\+/g, 'DDP').replace(/E-?AC-?3/g, 'EAC3').replace(/AC-3/g, 'AC3').replace(/HE-?AAC(?:V2)?/g, 'AAC')
    .replace(/DTS-?HD/g, 'DTS.HD').replace(/DTS[-:]?X(?![A-Z])/g, 'DTS.X').replace(/DTS-ES/g, 'DTS.ES')
    .replace(/[ _\[\]()]+/g, '.').replace(/^\.+|\.+$/g, '')
    .replace(gluedAudio, '$1$2.$3.$4')
    // DDPA5.1 是 DDP 5.1 Atmos 的简写；Atmos 写在编码与声道之间时挪到声道后。
    .replace(/(^|\.)DDPA(?:(\d)\.(\d))?(?=\.|$)/g, (_, start: string, a?: string, b?: string) => `${start}DDP${a ? `.${a}.${b}` : ''}.ATMOS`)
    .replace(/(^|\.)(TRUEHD|DDP|EAC3)\.ATMOS\.(\d)\.(\d)(?=\.|$)/g, '$1$2.$3.$4.ATMOS')
}
function technical(name: string) {
  const { specs, group } = splitReleaseGroup(name)
  const text = normalize(specs)
  const resolution = [...text.matchAll(/(?:^|\.)(\d{3,4})([PI])(?=\.|$)/g)].at(-1)
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
  const codec = new RegExp(videoSource).exec(text)?.[1]
  const audio = audioPattern.exec(text)
  const dynamic = /(?:^|\.)(SDR|HDR10|HDR|HLG|DV|DOVI)(?=\.|$)/.exec(text)?.[1]
  const fps = /(?:^|\.)(\d+(?:\.\d+)?)FPS(?=\.|$)/.exec(text)?.[1]
  let rest = text.split('.').filter(token => !source.platform || normalizePlatform(token) !== source.platform).join('.')
  for (const pattern of [
    /(?:^|\.)(WEB-DL|WEBRIP|BLURAY|HDTV|DVD)(?=\.|$)/g,
    new RegExp(videoSource, 'g'),
    /(?:^|\.)(SDR|HDR10|HDR|HLG|DV|DOVI)(?=\.|$)/g,
    new RegExp(audioSource, 'g'),
    /(?:^|\.)(\d+(?:\.\d+)?)FPS(?=\.|$)/g,
  ]) rest = rest.replace(pattern, '.')
  let tokens = rest.split('.').filter(t => t && !(source.type === 'REMUX' && t === 'REMUX') && !audioFragment.test(t))
  let audioVariant = audio?.[2]
  // 旧版本名把 DTS-HD.MA 拆成了 HD、MA 两个特殊标签，读回时并入音轨。
  if (audio?.[1] && !audioVariant && tokens.includes('HD')) {
    audioVariant = tokens.includes('MA') ? 'HD.MA' : tokens.includes('HRA') ? 'HD.HRA' : 'HD'
    tokens = tokens.filter(t => !audioVariant!.split('.').includes(t))
  }
  const channels = audio?.[4] ? Number(audio[4]) + Number(audio[5]) : audio?.[6] ? Number(audio[6]) : undefined
  return { height: resolution ? Number(resolution[1]) : fallbackHeight!, scan: resolution?.[2] === 'I' ? 'i' as const : undefined,
    codec: codec ? videoCodec(codec) : undefined, ...source, group, audio: audio ? audioCodec(audio[1] ?? audio[3]) : undefined, audioVariant, channels,
    range: dynamic ? normalizeRange(dynamic) : undefined, rangeTag: dynamic, fps: fps ? Math.round(Number(fps)) : undefined, extras: tokens.sort().join('.') }
}

/** 两端共用同一匹配规则；下载前预览可缺少编码，成品仍要求完整编码，已知差异始终保留。 */
export function matchingReleases(items: ReleaseOption[], name: string, options: { allowMissingCodec?: boolean } = {}): ReleaseOption[] {
  const expected = parseReleaseSpecs(name)
  if (!expected?.type || (!expected.codec && !options.allowMissingCodec)) return []
  return items.filter(row => {
    if (row.status === 'unpublished') return false
    const actual = parseReleaseSpecs(row.name)
    if (!actual?.codec || actual.height !== expected.height || actual.scan !== expected.scan || (expected.codec && actual.codec !== expected.codec)
      || actual.platform !== expected.platform || actual.type !== expected.type || actual.extras !== expected.extras || actual.fps !== expected.fps
      || actual.group.toUpperCase() !== expected.group.toUpperCase() || (actual.audioVariant ?? '') !== (expected.audioVariant ?? '')) return false
    const resolution = /^(\d{3,4})[pi]$/i.exec(row.resolution.trim())
    if (resolution && Number(resolution[1]) !== expected.height) return false
    const range = normalizeRange(row.dynamicRange) ?? actual.range ?? 'SDR'
    if (range !== (expected.range ?? 'SDR') || (actual.range && actual.range !== range && !(actual.rangeTag === 'HDR' && range === 'HLG'))) return false
    return (!actual.audio || !expected.audio || actual.audio === expected.audio)
      && (!actual.channels || !expected.channels || actual.channels === expected.channels)
  })
}
