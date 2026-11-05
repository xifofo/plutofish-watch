/** 服务端租约为 240 秒；临时网络故障允许续期重试，120 秒未确认即停止，留出安全余量。 */
import { PublisherError, retryableError } from './retry'

export class UploadHeartbeat {
  private confirmedAt?: number
  private timer?: ReturnType<typeof setInterval>
  private pulse?: Promise<void>
  private error?: unknown
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal

  constructor(signal: AbortSignal, private readonly renew: (signal: AbortSignal) => Promise<unknown>,
    private readonly failed: (error: unknown) => void, private readonly now = Date.now) {
    this.signal = AbortSignal.any([signal, this.abort.signal])
  }

  /** 使用请求开始时间，避免慢响应把本地租约寿命延长到服务端过期之后。 */
  confirmed(started: number): void {
    if (this.signal.aborted) return
    this.confirmedAt = Math.max(this.confirmedAt ?? started, started)
    this.error = undefined
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick() }, 20_000)
      this.timer.unref?.()
    }
  }

  async tick(): Promise<void> {
    if (this.signal.aborted || this.confirmedAt === undefined) return
    if (this.now() - this.confirmedAt >= 120_000) {
      this.failed(this.error ?? new PublisherError('上传租约续期超时，将沿原断点重试', true, undefined, { stage: '续期上传租约', code: 'UPLOAD_HEARTBEAT_TIMEOUT' }))
      return
    }
    if (this.pulse) return
    const started = this.now()
    this.pulse = this.renew(AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]))
      .then(() => { this.confirmed(started) })
      .catch(error => {
        if (this.signal.aborted) return
        this.error = error
        // 租约被占用、撤权或业务拒绝必须立即停，不能作为短暂断网继续传输。
        if (!retryableError(error) || (error instanceof PublisherError && error.diagnostic?.httpStatus === 409) || this.now() - this.confirmedAt! >= 120_000) this.failed(error)
      }).finally(() => { this.pulse = undefined })
    await this.pulse
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.abort.abort()
    await this.pulse
  }
}
