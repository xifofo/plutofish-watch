/** 版本展示采用成品文件名中的规格段；简短的非规格文件名回退到已探测媒体。 */
import { basename, extname } from 'node:path'
import { mediaFilenameTags, sanitizePath, tierHeight } from '../../lib/name.ts'
import type { PublicationDraft } from './publication-types.ts'
import { normalizeRange, splitReleaseGroup } from './release-specs'

export function publicationVersion(draft: PublicationDraft): { name: string; resolution: string; dynamicRange: string } {
  if (draft.version) return { ...draft.version }
  const media = draft.measured?.media
  if (!media) throw new Error('成品媒体规格待检查')
  const filename = basename(draft.output, extname(draft.output))
  const savedGroup = sanitizePath(draft.naming?.group.trim() || '')
  const { specs: stem, group } = savedGroup && filename.endsWith(`-${savedGroup}`)
    ? { specs: filename.slice(0, -savedGroup.length - 1), group: savedGroup } : splitReleaseGroup(filename)
  // 取最后一个分辨率段，避免片名或单集标题恰好含有 1080p 等文字。
  const match = [...stem.matchAll(/(?:^|\.)(\d{3,4}p)(?=\.|$)/gi)].at(-1)
  const resolution = match?.[1] ?? `${tierHeight(media.width || 0, media.height || 0)}p`
  const source = draft.naming?.source
  const specs = match ? stem.slice(match.index! + (match[0].startsWith('.') ? 1 : 0))
    : [resolution, source === 'YK' ? 'YOUKU' : source, 'WEB-DL', ...mediaFilenameTags(media)].filter(Boolean).join('.')
  const season = draft.seasonNumber === undefined ? '' : `S${String(draft.seasonNumber).padStart(2, '0')}`
  const suffix = group || savedGroup
  return { name: [season, specs].filter(Boolean).join('.') + (suffix ? `-${suffix}` : ''), resolution, dynamicRange: normalizeRange(media.dynamicRange) || media.dynamicRange || 'Unknown' }
}
