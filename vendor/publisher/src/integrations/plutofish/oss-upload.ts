/** 单任务串行分片：V2 使用完整主机，旧版 OSS 区域地址由 SDK 拼 bucket；每片落盘后才确认字节。 */
import { PublisherError } from './retry'
import { failureDetails, ossFailure } from './publication-error'
import OSS from 'ali-oss'
import { Agent } from 'node:https'
import { createHash } from 'node:crypto'
import { fileRange } from './upload-file.ts'
import { uploadCompletion } from './upload-receipt.ts'
import { UploadBudget, UploadMeter, uploadStream, type UploadTransfer } from './upload-traffic.ts'
import type { Readable } from 'node:stream'
import type { Credentials, Dispatch, UploadCheckpoint } from './upload-types.ts'

export type OSSClient = Pick<OSS, 'initMultipartUpload' | 'listParts' | 'uploadPart' | 'completeMultipartUpload'>
export type OSSFactory = (dispatch: Dispatch, credentials: Credentials, signal: AbortSignal,
  traffic?: { budget: UploadBudget; sent: (bytes: number) => void }) => { client: OSSClient; close: () => void }

export const createOSS: OSSFactory = (dispatch, credentials, signal, traffic) => {
  const endpoint = new URL(dispatch.endpoint || credentials.endpoint)
  const cname = endpoint.hostname.endsWith('.115.com')
  const regionalOSS = /^oss-[a-z0-9]+(?:-[a-z0-9]+)*\.aliyuncs\.com$/.test(endpoint.hostname) && !endpoint.hostname.includes('-internal')
  if (endpoint.protocol !== 'https:' || (!cname && !regionalOSS) || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('115 上传地址无效')
  const httpsAgent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  const streams = new Set<Readable>()
  const stop = () => { for (const stream of streams) stream.destroy(); httpsAgent.destroy() }
  const budget = traffic?.budget ?? new UploadBudget()
  budget.setRate(credentials.rate)
  signal.addEventListener('abort', stop, { once: true })
  const options: OSS.Options & { httpsAgent: Agent; retryMax: number } = {
    endpoint: endpoint.origin, cname, bucket: dispatch.bucket, secure: true, timeout: 180_000, retryMax: 0,
    accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, stsToken: credentials.securityToken, httpsAgent,
  }
  // ali-oss 6.23 的 initMultipartUpload 不暴露 sequential 参数，在签名前补齐。
  // 115 的合并回调需要顺序上传生成的整文件 SHA1；仅串行调用 uploadPart 并不等价。
  const sdk = new OSS(options) as OSS & {
    request: (params: { method: string; subres?: string | Record<string, string>; stream?: Readable }) => Promise<unknown>
    requestError: (result: unknown) => Promise<Error>
  }
  const request = sdk.request.bind(sdk)
  sdk.request = async params => {
    if (params.method === 'POST' && params.subres === 'uploads') return request({ ...params, subres: { uploads: '', sequential: '' } })
    if (params.method !== 'PUT' || !params.stream) return request(params)
    const stream = uploadStream(params.stream, budget, signal, traffic?.sent)
    streams.add(stream)
    try { return await request({ ...params, stream }) }
    finally { streams.delete(stream); stream.destroy() }
  }
  // ali-oss 会把 urllib 的 ECONNRESET 等系统码改成 RequestError；保留原因以区分断网和证书错误。
  const requestError = sdk.requestError.bind(sdk)
  sdk.requestError = async result => {
    const error = await requestError(result)
    if (result instanceof Error && error !== result) error.cause = result
    return error
  }
  return { client: sdk, close: () => { signal.removeEventListener('abort', stop); stop() } }
}

const etag = (value: string) => value.replaceAll('"', '').toUpperCase()

export async function uploadParts(options: {
  path: string; dispatch: Dispatch; checkpoint: UploadCheckpoint; signal: AbortSignal
  credentials: () => Promise<Credentials>; save: () => void; progress: (bytes: number) => void
  transfer?: (value: UploadTransfer | undefined) => void
  budgetFor?: (credentials: Credentials) => UploadBudget
  authorize?: () => void
  recoverLegacyUpload?: boolean
  factory?: OSSFactory
}): Promise<void> {
  const { path, dispatch, checkpoint: cp, signal, save, progress } = options
  if (!dispatch.object || !dispatch.bucket || !dispatch.pickCode || !dispatch.callback) throw new Error('115 上传调度信息不完整')
  if ((cp.uploadId || cp.pickCode) && cp.pickCode !== dispatch.pickCode) throw new Error('115 续传任务标识变化，请保留断点并核对原任务')
  // 续传以本次调度的 bucket/object/endpoint/回调为准，用新路由核对原 uploadId 的分片。
  const route = { ...dispatch }
  cp.endpoint = dispatch.endpoint
  const rememberRoute = () => {
    cp.object = dispatch.object; cp.bucket = dispatch.bucket; cp.pickCode = dispatch.pickCode; cp.endpoint = route.endpoint
  }
  const count = Math.ceil(cp.file.size / cp.partSize)
  if (!Number.isSafeInteger(cp.partSize) || count < 1 || count > 10000 || cp.partSize < 100 * 1024 || cp.partSize > 128 * 1024 * 1024) throw new Error('文件超过当前分片上传大小范围')
  let session: ReturnType<OSSFactory> | undefined, token: Credentials | undefined
  let budget = new UploadBudget(), uploaded = 0, meter: UploadMeter | undefined
  let meterTimer: ReturnType<typeof setInterval> | undefined
  const prefetchAbort = new AbortController()
  const readSignal = AbortSignal.any([signal, prefetchAbort.signal])
  let prefetched: Promise<{ data: Buffer; md5: Buffer } | { error: unknown }> | undefined
  let tokenCheckedAt = 0
  const client = async () => {
    signal.throwIfAborted()
    options.authorize?.()
    if (!token || Date.parse(token.expiration) - Date.now() < 180_000 || Date.now() - tokenCheckedAt >= 60_000) {
      session?.close()
      token = await options.credentials()
      signal.throwIfAborted()
      options.authorize?.()
      tokenCheckedAt = Date.now()
      if (!Number.isFinite(Date.parse(token.expiration)) || Date.parse(token.expiration) <= Date.now() || !Number.isSafeInteger(token.rate) || token.rate < 0 || token.rate > 104857600) throw new Error('115 临时凭据无效')
      budget = options.budgetFor?.(token) ?? budget
      budget.setRate(token.rate)
      route.endpoint = dispatch.endpoint || token.endpoint
      cp.endpoint = route.endpoint
      session = (options.factory ?? createOSS)(route, token, signal, { budget, sent: bytes => meter?.sent(uploaded + bytes) })
    }
    return session!.client
  }
  const initialize = async () => {
    const sdk = await client()
    const result = await sdk.initMultipartUpload(dispatch.object!).catch(error => { throw ossFailure(error, '创建上传会话') })
    if (!result.uploadId) throw new Error('115 未返回分片上传标识')
    cp.uploadId = result.uploadId
    cp.sequential = true; cp.completing = false
    rememberRoute()
    save()
  }
  try {
    const resuming = !!cp.uploadId
    if (!resuming) await initialize()
    // 只在续传时核对远端分片；新会话没有分片，不额外查询空列表。
    // 没有本地持久化回执的片仍须重传。
    const remote = new Map<number, { etag: string; size: number }>()
    let marker = 0
    for (; resuming;) {
      let page: OSS.ListPartsResult
      try {
        page = await (await client()).listParts(dispatch.object, cp.uploadId!, { 'max-parts': 1000, 'part-number-marker': marker, 'encoding-type': 'url' })
      } catch (error) {
        if (cp.sequential && cp.completing && (error as { code?: string })?.code === 'NoSuchUpload') {
          throw new PublisherError('115 合并结果仍待核验，请重试原任务核验', true, undefined, failureDetails(error, '核对合并结果'))
        }
        // 从未提交合并且 OSS 明确声明会话不存在，按本次续传参数重建分片会话。
        // 已提交合并只允许原有旧版迁移；普通断网、403 和结果不明均保留断点。
        signal.throwIfAborted()
        const legacy = marker === 0 && options.recoverLegacyUpload && !cp.sequential && cp.completing
        if ((cp.completing && !legacy) || (error as { code?: string })?.code !== 'NoSuchUpload') throw ossFailure(error, '核对续传分片')
        cp.previousUploadId = cp.uploadId
        cp.uploadId = undefined; cp.parts = []; cp.completing = false
        rememberRoute()
        save(); progress(0)
        await initialize()
        break
      }
      if (page.uploadId !== cp.uploadId || page.bucket !== dispatch.bucket || decodeURIComponent(page.name) !== dispatch.object) throw new Error('115 分片列表与原任务不匹配')
      const parts = Array.isArray(page.parts) ? page.parts : [page.parts]
      for (const part of parts) if (part) remote.set(Number(part.PartNumber), { etag: part.ETag, size: Number((part as unknown as { Size: string }).Size) })
      if (String(page.isTruncated) !== 'true') break
      const next = Number(page.nextPartNumberMarker)
      if (!Number.isSafeInteger(next) || next <= marker || next > 10000) throw new Error('115 分片列表分页无效')
      marker = next
    }
    const confirmed = new Set<number>()
    cp.parts = cp.parts.filter(p => {
      const expected = Math.min(cp.partSize, cp.file.size - (p.number - 1) * cp.partSize)
      if (!Number.isSafeInteger(p.number) || p.number < 1 || p.number > count || confirmed.has(p.number) || p.size !== expected || !/^[A-F0-9]{32}$/.test(etag(p.etag)) || remote.get(p.number)?.size !== p.size || etag(remote.get(p.number)!.etag) !== etag(p.etag)) return false
      confirmed.add(p.number)
      return true
    })
    // 只有新路由确认的分片可保留；将本次路由与筛选后的回执一起保存，重启继续原任务。
    rememberRoute()
    save()
    uploaded = cp.parts.reduce((sum, p) => sum + p.size, 0)
    progress(uploaded)
    meter = new UploadMeter(cp.file.size, uploaded)
    const report = () => options.transfer?.(meter!.sample(budget.limit))
    report(); meterTimer = setInterval(report, 500)
    const missing = Array.from({ length: count }, (_, i) => i + 1).filter(number => !confirmed.has(number))
    const prefetch = (number: number) => {
      const start = (number - 1) * cp.partSize, end = Math.min(cp.file.size, start + cp.partSize)
      return fileRange(path, start, end, cp.file, readSignal)
        .then(data => ({ data, md5: createHash('md5').update(data).digest() }), error => ({ error }))
    }
    if (missing.length) prefetched = prefetch(missing[0]!)
    for (let index = 0; index < missing.length; index++) {
      const number = missing[index]!
      const prepared = await prefetched!
      if ('error' in prepared) throw prepared.error
      const { data, md5 } = prepared
      // 最多两片驻留内存，读取/MD5 与当前 PUT 重叠；上传仍严格按分片编号排序。
      prefetched = index + 1 < missing.length ? prefetch(missing[index + 1]!) : undefined
      await fileRange(path, 0, 0, cp.file, signal)
      const sdk = await client()
      const headers: Record<string, string> = { 'Content-MD5': md5.toString('base64') }
      // OSS 单连接限速下限为 100 KiB/s；更小的分配额度由本地发送预算准确控制。
      if (token!.rate > 0) headers['x-oss-traffic-limit'] = String(Math.max(102400, token!.rate) * 8)
      const partOptions: OSS.RequestOptions & { headers: Record<string, string> } = { headers }
      const result = await sdk.uploadPart(dispatch.object, cp.uploadId!, number, data, 0, data.length, partOptions)
        .catch(error => { throw ossFailure(error, `上传第 ${number} 片`, number) })
      // 本地 MD5 与远端 ETag 对齐，避免错误断点或文件被更换后拼接混合内容。
      if (etag(result.etag) !== md5.toString('hex').toUpperCase()) throw new Error('115 分片校验失败')
      cp.parts.push({ number, etag: result.etag, size: data.length })
      save(); uploaded += data.length; meter.sent(uploaded); progress(uploaded)
    }
    signal.throwIfAborted()
    await fileRange(path, 0, 0, cp.file, signal)
    // 补传中间缺片会把新回执追加到末尾；合并必须恢复严格递增顺序。
    cp.parts.sort((a, b) => a.number - b.number)
    cp.completing = true; save()
    const headers: Record<string, string> = { 'x-oss-callback': Buffer.from(dispatch.callback).toString('base64') }
    if (dispatch.callbackVar) headers['x-oss-callback-var'] = Buffer.from(dispatch.callbackVar).toString('base64')
    const sdk = await client()
    const result = await sdk.completeMultipartUpload(dispatch.object, cp.uploadId!, cp.parts, { headers })
      .catch(error => { throw ossFailure(error, '合并上传分片') })
    const reply = (result as OSS.CompleteMultipartUploadResult & { data?: { state?: unknown } }).data
    if (reply?.state !== true && reply?.state !== 1) throw new PublisherError('115 合并回调未确认成功，请重试原任务核验', true, undefined, { stage: '核对合并回调', code: 'CALLBACK_UNCONFIRMED' })
    // 成功回调先持久化；资源登记断网或重启后只重放完成回执，不再查网盘或重复上传。
    cp.completion = uploadCompletion(dispatch.pickCode, reply)
    cp.completing = false
    save()
  } finally {
    if (meterTimer) clearInterval(meterTimer)
    prefetchAbort.abort()
    await prefetched
    session?.close()
    options.transfer?.(undefined)
  }
}
