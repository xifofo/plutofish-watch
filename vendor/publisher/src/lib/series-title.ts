export type SeriesTitle = { title: string; season?: number }

function seasonNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  const number = (text: string) => digits.indexOf(text.replace(/〇/g, '零').replace(/两|兩/g, '二'))
  if (value === '十') return 10
  if (/^[一二三四五六七八九两兩]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, ones] = value.split('十')
    return (tens ? number(tens) : 1) * 10 + (ones ? number(ones) : 0)
  }
  return value.length === 1 ? number(value) : 0
}

/** A trailing season label belongs to the TV season, not TMDB's series title.
 * Keep sequel numbers, episode numbers and season words inside a real title. */
export function parseSeriesTitle(value: string): SeriesTitle {
  const title = value.trim()
  const normalized = title.normalize('NFKC')
  const chinese = normalized.match(/[\s·•:：\-–—]*[([【]?\s*第\s*([\d零〇一二三四五六七八九十两兩]+)\s*季\s*[)\]】]?$/)
  const english = normalized.match(/(?:[\s·•:：\-–—]+|\s*[(\[【]\s*)(?:season\s*(\d{1,3})|s(\d{1,3}))\s*[)\]】]?$/i)
  const match = chinese ?? english
  if (!match || match.index === undefined) return { title }
  const season = seasonNumber(match[1] || match[2] || '')
  const base = normalized.slice(0, match.index).trim()
  if (!base || season < 1 || season > 999) return { title }
  return { title: base, season }
}

/** Explicit episode metadata wins; titles fill gaps before the historical S01 default. */
export function seriesSeason(season: number | undefined, title: string): number {
  return season !== undefined && Number.isSafeInteger(season) && season >= 0 ? season : parseSeriesTitle(title).season ?? 1
}

/** Search the full title first. Non-numeric season/release labels are only a fallback,
 * and never imply a season number or change an unmatched output title. */
export function tmdbTitleQueries(value: string): string[] {
  const title = parseSeriesTitle(value).title
  const normalized = title.normalize('NFKC')
  const match = normalized.match(/(?:[\s·•:：\-–—]+|\s*[(\[【]\s*)(?:最终季|最終季|完结季|完結季|final\s+season)\s*[)\]】]?$/i)
    ?? normalized.match(/[\s·•:：\-–—]*[([【]?\s*年番\s*[)\]】]?$/)
  const base = match?.index === undefined ? '' : normalized.slice(0, match.index).trim()
  return base ? [title, base] : [title]
}

/** An explicit TMDB season only changes output numbering, never stream IDs. */
export function tmdbSeasonOverride(season: number | undefined, match: { id: number; kind: 'movie' | 'show' } | null): number | undefined {
  if (season === undefined) return undefined
  if (!match || match.kind !== 'show' || !Number.isSafeInteger(match.id) || match.id <= 0)
    throw new Error('请先绑定 TMDB 剧集，再选择输出季号')
  if (!Number.isSafeInteger(season) || season < 0 || season > 999)
    throw new Error('无效的 TMDB 季号')
  return season
}
