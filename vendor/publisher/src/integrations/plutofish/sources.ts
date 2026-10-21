/** 从当前授权集合选择上传目标；不以默认账号替代被撤销的任务账号。 */
import type { PlutoFishView, PublisherIdentity, PublisherSource } from './types'

/** 旧服务端没有账号集合时，只允许原有的单个账号。 */
export function publisherSources(identity?: PublisherIdentity | null): PublisherSource[] {
  return identity?.sourceAccounts ?? (identity?.sourceAccount ? [identity.sourceAccount] : [])
}

/** 固定选中的账号；网盘平台标识随账号返回，不能由调用方伪造。 */
export function publicationSource(view: PlutoFishView, id?: string): PublisherSource {
  const source = publisherSources(view.identity).find(s => s.id === (id ?? view.identity?.sourceAccount.id) && s.enabled !== false)
  if (view.status !== 'verified' || !source) throw new Error('所选网盘账号已不可用，请重新选择上传账号')
  if ((source.provider ?? '115') !== '115') throw new Error('当前发布端尚不支持此网盘平台上传')
  return source
}
