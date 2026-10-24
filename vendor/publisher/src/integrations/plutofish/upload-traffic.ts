/** 按服务端返回的 rateScope 共享发送预算；分片内的发送进度只用于显示，不作为续传回执。 */
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export type UploadTransfer = {
  sentBytes: number
  bytesPerSecond: number
  etaSeconds?: number
  rateLimit: number
}

/** 相同 scope 共用额度；跨机器共享槽各有独立 scope 和半额 rate，旧服务仍返回账号 scope。 */
export class UploadBudget {
  private rate = 0
  private next = 0
  setRate(rate: number): void { this.rate = rate }
  get limit(): number { return this.rate }
  async take(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.rate) return
    const now = performance.now()
    // 不积攒空闲额度；每次只预约一个小块，两路读取自然轮流使用预算。
    const at = Math.max(now, this.next) + bytes / this.rate * 1000
    this.next = at
    await delay(Math.max(0, at - now), undefined, { signal })
  }
}

/** 小块按背压送入 HTTP 请求；保持 Content-Length、MD5、签名和分片边界不变。 */
export function uploadStream(source: Readable, budget: UploadBudget, signal: AbortSignal, sent?: (bytes: number) => void): Readable {
  let bytes = 0
  return Readable.from((async function* () {
    try {
      for await (const value of source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        for (let offset = 0; offset < buffer.length;) {
          signal.throwIfAborted()
          const size = Math.min(64 * 1024, budget.limit ? Math.max(1024, Math.floor(budget.limit / 10)) : 64 * 1024)
          const chunk = buffer.subarray(offset, offset + size)
          await budget.take(chunk.length, signal)
          offset += chunk.length; bytes += chunk.length
          sent?.(bytes)
          yield chunk
        }
      }
    } finally { source.destroy() }
  })(), { objectMode: false, highWaterMark: 64 * 1024, signal })
}

/** 五秒滑动平均；恢复断点只设基线，不将历史字节算作本次速度。 */
export class UploadMeter {
  private bytes: number
  private samples: Array<{ at: number; bytes: number }>
  constructor(private total: number, initial: number, private now = () => performance.now()) {
    this.bytes = initial
    this.samples = [{ at: now(), bytes: initial }]
  }
  sent(bytes: number): void { this.bytes = Math.max(this.bytes, Math.min(this.total, bytes)) }
  sample(rateLimit: number): UploadTransfer {
    const at = this.now()
    while (this.samples.length > 1 && this.samples[1]!.at <= at - 5000) this.samples.shift()
    const first = this.samples[0]!
    const speed = at > first.at ? Math.max(0, (this.bytes - first.bytes) * 1000 / (at - first.at)) : 0
    this.samples.push({ at, bytes: this.bytes })
    return { sentBytes: this.bytes, bytesPerSecond: speed, rateLimit,
      etaSeconds: speed > 0 && this.bytes < this.total ? Math.ceil((this.total - this.bytes) / speed) : undefined }
  }
}
