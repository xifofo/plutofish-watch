/** 目录编辑在扫描和上传暂停后应用；已登记任务保留原配置，未登记文件重新等待稳定。 */
import type { WatchRoot } from '../shared/model'
import { WatchStore } from './store'
import { episodeFromName } from './files'

export function applyWatchEdit(store: WatchStore, root: WatchRoot, next: WatchRoot, now = Date.now()): void {
  const moved = root.path !== next.path
  const targetChanged = JSON.stringify([root.binding, root.work, root.seasonNumber, root.versionMode ?? 'fixed', root.releaseId, root.sourcePreset, root.directoryId])
    !== JSON.stringify([next.binding, next.work, next.seasonNumber, next.versionMode ?? 'fixed', next.releaseId, next.sourcePreset, next.directoryId])
  const workChanged = JSON.stringify([root.work, root.seasonNumber]) !== JSON.stringify([next.work, next.seasonNumber])
  const stabilityChanged = root.stableSeconds !== next.stableSeconds
  for (const job of store.data.jobs.filter(j => j.watchId === root.id)) {
    if (job.fileKey || ['completed', 'duplicate', 'cancelled'].includes(job.status)) {
      job.watchSnapshot ??= structuredClone(root)
      continue
    }
    if (moved) {
      job.watchSnapshot = structuredClone(root)
      job.status = 'cancelled'; job.error = '监控路径已更换，原路径中未开始发布的任务已停止'
    } else if ((targetChanged || stabilityChanged) && !job.changed) {
      if (targetChanged) {
        delete job.release; delete job.versionReview; delete job.sourceOverride
        delete job.targetKey; delete job.retry; delete job.preparationError
      }
      if (workChanged) job.episodeNumber = next.work.mediaType === 'tv' ? episodeFromName(job.relativePath, next.seasonNumber!) : undefined
      job.status = job.manuallyPaused ? 'paused' : 'waiting'; job.error = ''
      const observation = store.data.observations[root.id]?.[job.path]
      if (observation && targetChanged) observation.stableSince = now
    }
    job.updatedAt = new Date(now).toISOString()
  }
  Object.assign(root, next)
  // 换了版本、季或账号后按新目标重新核对历史文件的追更进度。
  if (targetChanged) delete root.progressAt
  // Object.assign 不会移除已省略的可选字段；电影必须真正清掉原季号。
  if (next.work.mediaType === 'movie') delete root.seasonNumber
  if (!next.directoryCreation) delete root.directoryCreation
  if (moved) {
    root.initialized = false
    delete root.lastScan; delete root.error
    delete store.data.observations[root.id]
  }
  store.save()
}
