/** 应用更新回归：回环发布清单与安装包，验证提示、暂缓、下载校验、取消和安装交接，不访问 GitHub。 */
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchUpdater, type UpdaterOptions } from '../src/main/updater'
import { compareVersions, parseManifest, releaseNotes } from '../src/shared/update'
import type { UpdateState } from '../src/shared/model'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!fn()) { if (Date.now() - start > timeout) throw new Error('等待更新状态超时'); await sleep(10) }
}

const installer = Buffer.alloc(300_000, 7)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function setup(options: { manifest?: unknown; status?: number; body?: (res: ServerResponse) => void; platform?: NodeJS.Platform; stallMs?: number } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'watch-update-')))
  cleanup.push(() => rm(temp, { recursive: true, force: true }))
  const server = createServer((req, res) => {
    if (req.url === '/latest.json') {
      if (options.status) return void res.writeHead(options.status).end('not found')
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(options.manifest ?? manifest))
    }
    if (options.body) return options.body(res)
    res.writeHead(200, { 'Content-Length': installer.length }).end(installer)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const file = (platform: string, arch: string, name: string) => ({ platform, arch, name, url: `${base}/${name}`, size: installer.length, sha256: sha256(installer) })
  const manifest = { version: '0.2.0', publishedAt: '2026-11-02T08:00:00Z', page: 'https://github.com/xifofo/plutofish-watch/releases/tag/v0.2.0',
    notes: '# PlutoFish Watch 0.2.0\n\n- 新增应用内更新\n- 修复 `ffprobe` 路径\n\n已验证离线回归。',
    files: [file('win32', 'x64', 'PlutoFish-Watch-0.2.0-windows-x64-setup.exe'), file('darwin', 'arm64', 'PlutoFish-Watch-0.2.0-macos-arm64.dmg')] }
  const states: UpdateState[] = [], launched: string[] = []
  let quits = 0
  const config: UpdaterOptions = {
    current: '0.1.19', manifestURL: `${base}/latest.json`, directory: join(temp, 'update'), enabled: true,
    platform: options.platform ?? 'win32', arch: options.platform === 'darwin' ? 'arm64' : 'x64', fetch: (url, init) => fetch(url, init),
    launch: async path => { launched.push(path) }, quit: () => { quits++ }, onChange: state => { states.push(state) }, stallMs: options.stallMs ?? 300,
  }
  const updater = new WatchUpdater(config)
  cleanup.push(async () => updater.stop())
  return { updater, states, launched, base, temp, config, quits: () => quits }
}

test('版本比较与清单校验拒绝不完整或非 HTTPS 的安装包', () => {
  expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  expect(compareVersions('0.1.19', '0.2.0')).toBe(-1)
  expect(() => compareVersions('v0.1.0', '0.1.0')).toThrow()
  const valid = { version: '0.2.0', page: 'https://github.com/x/y/releases/tag/v0.2.0', notes: '', files: [
    { platform: 'win32', arch: 'x64', name: 'a.exe', url: 'https://github.com/x/y/a.exe', size: 1, sha256: 'a'.repeat(64) }] }
  expect(parseManifest(valid).files).toHaveLength(1)
  expect(() => parseManifest({ ...valid, version: '0.2' })).toThrow('更新信息无效')
  expect(() => parseManifest({ ...valid, files: [{ ...valid.files[0], url: 'http://example.com/a.exe' }] })).toThrow('HTTPS')
  expect(() => parseManifest({ ...valid, files: [{ ...valid.files[0], name: '../a.exe' }] })).toThrow('安装包信息无效')
  expect(() => parseManifest({ ...valid, files: [{ ...valid.files[0], sha256: 'xyz' }] })).toThrow('安装包信息无效')
  expect(() => parseManifest({ ...valid, page: 'http://127.0.0.1/notes' })).toThrow('HTTPS')
})

test('发布说明按段落与列表显示，去掉标题和行内标记', () => {
  expect(releaseNotes('# 标题\n\n- 第一项 `code`\n- 第二项 **重点**\n  续行\n\n说明[链接](https://x)\n第二行\n- 新列表')).toEqual([
    { kind: 'list', items: ['第一项 code', '第二项 重点续行'] },
    { kind: 'text', text: '说明链接第二行' },
    { kind: 'list', items: ['新列表'] },
  ])
  const real = releaseNotes(readFileSync(join(import.meta.dir, '../docs/release-v0.1.19.md'), 'utf8'))
  expect(real[0]).toMatchObject({ kind: 'list' })
  expect(real.some(block => block.kind === 'text')).toBe(true)
})

test('发现新版本后提示；暂不更新只在本次运行内隐藏，手动检查重新提示', async () => {
  const { updater } = await setup()
  await updater.check()
  expect(updater.state()).toMatchObject({ dismissed: false, release: { version: '0.2.0', mode: 'install', size: installer.length } })
  updater.dismiss()
  expect(updater.state().dismissed).toBe(true)
  await updater.check()
  expect(updater.state().dismissed).toBe(true)
  await updater.check(true)
  expect(updater.state().dismissed).toBe(false)
  expect(updater.state().checkedAt).toBeNumber()
})

test('没有清单、版本不新或网络失败时不提示；只有手动检查显示错误', async () => {
  const missing = await setup({ status: 404 })
  await missing.updater.check(true)
  expect(missing.updater.state()).toMatchObject({ release: undefined, checkError: undefined })
  const same = await setup({ manifest: { version: '0.1.19', page: 'https://github.com/x/y', notes: '', files: [] } })
  await same.updater.check()
  expect(same.updater.state().release).toBeUndefined()
  const broken = await setup({ status: 500 })
  await broken.updater.check()
  expect(broken.updater.state().checkError).toBeUndefined()
  await broken.updater.check(true)
  expect(broken.updater.state().checkError).toBe('检查更新失败，请检查网络后重试')
})

test('Windows 下载并校验后自动退出，任务保存后才启动安装程序', async () => {
  const { updater, states, launched, quits } = await setup()
  await updater.check()
  await updater.startDownload()
  expect(updater.state().download).toMatchObject({ status: 'installing', received: installer.length, total: installer.length })
  expect(states.some(state => state.download?.status === 'downloading')).toBe(true)
  expect(launched).toEqual([])
  await until(() => quits() === 1)
  await updater.launchPending()
  expect(launched).toHaveLength(1)
  expect(launched[0]).toEndWith('PlutoFish-Watch-0.2.0-windows-x64-setup.exe')
  expect(sha256(await readFile(launched[0]))).toBe(sha256(installer))
  await updater.launchPending()
  expect(launched).toHaveLength(1)
})

test('macOS 下载后等待确认，再在退出时打开安装包；无安装包的平台只打开下载页', async () => {
  const { updater, launched, quits } = await setup({ platform: 'darwin' })
  await updater.check()
  expect(updater.state().release?.mode).toBe('open')
  expect(updater.requestInstall()).toBe(false)
  await updater.startDownload()
  expect(updater.state().download?.status).toBe('ready')
  await sleep(900)
  expect(quits()).toBe(0)
  updater.dismiss()
  expect(updater.state()).toMatchObject({ dismissed: true, download: { status: 'ready' } })
  updater.reopen()
  expect(updater.requestInstall()).toBe(true)
  expect(updater.state().download?.status).toBe('installing')
  await updater.launchPending()
  expect(launched[0]).toEndWith('PlutoFish-Watch-0.2.0-macos-arm64.dmg')

  const linux = await setup({ platform: 'linux' })
  await linux.updater.check()
  expect(linux.updater.state().release?.mode).toBe('page')
  await linux.updater.startDownload()
  expect(linux.updater.state().download).toBeUndefined()
})

test('校验失败、大小超出或长时间无进度时删除半成品并允许重新下载', async () => {
  const corrupt = await setup({ body: res => res.writeHead(200).end(Buffer.alloc(installer.length, 1)) })
  await corrupt.updater.check()
  await corrupt.updater.startDownload()
  expect(corrupt.updater.state().download).toMatchObject({ status: 'failed', error: '安装包校验失败，已删除，请重新下载' })
  expect(readdirSync(corrupt.config.directory)).toEqual([])
  corrupt.updater.dismiss()
  expect(corrupt.updater.state().download).toBeUndefined()

  const oversized = await setup({ body: res => res.writeHead(200).end(Buffer.alloc(installer.length + 10, 7)) })
  await oversized.updater.check()
  await oversized.updater.startDownload()
  expect(oversized.updater.state().download?.error).toBe('安装包大小与发布信息不一致，已停止下载')

  const stalled = await setup({ body: res => { res.writeHead(200, { 'Content-Length': installer.length }); res.write(installer.subarray(0, 1000)) } })
  await stalled.updater.check()
  await stalled.updater.startDownload()
  expect(stalled.updater.state().download).toMatchObject({ status: 'failed', received: 1000, error: '下载长时间没有进度，请检查网络后重试' })
  expect(existsSync(join(stalled.config.directory, 'PlutoFish-Watch-0.2.0-windows-x64-setup.exe.part'))).toBe(false)
})

test('取消下载回到新版本提示，下载中不能暂缓或被新检查替换', async () => {
  const { updater, quits } = await setup({ stallMs: 10_000, body: res => { res.writeHead(200, { 'Content-Length': installer.length }); res.write(installer.subarray(0, 1000)) } })
  await updater.check()
  const download = updater.startDownload()
  await until(() => updater.state().download?.received === 1000)
  updater.dismiss()
  expect(updater.state().dismissed).toBe(false)
  await updater.check(true)
  expect(updater.state().download?.status).toBe('downloading')
  updater.cancel()
  await download
  expect(updater.state()).toMatchObject({ download: undefined, dismissed: false, release: { version: '0.2.0' } })
  expect(quits()).toBe(0)
})
