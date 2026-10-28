/** 手动关联改名/移动后的本地成品；只读取文件，不改名、不上传。 */
import { lstat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { Stats } from 'node:fs'
import type { CompletedMedia, MediaSpecs } from '../../lib/actual-version'
import { probeFinishedMedia } from '../../lib/gvs-record'
import type { PublicationFileNumbers } from './publication-file-types'
export type { PublicationFileChoice, PublicationFileNumbers } from './publication-file-types'
export type PublicationFileIdentity = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev'>
const identityFields = ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'] as const

/** 只回填单集的明确 SxxExx；多集/范围文件不能当作一个视频集号。 */
export function publicationFileNumbers(name: string): PublicationFileNumbers | undefined {
  const matches = [...name.matchAll(/(?:^|[. _-])S(\d{1,5})[. _-]?E(\d{1,6})(?=[. _-]|$)/gi)]
  if (matches.length !== 1) return
  const match = matches[0]!
  if (/^(?:E\d|[. _-]+(?:S\d+[. _-]?)?E\d|-\d+(?=[. _-]|$))/i.test(name.slice(match.index! + match[0].length))) return
  const seasonNumber = Number(match[1]), episodeNumber = Number(match[2])
  if (seasonNumber <= 10000 && episodeNumber <= 100000) return { seasonNumber, episodeNumber }
}

export async function publicationFileIdentity(path: string): Promise<PublicationFileIdentity> {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('请选择有效的本地视频文件')
  let stat: Stats
  try { stat = await lstat(path) } catch { throw new Error('找不到所选文件，请重新选择') }
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) throw new Error('请选择非空的普通视频文件')
  return Object.fromEntries(identityFields.map(field => [field, stat[field]])) as PublicationFileIdentity
}

export function samePublicationFile(a: PublicationFileIdentity, b: PublicationFileIdentity): boolean {
  return identityFields.every(field => a[field] === b[field])
}

export async function inspectPublicationFile(path: string, expectedSize?: number,
  probe: (path: string) => Promise<MediaSpecs> = probeFinishedMedia): Promise<{ identity: PublicationFileIdentity; measured: CompletedMedia }> {
  if (!['.mkv', '.mp4', '.m4v', '.mov', '.ts', '.m2ts', '.avi', '.webm'].includes(extname(path).toLowerCase())) throw new Error('请选择视频文件')
  const identity = await publicationFileIdentity(path)
  if (expectedSize && identity.size !== expectedSize) throw new Error('所选文件大小与下载成品不同，请选择改名或移动后的原视频')
  const media = await probe(path)
  if (!samePublicationFile(identity, await publicationFileIdentity(path))) throw new Error('所选文件在检查期间发生变化，请重新选择')
  if (media.status !== 'probed' || !media.width || !media.height || !media.codec) throw new Error('无法读取所选视频的媒体规格，请检查文件是否完整')
  return { identity, measured: { media, file: { size: identity.size } } }
}
