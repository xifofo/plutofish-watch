/** 正片轨道补报：上传时 ffprobe 读出的音轨与字幕轨，在资源登记完成后补报给 PlutoFish（files/media），
 * 服务端据此给版本标注「特效字幕」「双语字幕」「国语」等。补报只是展示信息，失败不影响上传与交付：
 *   - 每次只补报一个任务，与上传共用 1 秒节拍，不并发占用连接或磁盘；
 *   - missing（资源尚未登记）与可恢复错误按 30 秒到 6 小时退避，最多 5 次；其余错误（旧服务端 404、参数无效、源账号撤权）
 *     本次运行不再尝试，下次启动再给一次机会，服务端升级后历史任务也能补齐；
 *   - 历史任务没有轨道时，原文件仍在且未改变才重新探测，文件已清理或改变则跳过。 */
import { retryableError } from '../../vendor/publisher/src/integrations/plutofish/retry'
import type { WatchConnection } from './connection'
import { safeWatchFile, sameSignature } from './files'
import { findProbe, probeFile } from './probe'
import type { WatchStore } from './store'
import type { MediaTracks, WatchJob } from '../shared/model'

const delays = [30_000, 120_000, 600_000, 3_600_000, 21_600_000]

export class MediaReporter {
  private running?: Promise<void>
  constructor(private store: WatchStore, private connection: WatchConnection, private now: () => number = Date.now) {}

  /** 启动时调用：已完成但从未补报的历史任务排队，上次跳过的任务重新排队一次。返回是否有改动需要落盘。 */
  restore(): boolean {
    let changed = false
    for (const job of this.store.data.jobs) {
      if (job.status !== 'completed' || !job.sha1 || job.changed) continue
      if (!job.media || job.media.state === 'skipped') {
        job.media = { state: 'pending', attempts: 0 }
        changed = true
      }
    }
    return changed
  }

  /** 新探测的轨道：等待资源登记完成后补报。 */
  record(job: WatchJob, tracks: MediaTracks): void {
    job.tracks = tracks
    job.media = { state: 'pending', attempts: 0 }
  }

  /** 补报一个到期的任务；上一次还在进行时直接返回。请求与探测的错误只改变该任务的补报状态，只有落盘失败会抛出。 */
  async tick(): Promise<void> {
    if (this.running) return
    const job = this.store.data.jobs.find(j => j.status === 'completed' && j.media?.state === 'pending' && !j.changed
      && j.sha1 && (j.media.nextAt ?? 0) <= this.now())
    if (!job) return
    this.running = this.report(job).finally(() => { this.running = undefined })
    await this.running
  }

  private async report(job: WatchJob): Promise<void> {
    const media = job.media!
    const root = this.store.rootFor(job)
    const sourceAccount = root?.binding.sourceAccount?.alias
    try {
      if (!root || !sourceAccount) throw new Error('监控目录已移除')
      if (!job.tracks) {
        // 历史任务按原文件补探测；文件已被清理或内容改变时不能用其他内容冒充。
        const signal = AbortSignal.timeout(120_000)
        if (!sameSignature(await safeWatchFile(root, job.path), job.signature)) throw new Error('原文件已改变')
        const { tracks } = await probeFile(findProbe(this.store.data.ffprobe), job.path, job.signature.size, signal)
        job.tracks = tracks
      }
      const status = await this.connection.reportMedia(root.binding, { sourceAccount, sha1: job.sha1!, sizeBytes: job.signature.size, ...job.tracks })
      if (status === 'applied') {
        job.media = { state: 'done', attempts: media.attempts + 1 }
        delete job.tracks
      } else this.later(job, media)
    } catch (error) {
      if (retryableError(error)) this.later(job, media)
      else job.media = { state: 'skipped', attempts: media.attempts + 1 }
    }
    // 落盘失败与其他保存一样向上抛出，由发布器按致命错误停止，不能静默丢失状态。
    this.store.save()
  }

  private later(job: WatchJob, media: NonNullable<WatchJob['media']>): void {
    const attempts = media.attempts + 1
    job.media = attempts >= delays.length ? { state: 'skipped', attempts } : { state: 'pending', attempts, nextAt: this.now() + delays[attempts - 1] }
  }
}
