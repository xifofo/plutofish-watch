/** 两个发布客户端共用的识别协议、输入与回包校验；密钥仅保留在主进程。 */
import type { PlutoFishConnection } from './connection'
import type { PublicationDraft } from './publication-types'
import type { Recognition, RecognizedWork } from './recognition-types'
export type { Recognition, RecognizedWork, CategoryMatch } from './recognition-types'

function validWork(value: RecognizedWork | null): value is RecognizedWork {
  return !!value && ['movie', 'tv'].includes(value.mediaType) && typeof value.tmdbId === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(value.tmdbId) && Number(value.tmdbId) <= 2147483647 &&
    typeof value.title === 'string' && !!value.title.trim() && [...value.title].length <= 200 &&
    typeof value.originalTitle === 'string' && typeof value.englishTitle === 'string' && typeof value.posterUrl === 'string' &&
    (value.year === undefined || (Number.isInteger(value.year) && value.year > 0 && value.year <= 9999)) &&
    !!value.category && ['matched', 'unmatched', 'unmapped', 'ambiguous', 'disabled'].includes(value.category.status) &&
    ['name', 'value', 'label'].every(key => typeof value.category[key as 'name'] === 'string') &&
    (value.category.status !== 'matched' || (!!value.category.value.trim() && [...value.category.value].length <= 128))
}

/** 验证可自动回填标记与作品、分类、季号一致，拒绝错误服务的伪成功结果。 */
export function validateRecognition(value: Recognition): Recognition {
  const p = value?.parsed
  const invalid = () => { throw new Error('文件名识别结果无效，请重试或手动填写') }
  if (!value || !['compatible', 'review', 'ambiguous', 'not_identified'].includes(value.status) ||
    typeof value.canAutoFill !== 'boolean' || typeof value.truncated !== 'boolean' || typeof value.selectionBasis !== 'string' ||
    !Array.isArray(value.reasons) || value.reasons.some(r => typeof r !== 'string') ||
    !p || typeof p.title !== 'string' || !['unknown', 'movie', 'tv'].includes(p.mediaType) ||
    typeof p.resolution !== 'string' || typeof p.source !== 'string' || !Array.isArray(p.warnings) || p.warnings.some(w => typeof w !== 'string') ||
    [p.seasonNumber, p.seasonEnd, p.episodeNumber, p.episodeEnd].some(n => n !== undefined && (!Number.isInteger(n) || n < 0 || n > 100000)) ||
    (value.work !== null && !validWork(value.work)) || !Array.isArray(value.candidates) || value.candidates.length > 8 ||
    value.candidates.some(c => !c || !validWork(c.work) || !Array.isArray(c.conflicts) ||
      c.conflicts.some(f => !f || ['field', 'expected', 'actual'].some(k => typeof f[k as 'field'] !== 'string')))) invalid()
  const target = value.workTarget, work = value.work
  if (value.canAutoFill) {
    if (value.status !== 'compatible' || value.truncated || value.selectionBasis === 'tmdb_order' || value.reasons.length || p.warnings.length ||
      !target || !work || work.category.status !== 'matched' || target.tmdbId !== work.tmdbId || target.mediaType !== work.mediaType || target.category !== work.category.value ||
      (work.mediaType === 'tv' && (p.seasonNumber === undefined || p.seasonNumber > 10000 || (p.seasonEnd !== undefined && p.seasonEnd !== p.seasonNumber)))) invalid()
  } else if (target !== null) invalid()
  return value
}

/** 单次识别由服务端限时；连接变更由 connection 取消，不向渲染进程暴露 Bearer 密钥。 */
export async function recognizeFile(connection: PlutoFishConnection, binding: PublicationDraft['binding'], fileName: string): Promise<Recognition> {
  if (!binding.sourceAccount) throw new Error('请选择可用的上传账号')
  if (typeof fileName !== 'string' || !fileName.trim() || [...fileName].length > 1000 || /[\x00-\x1f\x7f]/.test(fileName)) {
    throw new Error('请输入不超过 1000 个字符的文件名')
  }
  const signal = AbortSignal.timeout(25_000)
  try {
    const result = await connection.request<Recognition>(binding, 'tmdb/recognize', { sourceAccount: binding.sourceAccount.alias, fileName }, signal)
    return validateRecognition(result)
  } catch (error) {
    if (signal.aborted) throw new Error('文件名识别超时，可重试或继续手动填写')
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) throw new Error('服务端尚不支持文件名识别，请升级服务端或继续手动填写')
    throw error
  }
}
