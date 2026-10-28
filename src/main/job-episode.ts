import { basename, join, relative } from 'node:path'
import type { WatchJob, WatchRoot } from '../shared/model'
import { episodeFromName, requiredWatchPath, seasonFromName } from './files'

/** 只解析所选根目录及其子目录，外部祖先目录不参与判断。已确认版本、已登记文件不改归属。 */
export function resolveJobEpisode(root: WatchRoot, job: WatchJob): void {
  if (job.fileKey || job.release) return
  if (root.work.mediaType !== 'tv') {
    delete job.seasonNumber; delete job.seasonConfirmed; delete job.seasonReview; delete job.episodeNumber
    return
  }
  const directory = requiredWatchPath(root, job.path)
  const name = join(basename(directory), relative(directory, job.path))
  if (!job.seasonConfirmed) {
    const detected = seasonFromName(name)
    if (detected.conflict) {
      job.seasonReview = '文件名与目录包含不同季号，请确认季号和集号后入队'
      return
    }
    job.seasonNumber = detected.seasonNumber ?? root.seasonNumber
  }
  delete job.seasonReview
  job.episodeNumber ??= episodeFromName(name, job.seasonNumber!)
}
