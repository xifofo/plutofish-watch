/* 真实 Electron/IPC、原生目录选择入口、回环服务和假时钟；只删除本测试的临时目录。 */
const { app, BrowserWindow, nativeTheme, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const originalNow = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, offset = 0
const calls = [], errors = []
async function until(fn, label = '状态', timeout = 25000) {
  const end = originalNow() + timeout
  while (originalNow() < end) { if (await fn()) return; await sleep(100) }
  throw Error(`一次性上传 ${label} 验收超时`)
}
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-once-ui-')))
  const media = path.join(temp, 'Stars'), second = path.join(temp, 'Second')
  fs.mkdirSync(media); fs.mkdirSync(second)
  const file = path.join(media, 'Stars.S01E01.NF.WEB-DL.mp4'), sidecar = path.join(media, 'poster.nfo')
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', file]).status, 0)
  fs.writeFileSync(sidecar, 'sidecar'); fs.copyFileSync(file, path.join(second, 'Stars.S01E01.NF.WEB-DL.mp4'))
  fs.mkdirSync(path.join(temp, 'app', 'Shared Dictionary', 'cache'), { recursive: true })
  app.setPath('userData', path.join(temp, 'app')); process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  let selected = media, chooseCount = 0
  dialog.showOpenDialog = async () => { chooseCount++; return { canceled: false, filePaths: [selected] } }
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
      calls.push({ endpoint, body })
      let result
      if (endpoint === 'me') result = { id: 'publisher', name: '一次性上传离线验收', kind: 'publisher', sourceAccount: { id: 'source', alias: 'offline', name: '离线网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
      else if (endpoint === 'tmdb/recognize') {
        const work = { tmdbId: '123', mediaType: 'tv', title: '星海纪行', originalTitle: 'Stars', englishTitle: 'Stars', year: 2024, posterUrl: '', category: { name: '剧集', value: 'tv', label: '剧集', status: 'matched' } }
        result = { status: 'compatible', canAutoFill: true, reasons: [], truncated: false, selectionBasis: '',
          parsed: { title: 'Stars', mediaType: 'tv', seasonNumber: 1, episodeNumber: 1, resolution: '1080p', source: 'WEB-DL', warnings: [] },
          work, workTarget: { tmdbId: '123', mediaType: 'tv', category: 'tv' }, candidates: [{ work, conflicts: [] }] }
      } else if (endpoint === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: 'S01.NF.WEB-DL.SDR', resolution: '1080p', dynamicRange: 'SDR', status: 'published' }], page: 1, total: 1, pageSize: 100 }
      else if (endpoint === 'files/check') result = { status: 'missing' }
      else if (endpoint === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'original', filePickCode: 'mockfile' } }
      else if (['files/report', 'files/ed2k', 'range-proofs/forget'].includes(endpoint)) result = { accepted: true }
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
  const click = async label => {
    const button = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`
    await until(() => js(`(() => {const b=${button}; return b && !b.disabled && !b.closest('fieldset:disabled')})()`), label)
    await js(`${button}.click()`)
  }
  const fill = (selector, value) => js(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); await sleep(150)
    if (name.includes('form')) await js("document.querySelector('.once-cleanup').scrollIntoView({block:'center'})")
    win.webContents.invalidate(); await sleep(300)
    fs.writeFileSync(path.resolve('.smoke', `${name}.png`), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await until(async () => (await snapshot()).ffprobeAvailable)
  await js(`window.plutoWatch.connect(${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-only' })})`)
  await js('window.plutoWatch.setRetention({enabled:true,days:3})')
  await js('window.plutoWatch.pauseAll()')
  await until(() => js("document.querySelector('.sidebar-bottom strong')?.textContent === '一次性上传离线验收'"), '连接状态显示')
  await click('一次性上传'); await click('选择目录上传')
  assert.equal(await js("!!document.querySelector('.once-cleanup')"), false)
  await click('选择目录'); await until(() => js("!!document.querySelector('.selected-work')"), '识别回填')
  assert.equal(chooseCount, 1)
  assert.equal(await js("document.querySelector('input[aria-label=目录保留天数]').value"), '1')
  assert.equal(await js("document.querySelector('input[aria-label=自动删除本次目录]').checked"), false)
  await fill('select[aria-label="版本归类"]', 'fixed'); await click('查询版本')
  await fill('input[type=number][min="10"]', '10')
  await until(() => js("!document.querySelector('input[aria-label=自动删除本次目录]').closest('fieldset:disabled')"), '表单就绪')
  await js("document.querySelector('input[aria-label=自动删除本次目录]').click()")
  assert.equal(await js("document.querySelector('input[aria-label=自动删除本次目录]').checked"), true)
  await js("document.querySelector('.once-cleanup').scrollIntoView({block:'center'})")
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('once-form-light')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720); await screenshot('once-form-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await click('开始一次性上传'); await until(async () => (await snapshot()).watches.length === 1)
  let root = (await snapshot()).watches[0]
  assert.equal(root.mode, 'once'); assert.deepEqual(root.cleanup, { enabled: true, days: 1 })
  await js('window.plutoWatch.pauseAll()'); offset += 11000; await js('window.plutoWatch.scan()')
  await until(async () => (await snapshot()).watches[0].batch.completedAt !== undefined, '上传和 ED2K 同步')
  root = (await snapshot()).watches[0]; const due = root.batch.deleteAt
  assert.equal(due - root.batch.completedAt, 24 * 3600_000)
  assert.ok((await snapshot()).jobs[0].ed2kSaved)
  await screenshot('once-completed-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  offset = due - 3600_000 - originalNow(); await sleep(1500)
  assert.equal(fs.existsSync(file), true) // 本次一天尚未到期；全局三天清理不改变此任务的独立策略。
  await js('window.plutoWatch.pauseAll()'); offset = due + 60001 - originalNow(); await sleep(1500)
  assert.equal(fs.existsSync(file), true)
  await js('window.plutoWatch.pauseAll()'); offset += 60001
  await until(async () => !fs.existsSync(media) && (await snapshot()).watches[0].batch.deletedAt, '整目录到期清理')
  await until(() => calls.some(c => c.endpoint === 'range-proofs/forget'), '撤销本地校验资格')
  assert.equal(fs.existsSync(sidecar), false)
  assert.equal((await snapshot()).jobs[0].status, 'completed')
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('once-deleted-light')

  // 第二次走相同入口，确认可取消删除，并且后续新增文件不会自动加入。
  selected = second; await click('选择目录上传'); await click('选择目录')
  await until(() => js("!!document.querySelector('.selected-work')"))
  await fill('select[aria-label="版本归类"]', 'fixed'); await click('查询版本')
  await until(() => js("!document.querySelector('input[aria-label=自动删除本次目录]').closest('fieldset:disabled')"), '表单就绪')
  await js("document.querySelector('input[aria-label=自动删除本次目录]').click()")
  assert.equal(await js("document.querySelector('input[aria-label=自动删除本次目录]').checked"), true)
  await click('开始一次性上传'); await until(async () => (await snapshot()).watches.length === 2)
  await click('取消删除')
  await until(async () => !(await snapshot()).watches[1].cleanup.enabled)
  fs.copyFileSync(path.join(second, 'Stars.S01E01.NF.WEB-DL.mp4'), path.join(second, 'Stars.S01E02.mp4'))
  await js('window.plutoWatch.scan()')
  assert.equal((await snapshot()).jobs.length, 2)
  assert.equal(chooseCount, 2)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, recognized: true, defaultOneDay: true, optionalDeletion: true, entireFolderDeleted: true,
    pauseRespected: true, globalPolicyIsolated: true, cancelCleanup: true, fixedFileList: true, notifiedServer: true, lightAndNarrowDark: true }))
  Date.now = originalNow; app.quit()
})().catch(async error => { failed = true; Date.now = originalNow; console.error(error); const win = BrowserWindow.getAllWindows()[0]; if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); fs.writeFileSync(path.resolve('.smoke/once-error.png'), (await win.webContents.capturePage()).toPNG()) }; app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
