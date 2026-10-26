/** 只提取错误码、状态码和请求编号；供应商 message、请求 URL、响应正文与密钥不进入清单或界面。 */
import { PublisherError, retryableError, type FailureDetails } from './retry'

const reasons: Record<string, string> = {
  ECONNRESET: '网络连接被重置', ECONNREFUSED: '连接被拒绝', EPIPE: '连接已断开',
  ETIMEDOUT: '网络请求超时', RequestTimeout: '存储请求超时', TimeoutError: '请求超时',
  ConnectionTimeout: '连接超时', ConnectionTimeoutError: '连接超时', ResponseTimeoutError: '响应超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时', UND_ERR_HEADERS_TIMEOUT: '等待响应超时', UND_ERR_BODY_TIMEOUT: '读取响应超时', UND_ERR_SOCKET: '网络连接中断',
  ENOTFOUND: '无法解析服务地址', EAI_AGAIN: '域名解析暂时失败', ENETUNREACH: '网络不可达', EHOSTUNREACH: '服务器不可达', ENETDOWN: '网络已断开',
  NoSuchUpload: '原分片上传会话已失效', InvalidPart: '远端分片缺失或校验不一致', InvalidPartOrder: '合并分片顺序不正确',
  InvalidDigest: '分片摘要无效', BadDigest: '分片摘要与远端不一致',
  AccessDenied: '存储服务拒绝访问，请检查账号权限', SecurityTokenExpired: '上传临时凭据已过期', ExpiredToken: '上传临时凭据已过期',
  InvalidAccessKeyId: '上传临时凭据无效', InvalidSecurityToken: '上传临时凭据无效', SignatureDoesNotMatch: '上传签名校验未通过',
  SlowDown: '存储服务繁忙或限流', ServiceUnavailable: '存储服务暂不可用', InternalError: '存储服务内部错误',
  CallbackFailed: '上传合并回调失败，需要核验原文件',
  ENOENT: '本地文件不存在或目录不可访问', EACCES: '没有本地文件访问权限', EPERM: '本地文件访问被系统拒绝', ENOSPC: '本地磁盘空间不足',
  CERT_HAS_EXPIRED: '服务器证书已过期', DEPTH_ZERO_SELF_SIGNED_CERT: '服务器证书不受信任', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书', ERR_TLS_CERT_ALTNAME_INVALID: '服务器证书与域名不匹配',
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const codeValue = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(value) ? value : undefined
const requestId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value) ? value : undefined

export function failureDetails(error: unknown, stage: string, partNumber?: number): FailureDetails {
  if (error instanceof PublisherError && error.diagnostic) return error.diagnostic
  const chain: Record<string, unknown>[] = [], seen = new Set<unknown>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value) || chain.length >= 8) return
    seen.add(value); const row = record(value); chain.push(row)
    visit(row.cause)
    if (Array.isArray(row.errors)) row.errors.forEach(visit)
  }
  visit(error)
  // SDK 外层 RequestError 不应盖住 cause 中具体的系统错误码。
  const codes = chain.flatMap(row => [codeValue(row.code), codeValue(row.name)]).filter((code): code is string => !!code && !['Error', 'RequestError', 'AggregateError'].includes(code))
  const code = codes.find(code => reasons[code]) ?? codes[0]
  const status = chain.map(row => row.status ?? row.statusCode).find(value => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) as number | undefined
  const id = chain.map(row => requestId(row.requestId)).find(Boolean)
  return { stage, ...(code ? { code } : {}), ...(status ? { httpStatus: status } : {}), ...(id ? { requestId: id } : {}), ...(partNumber ? { partNumber } : {}) }
}

export function httpFailureDetails(stage: string, response: Response, code: unknown): FailureDetails {
  return failureDetails({ code, status: response.status, requestId: response.headers.get('x-request-id') }, stage)
}

export function ossFailure(error: unknown, stage: string, partNumber?: number): PublisherError {
  const diagnostic = failureDetails(error, stage, partNumber)
  if (error instanceof PublisherError) { error.diagnostic ??= diagnostic; return error }
  const reason = reasons[diagnostic.code ?? ''] ?? ({ 502: '存储网关返回异常', 503: '存储服务暂不可用', 504: '存储网关响应超时', 403: '存储服务拒绝访问' } as Record<number, string>)[diagnostic.httpStatus ?? 0] ?? '存储请求失败，请查看错误码和请求编号'
  const retryable = retryableError(error) || ['NoSuchUpload', 'InvalidPart', 'InvalidPartOrder', 'SecurityTokenExpired', 'ExpiredToken', 'CallbackFailed'].includes(diagnostic.code ?? '')
  return new PublisherError(`${stage}失败：${reason}`, retryable, undefined, diagnostic)
}

export function publicationFailure(error: unknown, stage: string): PublisherError {
  if (error instanceof PublisherError) { error.diagnostic ??= failureDetails(error, stage); return error }
  if (error instanceof Error && /^(PlutoFish|当前发布端|成品|文件超过|115 [\u4e00-\u9fff]|发布|另一发布器)/.test(error.message)) {
    return new PublisherError(error.message, retryableError(error), undefined, failureDetails(error, stage))
  }
  return ossFailure(error, stage)
}
