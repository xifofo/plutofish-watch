/** 完成上传后响应订阅校验：只读本机持有的成品，绝不请求 115 源账号或下载地址。 */
import type { PlutoFishConnection } from './connection.ts'
import type { PublicationState } from './publication-state.ts'
import { challengeHash, fingerprint } from './upload-file.ts'
import { useLocalFile } from '../../lib/local-file-use.ts'

export interface ProofJob {
  id: string
  taskKey: string
  sha1: string
  sizeBytes: number
  signCheck: string
}

export class PublicationProofs {
  private nextPoll = 0
  private after = ''
  private bindingKey = ''
  private waitSupported = false
  private readonly using = new Map<PublicationState, number>()
  private readonly unavailableUntil = new Map<string, number>()

  constructor(private readonly connection: PlutoFishConnection,
    private readonly changed: (state: PublicationState, message?: string) => void,
    private readonly save: (state: PublicationState) => void = () => {},
    private readonly missing: (state: PublicationState) => void = () => {}) {}

  /** 本地清单清理不能与正在计算或保存身份的任务并发删除同一状态。 */
  isUsing(state: PublicationState): boolean { return this.using.has(state) }

  /** 独立收件循环：长等待不占用上传/快照同步循环，取消时同时结束请求与重连等待。 */
  async run(states: () => PublicationState[], signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.tick(states, signal) } catch { /* 回执和待办持久化，断线后重新领取。 */ }
      if (signal.aborted) return
      const delay = this.connection.ready ? Math.max(50, this.nextPoll - Date.now()) : 2000
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, delay)
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }
  }

  /** 先协商长轮询能力，旧服务端保持 15 秒轮询；翻页立即查询，首轮不会发送未知字段。 */
  async tick(states: PublicationState[] | (() => PublicationState[]), signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.connection.ready) return
    const view = this.connection.view(), source = view.identity?.sourceAccount
    if (!source) return
    const binding = { url: view.url, publisherId: view.identity!.id, sourceAccount: source }
    const bindingKey = JSON.stringify(binding)
    if (bindingKey !== this.bindingKey) {
      this.bindingKey = bindingKey
      this.after = ''
      this.waitSupported = false
      this.nextPoll = 0
      this.unavailableUntil.clear()
    }
    if (Date.now() < this.nextPoll) return
    this.nextPoll = Date.now() + 15_000
    for (const [id, until] of this.unavailableUntil) if (until <= Date.now()) this.unavailableUntil.delete(id)
    const waiting = this.waitSupported && !this.after
    const started = Date.now()
    const reply = await this.connection.request<{ jobs: ProofJob[]; nextCursor?: string; waitSupported?: boolean }>(binding, 'range-proofs/pending',
      { after: this.after, ...(waiting ? { waitSeconds: 25 } : {}) }, signal)
    if (!Array.isArray(reply.jobs) || reply.jobs.length > 100 || (reply.nextCursor !== undefined && typeof reply.nextCursor !== 'string')) throw new Error('PlutoFish 校验任务回执无效')
    let previous = this.after
    for (const job of reply.jobs) {
      if (!job || !/^[a-f0-9]{32}$/.test(job.id) || job.id <= previous || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.taskKey) ||
        !/^[A-F0-9]{40}$/.test(job.sha1) || !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || typeof job.signCheck !== 'string') throw new Error('PlutoFish 校验任务回执无效')
      previous = job.id
    }
    if (reply.nextCursor && (reply.nextCursor !== previous || !reply.jobs.length)) throw new Error('PlutoFish 校验分页回执无效')

    this.waitSupported = reply.waitSupported === true
    // 长等待期间可能刚完成其他上传或清理，收到任务后才取最新本地状态。
    const completed = (typeof states === 'function' ? states() : states).filter(state => {
      if (state.snapshot.stage !== 'completed' || !state.checkpoint?.resource || !state.draft.output || state.retention?.retiring) return false
      try { this.connection.assertBinding(state.draft.binding); return true } catch { return false }
    })
    const byKey = new Map(completed.map(state => [state.draft.fileKey, state]))
    const byFile = new Map(completed.filter(state => state.checkpoint?.file).map(state => {
      const file = state.checkpoint!.file
      return [`${file.sha1}:${file.size}`, state] as const
    }))
    let unavailable = false
    const hashes = new Map<string, Promise<string>>()
    const processJob = async (job: ProofJob) => {
      signal.throwIfAborted()
      // 同一内容可能重复发布；服务端选出的上传记录已不在本机时，可使用同绑定下身份相同的成品。
      const state = byKey.get(job.taskKey) ?? byFile.get(`${job.sha1}:${job.sizeBytes}`)
      const file = state?.checkpoint?.file
      if (file && (job.sha1 !== file.sha1 || job.sizeBytes !== file.size)) throw new Error('PlutoFish 校验任务文件身份不一致')
      if ((this.unavailableUntil.get(job.id) ?? 0) > Date.now()) { unavailable = true; return }
      if (state) this.using.set(state, (this.using.get(state) ?? 0) + 1)
      let releaseFile: (() => void) | undefined
      try {
        let signValue: string
        try {
          if (!state || !file || state.retention?.retiring) throw new Error('本机没有该成品的发布记录')
          releaseFile = useLocalFile(state.draft.output)
          // 每页同内容同范围只读取一次；页内复用随本次轮询结束释放，服务端不跨任务缓存。
          const cacheKey = `${file.sha1}:${file.size}:${job.signCheck}`
          let pending = hashes.get(cacheKey)
          if (!pending) {
            const expected = file
            pending = (async () => {
              try { return await challengeHash(state.draft.output, job.signCheck, expected, signal) }
              catch (error) {
                // 先验证范围，再处理恢复原文件导致的 mtime 变化；完整 SHA1 相符才允许继续。
                if (!(error instanceof Error) || error.message !== '成品已改变，不能复用原上传断点') throw error
                const restored = await fingerprint(state.draft.output, signal)
                if (restored.size !== expected.size || restored.sha1 !== expected.sha1) throw new Error('成品内容已经改变')
                state.checkpoint!.file = restored
                this.save(state)
                return challengeHash(state.draft.output, job.signCheck, restored, signal)
              }
            })()
            // 共享进行中的计算，两个工作协程遇到同一范围也只读一次。
            hashes.set(cacheKey, pending)
          }
          signValue = await pending
        } catch (error) {
          signal.throwIfAborted()
          if (state && (error as NodeJS.ErrnoException).code === 'ENOENT') this.missing(state)
          await this.connection.request(binding, 'range-proofs/report', { id: job.id, taskKey: job.taskKey, unavailable: true }, signal)
          unavailable = true
          this.unavailableUntil.set(job.id, Date.now() + 60_000)
          if (state) this.changed(state, '本地成品不可用，已通知服务端处理校验')
          return
        }
        const result = await this.connection.request<{ accepted: boolean }>(binding, 'range-proofs/report', { id: job.id, taskKey: job.taskKey, signValue }, signal)
        if (result.accepted !== true) throw new Error('PlutoFish 校验回执未确认')
        this.unavailableUntil.delete(job.id)
        if (state) this.changed(state)
      } finally {
        releaseFile?.()
        // 同一成品可能同时服务两个挑战；最后一个处理者退出后才允许清理清单。
        if (state) {
          const remaining = (this.using.get(state) ?? 1) - 1
          if (remaining) this.using.set(state, remaining)
          else this.using.delete(state)
        }
      }
    }
    // 每个发布端最多两个本地校验任务，回执也在名额内，避免网络变慢时无限堆积摘要。
    // 任一任务出错后停止领取本页后续任务；等另一个已开始的任务结束再退出，不遗留后台读写。
    let index = 0, failed = false
    let failure: unknown
    const worker = async () => {
      while (!failed && index < reply.jobs.length) {
        const job = reply.jobs[index++]!
        try { await processJob(job) }
        catch (error) { if (!failed) { failed = true; failure = error } }
      }
    }
    await Promise.all([worker(), worker()])
    if (failed) throw failure

    // 整页处理成功才前移。不可用待办可能等待手动执行，避免对它反复立即查询。
    this.after = reply.nextCursor ?? ''
    this.nextPoll = this.after || (this.waitSupported && !unavailable) ? 0 : Date.now() + 15_000
    // 代理或异常服务立即返回空长轮询时防止忙循环；正常 25 秒空返回后立即续接。
    if (waiting && this.waitSupported && !reply.jobs.length && Date.now() - started < 500) this.nextPoll = Date.now() + 2000
  }
}
