/** 预览与手动创建请求使用同一组经过清洗的目录名称。 */
const encoder = new TextEncoder()
function segment(value: string, suffix = ''): string {
  const clean = value.trim().replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
  let result = '', bytes = encoder.encode(suffix).length
  for (const character of clean) {
    const size = encoder.encode(character).length
    if (bytes + size > 255) break
    result += character; bytes += size
  }
  result = result.trim()
  if (!result || result === '.' || result === '..') result = '_'
  return result + suffix
}

export function directorySegments(input: { title: string; categoryLabel: string; tmdbId: string; seasonNumber?: number }): string[] {
  const parts = [segment(input.categoryLabel || '资源分类'),
    segment(input.title || '作品名称', ` {tmdbid-${input.tmdbId || 'ID'}}`)]
  if (input.seasonNumber !== undefined) parts.push(`season ${String(input.seasonNumber).padStart(2, '0')}`)
  return parts
}

export function directoryPreview(input: { rootPath?: string; title: string; categoryLabel: string; tmdbId: string; seasonNumber?: number }): string {
  return [input.rootPath?.replace(/\/+$/, '') ?? '', ...directorySegments(input)].join('/')
}
