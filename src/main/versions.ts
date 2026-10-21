/** 逐文件选择同作品同季版本；查询失败保留失败语义，不当作空候选。 */
import { releaseChoices } from '../../vendor/publisher/src/integrations/plutofish/release-selection'
import type { PlutoFishConnection } from '../../vendor/publisher/src/integrations/plutofish/connection'
import type { WatchRoot } from '../shared/model'
import { releaseKey } from './bindings'

export async function watchVersionChoices(connection: PlutoFishConnection, root: WatchRoot, signal: AbortSignal, key = releaseKey(root)) {
  const choices = await releaseChoices({
    request: (binding, path, body) => connection.request(binding, path, body, signal),
  }, [{
    schemaVersion: 1, binding: root.binding, workTarget: root.work, seasonNumber: root.seasonNumber,
    releaseKey: key, fileKey: '', title: root.title, categoryLabel: root.work.category,
    kind: 'video', output: '', updatedAt: new Date().toISOString(),
  }], '')
  signal.throwIfAborted()
  return choices
}
