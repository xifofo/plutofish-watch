/** 本地成品自动归类：实际媒体优先，来源和特殊规格保守比较；只接受唯一候选。 */
import { basename, extname } from 'node:path'
import type { MediaSpecs } from '../../lib/actual-version'
import { mediaFilenameTags, tierHeight } from '../../lib/name'
import type { ReleaseOption } from './release-selection'

import { audioCodec, videoCodec, normalizeRange as range, parseReleaseSpecs as parse, releaseSource, sourceReviewReason, matchingReleases, type ReleaseSource } from './release-specs'

/** 不凭一个相似文件名或单个候选推断版本；未知音轨、缺失来源和重名版本需要人工选择。 */
export function matchMeasuredRelease(items: ReleaseOption[], media: MediaSpecs, path: string, preset: ReleaseSource = {}): { matchedId?: string; canCreate?: boolean; reason: string } {
  const height = tierHeight(media.width ?? 0, media.height ?? 0), codec = videoCodec(media.codec ?? ''), dynamic = range(media.dynamicRange ?? '')
  if (media.status !== 'probed' || !height || !codec || !dynamic || !Number.isFinite(media.fps) || !media.fps || media.fps <= 0 ||
    !media.audio || media.audio.status === 'ambiguous') {
    return { reason: '媒体规格不完整，请选择版本' }
  }
  const stem = basename(path, extname(path))
  const file = parse(stem, height)
  const measuredAudio = media.audio.status === 'confirmed' ? audioCodec(media.audio.codec ?? '') : undefined
  const fps = Math.round(media.fps ?? 0)
  if (media.audio.status === 'confirmed' && (!measuredAudio || !media.audio.channels)) return { reason: '音轨规格无法确定，请选择版本' }
  if (file && (file.height !== height || (file.codec && file.codec !== codec) ||
    (file.range && file.range !== dynamic && !(file.rangeTag === 'HDR' && dynamic === 'HLG')) || (file.audio && file.audio !== measuredAudio) ||
    (file.channels && file.channels !== media.audio.channels) || (file.fps && file.fps !== fps))) return { reason: '文件名与实际媒体规格不符，请确认版本' }
  const reason = sourceReviewReason(releaseSource(stem, preset))
  if (reason) return { reason }
  const matches = matchingReleases(items, buildVersion(media, path, undefined, preset).name)
  return matches.length === 1 ? { matchedId: matches[0]!.id, reason: '' }
    : { canCreate: matches.length === 0, reason: matches.length > 1 ? '多个版本规格相同，请选择一次' : '未匹配到已有版本' }
}

/** 自动新建采用实际音视频规格，保留文件名中的来源及特殊标签；分集名和发布组不进入版本。 */
export function measuredReleaseVersion(media: MediaSpecs, path: string, season?: number, preset: ReleaseSource = {}) {
  const checked = matchMeasuredRelease([], media, path, preset)
  if (!checked.canCreate) throw new Error(checked.reason)
  return buildVersion(media, path, season, preset)
}

function buildVersion(media: MediaSpecs, path: string, season?: number, preset: ReleaseSource = {}) {
  const file = parse(basename(path, extname(path)), tierHeight(media.width ?? 0, media.height ?? 0))
  const source = releaseSource(basename(path, extname(path)), preset)
  const resolution = `${tierHeight(media.width ?? 0, media.height ?? 0)}p`
  const dynamicRange = range(media.dynamicRange!)!
  const tags = mediaFilenameTags(media)
  const fps = Math.round(media.fps!)
  if (fps < 48 && file?.fps) tags.splice(1, 0, `${fps}fps`)
  const parts = [
    season === undefined ? '' : `S${String(season).padStart(2, '0')}`,
    resolution, source.platform, source.type,
    ...(file?.extras.split('.').filter(tag => tag !== file.type && tag !== 'ATMOS') ?? []),
    ...tags,
    file?.extras.split('.').includes('ATMOS') && !media.audio?.atmos ? 'Atmos' : '',
  ]
  return { name: parts.filter(Boolean).join('.'), resolution, dynamicRange }
}
