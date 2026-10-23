/* 真实 Electron + 回环服务：慢查询、保存中重连和业务请求断线恢复，不读取正式配置。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, heldRoute = '', heldResponse, dropRoute = '', failed = false
const calls = []
async function until(fn, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(50) }
  throw new Error('连接恢复验收超时')
}
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-connection-ui-')))
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}, route = req.url.replace('/api/v1/publisher/', '')
    calls.push(route)
    if (route === heldRoute) { heldResponse = res; return }
    if (route === dropRoute) { dropRoute = ''; req.socket.destroy(); return }
    let result
    if (route === 'me') result = { id: 'publisher', name: '连接恢复验收', kind: 'publisher',
      sourceAccount: { id: 'source', alias: 'offline', name: '模拟源账号', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    else if (route === 'releases/query') result = { items: [], total: 0, page: body.page, pageSize: 100 }
    else if (route === 'directories') result = { sourceAccountId: 'source', path: [{ id: '0', name: '根目录' }], items: [], nextCursor: '' }
    else if (route === 'tmdb/search') result = { items: [], page: 1, total: 0, totalPages: 0 }
    else if (route === 'range-proofs/pending') result = { jobs: [] }
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
  const click = label => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled || b.closest('fieldset:disabled')) throw Error('按钮不可用：' + ${JSON.stringify(label)}); b.click() })()`)
  const fill = async (selector, value) => {
    await until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`))
    return js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  }
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true })
    win.show(); win.webContents.invalidate(); await sleep(200)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  const url = `http://127.0.0.1:${server.address().port}`
  await click('连接与设置')
  await fill('input[type=url]', url); await fill('input[type=password]', 'offline-only')
  await click('保存并连接')
  await until(async () => (await snapshot()).connection.status === 'verified')
  const releaseQuery = `window.plutoWatch.releases({ work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, sourceAccountId: 'source', seasonNumber: 1 })`
  const directoryQuery = `window.plutoWatch.directories({ sourceAccountId: 'source', directoryId: '0' })`

  // 未结束的只读请求不能占住写命令队列；重连可以取消请求而无需等待 90 秒超时。
  heldRoute = 'directories'
  await js(`(() => { window.pendingRead = ${directoryQuery}.catch(e => e.message); return true })()`)
  await until(() => !!heldResponse)
  await js('window.plutoWatch.pauseAll()')
  assert.equal((await snapshot()).uploadsPaused, true)
  await js('window.plutoWatch.pauseAll()')
  const oldRead = heldResponse; heldResponse = undefined; heldRoute = ''
  await click('重新验证连接')
  await until(async () => (await snapshot()).connection.status === 'verified')
  assert.match(await js('window.pendingRead'), /旧请求已取消/)
  oldRead.end(JSON.stringify({ error: 'old response' }))
  assert.equal((await js(directoryQuery)).sourceAccountId, 'source')

  // 保存表单本身在等待版本查询时，设置页仍能点击重连；取消的保存不得创建目录。
  await click('监控目录'); await click('添加目录')
  const media = path.join(temp, 'media'); fs.mkdirSync(media)
  await fill('input[placeholder="选择包含视频文件的目录"]', media)
  await click('直接填写 TMDB ID')
  await fill('input[placeholder="作品名称"]', '连接恢复验收')
  await fill('input[placeholder="填写 TMDB ID"]', '123')
  heldRoute = 'releases/query'
  await click('创建并开始监控')
  await until(() => !!heldResponse)
  await click('连接与设置')
  await click('重新验证连接')
  await until(() => js("!!document.querySelector('.identity-card') && !document.querySelector('form fieldset').disabled"))
  assert.equal((await snapshot()).watches.length, 0)
  assert.equal(await js("!!document.querySelector('.dismissible[role=alert]')"), false)
  heldRoute = ''; heldResponse.end(); heldResponse = undefined
  assert.deepEqual(await js(releaseQuery), [])

  // 作品/版本/目录任何一次断线都应自动恢复，添加目录页面也显示恢复提示。
  await click('监控目录'); await click('添加目录')
  const queries = [releaseQuery, directoryQuery, `window.plutoWatch.searchWorks({ query: '星海', mediaType: 'tv', sourceAccountId: 'source', page: 1 })`]
  for (const [i, route] of ['releases/query', 'directories', 'tmdb/search'].entries()) {
    dropRoute = route
    assert.match(await js(`${queries[i]}.catch(e => e.message)`), /网络连接中断/)
    await until(() => js("document.body.innerText.includes('正在自动恢复')"))
    if (i === 0) {
      await screenshot('27-form-reconnecting')
      win.setSize(840, 720); nativeTheme.themeSource = 'dark'
      await screenshot('28-form-reconnecting-narrow-dark')
      assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
    }
    await until(async () => (await snapshot()).connection.status === 'verified')
    await js(queries[i])
  }
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840)
  await screenshot('29-form-recovered')
  assert.deepEqual(errors, [])
  assert.ok(calls.filter(route => route === 'me').length >= 6)
  console.log(JSON.stringify({ ok: true, queriesRecovered: 3, slowReadCancelled: true, saveCancelledBeforeMutation: true, reconnectButtonAvailable: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
