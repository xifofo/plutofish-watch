/** 单任务串行分片：V2 使用完整主机，旧版 OSS 区域地址由 SDK 拼 bucket；每片落盘后才确认字节。 */
import { PublisherError } from './retry'
import OSS from 'ali-oss'
import { Agent } from 'node:https'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { fileRange } from './upload-file.ts'
import type { Credentials, Dispatch, UploadCheckpoint } from './upload-types.ts'

export type OSSClient = Pick<OSS, 'initMultipartUpload' | 'listParts' | 'uploadPart' | 'completeMultipartUpload'>
export type OSSFactory = (dispatch: Dispatch, credentials: Credentials, signal: AbortSignal) => { client: OSSClient; close: () => void }

export const createOSS: OSSFactory = (dispatch, credentials, signal) => {
  const endpoint = new URL(dispatch.endpoint || credentials.endpoint)
  const cname = endpoint.hostname.endsWith('.115.com')
  const regionalOSS = /^oss-[a-z0-9]+(?:-[a-z0-9]+)*\.aliyuncs\.com$/.test(endpoint.hostname) && !endpoint.hostname.includes('-internal')
  if (endpoint.protocol !== 'https:' || (!cname && !regionalOSS) || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('115 上传地址无效')
  const httpsAgent = new Agent({ keepAlive: false, maxSockets: 1 })
  const stop = () => httpsAgent.destroy()
  signal.addEventListener('abort', stop, { once: true })
  const options: OSS.Options & { httpsAgent: Agent; retryMax: number } = {
    endpoint: endpoint.origin, cname, bucket: dispatch.bucket, secure: true, timeout: 180_000, retryMax: 0,
    accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, stsToken: credentials.securityToken, httpsAgent,
  }
  // ali-oss 6.23 的 initMultipartUpload 不暴露 sequential 参数，在签名前补齐。
  // 115 的合并回调需要顺序上传生成的整文件 SHA1；仅串行调用 uploadPart 并不等价。
  const sdk = new OSS(options) as OSS & {
    request: (params: { method: string; subres?: string | Record<string, string> }) => Promise<unknown>
    requestError: (result: unknown) => Promise<Error>
  }
  const request = sdk.request.bind(sdk)
  sdk.request = params => request(params.method === 'POST' && params.subres === 'uploads'
    ? { ...params, subres: { uploads: '', sequential: '' } } : params)
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
  authorize?: () => void
  recoverLegacyUpload?: boolean
  factory?: OSSFactory
}): Promise<void> {
  const { path, dispatch, checkpoint: cp, signal, save, progress } = options
  if (!dispatch.object || !dispatch.bucket || !dispatch.pickCode || !dispatch.callback) throw new Error('115 上传调度信息不完整')
  if (cp.uploadId && (cp.object !== dispatch.object || cp.bucket !== dispatch.bucket || cp.pickCode !== dispatch.pickCode)) throw new Error('115 续传对象变化，请保留断点并核对原任务')
  // 续传采用当前调度地址；原对象、bucket 和 uploadId 仍必须保持一致。
  const route = { ...dispatch }
  cp.endpoint = dispatch.endpoint
  const count = Math.ceil(cp.file.size / cp.partSize)
  if (!Number.isSafeInteger(cp.partSize) || count < 1 || count > 10000 || cp.partSize < 100 * 1024 || cp.partSize > 128 * 1024 * 1024) throw new Error('文件超过当前分片上传大小范围')
  let session: ReturnType<OSSFactory> | undefined, token: Credentials | undefined
  let tokenCheckedAt = 0
  const client = async () => {
    signal.throwIfAborted()
    options.authorize?.()
    if (!token || Date.parse(token.expiration) - Date.now() < 180_000 || Date.now() - tokenCheckedAt >= 60_000) {
      session?.close()
      token = await options.credentials()
      tokenCheckedAt = Date.now()
      if (!Number.isFinite(Date.parse(token.expiration)) || Date.parse(token.expiration) <= Date.now() || !Number.isSafeInteger(token.rate) || token.rate < 0 || token.rate > 104857600) throw new Error('115 临时凭据无效')
      route.endpoint = dispatch.endpoint || token.endpoint
      cp.endpoint = route.endpoint
      session = (options.factory ?? createOSS)(route, token, signal)
    }
    return session!.client
  }
  const initialize = async () => {
    const result = await (await client()).initMultipartUpload(dispatch.object!)
    if (!result.uploadId) throw new Error('115 未返回分片上传标识')
    cp.uploadId = result.uploadId
    cp.sequential = true; cp.completing = false
    cp.object = dispatch.object; cp.bucket = dispatch.bucket; cp.pickCode = dispatch.pickCode; cp.endpoint = route.endpoint
    save()
  }
  try {
    if (!cp.uploadId) await initialize()
    // ListParts 只用于核对本地回执；没有持久化确认的片重新上传，不能把远端列表直接当完成清单。
    const remote = new Map<number, { etag: string; size: number }>()
    let marker = 0
    for (;;) {
      let page: OSS.ListPartsResult
      try {
        page = await (await client()).listParts(dispatch.object, cp.uploadId!, { 'max-parts': 1000, 'part-number-marker': marker, 'encoding-type': 'url' })
      } catch (error) {
        if (cp.sequential && cp.completing && (error as { code?: string })?.code === 'NoSuchUpload') {
          throw new PublisherError('115 合并结果仍待核验，请等待原任务恢复', true)
        }
        // 只迁移旧版未启用 sequential 且已经合并失效的断点；服务端须先明确确认原文件不存在。
        // 保留原 pick_code/object，仅重建 OSS 分片会话，不能把普通网络错误当成新上传许可。
        if (marker !== 0 || !options.recoverLegacyUpload || cp.sequential || !cp.completing || (error as { code?: string })?.code !== 'NoSuchUpload') throw error
        cp.previousUploadId = cp.uploadId
        cp.uploadId = undefined; cp.parts = []; cp.completing = false
        save(); progress(0)
        await initialize()
        continue
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
    save()
    let uploaded = cp.parts.reduce((sum, p) => sum + p.size, 0)
    progress(uploaded)
    for (let number = 1; number <= count; number++) {
      if (cp.parts.some(p => p.number === number)) continue
      const start = (number - 1) * cp.partSize, end = Math.min(cp.file.size, start + cp.partSize)
      const data = await fileRange(path, start, end, cp.file, signal)
      const sdk = await client()
      const headers: Record<string, string> = { 'Content-MD5': createHash('md5').update(data).digest('base64') }
      if (token!.rate > 0) headers['x-oss-traffic-limit'] = String(token!.rate * 8)
      const partOptions: OSS.RequestOptions & { headers: Record<string, string> } = { headers }
      const result = await sdk.uploadPart(dispatch.object, cp.uploadId!, number, data, 0, data.length, partOptions)
      // 本地 MD5 与远端 ETag 对齐，避免错误断点或文件被更换后拼接混合内容。
      if (etag(result.etag) !== createHash('md5').update(data).digest('hex').toUpperCase()) throw new Error('115 分片校验失败')
      cp.parts.push({ number, etag: result.etag, size: data.length })
      save(); uploaded += data.length; progress(uploaded)
    }
    signal.throwIfAborted()
    const finalStat = await stat(path)
    if (finalStat.size !== cp.file.size || finalStat.mtimeMs !== cp.file.mtimeMs) throw new Error('成品在上传过程中发生变化')
    cp.completing = true; save()
    const headers: Record<string, string> = { 'x-oss-callback': Buffer.from(dispatch.callback).toString('base64') }
    if (dispatch.callbackVar) headers['x-oss-callback-var'] = Buffer.from(dispatch.callbackVar).toString('base64')
    const result = await (await client()).completeMultipartUpload(dispatch.object, cp.uploadId!, cp.parts, { headers })
    const reply = (result as OSS.CompleteMultipartUploadResult & { data?: { state?: unknown } }).data
    if (reply?.state !== true && reply?.state !== 1) throw new PublisherError('115 合并回调未确认成功，请重试原任务核验', true)
  } finally { session?.close() }
}
