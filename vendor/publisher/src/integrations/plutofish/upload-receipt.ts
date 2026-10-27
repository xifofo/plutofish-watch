/** 从已确认成功的 OSS 回调提取可选文件定位；不为缺失信息查询网盘或伪造取件码。 */
import type { UploadCompletion } from './upload-types.ts'

export function uploadCompletion(pickCode: string, reply: unknown): UploadCompletion {
  const receipt: UploadCompletion = { pickCode }
  if (!reply || typeof reply !== 'object') return receipt
  const outer = reply as Record<string, unknown>
  const fields = outer.data && typeof outer.data === 'object' ? outer.data as Record<string, unknown> : outer
  const rawID = fields.file_id ?? fields.fileid ?? fields.fid
  const id = typeof rawID === 'string' ? rawID : typeof rawID === 'number' && Number.isSafeInteger(rawID) ? String(rawID) : ''
  if (/^[0-9]{1,40}$/.test(id) && !/^0+$/.test(id)) receipt.fileId = id
  const pick = fields.pick_code ?? fields.pickcode
  if (typeof pick === 'string' && /^[A-Za-z0-9]{1,128}$/.test(pick)) receipt.filePickCode = pick
  return receipt
}
