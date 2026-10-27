/** 添加目录时读取目录名和一个普通视频的相对名称，不读取媒体内容。 */
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import type { RecognitionSample } from '../shared/model'
export { recognizeFile, validateRecognition } from '../../vendor/publisher/src/integrations/plutofish/recognition'
import { canonicalRoot, safeFile, selectedVideoFiles } from './files'

const videoExtensions = new Set(['.mp4', '.mkv', '.m4v', '.mov', '.avi', '.ts', '.m2ts', '.webm'])

/** 搜索有总量和深度上限，跳过隐藏目录、链接、临时文件与空文件，不启动监控或上传。 */
export async function recognitionSample(input: string): Promise<RecognitionSample> {
  if (typeof input === 'string' && (await lstat(input)).isFile()) {
    const { path, files } = await selectedVideoFiles([input])
    return { directoryName: basename(path), fileName: basename(files[0]), truncated: false }
  }
  const root = await canonicalRoot(input)
  const directoryName = basename(root)
  const queue = [{ path: root, depth: 0 }], signal = AbortSignal.timeout(5000)
  let entries = 0, truncated = false
  while (queue.length) {
    signal.throwIfAborted()
    const dir = queue.shift()!
    if (await realpath(dir.path) !== dir.path) throw new Error('目录已变化，请重新选择')
    for await (const entry of await opendir(dir.path)) {
      signal.throwIfAborted()
      if (++entries > 2000) return { directoryName, fileName: null, truncated: true }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = join(dir.path, entry.name)
      if (entry.isDirectory()) {
        if (dir.depth < 8) queue.push({ path, depth: dir.depth + 1 })
        else truncated = true
      } else if (entry.isFile() && videoExtensions.has(extname(entry.name).toLowerCase()) &&
        !/\.(?:part|tmp|temp|download|crdownload)(?:\.|$)/i.test(entry.name)) {
        try { await safeFile(root, path) } catch { continue }
        const fileName = [basename(root), relative(root, path)].join('/').replaceAll('\\', '/')
        if ([...fileName].length <= 1000) return { directoryName, fileName, truncated }
        truncated = true
      }
    }
  }
  return { directoryName, fileName: null, truncated }
}
