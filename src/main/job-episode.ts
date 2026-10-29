import { basename, join, relative } from 'node:path'
import type { WatchJob, WatchRoot } from '../shared/model'
import { episodeFromName, requiredWatchPath, seasonFromName } from './files'

/** 只解析所选根目录及其子目录；已登记文件不改归属，旧版本跨季需重新确认。 */
export function resolveJobEpisode(root: WatchRoot, job: WatchJob): void {
  if (job.fileKey || (job.release && job.seasonNumber !== undefined)) return
  if (root.work.mediaType !== 'tv') {
    if (job.release) return
    delete job.seasonNumber; delete job.seasonConfirmed; delete job.seasonReview; delete job.episodeNumber
    return
  }
  const directory = requiredWatchPath(root, job.path)
  const name = join(basename(directory), relative(directory, job.path))
  const detected = seasonFromName(name)
  // 旧版在准备阶段已保存版本，但尚未登记文件，也没有逐文件季号。
  // 版本可能是人工选择，不能静默替换；先保留原绑定，确认后再按正确季号归类。
  if (job.release) {
    if (detected.conflict || (detected.seasonNumber !== undefined && detected.seasonNumber !== root.seasonNumber)) {
      job.seasonReview = detected.conflict
        ? '文件名与目录包含不同季号，旧版本归属需要确认，请确认季号和集号后重新归类'
        : `文件属于第 ${detected.seasonNumber} 季，旧版本绑定第 ${root.seasonNumber} 季，请确认季号和集号后重新归类`
      return
    }
    job.seasonNumber = root.seasonNumber
    return
  }

  if (!job.seasonConfirmed) {
    if (detected.conflict) {
      job.seasonReview = '文件名与目录包含不同季号，请确认季号和集号后入队'
      return
    }
    job.seasonNumber = detected.seasonNumber ?? root.seasonNumber
  }
  delete job.seasonReview
  job.episodeNumber ??= episodeFromName(name, job.seasonNumber!)
}
