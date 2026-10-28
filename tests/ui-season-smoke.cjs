/* 整部剧一次性上传：真实 Electron/IPC、临时目录和回环假服务，不访问真实网盘。 */
const { app, BrowserWindow, nativeTheme, dialog } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const originalNow = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, offset = 0
const calls = [], errors = []
async function until(fn, label = '状态') {
  const end = originalNow() + 25000
  while (originalNow() < end) { if (await fn()) return; await sleep(100) }
  throw Error(`跨季上传 ${label} 验收超时`)
}
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-seasons-ui-')))
  const media = path.join(temp, 'Platonic')
  for (const season of ['S1', 'S2']) fs.mkdirSync(path.join(media, season), { recursive: true })
  const files = ['S1/Platonic.S01E01.NF.WEB-DL.mp4', 'S2/Platonic.S02E01.NF.WEB-DL.mp4', 'S2/Platonic.S01E03.NF.WEB-DL.mp4']
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=0.1', '-c:v', 'libx264', '-y', path.join(media, files[0])]).status, 0)
  for (const file of files.slice(1)) fs.copyFileSync(path.join(media, files[0]), path.join(media, file))
  app.setPath('userData', path.join(temp, 'app')); process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [media] })
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
      calls.push({ endpoint, body })
      let result
      if (endpoint === 'me') result = { id: 'publisher', name: '跨季上传离线验收', kind: 'publisher', sourceAccount: { id: 'source', alias: 'offline', name: '离线网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
      else if (endpoint === 'tmdb/recognize') {
        const work = { tmdbId: '123', mediaType: 'tv', title: '柏拉图关系', originalTitle: 'Platonic', englishTitle: 'Platonic', year: 2023, posterUrl: '', category: { name: '剧集', value: 'tv', label: '剧集', status: 'matched' } }
        result = { status: 'compatible', canAutoFill: true, reasons: [], truncated: false, selectionBasis: '',
          parsed: { title: 'Platonic', mediaType: 'tv', seasonNumber: 1, episodeNumber: 1, resolution: '720p', source: 'WEB-DL', warnings: [] },
          work, workTarget: { tmdbId: '123', mediaType: 'tv', category: 'tv' }, candidates: [{ work, conflicts: [] }] }
      } else if (endpoint === 'releases/query') result = { items: [], page: 1, total: 0, pageSize: 100 }
      else if (endpoint === 'files/check') result = { status: 'missing' }
      else if (endpoint === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'original', filePickCode: 'mockfile' } }
      else if (['files/report', 'files/ed2k'].includes(endpoint)) result = { accepted: true }
      else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
      else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
      else throw Error(`不允许的请求 ${endpoint}`)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Date.now = () => originalNow() + offset
  require('../out/main/index.js'); await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0]
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  const snapshot = () => js('window.plutoWatch.snapshot()')
  const click = async text => {
    const find = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
    await until(() => js(`(() => {const b=${find}; return b && !b.disabled && !b.closest('fieldset:disabled')})()`), text)
    await js(`${find}.click()`)
  }
  const fill = (selector, value) => js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(300)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await until(async () => (await snapshot()).ffprobeAvailable)
  await js(`window.plutoWatch.connect(${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-only' })})`)
  await js('window.plutoWatch.pauseAll()')
  await until(() => js("document.querySelector('.sidebar-bottom strong')?.textContent === '跨季上传离线验收'"), '连接状态显示')
  await click('一次性上传'); await click('新建一次性上传'); await click('选择目录')
  await until(() => js("!!document.querySelector('.selected-work')"), '识别作品')
  assert.equal(await js("document.body.innerText.includes('默认季号')"), true)
  await fill('input[type=number][min="10"]', '10')
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840)
  await js("document.querySelector('.version-mode').scrollIntoView({block:'center'})")
  await screenshot('seasons-form-light')
  await click('开始一次性上传'); await until(async () => (await snapshot()).jobs.length === 3)
  offset += 11000; await js('window.plutoWatch.scan()')
  const state = await snapshot()
  const identities = state.jobs.map(j => [j.relativePath, j.seasonNumber, j.episodeNumber, j.status])
  assert.deepEqual(identities.find(j => j[0] === files[0]).slice(1), [1, 1, 'queued'])
  assert.deepEqual(identities.find(j => j[0] === files[1]).slice(1), [2, 1, 'queued'])
  assert.equal(identities.find(j => j[0] === files[2])[3], 'review')
  await js("document.querySelectorAll('nav button')[3].click()")
  await until(() => js("!!document.querySelector('input[placeholder=季号]')"), '季号冲突表单')
  await screenshot('seasons-queue-light')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720)
  await screenshot('seasons-queue-narrow-dark')
  await js("document.querySelector('.review-row').scrollIntoView({block:'center'})")
  await screenshot('seasons-review-narrow-dark')
  await fill('input[placeholder=季号]', '2'); await fill('input[placeholder=集号]', '3'); await click('确认入队')
  await until(async () => (await snapshot()).jobs.every(j => j.status === 'queued'), '人工确认')
  await click('继续上传')
  await until(async () => (await snapshot()).watches[0].batch.completedAt !== undefined, '跨季发布与 ED2K')
  const reports = calls.filter(c => c.endpoint === 'files/report')
  assert.deepEqual(reports.map(c => [c.body.releaseTarget.seasonNumber, c.body.episodeNumber]).sort(), [[1, 1], [2, 1], [2, 3]])
  assert.equal(new Set(reports.map(c => c.body.releaseTarget.releaseKey)).size, 2)
  await screenshot('seasons-completed-narrow-dark')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, mixedSeasonFolder: true, separateVersionKeys: true, seasonConflictConfirmation: true, allEd2kSynced: true, lightAndNarrowDark: true }))
  Date.now = originalNow; app.quit()
})().catch(async error => { failed = true; Date.now = originalNow; console.error(error); const win = BrowserWindow.getAllWindows()[0]; if (win) console.error(await win.webContents.executeJavaScript('document.body.innerText')); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
