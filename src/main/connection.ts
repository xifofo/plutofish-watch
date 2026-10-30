/** 上传初始化、续传与最终登记前再核对扫描时的文件身份，防止校验后被同大小文件替换。 */
import { PlutoFishConnection } from '../../vendor/publisher/src/integrations/plutofish/connection'
import { safeWatchFile, sameSignature } from './files'
import type { WatchStore } from './store'
import type { MediaTracks } from '../shared/model'

type Request = Parameters<PlutoFishConnection['request']>

export class WatchConnection extends PlutoFishConnection {
  constructor(options: ConstructorParameters<typeof PlutoFishConnection>[0] = {}) {
    super({ ...options, autoReconnect: true })
  }
  validateFile?: (key: string) => Promise<void>

  override async request<T>(binding: Request[0], path: Request[1], body: Request[2], signal?: Request[3]): Promise<T> {
    const data = body as { action?: string; taskKey?: string; fileKey?: string }
    if (path === 'files/report' || (path === 'uploads/prepare' && ['start', 'credentials', 'verify'].includes(data.action ?? ''))) {
      const key = path === 'files/report' ? data.fileKey : data.taskKey
      if (!key || !this.validateFile) throw new Error('成品任务身份无法确认，已停止上传')
      await this.validateFile(key)
      signal?.throwIfAborted()
    }
    return super.request<T>(binding, path, body, signal)
  }

  /** 补报正片轨道（files/media）。这是监控器自己的接口，共享引擎的路径列表只覆盖引擎内的请求，
   * 因此在这里转换路径类型；鉴权、绑定校验与错误处理仍走引擎的同一请求实现。返回 applied 或 missing。 */
  async reportMedia(binding: Request[0], body: { sourceAccount: string; sha1: string; sizeBytes: number } & MediaTracks, signal?: AbortSignal): Promise<'applied' | 'missing'> {
    const result = await super.request<{ status?: unknown } | null>(binding, 'files/media' as Request[1], body, signal)
    if (result?.status !== 'applied' && result?.status !== 'missing') throw new Error('PlutoFish 轨道补报结果无效')
    return result.status
  }
}

export function validateWatchedFile(store: WatchStore) {
  return async (key: string): Promise<void> => {
    const job = store.data.jobs.find(j => j.fileKey === key && !j.changed && j.status !== 'cancelled')
    const root = store.rootFor(job)
    if (!job || !root?.enabled || store.data.uploadsPaused || job.manuallyPaused) throw new Error('成品任务已停止，不能继续上传')
    if (!sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('成品在上传期间发生变化，已停止原任务')
  }
}
