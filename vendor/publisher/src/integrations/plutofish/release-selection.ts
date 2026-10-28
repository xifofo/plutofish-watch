/** 发布版本选择：稳定绑定优先；规格只用于唯一候选推荐，用户选择随任务固定。 */
import { createHash } from 'node:crypto'
import { matchingReleases } from './release-specs'
import type { PublicationDraft } from './publication-types.ts'
export { matchMeasuredRelease, measuredReleaseVersion } from './measured-release'
type ReleaseReader = { request<T>(binding: PublicationDraft['binding'], path: 'releases/query', body: unknown): Promise<T> }

export type ReleaseOption = {
  id: string; name: string; resolution: string; dynamicRange: string
  /** 查询时固定的季号，0 表示特别篇；电影省略。 */
  seasonNumber?: number
  status: 'draft' | 'published' | 'unpublished'; latestEpisode?: number
  /** 已就绪正片的集号（新版服务端返回）；订阅据此同步追更进度 */
  episodes?: number[]
}
export type ReleaseChoices = {
  context: string; name: string; items: ReleaseOption[]; matchedId?: string
  seasonNumber?: number
  /** remembered：绑定和规格都没对上，沿用订阅上次用过的版本（例如换了 115 源账号后发布标识变了） */
  match?: 'binding' | 'specs' | 'remembered'; needsChoice: boolean
}
export type ReleaseSelection = { context: string } & ({ mode: 'existing'; releaseId: string } | { mode: 'new' })
type ReleasePage = { items: ReleaseOption[]; total: number; page: number; pageSize: number; boundReleaseId?: string }

export function matchRelease(items: ReleaseOption[], name: string, boundId?: string): Pick<ReleaseChoices, 'matchedId' | 'match'> {
  if (boundId && items.some(r => r.id === boundId)) return { matchedId: boundId, match: 'binding' }
  // 目录预览可能只有数字 profile，尚无视频编码；按其余规格找唯一候选，不把候选编码当作成品证据。
  const matches = matchingReleases(items, name, { allowMissingCodec: true })
  return matches.length === 1 ? { matchedId: matches[0]!.id, match: 'specs' } : {}
}

/** 每次入队重查候选；服务端或网络错误不能伪装成没有版本。 */
export async function releaseChoices(connection: ReleaseReader, drafts: PublicationDraft[], name: string, includeSpecials = false): Promise<ReleaseChoices> {
  const draft = drafts[0]
  if (!draft || drafts.some(d => d.releaseKey !== draft.releaseKey)) throw new Error('请分批选择同一季、同一版本的内容')
  const items: ReleaseOption[] = []
  let boundId: string | undefined
  // 服务端要求剧集指定季号；手动选版额外查询 S00，不把特别篇推荐给普通季或订阅。
  const seasons = includeSpecials && draft.seasonNumber !== undefined && draft.seasonNumber !== 0 ? [draft.seasonNumber, 0] : [draft.seasonNumber]
  for (const seasonNumber of seasons) {
    let count = 0
    for (let page = 1; ; page++) {
      const result = await connection.request<ReleasePage>(draft.binding, 'releases/query', {
        sourceAccount: draft.binding.sourceAccount?.alias, workTarget: draft.workTarget,
        seasonNumber, releaseKey: draft.releaseKey, page,
      })
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.page !== page || result.pageSize !== 100 || result.items.length > 100
        || result.items.some(r => !r || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.name !== 'string' || typeof r.dynamicRange !== 'string'
          || typeof r.resolution !== 'string' || !['draft', 'published', 'unpublished'].includes(r.status)
          || (r.episodes !== undefined && (!Array.isArray(r.episodes) || r.episodes.length > 100000 || r.episodes.some(n => !Number.isSafeInteger(n) || n < 0))))) throw new Error('PlutoFish 版本列表响应无效，请重试')
      items.push(...result.items.map(item => ({ ...item, seasonNumber })))
      count += result.items.length
      if (seasonNumber === draft.seasonNumber) boundId = result.boundReleaseId
      if (new Set(items.map(r => r.id)).size !== items.length) throw new Error('PlutoFish 版本列表已变化，请重试')
      if (count >= result.total) break
      if (!result.items.length || page >= 100) throw new Error('PlutoFish 版本列表未完整读取，请重试')
    }
  }
  const matched = matchRelease(items.filter(item => item.seasonNumber === draft.seasonNumber), name, boundId)
  const context = createHash('sha256').update(JSON.stringify([draft.releaseKey, name, drafts.map(d => d.episodeNumber)])).digest('hex')
  return { context, name, items, seasonNumber: draft.seasonNumber, ...matched, needsChoice: !matched.matchedId && draft.seasonNumber !== undefined && !drafts.some(d => d.episodeNumber === 1) }
}

/** 绑定和规格都没匹配上时，沿用订阅记住的版本；该版本已下架或不在候选里则不沿用，仍按原规则要求选择。 */
export function preferRelease(choices: ReleaseChoices, releaseId?: string): ReleaseChoices {
  if (choices.matchedId || !releaseId || !choices.items.some(r => r.id === releaseId && r.status !== 'unpublished' && r.seasonNumber === choices.seasonNumber)) return choices
  return { ...choices, matchedId: releaseId, match: 'remembered', needsChoice: false }
}

/** 未匹配的续集必须明确选择；强制新建的随机标识由主进程按批次生成并保存。 */
export function resolveReleaseSelection(choices: ReleaseChoices, selection?: ReleaseSelection): { existingReleaseId?: string; forceNew?: boolean } {
  if (selection) {
    if (selection.context !== choices.context) throw new Error('发布条件已改变，请重新确认版本')
    if (selection.mode === 'new') return { forceNew: true }
    if (selection.mode === 'existing' && choices.items.some(r => r.id === selection.releaseId && r.seasonNumber === choices.seasonNumber)) return { existingReleaseId: selection.releaseId }
    throw new Error('所选版本已不可用，请重新选择')
  }
  if (choices.matchedId) return { existingReleaseId: choices.matchedId }
  if (choices.needsChoice) throw new Error('后续集数未匹配到已有版本，请选择已有版本或强制新版本')
  return {}
}
