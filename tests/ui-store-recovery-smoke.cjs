/* 实际 Electron 启动全零记录+有效备份；仅临时目录、无连接凭据与外部请求。 */
const { app, BrowserWindow, dialog, nativeTheme, net } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-store-ui-'))
const data = path.join(temp, 'app')
fs.mkdirSync(data)
const saved = {
  schemaVersion: 1, watches: [{
    id: 'offline-watch', path: path.join(temp, 'media'), title: '备份恢复验收', sourceAccountId: 'offline',
    binding: { url: 'http://127.0.0.1:1', publisherId: 'offline', sourceAccount: { id: 'offline', alias: '离线账号' } },
    work: { mediaType: 'tv', tmdbId: '1', category: 'tv' }, seasonNumber: 1,
    releaseId: '', releaseName: '自动归类', versionMode: 'auto', directoryId: '0', directoryPath: '/',
    includeExisting: false, stableSeconds: 60, enabled: true, initialized: true, createdAt: '2026-11-01T00:00:00Z',
  }], jobs: [{
    id: 'offline-job', watchId: 'offline-watch', path: path.join(temp, 'media', 'S01E01.mp4'), relativePath: 'S01E01.mp4',
    signature: { size: 123, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }, status: 'completed',
    percent: 100, error: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  }], observations: {}, uploadsPaused: false, ffprobe: '', retention: { enabled: true, days: 7 },
}
const corrupted = Buffer.alloc(784481)
fs.writeFileSync(path.join(data, 'watch-state.json'), corrupted)
fs.writeFileSync(path.join(data, 'watch-state.json.bak'), JSON.stringify(saved))
app.setPath('userData', data)
process.argv.push(`--watch-data=${data}`)
let warning, startupError, networkCalls = 0
dialog.showMessageBox = async (_window, options) => { warning = options; return { response: 0, checkboxChecked: false } }
dialog.showErrorBox = (title, message) => { startupError = { title, message } }
net.fetch = async () => { networkCalls++; throw new Error('offline test must not fetch') }
global.fetch = async () => { networkCalls++; throw new Error('offline test must not fetch') }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (startupError) throw Error(startupError.message); if (await fn()) return; await sleep(100) }
  throw Error('恢复窗口等待超时')
}
let failed = false
;(async () => {
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length > 0)
  const win = BrowserWindow.getAllWindows()[0]
  win.setIgnoreMouseEvents(true)
  win.webContents.setBackgroundThrottling(false)
  const js = code => win.webContents.executeJavaScript(code, true)
  await until(() => !!warning)
  assert.equal(warning.title, '监控记录已从备份恢复')
  const snapshot = await js('window.plutoWatch.snapshot()')
  assert.equal(snapshot.watches.length, 1)
  assert.equal(snapshot.jobs.length, 1)
  assert.equal(snapshot.jobs[0].status, 'completed')
  assert.equal(snapshot.watches[0].enabled, false)
  assert.equal(snapshot.uploadsPaused, true)
  assert.equal(snapshot.retention.enabled, false)
  const corruptFile = fs.readdirSync(data).find(n => n.startsWith('watch-state.json.corrupt-'))
  assert(corruptFile)
  assert.deepEqual(fs.readFileSync(path.join(data, corruptFile)), corrupted)
  assert(warning.detail.includes(corruptFile))
  const output = path.resolve('.smoke')
  fs.mkdirSync(output, { recursive: true })
  for (const [name, theme, width, height] of [['store-recovered-light', 'light', 1240, 840], ['store-recovered-narrow-dark', 'dark', 840, 640]]) {
    nativeTheme.themeSource = theme
    win.setSize(width, height)
    await sleep(300)
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  assert.equal(networkCalls, 0)
  console.log('PASS: Electron 从全零记录恢复，保留原件、暂停全部任务及清理，浅色/窄宽深色窗口通过；无网络请求。')
})().catch(error => { failed = true; console.error(error) }).finally(() => app.quit())
app.on('will-quit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* Chromium may briefly hold cache files on Windows. */ }
  process.exitCode = failed ? 1 : 0
})
