import type { DirectoryCreation, DirectoryPage, WatchInput } from './model'
import { directorySegments } from './directory-preview'

const sameWork = (input: WatchInput, record: DirectoryCreation) => input.sourceAccountId === record.sourceAccountId
  && input.work.mediaType === record.mediaType && input.work.tmdbId === record.tmdbId

export function directoryCreated(input: WatchInput): boolean {
  const record = input.directoryCreation
  return !!record && sameWork(input, record) && input.directoryId === record.directoryId
    && (input.work.mediaType === 'movie' || input.seasonNumber === record.seasonNumber)
}

export function directoryCreationPending(input: WatchInput): boolean {
  const record = input.directoryCreation
  return !!record && sameWork(input, record) && input.work.mediaType === 'tv'
    && input.seasonNumber !== record.seasonNumber && input.directoryId === record.workDirectoryId
}

/** 修改草稿时只回填已知父目录；所有真实创建仍由按钮触发。 */
export function adjustCreationTarget(input: WatchInput): void {
  const record = input.directoryCreation
  if (!record) return
  if (input.sourceAccountId !== record.sourceAccountId) { delete input.directoryCreation; return }
  if (![record.directoryId, record.workDirectoryId].includes(input.directoryId)) { delete input.directoryCreation; return }
  if (!sameWork(input, record)) {
    input.directoryId = record.parentId; input.directoryPath = record.parentPath
    delete input.directoryCreation
  } else if (input.work.mediaType === 'tv' && input.seasonNumber !== record.seasonNumber) {
    input.directoryId = record.workDirectoryId; input.directoryPath = record.workDirectoryPath
  } else {
    input.directoryId = record.directoryId; input.directoryPath = record.directoryPath
  }
}

export function creationSegments(input: WatchInput, categoryLabel: string): string[] {
  const record = input.directoryCreation
  if (record && sameWork(input, record) && input.work.mediaType === 'tv' && input.directoryId === record.workDirectoryId) {
    return [`season ${String(input.seasonNumber).padStart(2, '0')}`]
  }
  return directorySegments({ title: input.title, categoryLabel, tmdbId: input.work.tmdbId,
    seasonNumber: input.work.mediaType === 'tv' ? input.seasonNumber : undefined })
}

/** 弹窗使用独立草稿；只有明确选中原作品目录才复用该作品的季目录。 */
export function creationDraftForParent(input: WatchInput, parent: { id: string; path: string }): WatchInput {
  const draft = JSON.parse(JSON.stringify(input)) as WatchInput
  draft.directoryId = parent.id; draft.directoryPath = parent.path
  const record = draft.directoryCreation
  if (!record || !sameWork(draft, record) || draft.work.mediaType !== 'tv' || parent.id !== record.workDirectoryId) {
    delete draft.directoryCreation
  }
  return draft
}

export function rememberCreatedDirectory(input: WatchInput, page: DirectoryPage): void {
  const workIndex = page.path.length - (input.work.mediaType === 'tv' ? 2 : 1)
  const previous = input.directoryCreation
  const record: DirectoryCreation = {
    sourceAccountId: input.sourceAccountId, mediaType: input.work.mediaType, tmdbId: input.work.tmdbId,
    seasonNumber: input.work.mediaType === 'tv' ? input.seasonNumber : undefined,
    parentId: previous && sameWork(input, previous) ? previous.parentId : input.directoryId,
    parentPath: previous && sameWork(input, previous) ? previous.parentPath : input.directoryPath,
    directoryId: page.path.at(-1)!.id, directoryPath: '/' + page.path.slice(1).map(p => p.name).join('/'), workDirectoryId: page.path[workIndex].id,
    workDirectoryPath: '/' + page.path.slice(1, workIndex + 1).map(p => p.name).join('/'),
  }
  input.directoryId = record.directoryId
  input.directoryPath = record.directoryPath
  input.directoryCreation = record
}

/** 只持久化形状有效且属于当前账号和作品的界面记忆。 */
export function validateDirectoryCreation(input: WatchInput): DirectoryCreation | undefined {
  const record = input.directoryCreation
  if (record === undefined) return undefined
  if (directoryCreationPending(input)) throw new Error('请创建本季文件夹或手动选择上传目录')
  if (!record || typeof record !== 'object' || !sameWork(input, record)
    || ![record.parentId, record.directoryId, record.workDirectoryId].every(id => typeof id === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(id))
    || ![record.parentPath, record.directoryPath, record.workDirectoryPath].every(path => typeof path === 'string' && path.length <= 4096)
    || ![record.directoryId, record.workDirectoryId].includes(input.directoryId)
    || (record.mediaType === 'tv' && (!Number.isInteger(record.seasonNumber) || record.seasonNumber! < 0 || record.seasonNumber! > 10000))) {
    throw new Error('手动创建目录记录无效，请重新选择上传目录')
  }
  return { sourceAccountId: record.sourceAccountId, mediaType: record.mediaType, tmdbId: record.tmdbId,
    parentId: record.parentId, parentPath: record.parentPath, directoryId: record.directoryId, directoryPath: record.directoryPath,
    workDirectoryId: record.workDirectoryId, workDirectoryPath: record.workDirectoryPath,
    ...(record.mediaType === 'tv' ? { seasonNumber: record.seasonNumber } : {}) }
}
