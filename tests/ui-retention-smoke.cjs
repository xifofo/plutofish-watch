/* 真实 Electron + 假时钟 + 回环服务，只清理本测试创建的临时视频。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const syncFS = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const originalNow = Date.now
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, offset = 0
const calls = []
async function until(fn, timeout = 30000) {
  const start = originalNow()
  while (originalNow() - start < timeout) { if (await fn()) return; await sleep(100) }
  throw new Error('本地清理 UI 验收超时')
}
;(async () => {
  temp = syncFS.realpathSync(syncFS.mkdtempSync(path.join(os.tmpdir(), 'plutofish-retention-ui-')))
  syncFS.mkdirSync(path.join(temp, 'app', 'Shared Dictionary', 'cache'), { recursive: true })
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
    calls.push({ endpoint, body })
    let result
    if (endpoint === 'me') result = { id: 'retention-publisher', name: '本地清理验收', kind: 'publisher',
      sourceAccount: { id: 'source', alias: 'offline', name: '本机模拟网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    else if (endpoint === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: 'S01.1080p.WEB.WEB-DL.SDR.AVC', resolution: '1080p', dynamicRange: 'SDR', status: 'published' }], total: 1, page: 1, pageSize: 100 }
    else if (endpoint === 'files/check') result = { status: 'missing' }
    else if (endpoint === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'original', filePickCode: 'mockfile' } }
    else if (['files/report', 'files/ed2k', 'range-proofs/forget'].includes(endpoint)) result = { accepted: true }
    else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
    else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
    else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Date.now = () => originalNow() + offset
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0], errors = []
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  const snapshot = () => js('window.plutoWatch.snapshot()')
  const click = label => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw Error('找不到按钮: ' + ${JSON.stringify(label)}); b.click() })()`)
  const fill = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const toggle = () => js("document.querySelector('[role=switch]').click()")
  const screenshot = async name => {
    await fs.mkdir(path.resolve('.smoke'), { recursive: true })
    win.show(); win.webContents.invalidate(); await sleep(250)
    await fs.writeFile(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await until(async () => (await snapshot()).ffprobeAvailable)
  assert.deepEqual((await snapshot()).retention, { enabled: false, days: 7 })
  await click('连接与设置')
  await fill('input[type=url]', `http://127.0.0.1:${server.address().port}`)
  await fill('input[type=password]', 'offline-retention-test')
  await click('保存并连接')
  await until(async () => (await snapshot()).connection.status === 'verified')
  await js("document.querySelector('.retention-settings').scrollIntoView({block:'center'})")
  await screenshot('27-retention-disabled')
  await toggle(); await fill('input[aria-label="保留天数"]', '2')
  // 尚未保存的开关不能触发删除。
  assert.equal((await snapshot()).retention.enabled, false)
  await click('保存清理设置')
  await until(async () => (await snapshot()).retention.enabled)
  assert.deepEqual((await snapshot()).retention, { enabled: true, days: 2 })
  assert.equal(await js("window.plutoWatch.setRetention({enabled:true,days:0}).then(() => false, () => true)"), true)
  assert.equal((await snapshot()).retention.days, 2)
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await js("document.querySelector('.retention-settings').scrollIntoView({block:'center'})")
  await screenshot('28-retention-enabled-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  const media = path.join(temp, 'media'); await fs.mkdir(media)
  const file = path.join(media, 'Test.S01E01.mp4'), sidecar = path.join(media, 'Test.S01E01.nfo')
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', file]).status, 0)
  await fs.writeFile(sidecar, 'keep')
  await js(`window.plutoWatch.add(${JSON.stringify({ path: media, title: '定期清理验收', sourceAccountId: 'source',
    work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1, versionMode: 'fixed', releaseId: 'a'.repeat(32), directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 10 })})`)
  await click('传输任务')
  await until(async () => { const j = (await snapshot()).jobs[0]; return j?.status === 'completed' && j.synced && j.ed2kSaved })
  const complete = (await snapshot()).jobs[0], due = complete.retention.deleteAt
  assert.ok(due > originalNow() + 47 * 3600000)
  await screenshot('29-retention-planned-narrow-dark')
  offset = due - 60000 - originalNow(); await sleep(1500)
  assert.equal(syncFS.existsSync(file), true)
  await click('暂停上传')
  offset = due + 60001 - originalNow(); await sleep(1500)
  assert.equal(syncFS.existsSync(file), true)
  await click('连接与设置'); await toggle(); await click('保存清理设置')
  await until(async () => !(await snapshot()).retention.enabled)
  await js('window.plutoWatch.pauseAll()'); offset += 60001; await sleep(1500)
  assert.equal(syncFS.existsSync(file), true)
  await toggle(); await click('保存清理设置')
  await until(async () => (await snapshot()).retention.enabled)
  offset += 60001
  await until(async () => !syncFS.existsSync(file) && (await snapshot()).jobs[0].retention?.state === 'deleted')
  await until(() => calls.some(c => c.endpoint === 'range-proofs/forget'))
  assert.equal(syncFS.existsSync(sidecar), true)
  const final = (await snapshot()).jobs[0]
  assert.equal(final.status, 'completed'); assert.equal(final.ed2k.link, complete.ed2k.link)
  assert.deepEqual(calls.find(c => c.endpoint === 'range-proofs/forget').body.taskKeys, [final.fileKey])
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, 'app', 'watch-state.json'), 'utf8')).retention, { enabled: true, days: 2 })
  await click('传输任务')
  await until(() => js("document.body.innerText.includes('本地文件已清理')"))
  assert.equal(await js("[...document.querySelectorAll('.task-actions button')].some(b => b.textContent === '定位')"), false)
  await screenshot('30-retention-deleted-narrow-dark')
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  await screenshot('31-retention-deleted-light')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, defaultDisabled: true, retentionDays: 2, noEarlyDeletion: true, pauseRespected: true,
    disabledRespected: true, deletedOnlyVideo: true, historyAndED2KPreserved: true, notifiedServer: true, rendererErrors: errors }))
  Date.now = originalNow; app.quit()
})().catch(error => { failed = true; Date.now = originalNow; console.error(error); app.quit() })
app.on('will-quit', () => {
  server?.closeAllConnections(); server?.close()
  if (temp) syncFS.rmSync(temp, { recursive: true, force: true })
})
app.on('quit', () => { if (failed) process.exit(1) })
