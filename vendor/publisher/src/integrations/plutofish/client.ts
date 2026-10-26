/** 独立 HTTP 校验：不向网关发送发布密钥，不跟随重定向，不回显服务端原文。 */
import { PublisherError, transportError, retryAfter, retryableHTTP } from './retry'
import type { PlutoFishInput, PublisherIdentity } from './types.ts'

export function normalizePlutoFishURL(raw: string): string {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new Error('请填写有效的 PlutoFish 服务地址') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('PlutoFish 地址须使用 HTTPS，本机开发可使用 HTTP')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('PlutoFish 地址不能包含账号、密码、查询参数或锚点')
  return url.toString().replace(/\/+$/, '')
}

function identity(value: unknown): PublisherIdentity {
  if (!value || typeof value !== 'object') throw new Error('PlutoFish 身份响应格式不正确，请确认服务地址和版本')
  const v = value as Record<string, unknown>
  const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256
  if (!valid(v.id) || !valid(v.name) || v.kind !== 'publisher') {
    throw new Error('PlutoFish 身份响应格式不正确，请确认服务地址和版本')
  }
  const categories = v.categories
  if (categories !== undefined && (!Array.isArray(categories) || categories.some(c => !c || !valid(c.value) || !valid(c.label)))) {
    throw new Error('PlutoFish 分类响应格式不正确，请确认服务版本')
  }
  // 更高版本可增加能力；只识别显式 true，缺失、未知或格式异常时保守使用旧上传协议。
  const capabilities = v.capabilities as Record<string, unknown> | undefined
  const options = {
    ...(categories === undefined ? {} : { categories: (categories as Array<{value: string; label: string}>).map(c => ({ value: c.value, label: c.label })) }),
    ...(capabilities === undefined ? {} : { capabilities: { uploadClientGrouping: capabilities !== null && typeof capabilities === 'object' && !Array.isArray(capabilities) && capabilities.uploadClientGrouping === true, taskDiagnostics: capabilities !== null && typeof capabilities === 'object' && !Array.isArray(capabilities) && capabilities.taskDiagnostics === true } }),
  }
  const source = (value: unknown) => {
    const a = value as Record<string, unknown> | null
    if (!a || !valid(a.id) || !valid(a.name) || !valid(a.alias) || (a.provider !== undefined && !valid(a.provider)) || (a.enabled !== undefined && a.enabled !== true)) {
      throw new Error('PlutoFish 未返回有效的绑定源账号')
    }
    return { id: a.id, name: a.name, alias: a.alias,
      ...(a.provider === undefined ? {} : { provider: a.provider as string }), ...(a.enabled === undefined ? {} : { enabled: true }) }
  }
  const account = source(v.sourceAccount)
  if (v.sourceAccounts === undefined) return { id: v.id, name: v.name, kind: 'publisher', sourceAccount: account, ...options }
  if (!Array.isArray(v.sourceAccounts) || !v.sourceAccounts.length || v.sourceAccounts.length > 100) throw new Error('PlutoFish 网盘账号列表无效')
  const accounts = v.sourceAccounts.map(source)
  if (new Set(accounts.map(a => a.id)).size !== accounts.length || new Set(accounts.map(a => a.alias)).size !== accounts.length
    || !accounts.some(a => a.id === account.id && a.alias === account.alias && a.provider === account.provider)) throw new Error('PlutoFish 默认网盘账号无效')
  return { id: v.id, name: v.name, kind: 'publisher', sourceAccount: account, sourceAccounts: accounts, ...options }
}

export type PublisherFetch = (url: string, init: RequestInit) => Promise<Response>

export async function verifyPublisher(input: PlutoFishInput, signal?: AbortSignal, request: PublisherFetch = fetch): Promise<PublisherIdentity> {
  const url = normalizePlutoFishURL(input.url)
  if (!input.key.trim() || /[\r\n]/.test(input.key)) throw new Error('请填写 PlutoFish 发布端密钥')
  let response: Response
  try {
    response = await request(`${url}/api/v1/publisher/me`, {
      method: 'GET', headers: { Authorization: `Bearer ${input.key.trim()}`, Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    })
  } catch (error) {
    const failure = transportError(error, signal)
    throw new PublisherError('无法连接 PlutoFish，请检查地址、网络或证书后重试', failure.retryable)
  }
  if (response.status === 401) throw new Error('PlutoFish 密钥无效或发布端已停用，请重新填写')
  if (response.status === 403) throw new Error('PlutoFish 发布端绑定的源账号不可用，请联系管理员')
  if (!response.ok) throw new PublisherError(`PlutoFish 验证失败（HTTP ${response.status}），请稍后重试`, retryableHTTP(response.status), retryAfter(response))
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('PlutoFish 未返回身份 JSON，请检查服务地址')
  let body: unknown
  try { body = await response.json() } catch (error) { throw new PublisherError('PlutoFish 身份响应格式不正确', transportError(error, signal).retryable) }
  return identity(body)
}
