/** 服务端识别结果的纯数据协议，可安全用于渲染进程。 */
export type CategoryMatch = { name: string; value: string; label: string; status: 'matched' | 'unmatched' | 'unmapped' | 'ambiguous' | 'disabled' }
export type RecognizedWork = { tmdbId: string; mediaType: 'movie' | 'tv'; title: string; originalTitle: string; englishTitle: string; year?: number; posterUrl: string; category: CategoryMatch }
export type Recognition = {
  status: 'compatible' | 'review' | 'ambiguous' | 'not_identified'; canAutoFill: boolean; reasons: string[]
  parsed: { title: string; mediaType: string; seasonNumber?: number; seasonEnd?: number; episodeNumber?: number; episodeEnd?: number; resolution: string; source: string; warnings: string[] }
  work: RecognizedWork | null; workTarget: { mediaType: 'movie' | 'tv'; tmdbId: string; category: string } | null; truncated: boolean; selectionBasis: string
  candidates: Array<{ work: RecognizedWork; conflicts: Array<{ field: string; expected: string; actual: string }> }>
}
