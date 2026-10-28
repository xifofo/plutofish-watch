import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { m3u8dlPath, tuiBinDir } from './tool-paths.ts'
import { fetchToolBytes } from './tool-download.ts'
import { moveFileSync } from './file-move.ts'
export { tuiBinDir } from './tool-paths.ts'

const M3U8_REPO = 'my-name-is-alan/gvs-tui'
const M3U8_RELEASE = 'managed-re-v0.6.0-iq.4'
const MKV_REPO = 'Jesseatgao/MKVToolNix-static-builds'
const SHAKA_REPO = 'shaka-project/shaka-packager'

export function toolRuns(bin: string, args: string[] = ['-version']): boolean {
  if (!bin) return false
  try {
    return spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).status === 0
  } catch {
    return false
  }
}

/** Homebrew binaries dylib-link Cellar; copying them into bin/ dies on upgrade. */
export function unixHostWrapper(target: string): string {
  return `#!/bin/bash\nexec ${JSON.stringify(target)} "$@"\n`
}

export function ffmpegMissingError(platform = process.platform): string {
  if (platform === 'darwin') return '缺少可用的 ffmpeg，请执行 brew install ffmpeg'
  if (platform === 'win32') return '缺少 ffmpeg，请 git restore bin/ffmpeg.exe 或运行 bun run tools:prepare'
  return `缺少可用的 ffmpeg，请安装后放到 ${tuiBinDir()} 或加入 PATH`
}

export function mp4BoxMissingError(platform = process.platform): string {
  if (platform === 'darwin') return '缺少 MP4Box，请执行 brew install gpac'
  if (platform === 'win32') return '缺少 MP4Box，请 git restore bin/MP4Box.exe 恢复仓库工具'
  return '缺少 MP4Box，请安装 GPAC 或设置 MP4BOX'
}

function workingFile(p: string): string {
  const hit = existsFile(p)
  return hit && toolRuns(hit) ? hit : ''
}

function pinUnixHostTool(name: string, target: string, note?: (s: string) => void): string {
  const dest = join(tuiBinDir(), name)
  if (target === dest) return dest
  mkdirSync(tuiBinDir(), { recursive: true })
  writeFileSync(dest, unixHostWrapper(target), { encoding: 'utf8', mode: 0o755 })
  try { chmodSync(dest, 0o755) } catch { /* writeFile mode is enough on most volumes */ }
  note?.(`${name} → ${target}`)
  prependBin()
  return dest
}

export function lookBundledFFmpeg(): string {
  const bundled = join(tuiBinDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  // Windows ships ffmpeg.exe in git. Mac bin/ copies are Homebrew wrappers and
  // must pass -version; a dead Cellar path would otherwise shadow PATH.
  return process.platform === 'win32' ? existsFile(bundled) : workingFile(bundled)
}

/** Bundled or PATH ffmpeg that is already on this host; never downloads. */
export function lookHostFFmpeg(): string {
  return lookBundledFFmpeg() || workingFile(which('ffmpeg'))
}

let ffmpegInflight: Promise<string> | null = null
export function ensureFFmpeg(note?: (s: string) => void, signal?: AbortSignal): Promise<string> {
  const bundled = lookBundledFFmpeg()
  if (bundled) return Promise.resolve(bundled)
  const fromPath = workingFile(which('ffmpeg'))
  if (fromPath) {
    if (process.platform !== 'win32') return Promise.resolve(pinUnixHostTool('ffmpeg', fromPath, note))
    return Promise.resolve(fromPath)
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return Promise.reject(new Error(ffmpegMissingError()))
  }
  ffmpegInflight ||= pullGithub({
    repo: 'GyanD/codexffmpeg',
    pick: (names) => {
      const name = names.find((n) => n.endsWith('-essentials_build.zip'))
      if (!name) throw new Error('发行包没有 ffmpeg essentials')
      return name
    },
    want: { 'ffmpeg.exe': true }, destName: 'ffmpeg.exe', label: 'ffmpeg', note, signal,
  }).finally(() => { ffmpegInflight = null })
  return ffmpegInflight
}

export function m3u8dlName(): string {
  return process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE'
}

function existsFile(p: string): string {
  if (!p) return ''
  try {
    return statSync(p).isFile() ? p : ''
  } catch {
    return ''
  }
}

function which(bin: string): string {
  const ext = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const e of ext) {
      const hit = existsFile(join(dir, bin + e))
      if (hit) return hit
    }
  }
  return ''
}

function prependBin(): void {
  const dir = tuiBinDir()
  const sep = process.platform === 'win32' ? ';' : ':'
  const parts = (process.env.PATH ?? '').split(sep).filter(Boolean)
  if (!parts.includes(dir)) process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`
}

export function lookM3u8dl(): string {
  const bundled = existsFile(m3u8dlPath())
  if (bundled) return bundled
  const env = process.env.N_M3U8DL_RE?.trim()
  if (env) {
    const hit = existsFile(env)
    if (hit) return hit
  }
  return existsFile(join(tuiBinDir(), m3u8dlName())) || which('N_m3u8DL-RE')
}

export function lookMkvmerge(): string {
  const bundled = existsFile(join(tuiBinDir(), process.platform === 'win32' ? 'mkvmerge.exe' : 'mkvmerge'))
  if (bundled) return bundled
  const env = process.env.MKVMERGE?.trim()
  if (env) {
    const hit = existsFile(env)
    if (hit) return hit
  }
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  return existsFile(join(tuiBinDir(), process.platform === 'win32' ? 'mkvmerge.exe' : 'mkvmerge'))
    || which('mkvmerge')
    || existsFile(join(pf, 'MKVToolNix', 'mkvmerge.exe'))
}

export function lookMP4Box(): string {
  const bundled = join(tuiBinDir(), process.platform === 'win32' ? 'MP4Box.exe' : 'MP4Box')
  if (process.platform === 'win32') {
    return existsFile(bundled) || existsFile(process.env.MP4BOX?.trim() ?? '') || which('MP4Box')
  }
  return workingFile(bundled) || workingFile(process.env.MP4BOX?.trim() ?? '') || workingFile(which('MP4Box'))
}

export async function ensureMP4Box(note?: (s: string) => void): Promise<string> {
  const hit = lookMP4Box()
  if (!hit) throw new Error(mp4BoxMissingError())
  if (process.platform !== 'win32' && dirname(hit) !== tuiBinDir()) {
    return pinUnixHostTool('MP4Box', hit, note)
  }
  return hit
}

export function packagerName(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return 'packager-win-x64.exe'
  if (platform === 'darwin') return arch === 'arm64' ? 'packager-osx-arm64' : 'packager-osx-x64'
  return arch === 'arm64' ? 'packager-linux-arm64' : 'packager-linux-x64'
}

export function lookPackager(): string {
  const bundled = existsFile(join(tuiBinDir(), packagerName()))
  if (bundled) return bundled
  const env = process.env.SHAKA_PACKAGER?.trim()
  if (env) {
    const hit = existsFile(env)
    if (hit) return hit
  }
  const dir = tuiBinDir()
  return existsFile(join(dir, packagerName()))
    || existsFile(join(dir, process.platform === 'win32' ? 'packager.exe' : 'packager'))
    || which('packager-win-x64')
    || which('packager')
}


export function m3u8dlRid(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  throw new Error(`没有 N_m3u8DL-RE 构建：${platform}/${arch}`)
}

export function pickM3u8dlAsset(names: string[], rid: string): string {
  const needle = `_${rid}_`
  const hits = names.filter((n) => n.includes(needle) && !n.includes('android'))
  const hit = hits.find((n) => /\.(zip|tar\.gz)$/i.test(n)) ?? hits[0]
  if (!hit) throw new Error(`GitHub 发行包没有 ${rid}`)
  return hit
}

export function pickMkvmergeAsset(names: string[], platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin') throw new Error('请安装 mkvtoolnix（brew install mkvtoolnix）')
  const key = platform === 'win32'
    ? (arch === 'ia32' ? 'i686-win.zip' : 'x86_64-win.zip')
    : (arch === 'ia32' ? 'i686-linux.tar.xz' : 'x86_64-linux.tar.xz')
  const hit = names.find((n) => n.endsWith(key))
  if (!hit) throw new Error(`GitHub 发行包没有 mkvmerge（${platform}/${arch}）`)
  return hit
}

export function pickPackagerAsset(names: string[], platform = process.platform, arch = process.arch): string {
  const key = packagerName(platform, arch)
  const hit = names.find((n) => n === key)
  if (!hit) throw new Error(`GitHub 发行包没有 shaka-packager（${platform}/${arch}）`)
  return hit
}


type Asset = { name: string; browser_download_url: string }

let m3u8Inflight: Promise<string> | null = null
let mkvInflight: Promise<string> | null = null
let packagerInflight: Promise<string> | null = null

export function ensureM3u8dl(note?: (s: string) => void, signal?: AbortSignal): Promise<string> {
  const hit = lookM3u8dl()
  if (hit) {
    prependBin()
    return Promise.resolve(hit)
  }
  m3u8Inflight ||= pullGithub({
    repo: M3U8_REPO,
    releaseTag: M3U8_RELEASE,
    pick: (names) => pickM3u8dlAsset(names, m3u8dlRid()),
    want: { 'n_m3u8dl-re': true, 'n_m3u8dl-re.exe': true },
    destName: m3u8dlName(),
    label: 'N_m3u8DL-RE',
    note,
    signal,
  }).finally(() => { m3u8Inflight = null })
  return m3u8Inflight
}

export function ensureMkvmerge(note?: (s: string) => void, signal?: AbortSignal): Promise<string> {
  const hit = lookMkvmerge()
  if (hit) {
    prependBin()
    return Promise.resolve(hit)
  }
  mkvInflight ||= pullGithub({
    repo: MKV_REPO,
    pick: (names) => pickMkvmergeAsset(names),
    want: { mkvmerge: true, 'mkvmerge.exe': true },
    destName: process.platform === 'win32' ? 'mkvmerge.exe' : 'mkvmerge',
    label: 'mkvmerge',
    note,
    signal,
  }).finally(() => { mkvInflight = null })
  return mkvInflight
}

export function ensurePackager(note?: (s: string) => void, signal?: AbortSignal): Promise<string> {
  const want = join(tuiBinDir(), packagerName())
  const hit = lookPackager()
  if (hit) {
    prependBin()
    if (hit !== want) {
      mkdirSync(tuiBinDir(), { recursive: true })
      copyFileSync(hit, want)
    }
    return Promise.resolve(existsFile(want) || hit)
  }
  packagerInflight ||= pullGithub({
    repo: SHAKA_REPO,
    pick: (names) => pickPackagerAsset(names),
    want: { packager: true, 'packager.exe': true, [packagerName().toLowerCase()]: true },
    destName: packagerName(),
    label: 'shaka-packager',
    note,
    signal,
  }).finally(() => { packagerInflight = null })
  return packagerInflight
}


export async function ensureTools(note?: (s: string) => void, signal?: AbortSignal): Promise<void> {
  await ensureFFmpeg(note, signal)
  await ensureM3u8dl(note, signal)
  await ensureMkvmerge(note, signal)
  await ensurePackager(note, signal)
  await ensureMP4Box(note)
}

async function pullGithub(opts: {
  repo: string
  releaseTag?: string
  pick: (names: string[]) => string
  want: Record<string, true>
  destName: string
  label: string
  note?: (s: string) => void
  signal?: AbortSignal
}): Promise<string> {
  opts.note?.(`正在从 GitHub 拉取 ${opts.label}…`)
  const assets = await githubLatest(opts.repo, opts.signal, opts.note, opts.releaseTag)
  const name = opts.pick(assets.map((a) => a.name))
  const asset = assets.find((a) => a.name === name)
  if (!asset) throw new Error(`GitHub 发行包没有 ${opts.label}`)
  opts.note?.(`下载 ${name}…`)
  const buf = await fetchToolBytes(asset.browser_download_url, { label: opts.label, signal: opts.signal, note: opts.note })
  const dir = tuiBinDir()
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, opts.destName)
  const staging = `${dest}.tmp`
  if (!/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(name)) {
    writeFileSync(staging, buf)
    try { unlinkSync(dest) } catch { /* first install */ }
    moveFileSync(staging, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)
    prependBin()
    opts.note?.(`已放到 ${dest}`)
    return dest
  }
  const tmp = join(tmpdir(), `gvs-${opts.label}-${process.pid}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  try {
    const archive = join(tmp, name)
    writeFileSync(archive, buf)
    const extracted = join(tmp, 'out')
    mkdirSync(extracted)
    await extract(archive, extracted)
    const found = findBinary(extracted, opts.want)
    if (!found) throw new Error(`解压后没有找到 ${opts.label}`)
    copyFileSync(found, staging)
    try { unlinkSync(dest) } catch { /* first install */ }
    moveFileSync(staging, dest)
    if (process.platform !== 'win32') chmodSync(dest, 0o755)
    prependBin()
    opts.note?.(`已放到 ${dest}`)
    return dest
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function githubLatest(repo: string, signal?: AbortSignal, note?: (s: string) => void, tag?: string): Promise<Asset[]> {
  const bytes = await fetchToolBytes(`https://api.github.com/repos/${repo}/releases/${tag ? 'tags/' + encodeURIComponent(tag) : 'latest'}`, {
    label: `${repo} 版本列表`, accept: 'application/vnd.github+json', signal, note,
  })
  const data = JSON.parse(bytes.toString('utf8')) as { assets?: Asset[] }
  if (!data.assets?.length) throw new Error(`GitHub 发行包列表为空（${repo}）`)
  return data.assets
}

export function toolArchiveCommand(archive: string, dest: string, platform = process.platform): { command: string; args: string[] } {
  const lower = archive.toLowerCase()
  if (lower.endsWith('.zip') && platform !== 'win32') {
    return { command: 'unzip', args: ['-q', archive, '-d', dest] }
  }
  const args = lower.endsWith('.tar.xz') || lower.endsWith('.txz')
    ? ['-xJf', archive, '-C', dest]
    : lower.endsWith('.gz')
      ? ['-xzf', archive, '-C', dest]
      : ['-xf', archive, '-C', dest]
  return { command: 'tar', args }
}

function extract(archive: string, dest: string): Promise<void> {
  const { command, args } = toolArchiveCommand(archive, dest)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d: Buffer) => { err += d.toString() })
  child.once('error', (e) => reject(new Error(`无法解压（需要 ${command}）：${e.message}`)))
  child.once('close', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`${command} 解压失败 (${code}): ${err.trim().slice(0, 240)}`))
  })
  return promise
}

function findBinary(root: string, want: Record<string, true>): string {
  const stack = [root]
  const hits: string[] = []
  while (stack.length) {
    const dir = stack.pop()!
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && want[e.name.toLowerCase()]) hits.push(p)
    }
  }
  hits.sort((a, b) => a.length - b.length)
  return hits[0] ?? ''
}
