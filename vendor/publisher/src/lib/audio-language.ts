import type { FileConfig } from './config.ts'
import type { MediaKind } from './name.ts'
import { tmdbDetails, type TmdbDetails } from './tmdb.ts'

/** Original Chinese language is sufficient; region is the fallback when it is absent. */
export function mainlandAudioLanguage(details?: TmdbDetails): string {
  if (!details) return ''
  if (details.originalLanguage) return /^(zh|zho|chi|cmn|yue|nan|wuu|hak)$/.test(details.originalLanguage) ? 'zh' : ''
  return details.countries.includes('CN') ? 'zh' : ''
}

export function isUnknownAudioLanguage(lang = ''): boolean {
  return /^(|—|-|und|unknown|原声|未知|未提供|未指定|aac|dolby|dts|atmos|eac3|ac3|ec3)$/i.test(lang.trim())
}

/** Explicit catalog language, then source metadata, then the matched title's language/region. */
export function resolveAudioLanguage(selected = '', source = '', fallback = ''): string {
  if (!isUnknownAudioLanguage(selected)) return selected
  if (!isUnknownAudioLanguage(source)) return source
  return fallback || 'und'
}

type MatchedTask = { tmdbId: number; kind?: MediaKind; tmdbMetadata?: TmdbDetails }

/** Persist the matched metadata on the job so a resume does not need TMDB again. */
export async function prepareAudioLanguage(
  cfg: Pick<FileConfig, 'tmdbKey' | 'tmdbProxy'>,
  task: MatchedTask,
  signal?: AbortSignal,
  lookup: typeof tmdbDetails = tmdbDetails,
): Promise<string> {
  signal?.throwIfAborted()
  const kind = task.kind ?? 'show'
  if (!task.tmdbId || (kind !== 'movie' && kind !== 'show')) return ''
  if (task.tmdbMetadata?.id !== task.tmdbId || task.tmdbMetadata.kind !== kind) {
    if (!cfg.tmdbKey.trim()) return ''
    const details = await lookup(cfg.tmdbKey, kind, task.tmdbId, { proxy: cfg.tmdbProxy, signal })
    signal?.throwIfAborted()
    task.tmdbMetadata = details
  }
  return mainlandAudioLanguage(task.tmdbMetadata)
}
