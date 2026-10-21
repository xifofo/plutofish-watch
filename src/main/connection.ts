/** 上传初始化、续传与最终登记前再核对扫描时的文件身份，防止校验后被同大小文件替换。 */
import { PlutoFishConnection } from '../../vendor/publisher/src/integrations/plutofish/connection'
import { safeFile, sameSignature } from './files'
import type { WatchStore } from './store'

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
}

export function validateWatchedFile(store: WatchStore) {
  return async (key: string): Promise<void> => {
    const job = store.data.jobs.find(j => j.fileKey === key && !j.changed && j.status !== 'cancelled')
    const root = store.data.watches.find(w => w.id === job?.watchId)
    if (!job || !root?.enabled || store.data.uploadsPaused || job.manuallyPaused) throw new Error('成品任务已停止，不能继续上传')
    if (!sameSignature(await safeFile(root.path, job.path), job.signature)) throw new Error('成品在上传期间发生变化，已停止原任务')
  }
}
