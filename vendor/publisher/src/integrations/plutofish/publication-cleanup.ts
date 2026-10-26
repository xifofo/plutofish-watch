/** 清理已确认上传完成且本地成品已删除的发布清单；先通知服务端，失败保留记录供重试。 */
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlutoFishConnection } from './connection.ts'
import type { PublicationState } from './publication-state.ts'

const completed = (state: PublicationState) => state.snapshot.stage === 'completed' &&
  !state.pendingFailures?.length && state.acknowledged >= state.snapshot.sequence && !!state.checkpoint?.resource && !!state.draft.output

export class PublicationCleanup {
  private queue: string[] = []
  private readonly priority = new Set<string>()
  private nextScan = 0
  private retryAt = 0

  constructor(private readonly connection: PlutoFishConnection, private readonly remove: (state: PublicationState) => void,
    private readonly beforeRemove: () => void = () => {},
    private readonly confirmedMissing: (state: PublicationState) => void = () => {}) {}

  /** 校验过程中发现文件缺失时优先复查，仍需确认完成回执及目录可访问。 */
  missing(state: PublicationState): void { this.priority.add(state.draft.fileKey) }

  /** 每个 worker 周期最多检查 50 个路径，一轮结束后每分钟复查；只 stat，不读取视频。 */
  async tick(states: Map<string, PublicationState>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.connection.ready || Date.now() < this.retryAt) return
    if (!this.queue.length && Date.now() >= this.nextScan) {
      this.queue = [...states.values()].filter(completed).map(state => state.draft.fileKey)
      this.nextScan = Date.now() + 60_000
    }
    const keys = new Set([...this.priority].slice(0, 50))
    for (const key of keys) this.priority.delete(key)
    while (keys.size < 50 && this.queue.length) keys.add(this.queue.shift()!)

    const missing: PublicationState[] = []
    for (const key of keys) {
      signal.throwIfAborted()
      const state = states.get(key)
      if (!state || !completed(state)) continue
      try { this.connection.assertBinding(state.draft.binding) } catch { continue }
      try { await stat(state.draft.output) }
      catch (error) {
        // 权限错误、I/O 故障和挂载目录消失不能证明用户删了文件，留待下一轮复查。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        try { if (!(await stat(dirname(state.draft.output))).isDirectory()) continue } catch { continue }
        missing.push(state)
      }
    }
    signal.throwIfAborted()
    if (!missing.length) return

    try {
      const reply = await this.connection.request<{ accepted: boolean }>(missing[0]!.draft.binding, 'range-proofs/forget',
        { taskKeys: missing.map(state => state.draft.fileKey) }, signal)
      if (reply.accepted !== true) throw new Error('PlutoFish 本地成品清理未确认')
      signal.throwIfAborted()
      // 桌面端先把已完成状态同步写入下载历史，避免崩溃后旧历史重新创建已删除清单。
      for (const state of missing) this.confirmedMissing(state)
      this.beforeRemove()
      for (const state of missing) this.remove(state)
    } catch (error) {
      // 网络或落盘失败都保留本地记录；服务端接口幂等，重启后也可以安全补办。
      for (const state of missing) this.priority.add(state.draft.fileKey)
      this.retryAt = Date.now() + 15_000
      throw error
    }
  }
}
