/** 搜索走已验证的发布连接，仅向界面返回经过检查的作品选择资料。 */
import type { PlutoFishConnection } from '../../vendor/publisher/src/integrations/plutofish/connection'
import type { Binding, WorkPage, WorkSearch } from '../shared/model'

export async function searchWorks(connection: PlutoFishConnection, binding: Binding, input: WorkSearch): Promise<WorkPage> {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (!query || [...query].length > 100 || !['movie', 'tv'].includes(input?.mediaType) ||
    !Number.isInteger(input?.page) || input.page < 1 || input.page > 500) throw new Error('请输入作品名称，并选择电影或剧集')
  const signal = AbortSignal.timeout(22_000)
  let result: WorkPage
  try {
    result = await connection.request<WorkPage>(binding, 'tmdb/search', {
      sourceAccount: binding.sourceAccount.alias, mediaType: input.mediaType, query, page: input.page,
    }, signal)
  } catch (error) {
    if (signal.aborted) throw new Error('作品搜索超时，请重试')
    throw error
  }
  if (!result || result.page !== input.page || !Number.isSafeInteger(result.total) || result.total < 0 ||
    !Number.isInteger(result.totalPages) || result.totalPages < 0 || result.totalPages > 500 ||
    !Array.isArray(result.items) || result.items.length > 100 || result.items.length > result.total ||
    result.items.some(item => !item || typeof item.tmdbId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(item.tmdbId) ||
      Number(item.tmdbId) > 2147483647 || typeof item.title !== 'string' || !item.title.trim() || [...item.title].length > 200 ||
      typeof item.originalTitle !== 'string' || [...item.originalTitle].length > 200 ||
      (item.year !== undefined && (!Number.isInteger(item.year) || item.year < 1 || item.year > 9999)))) {
    throw new Error('作品搜索结果无效，请重试')
  }
  return {
    page: result.page, totalPages: result.totalPages, total: result.total,
    items: result.items.map(item => ({ tmdbId: item.tmdbId, title: item.title, originalTitle: item.originalTitle, year: item.year })),
  }
}
