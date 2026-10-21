/** 对成品计算完整 SHA1 和首 128 KiB SHA1；范围挑战只读取闭区间，文件变动立即停止。 */
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import type { UploadCheckpoint } from './upload-types.ts'

export async function fingerprint(path: string, signal: AbortSignal): Promise<UploadCheckpoint['file']> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || !Number.isSafeInteger(before.size)) throw new Error('成品文件不存在或大小无效')
    const hash = createHash('sha1'), pre = createHash('sha1')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < before.size) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
      if (!bytesRead) throw new Error('成品文件读取不完整')
      hash.update(buffer.subarray(0, bytesRead))
      if (offset < 128 * 1024) pre.update(buffer.subarray(0, Math.min(bytesRead, 128 * 1024 - offset)))
      offset += bytesRead
    }
    const after = await stat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('成品在校验过程中发生变化')
    return { size: before.size, mtimeMs: before.mtimeMs, sha1: hash.digest('hex').toUpperCase(), preId: pre.digest('hex').toUpperCase() }
  } finally { await handle.close() }
}

export async function fileRange(path: string, start: number, end: number, file: UploadCheckpoint['file'], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (before.size !== file.size || before.mtimeMs !== file.mtimeMs) throw new Error('成品已改变，不能复用原上传断点')
    const data = Buffer.alloc(end - start)
    let offset = 0
    while (offset < data.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(data, offset, data.length - offset, start + offset)
      if (!bytesRead) throw new Error('成品文件读取不完整')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('成品在读取过程中发生变化')
    return data
  } finally { await handle.close() }
}

export async function challengeHash(path: string, range: string, file: UploadCheckpoint['file'], signal: AbortSignal): Promise<string> {
  if (!/^\d+-\d+$/.test(range)) throw new Error('115 校验范围无效')
  const [start, end] = range.split('-').map(Number) as [number, number]
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.size || end - start >= 8 * 1024 * 1024) throw new Error('115 校验范围超出文件或超过 8 MiB')
  return createHash('sha1').update(await fileRange(path, start, end + 1, file, signal)).digest('hex').toUpperCase()
}
