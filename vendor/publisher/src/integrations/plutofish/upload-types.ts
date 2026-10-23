/** 115 上传清单只存文件身份和分片回执；短期密钥仅存在内存中的 Credentials。 */
export type Dispatch = {
  status: 'challenge' | 'uploading' | 'ready'
  pickCode?: string; filePickCode?: string; fileId?: string; bucket?: string; object?: string; endpoint?: string
  callback?: string; callbackVar?: string; signKey?: string; signCheck?: string
}
export type Credentials = { accessKeyId: string; accessKeySecret: string; securityToken: string; expiration: string; endpoint: string; rate: number; rateScope?: string }
export type UploadReply = { dispatch: Dispatch; credentials?: Credentials }
export type UploadCheckpoint = {
  file: { size: number; mtimeMs: number; sha1: string; preId: string; ctimeMs?: number; ino?: number; dev?: number }
  uploadId?: string; object?: string; bucket?: string; endpoint?: string; pickCode?: string
  partSize: number; parts: Array<{ number: number; etag: string; size: number }>
  sequential?: boolean; previousUploadId?: string
  completing?: boolean
  resource?: { fileId: string; pickCode: string; preId: string }
}
