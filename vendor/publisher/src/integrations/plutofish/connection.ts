/** 强制连接状态机：每次启动重验，过期请求不能放行，运行中定时重验。 */
import { PublisherError, retryableError, retryableHTTP, retryAfter, retryDelay, transportError } from './retry'
import { failureDetails, httpFailureDetails } from './publication-error'
import { UploadRateLimitError } from './upload-pause'
import { loadPlutoFishConfig, savePlutoFishConfig } from './config.ts'
import { normalizePlutoFishURL, verifyPublisher } from './client.ts'
import type { PlutoFishInput, PlutoFishView, PublisherIdentity, PublisherDirectoryPage } from './types.ts'
import { publisherSources } from './sources.ts'
import type { PublicationDraft } from './publication-types.ts'

type Options = {
  load?: () => PlutoFishInput
  save?: (input: PlutoFishInput) => void
  verify?: (input: PlutoFishInput, signal: AbortSignal) => Promise<PublisherIdentity>
  changed?: () => void
  intervalMs?: number
  /** 监控器可自动重连；下载器双重鉴权保持原手动恢复行为。 */
  autoReconnect?: boolean
  retryBaseMs?: number
  retryMaxMs?: number
}

export class PlutoFishConnection {
  private saved: PlutoFishInput = { url: '', key: '' }
  private state: PlutoFishView = { url: '', hasKey: false, status: 'idle', error: '', identity: null }
  private generation = 0
  private abort?: AbortController
  private requestAbort = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private monitoring = false
  private failures = 0
  private retryInput?: PlutoFishInput
  private verifying = false
  private closed = false

  constructor(private readonly options: Options = {}) {
    try {
      this.saved = (options.load ?? loadPlutoFishConfig)()
      this.state.url = this.saved.url
      this.state.hasKey = !!this.saved.key
    } catch {
      this.state.status = 'error'
      this.state.error = 'PlutoFish 配置读取失败，请重新填写连接信息'
    }
  }

  get ready(): boolean { return !this.closed && this.state.status === 'verified' }
  get groupedUploads(): boolean { return this.ready && this.state.identity?.capabilities?.uploadClientGrouping === true }
  view(): PlutoFishView {
    return { ...structuredClone(this.state), uploadNotice: this.ready && !this.groupedUploads
      ? '服务端尚未声明支持双文件上传，已使用单文件兼容模式；其他文件仍会提前准备。' : undefined }
  }
  assertReady(): void { if (!this.ready) throw new PublisherError('请先完成网关与 PlutoFish 双重鉴权', !!(this.options.autoReconnect && this.monitoring && (this.state.reconnect || this.verifying)) && !this.closed) }

  /** 绑定或权限变化后，尚未发送的 OSS 分片也必须停止。 */
  assertBinding(binding: PublicationDraft['binding']): void {
    this.assertReady()
    const current = this.view()
    if (binding.url !== current.url || binding.publisherId !== current.identity?.id || !binding.sourceAccount ||
      !publisherSources(current.identity).some(source => source.enabled !== false && source.id === binding.sourceAccount!.id && source.alias === binding.sourceAccount!.alias)) {
      throw new Error('当前发布端或源账号与任务绑定不一致，请恢复原连接')
    }
  }

  /** 目录选择先于任务创建；请求和回包都必须属于同一发布端及绑定源账号。 */
  async directories(sourceAccountId: string, directoryId: string, cursor = ''): Promise<PublisherDirectoryPage> {
    const view = this.view()
    const source = publisherSources(view.identity).find(s => s.id === sourceAccountId)
    if (!source || source.id !== sourceAccountId) throw new Error('绑定源账号已变化，请重新选择上传目录')
    if (!/^(0|[1-9][0-9]{0,39})$/.test(directoryId) || typeof cursor !== 'string' || cursor.length > 256) throw new Error('目录或分页标识无效')
    const binding = { url: view.url, publisherId: view.identity!.id, sourceAccount: source }
    const page = await this.request<PublisherDirectoryPage>(binding, 'directories', { sourceAccountId, directoryId, cursor })
    this.validateDirectoryPage(page, sourceAccountId, directoryId, cursor)
    return page
  }

  /** 显式创建预览目录；不自动重试写请求，服务端先复用已存在的层级。 */
  async createDirectories(sourceAccountId: string, directoryId: string, segments: string[]): Promise<PublisherDirectoryPage> {
    const view = this.view(), source = publisherSources(view.identity).find(s => s.id === sourceAccountId)
    if (!source || source.id !== sourceAccountId) throw new Error('绑定源账号已变化，请重新选择上传目录')
    if (!/^(0|[1-9][0-9]{0,39})$/.test(directoryId) || !Array.isArray(segments) || segments.length < 1 || segments.length > 4 ||
      segments.some(s => typeof s !== 'string' || !s || s.trim() !== s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(s) || Buffer.byteLength(s, 'utf8') > 255)) throw new Error('输出文件夹名称无效，请检查命名预览')
    const names = [...segments]
    const binding = { url: view.url, publisherId: view.identity!.id, sourceAccount: source }
    const page = await this.request<PublisherDirectoryPage>(binding, 'directories/create', { sourceAccountId, directoryId, segments: names })
    this.validateDirectoryPage(page, sourceAccountId, Array.isArray(page?.path) ? page.path.at(-1)?.id ?? '' : '', '')
    const start = page.path.length - names.length
    if (start < 1 || page.path[start - 1]?.id !== directoryId || names.some((name, i) => page.path[start + i]?.name !== name)) {
      throw new Error('PlutoFish 创建后的目录与预览不一致，请刷新重试')
    }
    return page
  }

  private validateDirectoryPage(page: PublisherDirectoryPage, sourceAccountId: string, directoryId: string, cursor: string): void {
    const valid = (d: { id: string; name: string }) => d && typeof d.id === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(d.id) && typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 1024
    if (!page || page.sourceAccountId !== sourceAccountId || !Array.isArray(page.path) || page.path.length < 1 || page.path.length > 64 ||
      !Array.isArray(page.items) || page.items.length > 100 || ![...page.path, ...page.items].every(valid) || page.path[0]?.id !== '0' ||
      page.path.at(-1)?.id !== directoryId || typeof page.nextCursor !== 'string' || page.nextCursor.length > 256 || (page.nextCursor && page.nextCursor === cursor) ||
      new Set([...page.path, ...page.items].map(d => d.id)).size !== page.path.length + page.items.length) {
      throw new Error('PlutoFish 目录响应无效，请刷新重试')
    }
  }

  /** 只有固定绑定相符的请求可发出；密钥不经过渲染进程或任务清单。 */
  async request<T>(binding: PublicationDraft['binding'], path: 'tmdb/recognize' | 'tmdb/search' | 'releases/query' | 'tasks/report' | 'uploads/prepare' | 'files/check' | 'files/report' | 'files/ed2k' | 'directories' | 'directories/create' | 'range-proofs/pending' | 'range-proofs/report' | 'range-proofs/forget', body: unknown, signal?: AbortSignal): Promise<T> {
    this.assertBinding(binding)
    const key = this.saved.key
    const uploadActions: Record<string, string> = { start: '申请上传', credentials: '获取上传凭据', verify: '核验网盘文件', heartbeat: '续期上传租约', release: '释放上传名额' }
    const stage = path === 'uploads/prepare' ? uploadActions[String((body as { action?: unknown })?.action)] ?? '上传调度'
      : ({ 'tasks/report': '同步任务状态', 'files/report': '登记资源', 'files/check': '检查重复文件', 'files/ed2k': '同步 ED2K' } as Record<string, string>)[path] ?? path
    const requestSignal = AbortSignal.any([this.requestAbort.signal, ...(signal ? [signal] : [])])
    const failed = (error: unknown) => {
      const failure = transportError(error, requestSignal)
      failure.diagnostic = failureDetails(error, stage)
      if (key === this.saved.key && binding.url === this.saved.url && !this.closed && failure.retryable) this.disconnected(failure)
      return failure
    }
    let response: Response
    try { response = await fetch(`${this.saved.url}/api/v1/publisher/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.saved.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(90_000), requestSignal]),
    })
    } catch (error) {
      throw failed(error)
    }
    requestSignal.throwIfAborted()
    this.assertBinding(binding)
    if (key !== this.saved.key) throw new Error('发布端密钥已变化，请重试')
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: { code?: string; fieldErrors?: Record<string, unknown> } } | null
      const diagnostic = httpFailureDetails(path === 'uploads/prepare' ? ({ prepare: '申请上传', verify: '核验网盘文件', verify_reuse: '核验历史文件', credentials: '获取上传凭据', token_refresh: '刷新网盘授权' } as Record<string, string>)[response.headers.get('x-plutofish-upload-stage') ?? ''] ?? stage : stage, response, failure?.error?.code)
      requestSignal.throwIfAborted()
      if (response.status === 422 && path !== 'tmdb/search' && path !== 'tmdb/recognize') {
        // 只展示固定字段名和业务提示，绝不把服务端正文、字段值或供应商凭据带入界面。
        const labels: Record<string, string> = {
          title: '作品或集标题', episodeTitle: '集标题', episodeNumber: '集号', seasonNumber: '季号',
          taskKey: '任务、版本或源账号标识', releaseKey: '版本标识', sourceAccount: '源账号',
          workTarget: '作品信息', 'releaseTarget.workTarget.tmdbId': 'TMDB ID',
          'releaseTarget.workTarget.mediaType': '作品类型', 'releaseTarget.workTarget.category': '资源分类',
          sequence: '任务序号', stage: '任务阶段', progress: '进度', sizeBytes: '文件大小', directoryId: '网盘目录',
        }
        const fields = failure?.error?.fieldErrors
        const names = fields && typeof fields === 'object' && !Array.isArray(fields)
          ? [...new Set(Object.keys(fields).map(key => labels[key]).filter(Boolean))].join('、') : ''
        const reasons: Record<string, string> = {
          TMDB_KEY_MISSING: '请先在后台配置 TMDB API Key',
          TMDB_WORK_NOT_FOUND: 'TMDB 中不存在该类型和 ID 的作品',
        }
        const reason = reasons[failure?.error?.code ?? ''] || (names ? `${names}校验未通过` : '提交的数据未通过校验，请检查目录绑定与任务信息')
        const action = path === 'tasks/report' ? '任务上报' : path === 'files/report' ? '资源登记' : path === 'uploads/prepare' ? '上传调度' : path === 'releases/query' ? '版本查询' : '请求'
        throw new PublisherError(`PlutoFish ${action}失败：${reason}（HTTP 422）`, false, undefined, diagnostic)
      }
      if (path === 'tmdb/recognize' && response.status !== 401 && response.status !== 403) {
        const messages: Record<string, string> = {
          TMDB_KEY_MISSING: '请先在 PlutoFish 后台配置 TMDB API Key',
          TMDB_CATEGORY_RULES_INVALID: '请在后台修正影视分类规则',
          TMDB_RECOGNITION_TIMEOUT: '文件名识别超时，可重试或手动填写',
          TMDB_RECOGNITION_FAILED: 'TMDB 识别请求失败，请检查后台密钥与网络',
        }
        if (response.status === 404) throw new Error('当前 PlutoFish 服务尚不支持文件名识别，请更新服务端或手动填写')
        throw new Error(messages[failure?.error?.code ?? ''] ?? '文件名识别失败，请检查文件名或继续手动填写')
      }
      if (path === 'tmdb/search' && response.status !== 401 && response.status !== 403) {
        if (failure?.error?.code === 'TMDB_KEY_MISSING') throw new Error('请先在 PlutoFish 后台配置 TMDB API Key')
        if (response.status === 404) throw new Error('当前 PlutoFish 服务尚不支持作品搜索，请更新服务端')
        throw new Error('作品搜索失败，请稍后重试')
      }
      if (path === 'uploads/prepare') {
        if (failure?.error?.code === 'CLOUD_ACCESS_LIMIT') throw Object.assign(new UploadRateLimitError(), { diagnostic })
        // 使用本地固定提示，不把供应商正文或凭据送到渲染进程。
        const providerCode = response.headers.get('x-plutofish-provider-code') ?? ''
        const providerHint = /^[0-9]{1,9}$/.test(providerCode) ? `（115 错误码：${providerCode}）` : ''
        const messages: Record<string, string> = {
          CLOUD_PROVIDER_REJECTED: `115 拒绝${diagnostic.stage}${providerHint}，已停止自动重试，请核对源账号和文件状态`,
          CLOUD_FILE_NOT_FOUND: '115 原文件已不存在，请核对网盘文件；原上传任务不会自动重新创建',
          CLOUD_UPLOAD_REUSE_INVALID: '历史文件已失效或不符合目标，已退出复用，将重试原任务进入正常上传',
          CLOUD_ACCESS_LIMIT: '115 已限制访问，自动上传已停止，请稍后手动继续',
          CLOUD_REFRESH_PAUSED: '115 凭据刷新已暂停，请在账号管理中手动刷新',
          CLOUD_UPLOAD_SEARCH_LIMIT: '115 文件搜索结果过多，已停止核验，请人工核对目标文件',
          CLOUD_UPLOAD_RESPONSE: '115 上传调度信息不完整，请重试上传；已下载文件会保留',
          CLOUD_PROVIDER_RESPONSE: '115 上传服务响应异常，请重试上传；已下载文件会保留',
          CLOUD_UPLOAD_REJECTED: '115 拒绝上传，请检查源账号权限和目标文件夹',
          CLOUD_UPLOAD_UNCERTAIN: '115 上传连接中断，请重试原任务，继续已有上传进度',
          CLOUD_UPLOAD_MISMATCH: '115 文件还未通过校验，请重试原任务完成核验',
          CLOUD_UPLOAD_NOT_READY: '115 文件尚未就绪，请重试原任务完成核验',
          CLOUD_TOKEN_REJECTED: '115 源账号登录已失效，请在 PlutoFish 后台重新授权',
          CLOUD_REAUTH_REQUIRED: '115 源账号登录已过期，请在 PlutoFish 后台重新授权',
          PUBLISHER_UPLOAD_FILE_CHANGED: '成品与原上传任务不一致，请检查文件后再试',
          PUBLISHER_UPLOAD_ACCOUNT_CHANGED: '当前发布端绑定的网盘已变化，请恢复原账号后重试',
        }
        const message = messages[failure?.error?.code ?? '']
        if (message && response.status !== 401 && response.status !== 403) throw new PublisherError(message, ['CLOUD_UPLOAD_UNCERTAIN', 'CLOUD_UPLOAD_NOT_READY', 'CLOUD_UPLOAD_REUSE_INVALID'].includes(failure?.error?.code ?? ''), retryAfter(response), diagnostic)
        if (failure?.error?.code?.startsWith('CLOUD_') && response.status !== 401 && response.status !== 403) throw new PublisherError('115 操作已停止，请在 PlutoFish 查看失败原因后手动继续', false, undefined, diagnostic)
      }
      if (response.status === 409) {
        if (failure?.error?.code === 'PUBLISHER_UPLOAD_BUSY') throw new PublisherError('PlutoFish 网盘上传排队中', true, retryAfter(response), diagnostic)
        if (path.startsWith('directories')) {
          const messages: Record<string, string> = {
            CLOUD_ACCOUNT_UNAVAILABLE: '绑定的源网盘暂不可用，请在 PlutoFish 后台检查账号状态',
            CLOUD_REAUTH_REQUIRED: '源网盘凭据已过期，请在 PlutoFish 后台刷新或重新授权',
            CLOUD_DIRECTORY_MISSING: '文件夹已不存在或不可访问，请返回根目录重新选择',
            CLOUD_DIRECTORY_UNSUPPORTED: '当前源网盘暂不支持此目录操作',
            CLOUD_DIRECTORY_CHANGED: '网盘或目录已变化，请刷新后重新选择',
            CLOUD_DIRECTORY_AMBIGUOUS: '存在多个同名文件夹，请手动选择目标目录',
            CLOUD_DIRECTORY_SCAN_LIMIT: '目录内容过多或分页已变化，请进入更具体的目录后重试',
          }
          const message = messages[failure?.error?.code ?? '']
          if (message) throw new Error(message)
        }
      }
      // 单个账号撤权只终止该目标的请求，其他已授权账号仍可工作。
      if (response.status === 403 && failure?.error?.code === 'PUBLISHER_SOURCE_FORBIDDEN') {
        throw new Error('此任务的网盘账号已被停用或撤销授权，请在后台恢复授权或重新选择账号')
      }
      if (response.status === 401 || response.status === 403) {
        this.stopMonitor(); this.abort?.abort(); ++this.generation; this.verifying = false
        this.state = { ...this.state, status: 'error', error: '发布端权限或源账号已变化，请重新验证', identity: null }
        this.options.changed?.()
      }
      // 不拼接供应商正文，避免临时凭据、下载地址进入 UI 和运行日志。
      throw new PublisherError(`PlutoFish ${path === 'tmdb/search' ? '作品搜索' : path === 'releases/query' ? '版本查询' : path === 'directories/create' ? '目录创建（已创建的目录会在重试时复用）' : path === 'directories' ? '目录读取' : '上报或上传调度'}失败（HTTP ${response.status}）`, retryableHTTP(response.status), retryAfter(response), diagnostic)
    }
    let result: T
    try { result = await response.json() as T }
    catch (error) { throw failed(error) }
    requestSignal.throwIfAborted()
    this.assertBinding(binding)
    if (key !== this.saved.key) throw new Error('发布端密钥已变化，请重试')
    return result
  }

  async verify(input?: PlutoFishInput, background = false): Promise<void> {
    if (this.closed) throw new Error('PlutoFish 连接已关闭')
    const generation = ++this.generation
    this.abort?.abort()
    const abort = this.abort = new AbortController()
    this.clearTimer()
    if (!background) { this.cancelRequests(); this.monitoring = false; this.retryInput = undefined; this.failures = 0 }
    this.verifying = true
    this.state = { ...this.state, status: background && this.ready ? 'verified' : 'checking', error: '', reconnect: undefined }
    this.options.changed?.()
    let candidate: PlutoFishInput | undefined
    try {
      const url = normalizePlutoFishURL(input?.url ?? this.saved.url)
      const key = input ? (input.key.trim() || (url === this.saved.url ? this.saved.key : '')) : this.saved.key
      if (!key) throw new Error('请填写 PlutoFish 发布端密钥')
      candidate = { url, key }
      const identity = await (this.options.verify ?? verifyPublisher)(candidate, abort.signal)
      if (generation !== this.generation || this.closed) throw new Error('连接已变更，请重试')
      if (input) {
        try { (this.options.save ?? savePlutoFishConfig)(candidate) }
        catch { throw new Error('PlutoFish 配置保存失败，请检查本机目录权限') }
      }
      this.saved = candidate
      this.retryInput = undefined; this.failures = 0
      this.state = { url, hasKey: true, status: 'verified', error: '', identity }
      this.monitoring ||= this.options.autoReconnect === true
      this.options.changed?.()
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.state = { ...this.state, status: 'error', identity: null, error: error instanceof Error ? error.message : 'PlutoFish 验证失败' }
        if (this.options.autoReconnect && candidate && retryableError(error)) {
          // 新地址验证失败时只重试用户这次输入，不退回旧服务器或提前持久化密钥。
          if (input) this.retryInput = candidate
          this.monitoring = true
          this.scheduleRetry(error)
        } else this.stopMonitor()
        this.options.changed?.()
      }
      throw error
    } finally {
      if (generation === this.generation) {
        this.verifying = false
        if (this.monitoring && this.ready) this.schedule(this.options.intervalMs ?? 60_000)
      }
    }
  }

  private disconnected(error: PublisherError): void {
    if (!this.options.autoReconnect || this.closed || this.state.reconnect || this.verifying || !this.ready) return
    this.state = { ...this.state, status: 'error', identity: null, error: error.message }
    this.cancelRequests()
    this.monitoring = true
    this.scheduleRetry(error)
    this.options.changed?.()
  }

  private scheduleRetry(error: unknown): void {
    const delay = Math.max(retryDelay(++this.failures, this.options.retryBaseMs ?? 5000, this.options.retryMaxMs ?? 60_000), error instanceof PublisherError ? error.retryAfterMs ?? 0 : 0)
    this.state.reconnect = { attempt: this.failures, nextAt: Date.now() + delay }
    this.schedule(delay)
  }
  private schedule(delay: number): void {
    this.clearTimer()
    if (!this.monitoring || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.verify(this.retryInput, true).catch(() => {})
    }, delay)
    this.timer.unref?.()
  }
  /** 单次校验结束后才安排下一次，慢请求不会被定时器互相打断。 */
  monitor(): void {
    if (this.closed) return
    this.monitoring = true
    if (this.verifying) return
    if (this.ready) this.schedule(this.options.intervalMs ?? 60_000)
    else if (this.state.reconnect) this.schedule(Math.max(0, this.state.reconnect.nextAt - Date.now()))
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private stopMonitor(): void { this.monitoring = false; this.clearTimer(); this.state.reconnect = undefined; this.retryInput = undefined }
  /** 手动重连可先打断旧请求，避免等待慢目录/版本查询；旧回包不能影响新连接。 */
  cancelRequests(): void {
    this.requestAbort.abort(new PublisherError('PlutoFish 连接已变更，旧请求已取消，请重试', true))
    this.requestAbort = new AbortController()
  }
  close(): void { this.closed = true; ++this.generation; this.abort?.abort(); this.cancelRequests(); this.stopMonitor() }
}
