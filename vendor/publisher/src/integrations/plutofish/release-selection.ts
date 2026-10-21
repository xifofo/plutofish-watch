/** 发布版本选择：稳定绑定优先；规格只用于唯一候选推荐，用户选择随任务固定。 */
import { createHash } from 'node:crypto'
import { matchingReleases } from './release-specs'
import type { PublicationDraft } from './publication-types.ts'
export { matchMeasuredRelease, measuredReleaseVersion } from './measured-release'
type ReleaseReader = { request<T>(binding: PublicationDraft['binding'], path: 'releases/query', body: unknown): Promise<T> }

export type ReleaseOption = {
  id: string; name: string; resolution: string; dynamicRange: string
  status: 'draft' | 'published' | 'unpublished'; latestEpisode?: number
}
export type ReleaseChoices = {
  context: string; name: string; items: ReleaseOption[]; matchedId?: string
  match?: 'binding' | 'specs'; needsChoice: boolean
}
export type ReleaseSelection = { context: string } & ({ mode: 'existing'; releaseId: string } | { mode: 'new' })
type ReleasePage = { items: ReleaseOption[]; total: number; page: number; pageSize: number; boundReleaseId?: string }

export function matchRelease(items: ReleaseOption[], name: string, boundId?: string): Pick<ReleaseChoices, 'matchedId' | 'match'> {
  if (boundId && items.some(r => r.id === boundId)) return { matchedId: boundId, match: 'binding' }
  const matches = matchingReleases(items, name)
  return matches.length === 1 ? { matchedId: matches[0]!.id, match: 'specs' } : {}
}

/** 每次入队重查候选；服务端或网络错误不能伪装成没有版本。 */
export async function releaseChoices(connection: ReleaseReader, drafts: PublicationDraft[], name: string): Promise<ReleaseChoices> {
  const draft = drafts[0]
  if (!draft || drafts.some(d => d.releaseKey !== draft.releaseKey)) throw new Error('请分批选择同一季、同一版本的内容')
  const items: ReleaseOption[] = []
  let boundId: string | undefined
  for (let page = 1; ; page++) {
    const result = await connection.request<ReleasePage>(draft.binding, 'releases/query', {
      sourceAccount: draft.binding.sourceAccount?.alias, workTarget: draft.workTarget,
      seasonNumber: draft.seasonNumber, releaseKey: draft.releaseKey, page,
    })
    if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
      || result.page !== page || result.pageSize !== 100 || result.items.length > 100
      || result.items.some(r => !r || !/^[a-f0-9]{32}$/.test(r.id) || typeof r.name !== 'string' || typeof r.dynamicRange !== 'string'
        || typeof r.resolution !== 'string' || !['draft', 'published', 'unpublished'].includes(r.status))) throw new Error('PlutoFish 版本列表响应无效，请重试')
    items.push(...result.items)
    boundId = result.boundReleaseId
    if (new Set(items.map(r => r.id)).size !== items.length) throw new Error('PlutoFish 版本列表已变化，请重试')
    if (items.length >= result.total) break
    if (!result.items.length || page >= 100) throw new Error('PlutoFish 版本列表未完整读取，请重试')
  }
  const matched = matchRelease(items, name, boundId)
  const context = createHash('sha256').update(JSON.stringify([draft.releaseKey, name, drafts.map(d => d.episodeNumber)])).digest('hex')
  return { context, name, items, ...matched, needsChoice: !matched.matchedId && draft.seasonNumber !== undefined && !drafts.some(d => d.episodeNumber === 1) }
}

/** 未匹配的续集必须明确选择；强制新建的随机标识由主进程按批次生成并保存。 */
export function resolveReleaseSelection(choices: ReleaseChoices, selection?: ReleaseSelection): { existingReleaseId?: string; forceNew?: boolean } {
  if (selection) {
    if (selection.context !== choices.context) throw new Error('发布条件已改变，请重新确认版本')
    if (selection.mode === 'new') return { forceNew: true }
    if (selection.mode === 'existing' && choices.items.some(r => r.id === selection.releaseId)) return { existingReleaseId: selection.releaseId }
    throw new Error('所选版本已不可用，请重新选择')
  }
  if (choices.matchedId) return { existingReleaseId: choices.matchedId }
  if (choices.needsChoice) throw new Error('后续集数未匹配到已有版本，请选择已有版本或强制新版本')
  return {}
}
