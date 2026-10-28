/* 真实 Electron / IPC + 回环假服务：识别后手动建目录、固定 ID、换季和窄屏深色。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const assert = require('node:assert/strict'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, nextId = 100, failCreate = true, slowBrowse = false
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-directory-screens-')); console.log('screenshots:', output)
const calls = [], errors = [], paths = new Map([['0', [{ id: '0', name: '/' }]], ['10', [{ id: '0', name: '/' }, { id: '10', name: '影视资源' }]],
  ['11', [{ id: '0', name: '/' }, { id: '11', name: '备用资源' }]], ['12', [{ id: '0', name: '/' }, { id: '10', name: '影视资源' }, { id: '12', name: '待整理' }]]])
async function until(fn, label = '界面', timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(50) }
  throw new Error(`手动创建目录验收超时：${label}`)
}
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-directory-ui-')))
  const media = path.join(temp, 'Doctor X'); fs.mkdirSync(media); fs.writeFileSync(path.join(media, 'Doctor.X.S01E01.mkv'), 'offline-only')
  app.setPath('userData', path.join(temp, 'app')); process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  const source = { id: 'source', alias: 'primary', name: '主网盘', provider: '115' }, other = { id: 'other', alias: 'second', name: '第二网盘', provider: '115' }
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}, route = req.url.replace('/api/v1/publisher/', '')
      calls.push({ route, body }); let result
      if (route === 'me') result = { id: 'publisher', name: '手动建目录离线验收', kind: 'publisher', sourceAccount: source,
        sourceAccounts: [source, other], categories: [{ value: 'japan', label: '日韩剧集' }, { value: 'tv', label: '其他剧集' }] }
      else if (route === 'tmdb/recognize') {
        const work = { tmdbId: '45951', mediaType: 'tv', title: 'Doctor X', originalTitle: 'Doctor X', englishTitle: 'Doctor X', year: 2012, posterUrl: '',
          category: { name: '日韩剧集', value: 'japan', label: '日韩剧集', status: 'matched' } }
        result = { status: 'compatible', canAutoFill: true, reasons: [], truncated: false, selectionBasis: '',
          parsed: { title: 'Doctor X', mediaType: 'tv', seasonNumber: 1, episodeNumber: 1, resolution: '1080p', source: 'WEB-DL', warnings: [] },
          work, workTarget: { tmdbId: '45951', mediaType: 'tv', category: 'japan' }, candidates: [{ work, conflicts: [] }] }
      } else if (route === 'directories/create') {
        if (failCreate) { failCreate = false; res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: '目录创建暂不可用，请重试' } })); return }
        await sleep(200)
        const parent = paths.get(body.directoryId); assert.ok(parent)
        const chain = [...parent]
        for (const name of body.segments) { chain.push({ id: String(nextId++), name }); paths.set(chain.at(-1).id, [...chain]) }
        result = { sourceAccountId: body.sourceAccountId, path: chain, items: [], nextCursor: '' }
      } else if (route === 'directories') {
        if (slowBrowse) await sleep(500)
        const chain = paths.get(body.directoryId); assert.ok(chain)
        const items = [...paths.values()].filter(p => p.length === chain.length + 1 && p.at(-2).id === body.directoryId).map(p => p.at(-1))
        result = { sourceAccountId: body.sourceAccountId, path: chain, items, nextCursor: '' }
      }
      else if (route === 'releases/query') result = { items: [], total: 0, page: body.page, pageSize: 100 }
      else if (route === 'range-proofs/pending') result = { jobs: [] }
      else throw new Error(`不允许的测试请求: ${route}`)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../out/main/index.js')
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0]
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = async code => {
    try { return await win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true) }
    catch (error) { throw new Error(`${code}\n${error.message}`) }
  }
  const snapshot = () => js('window.plutoWatch.snapshot()')
  const click = async text => {
    const find = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
    await until(() => js(`(() => { const b = ${find}; return !!b && !b.disabled && !b.closest('fieldset:disabled') })()`), text); await js(`(${find}).click()`)
  }
  const fill = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('缺少输入框: ' + ${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  const screenshot = async name => {
    fs.mkdirSync(output, { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(200)
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
    assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  }
  const creates = () => calls.filter(c => c.route === 'directories/create')
  const directoryId = () => js(`document.querySelector(${JSON.stringify('input[pattern="0|[1-9][0-9]{0,39}"]')}).value`)
  const directoryPath = () => js(`document.querySelector(${JSON.stringify('input[placeholder="/"]')}).value`)
  const seasonInput = 'label:has(input[type=number][min="0"]) input'
  const dialogPreview = () => js('document.querySelector(".directory-dialog .directory-preview p")?.textContent')
  const openDialog = async () => { await click('在网盘创建文件夹'); await until(() => dialogPreview().then(Boolean), '选择上级目录弹窗') }
  const closeDialog = async () => { await click('取消'); await until(() => js('!document.querySelector("dialog[open]")')) }
  const enter = async name => {
    const selector = JSON.stringify('[aria-label="进入“' + name + '”"]')
    await until(() => js(`!!document.querySelector(${selector}) && !document.querySelector(${selector}).disabled && !document.querySelector(${selector}).closest('fieldset:disabled')`))
    await js(`document.querySelector(${selector}).click()`)
  }
  const changeParent = async name => {
    await click('网盘顶层')
    await until(() => js('!!document.querySelector(".directory-dialog .folder-select:not(:disabled)")'))
    const reads = calls.filter(c => c.route === 'directories').length
    await click(name)
    await until(() => dialogPreview().then(value => value?.startsWith('/' + name + '/')))
    assert.equal(calls.filter(c => c.route === 'directories').length, reads, 'single selection must not browse')
  }
  await until(() => js('!!window.plutoWatch').catch(() => false)); await until(async () => (await snapshot()).ffprobeAvailable)
  assert.equal(await js('document.querySelector(".sidebar-version").textContent'), 'v' + require('../package.json').version)
  await js(`window.plutoWatch.connect({ url: 'http://127.0.0.1:${server.address().port}', key: 'offline-only' })`); await js('window.plutoWatch.pauseAll()')
  await until(() => js('document.querySelector(".sidebar-bottom strong")?.textContent === "手动建目录离线验收"'))
  await click('添加目录')
  await until(() => js('document.querySelector("h1")?.textContent === "添加监控目录"'))
  assert.equal(await js('!!document.querySelector(".directory-create")'), false)
  await fill('input[pattern="0|[1-9][0-9]{0,39}"]', '10'); await fill('input[placeholder="/"]', '/影视资源')
  await click('浏览网盘')
  await until(() => js('!!document.querySelector(".cloud-picker .folder-select:not(:disabled)")'))
  nativeTheme.themeSource = 'light'
  const reads = calls.filter(c => c.route === 'directories').length
  await click('待整理')
  assert.equal(calls.filter(c => c.route === 'directories').length, reads)
  assert.equal(await js('document.querySelector(".cloud-target-path").textContent'), '保存到：/影视资源/待整理')
  await js('document.querySelector(".cloud-picker").scrollIntoView({ block: "center" })')
  await screenshot('39-directory-selected-light')
  await js('document.querySelector(".cloud-picker .folder-select[aria-pressed=true]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))')
  await until(() => js('document.querySelectorAll(".cloud-picker .cloud-path button").length === 3'))
  assert.equal(calls.filter(c => c.route === 'directories').length, reads + 1)
  await click('影视资源 /'); await enter('待整理')
  await until(() => js('document.querySelectorAll(".cloud-picker .cloud-path button").length === 3'))
  assert.equal(calls.filter(c => c.route === 'directories').length, reads + 3)
  await click('影视资源 /'); await click('待整理'); await click('保存到选中的文件夹')
  assert.equal(await directoryId(), '12'); assert.equal(await directoryPath(), '/影视资源/待整理')
  await fill('input[pattern="0|[1-9][0-9]{0,39}"]', '10'); await fill('input[placeholder="/"]', '/影视资源')
  await fill('input[placeholder="选择包含视频文件的目录"]', media)
  await until(() => js('document.querySelector(".selected-work strong")?.textContent === "Doctor X"'), '识别成功')
  await until(() => js('document.querySelector(".directory-preview").textContent.includes("/影视资源/日韩剧集/Doctor X {tmdbid-45951}/season 01")'))
  assert.equal(creates().length, 0)
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720)
  await until(() => js('matchMedia("(prefers-color-scheme: dark)").matches'), '深色模式')
  await js('document.querySelector(".directory-create").scrollIntoView({ block: "center" })'); await screenshot('40-manual-directory-create-narrow-dark')
  await openDialog(); await click('待整理'); await until(() => dialogPreview().then(value => value?.includes('/影视资源/待整理/')))
  assert.equal(await directoryId(), '10'); assert.equal(creates().length, 0)
  await closeDialog(); assert.equal(await directoryId(), '10'); assert.equal(await directoryPath(), '/影视资源')
  await openDialog(); await changeParent('备用资源')
  assert.equal(await dialogPreview(), '/备用资源/日韩剧集/Doctor X {tmdbid-45951}/season 01')
  assert.equal(await js('document.querySelector("dialog").matches(":modal")'), true)
  await screenshot('42-directory-parent-dialog-narrow-dark')
  assert.equal(await js('(() => { const p=document.querySelector(".directory-dialog .directory-preview").getBoundingClientRect(); const b=document.querySelector(".dialog-footer .primary").getBoundingClientRect(); return p.top>=0 && p.bottom<=innerHeight && b.top>=0 && b.bottom<=innerHeight; })()'), true)
  await click('确认创建文件夹'); await until(() => js('!!document.querySelector(".directory-dialog [role=alert]")'), '错误留在弹窗')
  assert.equal(await directoryId(), '10'); assert.equal(creates().length, 1)
  assert.equal(await dialogPreview(), '/备用资源/日韩剧集/Doctor X {tmdbid-45951}/season 01')
  await click('确认创建文件夹')
  await js('document.querySelector(".dialog-footer .primary").click()')
  assert.equal(await js('document.querySelector("form > fieldset").disabled'), true)
  await until(() => directoryId().then(id => id === '102'))
  assert.equal(creates().length, 2); assert.equal(creates()[1].body.directoryId, '11')
  assert.deepEqual(creates()[1].body.segments, ['日韩剧集', 'Doctor X {tmdbid-45951}', 'season 01'])
  await js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "文件夹已创建").click()')
  assert.equal(creates().length, 2)
  await click('浏览网盘'); await click('保存到当前文件夹')
  assert.equal(await js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "文件夹已创建").disabled'), true)
  await click('创建并开始监控'); await until(async () => (await snapshot()).watches.length === 1)
  const originalCreation = (await snapshot()).watches[0].directoryCreation
  assert.equal(creates().length, 2)
  await click('编辑'); await click('修改信息'); await fill('input[placeholder=作品名称]', '新译名'); await fill('select:has(option[value=japan])', 'tv')
  assert.equal(await directoryId(), '102'); assert.equal(await js('document.querySelector(".directory-preview").textContent.includes("Doctor X")'), true)
  await fill(seasonInput, '2'); await until(() => directoryId().then(id => id === '101'))
  assert.equal(await js('document.querySelector("button[type=submit]").disabled'), true)
  assert.equal(creates().length, 2)
  await openDialog(); assert.equal(await dialogPreview(), '/备用资源/日韩剧集/Doctor X {tmdbid-45951}/season 02')
  await changeParent('影视资源'); await enter('影视资源'); await click('待整理'); await until(() => dialogPreview().then(value => value?.startsWith('/影视资源/待整理/')))
  await closeDialog(); assert.equal(await directoryId(), '101')
  await fill(seasonInput, '1'); await until(() => directoryId().then(id => id === '102'))
  assert.equal(await js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "文件夹已创建").disabled'), true)
  await click('保存修改'); await until(() => js('document.querySelector("h1").textContent === "监控目录"'))
  assert.deepEqual((await snapshot()).watches[0].directoryCreation, originalCreation)
  await click('编辑')
  await fill(seasonInput, '2'); await until(() => directoryId().then(id => id === '101'))
  await openDialog(); await click('确认创建文件夹'); await until(() => directoryId().then(id => id === '103'))
  assert.equal(creates()[2].body.directoryId, '101'); assert.deepEqual(creates()[2].body.segments, ['season 02'])
  await js('document.querySelector(".directory-create").scrollIntoView({ block: "center" })'); await screenshot('41-manual-directory-created-narrow-dark')
  await click('保存修改'); await until(() => js('document.querySelector("h1").textContent === "监控目录"'))
  const saved = (await snapshot()).watches[0]
  assert.equal(saved.directoryId, '103'); assert.ok(saved.directoryPath.includes('Doctor X')); assert.equal(saved.directoryCreation.parentId, '11')
  await click('编辑'); await fill(seasonInput, '3'); await until(() => directoryId().then(id => id === '101'))
  await openDialog(); await changeParent('影视资源'); await enter('影视资源'); await click('待整理'); await until(() => dialogPreview().then(value => value === '/影视资源/待整理/其他剧集/新译名 {tmdbid-45951}/season 03'))
  await click('确认创建文件夹'); await until(() => directoryId().then(id => id === '106'))
  assert.equal(creates()[3].body.directoryId, '12'); assert.deepEqual(creates()[3].body.segments, ['其他剧集', '新译名 {tmdbid-45951}', 'season 03'])
  await click('保存修改'); await until(() => js('document.querySelector("h1").textContent === "监控目录"'))
  const moved = (await snapshot()).watches[0]
  assert.equal(moved.directoryCreation.parentId, '12'); assert.equal(moved.directoryCreation.parentPath, '/影视资源/待整理')
  assert.equal(moved.directoryCreation.workDirectoryId, '105'); assert.equal(moved.directoryPath, '/影视资源/待整理/其他剧集/新译名 {tmdbid-45951}/season 03')
  await click('编辑'); await fill(seasonInput, '4'); slowBrowse = true
  await click('在网盘创建文件夹'); await until(() => js('!!document.querySelector("dialog[open]")'))
  await fill('select:has(option[value=other])', 'other'); await until(() => directoryId().then(id => id === '0'))
  await sleep(600); assert.equal(await js('!!document.querySelector("dialog[open]")'), false)
  await click('返回监控目录'); assert.equal((await snapshot()).watches[0].sourceAccountId, 'source')
  assert.equal(creates().length, 4); assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, recognitionNoCreation: true, explicitCreationCalls: creates().length, duplicateClickPrevented: true, sameLeafPreserved: true,
    titleAndCategoryChangePreserved: true, dialogCancellationPreservedRecord: true, failedCreateRetriedInPlace: true, alternateParentUsed: true, seasonSwitchRequiresClick: true,
    seasonSwitchBackRestored: true, originalWorkDirectoryReused: true, seasonNewParentMetadataReset: true, staleAccountBrowseIgnored: true, accountSwitchReset: true, narrowDark: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error, errors); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
