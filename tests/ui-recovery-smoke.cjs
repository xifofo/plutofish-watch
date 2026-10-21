/* 真实 Electron + 回环假服务：连接恢复、自动重试与人工暂停边界，不访问真实网盘。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const syncFS = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, offline = false, revoked = false, failed = false
const calls = []
async function until(fn, timeout = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(100) }
  throw new Error('自动恢复 UI 验收超时')
}
;(async () => {
  temp = syncFS.realpathSync(syncFS.mkdtempSync(path.join(os.tmpdir(), 'plutofish-recovery-ui-')))
  syncFS.mkdirSync(path.join(temp, 'app', 'Shared Dictionary', 'cache'), { recursive: true })
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
    calls.push({ endpoint, body })
    if (offline) { req.socket.destroy(); return }
    let result
    if (endpoint === 'me') {
      if (revoked) { res.writeHead(401).end(); return }
      result = { id: 'recovery-publisher', name: '离线恢复验收', kind: 'publisher',
        sourceAccount: { id: 'source', alias: 'offline', name: '本机模拟网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    } else if (endpoint === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: 'S01.1080p.WEB.WEB-DL.SDR.AVC', resolution: '1080p', dynamicRange: 'SDR', status: 'published' }], total: 1, page: 1, pageSize: 100 }
    else if (endpoint === 'files/check') result = { status: 'missing' }
    else if (endpoint === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'original', filePickCode: 'mockfile' } }
    else if (endpoint === 'files/report') {
      if (calls.filter(c => c.endpoint === endpoint).length <= 2) { res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}'); return }
      result = { accepted: true }
    } else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
    else if (endpoint === 'files/ed2k' || endpoint === 'range-proofs/forget') result = { accepted: true }
    else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
    else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0], errors = []
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  const snapshot = () => js('window.plutoWatch.snapshot()')
  const click = label => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw Error('找不到按钮'); b.click() })()`)
  const screenshot = async name => {
    await fs.mkdir(path.resolve('.smoke'), { recursive: true })
    win.show(); win.webContents.invalidate(); await sleep(250)
    await fs.writeFile(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await until(async () => (await snapshot()).ffprobeAvailable)
  const url = `http://127.0.0.1:${server.address().port}`
  const connect = () => js(`window.plutoWatch.connect(${JSON.stringify({ url, key: 'offline-recovery-test' })}).catch(e => e.message)`)
  assert.equal(await connect(), undefined)
  await until(async () => (await snapshot()).connection.status === 'verified')
  const media = path.join(temp, 'media'); await fs.mkdir(media)
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', path.join(media, 'Test.S01E01.mp4')]).status, 0)
  await js(`window.plutoWatch.add(${JSON.stringify({ path: media, title: '自动恢复验收', sourceAccountId: 'source',
    work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1, versionMode: 'fixed', releaseId: 'a'.repeat(32), directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 10 })})`)
  await click('传输任务')
  await until(() => js("document.body.innerText.includes('等待自动重试')"))
  const original = (await snapshot()).jobs[0]
  assert.equal(original.retry.attempt, 1)
  await screenshot('22-retry-waiting')
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await screenshot('23-retry-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await click('暂停')
  await until(async () => (await snapshot()).jobs[0].status === 'paused')
  await sleep(5500)
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 1)
  offline = true; await connect()
  await until(() => js("document.body.innerText.includes('正在自动恢复')"))
  await screenshot('24-reconnecting-narrow-dark')
  await click('连接与设置')
  await screenshot('25-reconnecting-settings')
  assert.equal(await js("document.body.innerText.includes('自动重连')"), true)
  offline = false
  await until(async () => (await snapshot()).connection.status === 'verified')
  assert.equal((await snapshot()).jobs[0].status, 'paused')
  await click('传输任务'); await click('继续')
  await until(() => js("document.body.innerText.includes('等待自动重试')"))
  assert.equal((await snapshot()).jobs[0].retry.attempt, 2)
  await until(async () => { const job = (await snapshot()).jobs[0]; return job.status === 'completed' && job.synced && job.ed2kSaved })
  const done = (await snapshot()).jobs[0]
  assert.equal(done.fileKey, original.fileKey)
  assert.equal(calls.filter(c => c.endpoint === 'uploads/prepare' && c.body.action === 'start').length, 1)
  const reports = calls.filter(c => c.endpoint === 'files/report')
  assert.equal(reports.length, 3); assert.deepEqual(reports[0].body, reports[2].body)
  assert.equal(done.retry, undefined)
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  await screenshot('26-recovered-complete')
  await click('暂停上传')
  offline = true; await connect(); offline = false
  await until(async () => (await snapshot()).connection.status === 'verified')
  assert.equal((await snapshot()).uploadsPaused, true)
  revoked = true; await connect()
  assert.equal((await snapshot()).connection.reconnect, undefined)
  const authCalls = calls.filter(c => c.endpoint === 'me').length
  await sleep(5500)
  assert.equal(calls.filter(c => c.endpoint === 'me').length, authCalls)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, automaticReconnects: 2, fileReports: reports.length, uploadStarts: 1,
    manualPausePreserved: true, globalPausePreserved: true, revokedCredentialsStopped: true, ed2kSaved: done.ed2kSaved, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => {
  server?.closeAllConnections(); server?.close()
  if (temp) syncFS.rmSync(temp, { recursive: true, force: true })
})
app.on('quit', () => { if (failed) process.exit(1) })
