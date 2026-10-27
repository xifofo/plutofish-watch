/** 一次性文件清单与整目录保留策略；只删除启动时记录且仍未改变的普通文件。 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FolderEntry, LocalRetentionSettings, OneTimeBatch, WatchJob, WatchRoot } from '../shared/model'
import { validateRetention } from '../shared/retention'
import { lockLocalFileDeletion } from '../../vendor/publisher/src/lib/local-file-use'
import { isVideoFile, sameSignature, scanTree, selectedVideoFiles, signature, within } from './files'
import type { WatchStore } from './store'

const DAY = 24 * 3600_000

function folderEntries(root: string): FolderEntry[] {
  const entries: FolderEntry[] = [], pending = [root]
  while (pending.length) {
    const path = pending.pop()!
    const stat = lstatSync(path)
    if (realpathSync(path) !== path || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.dev !== (entries[0]?.signature.dev ?? stat.dev)) {
      throw new Error('目录包含链接、挂载或特殊文件，请关闭自动删除后再上传')
    }
    entries.push({ path: relative(root, path), kind: stat.isDirectory() ? 'directory' : 'file', signature: signature(stat), birthtimeMs: stat.birthtimeMs })
    if (entries.length > 100_000) throw new Error('目录内容过多，请关闭自动删除后再上传')
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name))
  }
  return entries
}

export async function createOneTimeBatch(path: string, cleanup: LocalRetentionSettings, selectedFiles?: string[]): Promise<OneTimeBatch> {
  if (selectedFiles !== undefined) {
    const selection = await selectedVideoFiles(selectedFiles)
    if (selection.path !== path) throw new Error('所选文件不属于本次目录，请重新选择')
    return { files: selection.files, entries: cleanup.enabled
      ? selection.files.map(file => {
        const stat = lstatSync(file)
        if (realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink()) throw new Error('所选文件已变化，请重新选择')
        return { path: relative(path, file), kind: 'file', signature: signature(stat), birthtimeMs: stat.birthtimeMs }
      }) : undefined }
  }
  const files = [...(await scanTree(path)).keys()]
  if (!files.length) throw new Error('所选目录没有可上传的视频文件')
  if (cleanup.enabled && (dirname(path) === path || path === realpathSync(homedir()))) throw new Error('不能自动删除磁盘根目录或用户主目录')
  return { files, entries: cleanup.enabled ? folderEntries(path) : undefined }
}

/** 损坏的批次记录必须停止启动，不能退化为持续监控或扩大删除范围。 */
export function validateOneTimeRoot(root: WatchRoot): void {
  if (root.mode !== undefined && !['watch', 'once'].includes(root.mode)) throw new Error('目录任务类型记录损坏')
  if (root.selectedFiles !== undefined && root.mode !== 'once') throw new Error('文件选择记录损坏')
  if (root.mode !== 'once') return
  const batch = root.batch
  root.cleanup = validateRetention(root.cleanup)
  const validPath = (path: unknown) => typeof path === 'string' && isAbsolute(path) && path !== root.path && within(root.path, path) && resolve(path) === path
  const selected = root.selectedFiles !== undefined
  if (!isAbsolute(root.path) || resolve(root.path) !== root.path || (root.additionalPaths?.length ?? 0) > 0
    || !batch || !Array.isArray(batch.files) || !batch.files.length || batch.files.some(path => !validPath(path))
    || new Set(batch.files).size !== batch.files.length
    || (selected && (!Array.isArray(root.selectedFiles) || root.selectedFiles.length !== batch.files.length
      || root.selectedFiles.some((path, index) => path !== batch.files[index] || dirname(path) !== root.path || !isVideoFile(path))))
    || [batch.completedAt, batch.deleteAt, batch.deletingAt, batch.deletedAt].some(time => time !== undefined && (!Number.isFinite(time) || time < 0))
    || (batch.deleteAt !== undefined && (batch.completedAt === undefined || batch.deleteAt < batch.completedAt + root.cleanup.days * DAY))) {
    throw new Error('一次性上传记录损坏，请保留数据文件后修复')
  }
  if (root.cleanup.enabled && (!Array.isArray(batch.entries) || !batch.entries.length)) throw new Error('目录清理清单损坏')
  if (batch.entries !== undefined && (!Array.isArray(batch.entries) || batch.entries.length > 100_000
    || new Set(batch.entries.map(e => e.path)).size !== batch.entries.length
    || (selected ? batch.entries.length !== batch.files.length
      || batch.entries.some(entry => entry.kind !== 'file' || !batch.files.includes(join(root.path, entry.path)))
      : batch.entries[0]?.path !== '' || batch.entries[0]?.kind !== 'directory')
    || batch.entries.some(entry => typeof entry.path !== 'string' || (entry.path !== '' && (!validPath(join(root.path, entry.path)) || relative(root.path, join(root.path, entry.path)) !== entry.path))
      || !['file', 'directory'].includes(entry.kind) || !Number.isFinite(entry.birthtimeMs)
      || !entry.signature || ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].some(key => !Number.isFinite(entry.signature[key as keyof typeof entry.signature]))))) {
    throw new Error('目录清理清单损坏')
  }
}

/** 文件选择只删除明确列出的文件；父目录和其他内容不参与清理。 */
function deleteSelectedFiles(root: WatchRoot, store: WatchStore, now: number): void {
  const batch = root.batch!, remaining: FolderEntry[] = []
  for (const entry of batch.entries!) {
    const path = join(root.path, entry.path)
    try {
      const stat = lstatSync(path)
      if (realpathSync(path) !== path || !stat.isFile() || stat.isSymbolicLink() || !sameSignature(signature(stat), entry.signature)) {
        throw new Error('所选文件已修改或替换，已停止自动删除；请手动检查')
      }
      remaining.push(entry)
    } catch (error) {
      if (!batch.deletingAt || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const releases: Array<() => void> = []
  try {
    for (const entry of remaining) {
      const release = lockLocalFileDeletion(join(root.path, entry.path))
      if (!release) return
      releases.push(release)
    }
    batch.deletingAt ??= now
    store.save()
    for (const entry of remaining) {
      const path = join(root.path, entry.path)
      if (realpathSync(path) !== path || !sameSignature(signature(lstatSync(path)), entry.signature)) throw new Error('文件在清理期间发生变化，已停止自动删除')
      unlinkSync(path)
    }
    batch.deletedAt = now
  } finally { for (const release of releases) release() }
}

function completedJob(job: WatchJob, jobs: WatchJob[], seen = new Set<string>()): WatchJob | undefined {
  if (job.changed || job.manuallyPaused || seen.has(job.id)) return
  if (job.status === 'completed') return job.synced && job.ed2kSaved && job.ed2k?.state === 'done' && job.ed2k.link ? job : undefined
  if (job.status !== 'duplicate' || !job.duplicateOf || !job.sha1) return
  seen.add(job.id)
  const original = jobs.find(other => other.id === job.duplicateOf)
  return original && original.sha1 === job.sha1 && original.signature.size === job.signature.size ? completedJob(original, jobs, seen) : undefined
}

/** 身份核对和逐项删除之间不让出事件循环；不使用递归删除，新增内容会阻止 rmdir。 */
function deleteFolder(root: WatchRoot, store: WatchStore, now: number): void {
  const batch = root.batch!, expected = batch.entries!
  const actual = folderEntries(root.path)
  const unchanged = (entry: FolderEntry, previous?: FolderEntry) => previous && entry.kind === previous.kind &&
    (entry.kind === 'file' ? sameSignature(entry.signature, previous.signature)
      : entry.signature.dev === previous.signature.dev && entry.signature.ino === previous.signature.ino && entry.birthtimeMs === previous.birthtimeMs)
  const byPath = new Map(expected.map(entry => [entry.path, entry]))
  // 未开始清理时必须完全一致；中途退出后允许已删除项缺失，仍拒绝任何新内容。
  if ((!batch.deletingAt && actual.length !== expected.length) || actual.some(entry => !unchanged(entry, byPath.get(entry.path)))) {
    throw new Error('目录内容已新增、修改或替换，已停止自动删除；请手动检查')
  }
  const releases: Array<() => void> = []
  try {
    for (const entry of actual.filter(e => e.kind === 'file')) {
      const release = lockLocalFileDeletion(join(root.path, entry.path))
      if (!release) return // 本地片段校验仍在使用，下一轮重试。
      releases.push(release)
    }
    batch.deletingAt ??= now
    store.save() // 删除前落盘；中途退出可核对剩余清单。
    for (const entry of actual.filter(e => e.kind === 'file')) {
      const path = join(root.path, entry.path)
      if (realpathSync(path) !== path || !sameSignature(signature(lstatSync(path)), entry.signature)) throw new Error('文件在清理期间发生变化，已停止自动删除')
      unlinkSync(path)
    }
    for (const entry of actual.filter(e => e.kind === 'directory').sort((a, b) => b.path.length - a.path.length)) {
      const path = join(root.path, entry.path), stat = lstatSync(path)
      if (realpathSync(path) !== path || stat.ino !== entry.signature.ino || stat.dev !== entry.signature.dev || stat.birthtimeMs !== entry.birthtimeMs) throw new Error('目录在清理期间发生变化，已停止自动删除')
      rmdirSync(path)
    }
    batch.deletedAt = now
  } finally { for (const release of releases) release() }
}

export class OneTimeBatches {
  private nextCleanup = 0
  constructor(private store: WatchStore, private changed: () => void, private eligible: (root: WatchRoot) => boolean, private now = Date.now) {}

  tick(): void {
    const now = this.now(), clean = now >= this.nextCleanup
    if (clean) this.nextCleanup = now + 60_000
    for (const root of this.store.data.watches) {
      const batch = root.batch
      if (root.mode !== 'once' || !batch || !this.eligible(root) || batch.deletedAt) continue
      const jobs = this.store.data.jobs.filter(j => j.watchId === root.id)
      const completed = batch.files.map(path => {
        const job = jobs.findLast(item => item.path === path)
        return { job, original: job && completedJob(job, this.store.data.jobs) }
      })
      if (completed.some(item => !item.original)) continue
      if (batch.completedAt === undefined) {
        // 本地重复任务可能在原任务生成 ED2K 前就已跳过，整批完成时补齐其历史链接。
        for (const { job, original } of completed) if (job!.status === 'duplicate') {
          job!.ed2k = structuredClone(original!.ed2k); job!.ed2kSaved = true; job!.synced = true
        }
        batch.completedAt = now
        if (root.cleanup?.enabled) batch.deleteAt = now + root.cleanup.days * DAY
        this.store.save(); this.changed()
      }
      if (!clean || !root.cleanup?.enabled || batch.deleteAt === undefined || now < batch.deleteAt || batch.cleanupError) continue
      try {
        if (root.selectedFiles) deleteSelectedFiles(root, this.store, now)
        else deleteFolder(root, this.store, now)
      }
      catch (error) {
        if (batch.deletingAt && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { lstatSync(root.path) }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') batch.deletedAt = now }
        }
        if (!batch.deletedAt) batch.cleanupError = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
          ? error.message : '本地清理失败，已停止自动删除；请检查文件与权限'
      }
      this.store.save(); this.changed()
    }
  }
}
