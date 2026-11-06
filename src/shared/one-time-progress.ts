import type { WatchJob, WatchRoot } from './model'

/** 取消属于批次终态；已释放路径即使收到迟到成功，也保持原取消决定。 */
export function oneTimeProgress(root: WatchRoot, jobs: WatchJob[]) {
  const latest = new Map(jobs.filter(job => job.watchId === root.id).map(job => [job.path, job]))
  const files = root.batch?.files ?? []
  let processed = 0, cancelled = 0
  for (const path of files) {
    const job = latest.get(path)
    if (root.batch?.releasedFiles?.includes(path) || job?.status === 'cancelled') cancelled++
    else if (job && ['completed', 'duplicate'].includes(job.status)) processed++
  }
  const total = files.length
  return { processed, cancelled, total, allCancelled: total > 0 && cancelled === total,
    settled: total > 0 && processed + cancelled === total }
}
