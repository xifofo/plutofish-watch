/** 只读取根目录内的普通媒体文件；不跟随符号链接，不把失联挂载当作删除。 */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Signature, WatchInput } from '../shared/model'
import { watchPaths } from '../shared/watch-paths'

export const signature = (s: Signature): Signature => ({
  size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev,
})
export const sameSignature = (a: Signature, b: Signature) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev

export function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export const watchPathFor = (root: WatchInput, path: string): string | undefined =>
  watchPaths(root).find(directory => within(directory, path))

export function requiredWatchPath(root: WatchInput, path: string): string {
  const directory = watchPathFor(root, path)
  if (!directory) throw new Error('文件已不属于监控目录，请重新检查')
  return directory
}

export const safeWatchFile = async (root: WatchInput, path: string): Promise<Signature> =>
  safeFile(requiredWatchPath(root, path), path)

export async function canonicalRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw new Error('请选择有效的本地目录')
  const path = await realpath(input)
  if (!(await lstat(path)).isDirectory()) throw new Error('所选路径不是目录')
  return path
}

export async function safeFile(root: string, path: string): Promise<Signature> {
  if (!within(root, path) || await realpath(root) !== root || await realpath(path) !== resolve(path)) {
    throw new Error('文件路径已变化或包含符号链接，请重新检查')
  }
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('文件不存在、为空或不是普通文件')
  }
  return signature(file)
}

export const videoExtensions = ['mp4', 'mkv', 'm4v', 'mov', 'avi', 'ts', 'm2ts', 'webm']
export const isVideoFile = (path: string) => videoExtensions.includes(extname(path).slice(1).toLowerCase())
  && !basename(path).startsWith('.') && !/\.(?:part|tmp|temp|download|crdownload)(?:\.|$)/i.test(basename(path))

/** 文件选择固定为同一目录中的普通视频；规范化父目录，不跟随文件链接。 */
export async function selectedVideoFiles(input: string[]): Promise<{ path: string; files: string[] }> {
  if (!Array.isArray(input) || !input.length || input.length > 100_000
    || input.some(path => typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0') || !isVideoFile(path))) {
    throw new Error('请选择有效的视频文件')
  }
  const path = await canonicalRoot(dirname(input[0])), files = new Set<string>()
  for (const raw of input) {
    if (await canonicalRoot(dirname(raw)) !== path) throw new Error('一次请选择同一目录内的视频文件')
    const file = join(path, basename(raw))
    await safeFile(path, file)
    files.add(file)
  }
  return { path, files: [...files] }
}
export async function scanTree(root: string, signal?: AbortSignal): Promise<Map<string, Signature>> {
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('监控目录已变化或不可访问')
  const files = new Map<string, Signature>(), directories = [root]
  while (directories.length) {
    signal?.throwIfAborted()
    const dir = directories.pop()!
    // 子目录若在遍历期间被替换成链接，整次扫描失败，不保存不完整基线。
    if (await realpath(dir) !== dir) throw new Error('子目录在扫描期间发生变化')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile() && isVideoFile(entry.name)) {
        const stat = await lstat(path)
        if (stat.isFile()) files.set(path, signature(stat))
      }
    }
  }
  return files
}

/** Windows 和 macOS 路径使用同一规则；只接受明确季号，不把年份、分辨率当季。 */
export function seasonFromName(path: string): { seasonNumber?: number; conflict?: boolean } {
  const parts = path.split(/[\\/]/), file = parts.pop() ?? '', seasons = new Set<number>()
  for (const folder of parts) {
    const match = /^(?:season\s*|s)(\d{1,4})$|^第\s*(\d{1,4})\s*季$/i.exec(folder)
    if (match) seasons.add(Number(match[1] ?? match[2]))
  }
  for (const match of file.matchAll(/(?:^|[^a-z0-9])S(\d{1,4})(?=E\d|[^a-z0-9]|$)|第\s*(\d{1,4})\s*季/gi)) {
    seasons.add(Number(match[1] ?? match[2]))
  }
  return seasons.size > 1 ? { conflict: true } : { seasonNumber: [...seasons][0] }
}

/** 不猜纯数字标题；多集文件或季号不符必须人工确认。 */
export function episodeFromName(path: string, season: number): number | undefined {
  const detected = seasonFromName(path)
  if (detected.conflict || (detected.seasonNumber !== undefined && detected.seasonNumber !== season)) return
  const file = path.split(/[\\/]/).at(-1) ?? ''
  const name = file.slice(0, file.length - extname(file).length)
  const full = [...name.matchAll(/(?:^|[^a-z0-9])S(\d{1,4})E(\d{1,5})(?!\d)/gi)]
  if (full.length) {
    if (full.length !== 1 || Number(full[0][1]) !== season || /E\d+\s*(?:[-~]\s*(?:E)?\d+|E\d+)/i.test(name)) return
    return Number(full[0][2])
  }
  const short = [...name.matchAll(/(?:^|[ ._-])E(?:P)?(\d{1,5})(?!\d)|第\s*(\d{1,5})\s*集/gi)]
  if (short.length !== 1 || /E(?:P)?\d+\s*(?:[-~]\s*(?:E(?:P)?)?\d+|E(?:P)?\d+)/i.test(name)) return
  return Number(short[0][1] ?? short[0][2])
}
