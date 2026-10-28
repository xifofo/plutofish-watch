import { dots } from './name.ts'
import { fetchTmdb, normalizeHttpProxy } from './proxy.ts'
import { runLog } from './runlog.ts'
import { isObj } from './util.ts'
import { tmdbTitleQueries } from './series-title.ts'
import type { TmdbSeason, TmdbSeasonList } from './tmdb-types.ts'
export type { TmdbSeason, TmdbSeasonList } from './tmdb-types.ts'

export type TmdbResult = {
  id: number
  name: string
  title: string
  year: number
  overview: string
  englishDots: string
  kind: 'movie' | 'show'
}

/** Details of the matched title, not the viewer's locale or the release region. */
export type TmdbDetails = {
  id: number
  kind: 'movie' | 'show'
  countries: string[]
  originalLanguage: string
}

type SearchResponse = {
  results?: Array<{
    id: number
    media_type?: string
    name?: string
    title?: string
    original_name?: string
    original_title?: string
    first_air_date?: string
    release_date?: string
    overview?: string
  }>
}

class TmdbHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403
      ? 'TMDB 凭证无效或没有访问权限，请检查设置中的 TMDB Key'
      : status === 429 ? 'TMDB 请求过于频繁，请稍后重试' : `TMDB HTTP ${status}`)
  }
}

export function normalizeTmdbProxy(value: string): string {
  return normalizeHttpProxy(value)
}

type TmdbRequestInit = RequestInit & { proxy?: string }
type TmdbFetch = (url: string, init?: TmdbRequestInit) => Promise<Response>
type TmdbOptions = { proxy?: string }

/** Both are TMDB API hosts. Keep the last reachable one first for this session. */
function createTmdbRequest(fetcher: TmdbFetch, timeoutMs: number) {
  let preferred = 'api.tmdb.org'
  return async <T>(apiKey: string, path: string, params: Record<string, string>, parse: (out: unknown) => T, options: TmdbOptions): Promise<T> => {
    const key = apiKey.trim().replace(/^Bearer\s+/i, '')
    if (!key) throw new Error('未配置 TMDB API Key')
    const proxy = normalizeTmdbProxy(options.proxy || '')
    const route = proxy ? 'proxy' : 'default'
    const hosts = [preferred, ...['api.tmdb.org', 'api.themoviedb.org'].filter(h => h !== preferred)]
    for (const host of hosts) {
      const url = new URL(`https://${host}/3/${path}`)
      url.search = new URLSearchParams(params).toString()
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (key.includes('.')) headers.Authorization = `Bearer ${key}`
      else url.searchParams.set('api_key', key)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const started = Date.now()
      try {
        const res = await fetcher(url.href, { headers, signal: ac.signal,
          // Chromium can reuse an older search response when the user retries
          // a newly added title. Search must ask TMDB for the current index.
          ...(path.startsWith('search/') ? { cache: 'no-store' as const } : {}),
          ...(proxy ? { proxy } : {}) })
        if (!res.ok) {
          await res.body?.cancel()
          throw new TmdbHttpError(res.status)
        }
        // The timeout includes reading the body, not just receiving headers.
        const out = parse(await res.json())
        preferred = host
        runLog(`tmdb ${path} host=${host} via=${route} ${Date.now() - started}ms ok`)
        return out
      } catch (e) {
        // Never log the request URL or raw fetch error: either can contain the key.
        const reason = e instanceof TmdbHttpError ? `http=${e.status}` : ac.signal.aborted ? 'timeout' : 'network-or-response'
        runLog(`tmdb ${path} host=${host} via=${route} ${Date.now() - started}ms fail ${reason}`)
        if (e instanceof TmdbHttpError && e.status < 500) throw e
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(proxy
      ? '无法通过代理连接 TMDB（两个 API 地址均未成功），请检查代理是否运行及其分流规则'
      : '无法连接 TMDB（两个 API 地址均未成功），可在设置 → TMDB 代理中填写本地代理地址')
  }
}

export function createTmdbSearch(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  return async (apiKey: string, lang: string, query: string, options: TmdbOptions = {}): Promise<TmdbResult[]> => {
    if (!query.trim()) throw new Error('缺少用于 TMDB 搜索的片名')
    const language = lang || 'zh-CN'
    // Missing platform categories must not lock a movie into the TV endpoint.
    for (const title of tmdbTitleQueries(query)) {
      const hits = await request(apiKey, 'search/multi', { language, query: title, include_adult: 'false' }, out => {
        if (!isObj(out) || !Array.isArray(out.results)) throw new Error('invalid TMDB response')
        const rows = (out as SearchResponse).results!.filter(h => h.media_type === 'movie' || h.media_type === 'tv').slice(0, 8)
        return rows.map((h): TmdbResult => {
          const movie = h.media_type === 'movie'
          const date = (movie ? h.release_date : h.first_air_date) || ''
          const name = (movie ? h.title : h.name) || ''
          return { id: h.id, name, title: h.title || '', year: Number.parseInt(date.slice(0, 4), 10) || 0,
            overview: h.overview || '', englishDots: dots(h.original_name || h.original_title || name), kind: movie ? 'movie' : 'show' }
        })
      }, options)
      // New entries can have a date in regional movie search before multi search
      // or details are updated. Enrich by movie ID only; keep the mixed results.
      if (hits.some(h => h.kind === 'movie' && !h.year)) {
        try {
          const region = language.match(/-([a-z]{2})$/i)?.[1]?.toUpperCase() || 'CN'
          const years = await request(apiKey, 'search/movie', { language, query: title, include_adult: 'false', region }, out => {
            if (!isObj(out) || !Array.isArray(out.results)) throw new Error('invalid TMDB movie response')
            const dates = new Map<number, number>()
            for (const row of out.results) {
              if (!isObj(row) || !Number.isSafeInteger(row.id) || Number(row.id) <= 0 || typeof row.release_date !== 'string'
                || !/^\d{4}-\d{2}-\d{2}$/.test(row.release_date)) continue
              const year = Number(row.release_date.slice(0, 4))
              if (year > 0) dates.set(Number(row.id), year)
            }
            return dates
          }, options)
          for (const hit of hits) if (hit.kind === 'movie' && !hit.year) hit.year = years.get(hit.id) || 0
        } catch {
          // Optional enrichment must not discard usable search results.
          runLog('tmdb movie year enrichment unavailable; keeping search results')
        }
      }
      if (hits.length) return hits
    }
    return []
  }
}

/** Resolve only the selected work. original_name/original_title are not necessarily English. */
export function createTmdbFilenameTitle(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  const cache = new Map<string, { expires: number; promise: Promise<string> }>()
  return async (apiKey: string, kind: 'movie' | 'show', id: number, fallback: string, options: TmdbOptions = {}): Promise<string> => {
    if (!apiKey.trim() || !Number.isSafeInteger(id) || id <= 0) return fallback
    const key = JSON.stringify([apiKey.trim(), kind, id, options.proxy || ''])
    let entry = cache.get(key)
    if (!entry || entry.expires <= Date.now()) {
      const current = { expires: Infinity, promise: Promise.resolve('') }
      current.promise = request(apiKey, `${kind === 'movie' ? 'movie' : 'tv'}/${id}/translations`, {}, out => {
        if (!isObj(out) || out.id !== id || !Array.isArray(out.translations)) throw new Error('invalid TMDB translations')
        const titles = out.translations.filter(isObj).flatMap(row => {
          if (!isObj(row.data)) return []
          const value = kind === 'movie' ? row.data.title : row.data.name
          if (typeof value !== 'string' || !/[\p{L}\p{N}]/u.test(value)) return []
          const language = row.iso_639_1, region = row.iso_3166_1
          const rank = language === 'en' ? (region === 'US' ? 0 : region === 'GB' ? 1 : 2)
            : language === 'zh' ? (region === 'CN' ? 3 : region === 'SG' ? 4 : 5) : 6
          return rank < 6 ? [{ title: value.trim(), rank }] : []
        })
        return titles.sort((a, b) => a.rank - b.rank)[0]?.title || ''
      }, options).then(title => {
        current.expires = Date.now() + 60 * 60_000
        return title
      }, () => {
        // Optional metadata must not block a download or trigger a request for every episode.
        current.expires = Date.now() + 30_000
        runLog('tmdb filename title unavailable; keeping matched title')
        return ''
      })
      entry = current
      cache.delete(key)
      cache.set(key, entry)
      if (cache.size > 128) cache.delete(cache.keys().next().value!)
    }
    return await entry.promise || fallback
  }
}

/** Season zero is a real TMDB season. Never infer "final" from the last row. */
export function createTmdbSeasons(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  const cache = new Map<string, { expires: number; promise: Promise<TmdbSeasonList> }>()
  return (apiKey: string, lang: string, id: number, options: TmdbOptions = {}): Promise<TmdbSeasonList> => {
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('无效的 TMDB ID'))
    const language = lang || 'zh-CN'
    const key = JSON.stringify([apiKey.trim(), language, id, options.proxy || ''])
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.promise
    const promise = (async (): Promise<TmdbSeasonList> => {
      const ordinary = await request(apiKey, `tv/${id}`, { language }, out => {
        if (!isObj(out) || out.id !== id || !Array.isArray(out.seasons)) throw new Error('invalid TMDB seasons')
        const seasons = new Map<number, TmdbSeason>()
        for (const row of out.seasons) {
          if (!isObj(row) || !Number.isSafeInteger(row.season_number) || Number(row.season_number) < 0 || Number(row.season_number) > 999) continue
          const number = Number(row.season_number)
          if (seasons.has(number)) continue
          seasons.set(number, { number, name: typeof row.name === 'string' ? row.name : number === 0 ? '特别篇' : `第 ${number} 季`,
            episodeCount: Number.isSafeInteger(row.episode_count) && Number(row.episode_count) >= 0 ? Number(row.episode_count) : 0,
            airDate: typeof row.air_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.air_date) ? row.air_date : '' })
        }
        return [...seasons.values()].sort((a, b) => a.number - b.number)
      }, options)
      const result: TmdbSeasonList = { seasons: ordinary, warning: '' }
      try {
        const groups = await request(apiKey, `tv/${id}/episode_groups`, { language }, out => {
          if (!isObj(out) || out.id !== id || !Array.isArray(out.results)) throw new Error('invalid TMDB episode groups')
          const unique = new Map<string, { id: string; name: string }>()
          for (const row of out.results) {
            if (!isObj(row) || typeof row.id !== 'string' || !/^[a-f\d]{24}$/i.test(row.id)) continue
            if (!unique.has(row.id)) unique.set(row.id, { id: row.id, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : '未命名分组' })
          }
          return [...unique.values()]
        }, options)
        // Preserve the API's group order while limiting concurrent requests.
        const grouped: TmdbSeason[][] = new Array(groups.length)
        let next = 0
        await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
          while (next < groups.length) {
            const index = next++
            const group = groups[index]!
            try {
              grouped[index] = await request(apiKey, `tv/episode_group/${group.id}`, { language }, out => {
                if (!isObj(out) || out.id !== group.id || !Array.isArray(out.groups)) throw new Error('invalid TMDB episode group')
                const rows = new Map<number, TmdbSeason>()
                for (const row of out.groups) {
                  if (!isObj(row) || !Number.isSafeInteger(row.order) || Number(row.order) < 0 || Number(row.order) > 999 || !Array.isArray(row.episodes)) continue
                  const number = Number(row.order)
                  if (rows.has(number)) continue
                  const episodes = row.episodes.filter(isObj)
                  const dates = episodes.map(ep => ep.air_date).filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
                  rows.set(number, { number, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `第 ${number} 季`,
                    episodeCount: episodes.length, airDate: dates[0] || '', groupId: group.id, groupName: group.name })
                }
                return [...rows.values()].sort((a, b) => a.number - b.number)
              }, options)
            } catch {
              grouped[index] = []
              result.warning = '部分剧集分组读取失败，可重试；已读取的季号仍可选。'
            }
          }
        }))
        result.seasons.push(...grouped.flat())
      } catch {
        result.warning = '剧集分组读取失败，可重试；也可选择普通季号或沿用平台季号。'
      }
      return result
    })().then(value => {
      // An immediate user retry must be able to recover missing optional groups.
      if (value.warning && cache.get(key) === entry) cache.delete(key)
      entry.expires = Date.now() + 10 * 60_000
      return value
    }, error => {
      if (cache.get(key) === entry) cache.delete(key)
      throw error
    })
    const entry = { expires: Infinity, promise }
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
    return promise
  }
}

/** Cancellation stops this caller's wait without aborting another episode's shared request. */
function waitForDetails(promise: Promise<TmdbDetails>, signal?: AbortSignal): Promise<TmdbDetails> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** One details request per matched title in a batch, including concurrent episodes. */
export function createTmdbDetails(fetcher: TmdbFetch = fetchTmdb, timeoutMs = 10_000) {
  const request = createTmdbRequest(fetcher, timeoutMs)
  const cache = new Map<string, { expires: number; promise: Promise<TmdbDetails> }>()
  return (apiKey: string, kind: 'movie' | 'show', id: number, options: TmdbOptions & { signal?: AbortSignal } = {}): Promise<TmdbDetails> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('无效的 TMDB ID'))
    const key = JSON.stringify([apiKey.trim(), kind, id, options.proxy || ''])
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return waitForDetails(hit.promise, options.signal)
    const promise = request(apiKey, `${kind === 'movie' ? 'movie' : 'tv'}/${id}`, {}, out => {
      if (!isObj(out) || out.id !== id) throw new Error('invalid TMDB details')
      // TV prefers origin_country; movies prefer production countries. New movie
      // records can have only origin_country, which is still title metadata.
      const origin = Array.isArray(out.origin_country) ? out.origin_country : []
      const production = Array.isArray(out.production_countries) ? out.production_countries.filter(isObj).map(c => c.iso_3166_1) : []
      const countries = (kind === 'show' && origin.length ? origin : production.length ? production : origin)
        .filter((c): c is string => typeof c === 'string' && /^[a-z]{2}$/i.test(c)).map(c => c.toUpperCase())
      return { id, kind, countries: [...new Set(countries)], originalLanguage: typeof out.original_language === 'string' ? out.original_language.toLowerCase() : '' }
    }, options).then(value => {
      entry.expires = Date.now() + 60 * 60_000
      return value
    }, error => {
      // Avoid repeated timeouts for every episode; a retry can recover shortly.
      entry.expires = Date.now() + 30_000
      throw error
    })
    const entry = { expires: Infinity, promise }
    cache.delete(key)
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
    return waitForDetails(entry.promise, options.signal)
  }
}

export const tmdbSearch = createTmdbSearch()
export const tmdbFilenameTitle = createTmdbFilenameTitle()
export const tmdbDetails = createTmdbDetails()
export const tmdbSeasons = createTmdbSeasons()
