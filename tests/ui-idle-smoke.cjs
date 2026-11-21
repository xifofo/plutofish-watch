/* Windows 空闲监控验收：独立临时目录，不加载正式配置或连接外部服务。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-idle-')))
const data = path.join(temp, 'app'), media = path.join(temp, 'media')
fs.mkdirSync(data); fs.mkdirSync(media)
const statePath = path.join(data, 'watch-state.json')
fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, watches: [{
  id: 'idle-root', path: media, title: '离线空闲验收', sourceAccountId: 'offline',
  work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
  releaseId: 'a'.repeat(32), releaseName: '离线测试', directoryId: '0', directoryPath: '/',
  includeExisting: true, stableSeconds: 10, initialized: false, enabled: true,
  createdAt: new Date().toISOString(),
  binding: { url: 'http://127.0.0.1:1', publisherId: 'offline', sourceAccount: { id: 'offline', alias: 'offline' } },
}], jobs: [], observations: {}, uploadsPaused: false, ffprobe: '', retention: { enabled: false, days: 7 } }))
app.setPath('userData', data)
process.argv.push(`--watch-data=${data}`)
require('../out/main/index.js')

let failed = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await sleep(100) }
  throw new Error('空闲监控验收等待超时')
}
;(async () => {
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.isLoading() === false)
  const win = BrowserWindow.getAllWindows()[0]
  win.setIgnoreMouseEvents(true)
  const errors = []
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason))
  const snapshot = () => win.webContents.executeJavaScript('window.plutoWatch.snapshot()')
  await until(async () => (await snapshot()).watches[0]?.initialized)
  if (process.platform === 'win32') assert.equal(app.isHardwareAccelerationEnabled(), false)
  const baseline = fs.readFileSync(statePath, 'utf8')
  const modified = fs.statSync(statePath).mtimeMs
  win.hide()
  await sleep(32000) // 跨过一次真实后台补扫。
  assert.equal(fs.readFileSync(statePath, 'utf8'), baseline)
  assert.equal(fs.statSync(statePath).mtimeMs, modified)
  assert.equal((await snapshot()).jobs.length, 0)
  fs.mkdirSync(path.join(media, 'new'))
  fs.writeFileSync(path.join(media, 'new', 'Show.S01E01.mp4'), 'offline-fixture')
  await until(async () => (await snapshot()).jobs.some(job => job.status === 'waiting'))
  await until(async () => (await snapshot()).jobs.some(job => job.status === 'queued'))
  assert.equal((await snapshot()).jobs.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).jobs[0].status, 'queued')
  win.show()
  fs.mkdirSync(path.resolve('.smoke'), { recursive: true })
  for (const mode of ['light', 'dark']) {
    nativeTheme.themeSource = mode
    win.setSize(mode === 'light' ? 1240 : 840, 720)
    await sleep(250)
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'), false)
    fs.writeFileSync(path.resolve(`.smoke/idle-${mode}.png`), (await win.webContents.capturePage()).toPNG())
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, hardwareAcceleration: app.isHardwareAccelerationEnabled(),
    idleStateWrites: 0, nestedFileDiscovered: true, stableFileQueued: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { console.error(error); failed = true; app.quit() })
app.on('quit', () => {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  if (failed) process.exitCode = 1
})
