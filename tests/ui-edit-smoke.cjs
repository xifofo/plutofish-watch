/* 真实 Electron 编辑验收：回填、取消、校验、暂停保留、路径变更及窄屏深色；仅本机假服务。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false
const calls = []
async function until(fn, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(50) }
  throw new Error('目录编辑验收超时')
}
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-edit-ui-')))
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  const source = { id: 'source', alias: 'old', name: '原源账号', provider: '115' }
  const other = { id: 'other', alias: 'new', name: '新源账号', provider: '115' }
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}, route = req.url.replace('/api/v1/publisher/', '')
    calls.push(route)
    let result
    if (route === 'me') result = { id: 'publisher', name: '目录编辑验收', kind: 'publisher', sourceAccount: source,
      sourceAccounts: [source, other], categories: [{ value: 'tv', label: '剧集' }, { value: 'film', label: '电影' }] }
    else if (route === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: '原版本', resolution: '1080p', dynamicRange: 'SDR', status: 'published' }], total: 1, page: body.page, pageSize: 100 }
    else if (route === 'range-proofs/pending') result = { jobs: [] }
    else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../out/main/index.js')
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0], errors = []
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  const snapshot = () => js('window.plutoWatch.snapshot()')
  const click = async text => {
    const find = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
    await until(() => js(`(() => { const b = ${find}; return !!b && !b.disabled && !b.closest('fieldset:disabled') })()`))
    await js(`(${find}).click()`)
  }
  const fill = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('输入框不存在: ' + ${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(150)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  assert.equal(await js("document.querySelector('.sidebar-version').textContent"), 'v' + require('../package.json').version)
  await until(async () => (await snapshot()).ffprobeAvailable)
  await js(`window.plutoWatch.connect({ url: 'http://127.0.0.1:${server.address().port}', key: 'offline-only' })`)
  await js('window.plutoWatch.pauseAll()')
  const oldPath = path.join(temp, '原目录'), newPath = path.join(temp, '新目录'), secondPath = path.join(temp, '另一个目录')
  for (const dir of [oldPath, newPath, secondPath]) fs.mkdirSync(dir)
  const extraPaths = ['补充目录一', '补充目录二', '补充目录三'].map(name => path.join(temp, name))
  for (const dir of extraPaths) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(oldPath, 'Show.S01E01.mp4'), 'offline fixture, never uploaded')
  fs.writeFileSync(path.join(newPath, 'New.Movie.mp4'), 'new offline fixture')
  const input = { path: oldPath, title: '原作品', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    sourceAccountId: 'source', versionMode: 'fixed', releaseId: 'a'.repeat(32), directoryId: '42', directoryPath: '/原目录', includeExisting: true, stableSeconds: 30 }
  await js(`window.plutoWatch.add(${JSON.stringify(input)})`)
  await js(`window.plutoWatch.add(${JSON.stringify({ ...input, path: secondPath, title: '另一作品' })})`)
  const original = (await snapshot()).watches[0]
  await js(`window.plutoWatch.toggleWatch(${JSON.stringify(original.id)})`)
  await click('监控目录'); await click('编辑')
  await until(() => js("document.querySelector('h1')?.textContent === '编辑监控目录'"))
  assert.equal(await js("document.querySelector('.selected-work strong').textContent"), '原作品')
  assert.equal(await js("document.querySelector('.version-row select').value"), input.releaseId)
  await click('修改信息')
  assert.equal(await js("document.querySelector('input[placeholder=\"作品名称\"]').value"), '原作品')
  assert.equal(await js("document.querySelector('input[placeholder=\"填写 TMDB ID\"]').value"), '123')
  await fill('input[placeholder="作品名称"]', '临时修改名称')
  await fill('input[type=number]', '60'); await click('返回监控目录')
  assert.equal((await snapshot()).watches[0].stableSeconds, 30)
  assert.equal((await snapshot()).watches[0].title, '原作品')
  await click('编辑')
  await fill('input[placeholder="选择包含视频文件的目录"]', secondPath)
  await click('保存修改')
  await until(() => js("document.body.innerText.includes('监控目录不能重复')"))
  assert.equal((await snapshot()).watches[0].path, oldPath)
  await fill('input[placeholder="选择包含视频文件的目录"]', oldPath)
  await fill('input[type=number]', '20')
  await fill('select:has(option[value="movie"])', 'movie')
  await fill('select:has(option[value="film"])', 'film')
  await click('直接填写 TMDB ID')
  await fill('input[placeholder="作品名称"]', '修改后的电影 · 一段足够长的名称用于检查窄窗口里的换行显示')
  await fill('input[placeholder="填写 TMDB ID"]', '456')
  await fill('select:has(option[value="other"])', 'other')
  await fill('select[aria-label="版本归类"]', 'auto')
  await fill('input[pattern="0|[1-9][0-9]{0,39}"]', '99')
  await fill('input[placeholder="/"]', '/新的网盘目录')
  await js("[...document.querySelectorAll('details')].find(d => d.textContent.includes('目录来源预设')).open = true")
  await fill('input[aria-label="来源平台"]', 'NF'); await fill('select[aria-label="来源类型"]', 'WEB-DL')
  await js("document.querySelector('button[aria-label=\"关闭错误\"]').click()")
  // 超过两个目录可连续添加；删除中间一行后其他路径保持正确。
  for (const [index, directory] of extraPaths.entries()) {
    await click('添加本地目录')
    await fill(`input[aria-label="本地目录 ${index + 2}"]`, directory)
  }
  assert.equal(await js("document.querySelectorAll('.local-directory').length"), 4)
  await js("document.querySelector('button[aria-label=\"移除本地目录 3\"]').click()")
  assert.equal(await js("document.querySelector('input[aria-label=\"本地目录 3\"]').value"), extraPaths[2])
  await screenshot('34-edit-light')
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await screenshot('35-edit-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await js("document.querySelector('button[type=submit]').scrollIntoView({ block: 'end' })")
  await screenshot('36-edit-target-dark')
  await click('保存修改')
  await until(() => js("document.querySelector('h1')?.textContent === '监控目录'"))
  const edited = (await snapshot()).watches[0]
  assert.deepEqual(edited.additionalPaths, [extraPaths[0], extraPaths[2]])
  assert.equal(edited.id, original.id); assert.equal(edited.createdAt, original.createdAt)
  assert.equal(edited.enabled, false); assert.equal(edited.work.tmdbId, '456'); assert.equal(edited.work.category, 'film')
  assert.equal(edited.work.mediaType, 'movie'); assert.equal(edited.seasonNumber, undefined)
  assert.equal(edited.binding.sourceAccount.id, 'other'); assert.equal(edited.directoryId, '99')
  assert.equal(edited.stableSeconds, 20); assert.equal(edited.versionMode, 'auto')
  assert.deepEqual(edited.sourcePreset, { platform: 'NF', type: 'WEB-DL' })
  assert.equal((await snapshot()).jobs[0].episodeNumber, undefined)
  await screenshot('37-edited-directory-dark')
  await click('编辑')
  assert.equal(await js("document.querySelector('.selected-work strong').textContent"), edited.title)
  assert.equal(await js("document.querySelector('input[aria-label=\"本地目录 2\"]').value"), extraPaths[0])
  assert.equal(await js("document.querySelector('input[aria-label=\"本地目录 3\"]').value"), extraPaths[2])
  await fill('input[placeholder="选择包含视频文件的目录"]', newPath)
  await click('保存修改'); await until(() => js("document.querySelector('h1')?.textContent === '监控目录'"))
  assert.equal((await snapshot()).jobs[0].status, 'cancelled')
  await js(`window.plutoWatch.toggleWatch(${JSON.stringify(original.id)})`)
  const final = await snapshot()
  assert.equal(final.watches[0].enabled, true); assert.equal(final.watches[0].path, newPath)
  await until(() => js("document.querySelector('.topbar').textContent.includes('4 个目录监控中')"))
  assert.ok(final.jobs.some(j => j.path === path.join(newPath, 'New.Movie.mp4')))
  const disk = JSON.parse(fs.readFileSync(path.join(temp, 'app', 'watch-state.json'), 'utf8'))
  assert.equal(disk.watches[0].directoryId, '99')
  assert.deepEqual(disk.watches[0].additionalPaths, [extraPaths[0], extraPaths[2]])
  for (const directory of extraPaths.filter((_, index) => index !== 1)) assert.ok((await js("document.querySelector('.watch-row').textContent")).includes(directory))
  assert.equal(calls.some(p => p.startsWith('uploads/') || p === 'files/report' || p === 'directories'), false)
  await click('传输任务')
  await until(() => js("!!document.querySelector('.original-target')"))
  assert.ok((await js("document.querySelector('.original-target').textContent")).includes('新的网盘目录'))
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await screenshot('38-original-target-dark')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, editPrefill: true, cancelPreservesValues: true, duplicatePathRejected: true, pausedPreserved: true, pathChanged: true, multipleDirectories: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error, { calls }); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
