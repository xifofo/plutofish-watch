import type { WatchJob, WatchRoot } from './model'

/** 季号属于文件；固定版本只适用于其原季，跨季重新查询和归类版本。 */
export function jobTarget(root: WatchRoot, job: WatchJob): WatchRoot {
  const target = job.watchSnapshot ?? root
  const seasonNumber = target.work.mediaType === 'tv' ? job.seasonNumber ?? target.seasonNumber : undefined
  return { ...target, enabled: root.enabled, seasonNumber,
    ...(seasonNumber !== target.seasonNumber ? { versionMode: 'auto', releaseId: '', releaseName: '自动归类', releaseVersion: undefined } : {}) }
}
