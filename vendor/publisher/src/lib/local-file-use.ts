/** 本进程内的成品读写租约，定时清理与校验、ED2K 计算共用；不代表外部播放器占用。 */
import { resolve } from 'node:path'

const readers = new Map<string, number>()
const deleting = new Set<string>()

export function useLocalFile(path: string): () => void {
  const key = resolve(path)
  if (deleting.has(key)) throw new Error('成品正在清理')
  readers.set(key, (readers.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (readers.get(key) ?? 1) - 1
    if (count) readers.set(key, count)
    else readers.delete(key)
  }
}

export function localFileInUse(path: string): boolean { return readers.has(resolve(path)) }

export function lockLocalFileDeletion(path: string): (() => void) | undefined {
  const key = resolve(path)
  if (readers.has(key) || deleting.has(key)) return
  deleting.add(key)
  return () => { deleting.delete(key) }
}
