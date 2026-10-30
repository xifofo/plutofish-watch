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

/** 包括本地读取和回执的总在途上限；单个范围最多 8 MiB，不随订阅人数创建工作协程。 */
export const PUBLICATION_PROOF_CONCURRENCY = 16

export class PublicationProofs {
  private nextPoll = 0
  private after = ''
  private bindingKey = ''
  private waitSupported = false
  private idlePollDelay = 1000
  private readonly using = new Map<PublicationState, number>()
  private readonly warned = new WeakSet<PublicationState>()
  private readonly unavailableUntil = new Map<string, number>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly restoring = new Map<string, Promise<Awaited<ReturnType<typeof fingerprint>>>>()
  private replay = 0
  private waitForActive = false
  private activeChanged?: () => void

  constructor(private readonly connection: PlutoFishConnection,
    private readonly changed: (state: PublicationState, message?: string) => void,
    private readonly save: (state: PublicationState) => void = () => {},
    private readonly missing: (state: PublicationState) => void = () => {}) {}

  /** 本地清单清理不能与正在计算或保存身份的任务并发删除同一状态。 */
  isUsing(state: PublicationState): boolean { return this.using.has(state) }

  /** 独立收件循环：长等待不占用上传/快照同步循环，取消时同时结束请求与重连等待。 */
  async run(states: () => PublicationState[], signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        // 满额时等待一个真实任务释放，避免重复领取、无限排队或为了空闲槽忙轮询。
        if (this.active.size >= PUBLICATION_PROOF_CONCURRENCY) {
          await Promise.race(this.active.values())
          continue
        }
        try { await this.tick(states, signal, true) } catch {
          // 收件失败也从首页恢复，短暂退避不会白白消耗旧版 15 秒轮询周期。
          this.after = ''
          this.nextPoll = Date.now() + 1000
          this.waitForActive = false
        }
        if (signal.aborted) return
        if (this.waitForActive && !this.active.size) this.nextPoll = 0
        // 有下一页或需要续接长轮询时直接领取；满额由上方真实回执释放唤醒。
        // 空页、不可用文件及失败仍按各自退避等待，避免固定停顿拖慢每批计算。
        const delay = this.connection.ready ? Math.max(0, this.nextPoll - Date.now()) : 2000
        if (!delay) continue
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            if (this.activeChanged === wake) this.activeChanged = undefined
            resolve()
          }
          const wake = () => {
            if (this.waitForActive) this.nextPoll = 0
            finish()
          }
          const timer = setTimeout(finish, delay)
          // 只见到自己的在途任务时，回执结束就续查；250ms 兜底仍可发现后来新建的挑战。
          if (this.waitForActive) this.activeChanged = wake
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish()
        })
      }
    } finally {
      // 关闭客户端时，所有读取和回执退出后才能清理文件及发布清单。
      await Promise.all(this.active.values())
    }
  }

  /** 每页最多保留 100 条待办，仅有空闲槽时启动；后台不等最后一批回执即可继续翻页。 */
  async tick(states: PublicationState[] | (() => PublicationState[]), signal: AbortSignal, background = false): Promise<void> {
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
      this.idlePollDelay = 1000
      this.nextPoll = 0
      this.unavailableUntil.clear()
    }
    if (Date.now() < this.nextPoll) return
    this.waitForActive = false
    this.nextPoll = Date.now() + 1000
    for (const [id, until] of this.unavailableUntil) if (until <= Date.now()) this.unavailableUntil.delete(id)
    const after = this.after, generation = this.replay
    const waiting = this.waitSupported && !after
    const started = Date.now()
    const reply = await this.connection.request<{ jobs: ProofJob[]; nextCursor?: string; waitSupported?: boolean }>(binding, 'range-proofs/pending',
      { after, ...(waiting ? { waitSeconds: 25 } : {}) }, signal)
    // 请求期间有旧回执失败时保留首页重查，不让迟到的分页响应覆盖重放位置。
    if (generation !== this.replay || bindingKey !== this.bindingKey) return
    if (!Array.isArray(reply.jobs) || reply.jobs.length > 100 || (reply.nextCursor !== undefined && typeof reply.nextCursor !== 'string')) throw new Error('PlutoFish 校验任务回执无效')
    let previous = after
    for (const job of reply.jobs) {
      if (!job || !/^[a-f0-9]{32}$/.test(job.id) || job.id <= previous || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.taskKey) ||
        !/^[A-F0-9]{40}$/.test(job.sha1) || !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || typeof job.signCheck !== 'string') throw new Error('PlutoFish 校验任务回执无效')
      previous = job.id
    }
    if (reply.nextCursor && (reply.nextCursor !== previous || !reply.jobs.length)) throw new Error('PlutoFish 校验分页回执无效')

    this.waitSupported = reply.waitSupported === true
    if (reply.jobs.length || this.waitSupported) this.idlePollDelay = 1000
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
    let unavailable = false, skipped = false
    const hashes = new Map<string, Promise<string>>()
    const processJob = async (job: ProofJob) => {
      signal.throwIfAborted()
      // 同一内容可能重复发布；服务端选出的上传记录已不在本机时，可使用同绑定下身份相同的成品。
      const state = byKey.get(job.taskKey) ?? byFile.get(`${job.sha1}:${job.sizeBytes}`)
      const file = state?.checkpoint?.file
      // 同 Key 的其他客户端也会收到待办；没有本机成品记录不等于发布端整体不可用。
      // 刚登记成功但本机尚未切到 completed 的任务也先跳过，下一轮用最新状态重查。
      if (!state || !file || state.retention?.retiring) { skipped = true; return }
      if (file && (job.sha1 !== file.sha1 || job.sizeBytes !== file.size)) throw new Error('PlutoFish 校验任务文件身份不一致')
      if ((this.unavailableUntil.get(job.id) ?? 0) > Date.now()) { unavailable = true; return }
      if (state) this.using.set(state, (this.using.get(state) ?? 0) + 1)
      let releaseFile: (() => void) | undefined
      try {
        let signValue: string
        try {
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
                // 不同范围同时发现文件身份变化时，共享一次完整文件读取，避免十六路重扫整部影片。
                const path = state.draft.output
                const restoreKey = `${bindingKey}:${path}`
                let restoring = this.restoring.get(restoreKey)
                if (!restoring) {
                  restoring = fingerprint(path, signal).finally(() => { this.restoring.delete(restoreKey) })
                  this.restoring.set(restoreKey, restoring)
                }
                const restored = await restoring
                if (restored.size !== expected.size || restored.sha1 !== expected.sha1) throw new Error('成品内容已经改变')
                if (state.checkpoint!.file !== restored) {
                  state.checkpoint!.file = restored
                  this.save(state)
                }
                return challengeHash(state.draft.output, job.signCheck, restored, signal)
              }
            })()
            // 共享进行中的计算，多个工作协程遇到同一范围也只读一次。
            hashes.set(cacheKey, pending)
          }
          signValue = await pending
        } catch (error) {
          signal.throwIfAborted()
          if (state && (error as NodeJS.ErrnoException).code === 'ENOENT') this.missing(state)
          await this.connection.request(binding, 'range-proofs/report', { id: job.id, taskKey: job.taskKey, unavailable: true }, signal)
          unavailable = true
          this.unavailableUntil.set(job.id, Date.now() + 60_000)
          if (state) {
            this.warned.add(state)
            this.changed(state, '本机成品暂不可用，其他客户端仍可继续校验')
          }
          return
        }
        const result = await this.connection.request<{ accepted: boolean }>(binding, 'range-proofs/report', { id: job.id, taskKey: job.taskKey, signValue }, signal)
        if (result.accepted !== true) throw new Error('PlutoFish 校验回执未确认')
        this.unavailableUntil.delete(job.id)
        // 成功摘要不改变发布任务状态；不要让每个订阅回执触发 UI 和整份清单同步写盘。
        // 只有恢复了本流程之前展示的不可用提示，才需要通知界面清除它。
        if (state && this.warned.delete(state)) this.changed(state)
      } finally {
        releaseFile?.()
        // 同一成品可能同时服务多个挑战；最后一个处理者退出后才允许清理清单。
        if (state) {
          const remaining = (this.using.get(state) ?? 1) - 1
          if (remaining) this.using.set(state, remaining)
          else this.using.delete(state)
        }
      }
    }
    // 当前响应至多 100 条，按空闲槽消费完再翻页；不要丢弃已取得的页尾，
    // 否则每释放一个槽就会重新查库、传输同一批尚未启动的挑战。
    // 回执失败后从首页重查，绝不因前移游标丢掉未确认的回执。
    let index = 0, failed = false
    let failure: unknown
    const startedJobs: Promise<void>[] = []
    while (!failed && generation === this.replay && bindingKey === this.bindingKey && index < reply.jobs.length) {
      const job = reply.jobs[index]!
      const key = `${bindingKey}:${job.id}`
      if (this.active.has(key)) { index++; continue }
      if (this.active.size >= PUBLICATION_PROOF_CONCURRENCY) {
        await Promise.race(this.active.values())
        continue
      }
      index++
      const work = processJob(job).catch(error => {
        if (!failed) { failed = true; failure = error }
        if (background && bindingKey === this.bindingKey) {
          this.replay++
          this.after = ''
          this.nextPoll = Date.now() + 1000
          this.waitForActive = false
        }
      }).finally(() => { this.active.delete(key); this.activeChanged?.() })
      this.active.set(key, work)
      startedJobs.push(work)
    }
    if (!background) {
      await Promise.all(startedJobs)
      if (failed) throw failure
    }
    if (generation !== this.replay || bindingKey !== this.bindingKey) return

    // 本页已经全部启动或跳过；没有取完的页只可能发生在失败重放时，已在上方返回。
    this.after = reply.nextCursor ?? ''
    this.nextPoll = this.after ? 0 : skipped && this.waitSupported ? Date.now() + 1000
      : this.waitSupported ? (unavailable ? Date.now() + 1000 : 0) : Date.now() + this.idlePollDelay
    // 通知暂不可用或旧服务端：有任务时一秒后再查；连续空闲才退避到 15 秒。
    if (!this.waitSupported && !reply.jobs.length) this.idlePollDelay = Math.min(15_000, this.idlePollDelay * 2)
    // 只看到仍在等待回执的挑战时小幅退避；新任务不被单个慢回执挡住整页。
    if (background && reply.jobs.length && !startedJobs.length && !skipped && !unavailable && this.active.size) {
      this.waitForActive = true
      this.nextPoll = Date.now() + 250
    }
    // 代理或异常服务立即返回空长轮询时防止忙循环；正常 25 秒空返回后立即续接。
    if (waiting && this.waitSupported && !reply.jobs.length && Date.now() - started < 500) this.nextPoll = Date.now() + 2000
  }
}
