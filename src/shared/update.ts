/** 发布清单由标签工作流生成；客户端只接受版本、地址、大小和 SHA256 都完整的安装包条目。 */
export type UpdateFile = { platform: 'win32' | 'darwin' | 'linux'; arch: 'x64' | 'arm64'; name: string; url: string; size: number; sha256: string }
export type UpdateManifest = { version: string; publishedAt: string; page: string; notes: string; files: UpdateFile[] }

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

function parts(version: string): number[] {
  const match = semver.exec(version)
  if (!match) throw new Error('版本号无效')
  return match.slice(1).map(Number)
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a), right = parts(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}

/** 与服务连接一致：远程地址必须使用 HTTPS，仅本机回环允许 HTTP 测试。 */
export function updateURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('更新地址无效')
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) throw new Error('更新地址必须使用 HTTPS')
  return url.toString()
}

export function parseManifest(value: unknown): UpdateManifest {
  const data = value as Partial<UpdateManifest> | null
  if (!data || typeof data !== 'object' || typeof data.version !== 'string' || !semver.test(data.version)
    || typeof data.notes !== 'string' || data.notes.length > 20000 || !Array.isArray(data.files) || data.files.length > 20) {
    throw new Error('更新信息无效')
  }
  const files = data.files.map(file => {
    if (!file || !['win32', 'darwin', 'linux'].includes(file.platform) || !['x64', 'arm64'].includes(file.arch)
      || typeof file.name !== 'string' || !/^[\w.-]{1,200}$/.test(file.name) || !Number.isSafeInteger(file.size) || file.size <= 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('更新安装包信息无效')
    return { platform: file.platform, arch: file.arch, name: file.name, url: updateURL(file.url), size: file.size, sha256: file.sha256 }
  })
  const page = updateURL(data.page)
  if (!page.startsWith('https:')) throw new Error('更新说明地址必须使用 HTTPS')
  return { version: data.version, publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : '', page, notes: data.notes, files }
}

/** 发布说明只渲染为纯文本段落和列表；去掉标题与行内 Markdown 标记。 */
export type NoteBlock = { kind: 'text'; text: string } | { kind: 'list'; items: string[] }
export function releaseNotes(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let paragraph: string[] = []
  const inline = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim()
  const flush = () => { if (paragraph.length) blocks.push({ kind: 'text', text: inline(paragraph.join('')) }); paragraph = [] }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim(), item = /^[-*]\s+(.*)$/.exec(line)
    if (!line || line.startsWith('#')) { flush(); continue }
    if (item) flush()
    const last = blocks.at(-1)
    // 列表项的缩进续行并入上一项；其他连续行合并为一个段落。
    if (item && last?.kind === 'list') last.items.push(inline(item[1]))
    else if (item) blocks.push({ kind: 'list', items: [inline(item[1])] })
    else if (last?.kind === 'list' && !paragraph.length && /^\s{2,}/.test(raw)) last.items[last.items.length - 1] += inline(line)
    else paragraph.push(line)
  }
  flush()
  return blocks
}
