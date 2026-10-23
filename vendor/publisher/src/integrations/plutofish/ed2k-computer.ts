/** 桌面历史与发布端共用后台 ED2K 计算；缓存本地摘要，文件身份变化后重新计算。 */
import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { ED2KResult } from './publication-retention.ts'
import { useLocalFile } from '../../lib/local-file-use.ts'

export function createED2KComputer(factory: (path: string) => Worker) {
  const cache = new Map<string, ED2KResult>()
  const running = new Map<string, { result: Promise<ED2KResult>; listeners: Set<(done: number, total: number) => void>; users: number; cancel: () => void }>()
  return async (path: string, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<ED2KResult> => {
    signal?.throwIfAborted()
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error('成品文件不存在或大小无效')
    const key = JSON.stringify([resolve(path), stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev])
    const cached = cache.get(key)
    if (cached) return cached
    let job = running.get(key)
    if (!job) {
      const release = useLocalFile(path)
      const listeners = new Set<(done: number, total: number) => void>()
      let cancel = () => {}
      const result = new Promise<ED2KResult>((resolve, reject) => {
        let worker: Worker
        try { worker = factory(path) } catch (error) { release(); reject(error); return }
        cancel = () => { void worker.terminate() }
        let settled = false
        worker.on('message', (message: ED2KResult & { type: string; done: number; total: number; message: string }) => {
          if (message.type === 'progress') for (const listener of listeners) listener(message.done, message.total)
          if (message.type === 'done' || message.type === 'error') {
            settled = true
            // 等后台线程真正退出才释放占用或返回结果。
            void worker.terminate().then(() => {
              if (message.type === 'done') resolve(message)
              else reject(new Error(message.message))
            }, reject)
          }
        })
        worker.on('error', reject)
        worker.on('exit', () => { release(); if (!settled) reject(new Error('ED2K 计算线程提前结束')) })
      }).then(value => {
        cache.set(key, value)
        if (cache.size > 64) cache.delete(cache.keys().next().value!)
        return value
      }).finally(() => running.delete(key))
      job = { result, listeners, users: 0, cancel }
      running.set(key, job)
    }
    const current = job
    current.users++
    if (progress) current.listeners.add(progress)
    try {
      return await new Promise<ED2KResult>((resolve, reject) => {
        const aborted = () => reject(signal?.reason ?? new Error('ED2K 计算已取消'))
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
        current.result.then(resolve, reject).finally(() => signal?.removeEventListener('abort', aborted))
      })
    } finally {
      if (progress) current.listeners.delete(progress)
      if (--current.users === 0 && signal?.aborted) current.cancel()
    }
  }
}
