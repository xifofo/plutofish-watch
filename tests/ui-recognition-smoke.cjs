/* 真实 Electron/IPC 和回环识别服务验证添加目录，独立状态且不发出任何真实网盘请求。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, win
let slow = false, mode = 'normal', recognitionCalls = 0
const endpoints = [], errors = [], recognizedNames = []
async function until(fn, label = 'UI 状态', timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw Error(`${label}验收超时`)
}

function recognized() {
  const work = { tmdbId: '123', mediaType: 'tv', title: '星海纪行', originalTitle: 'Stars', englishTitle: 'Stars', year: 2024, posterUrl: '',
    category: { name: '动画番剧', value: 'anime', label: '动画番剧', status: 'matched' } }
  return { status: 'compatible', canAutoFill: true, reasons: [], truncated: false, selectionBasis: '',
    parsed: { title: 'Stars', mediaType: 'tv', seasonNumber: 2, episodeNumber: 3, resolution: '1080p', source: 'WEB-DL', warnings: [] },
    work, workTarget: { tmdbId: '123', mediaType: 'tv', category: 'anime' }, candidates: [{ work, conflicts: [] }] }
}

;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-recognition-ui-')))
  fs.mkdirSync(path.join(temp, 'app')); const media = path.join(temp, 'Stars'), empty = path.join(temp, 'Stars.2024.S02')
  fs.mkdirSync(media); fs.mkdirSync(empty); fs.writeFileSync(path.join(media, 'Stars.S02E03.mkv'), 'offline-sample')
  app.setPath('userData', path.join(temp, 'app')); process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
      endpoints.push(endpoint)
      let result
      if (endpoint === 'me') result = { id: 'publisher', name: '识别离线验收', kind: 'publisher', sourceAccount: { id: 'source', alias: 'offline', name: '离线源', provider: '115' }, categories: [{ value: 'manual', label: '手动分类' }, { value: 'anime', label: '动画番剧' }, { value: 'animation-movie', label: '动画电影' }], capabilities: { uploadClientGrouping: true } }
      else if (endpoint === 'tmdb/recognize') {
        recognitionCalls++; assert.equal(body.sourceAccount, 'offline'); assert.equal(body.fileName.startsWith('/'), false)
        recognizedNames.push(body.fileName)
        const thisMode = process.argv.includes('--interactive') ? (body.fileName.includes('Old') ? 'old' : body.fileName.includes('Ambiguous') ? 'ambiguous' : 'normal') : mode
        if (slow || body.fileName.includes('Slow')) await sleep(slow ? 1000 : 5000)
        if (thisMode === 'old') { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'NOT_FOUND' } })); return }
        result = recognized()
        if (['ambiguous', 'incomplete', 'missing-season', 'special'].includes(thisMode)) {
          const work = result.work
          result.status = 'ambiguous'; result.canAutoFill = false; result.work = null; result.workTarget = null; result.reasons = ['identity_ambiguous']
          result.truncated = true
          result.candidates.push({ work: { ...work, tmdbId: '456', mediaType: 'movie', title: '星海纪行：归途', originalTitle: 'Stars: Homecoming', year: 2025,
            category: { name: '动画电影', value: 'animation-movie', label: '动画电影', status: 'matched' } }, conflicts: [{ field: 'year', expected: '2024', actual: '2025' }] },
          { work: { ...work, tmdbId: '789', title: '星海纪行：新篇', category: { ...work.category, status: 'disabled' } }, conflicts: [] })
          if (thisMode === 'incomplete') result.parsed.seasonEnd = 3
          if (thisMode === 'missing-season') delete result.parsed.seasonNumber
          if (thisMode === 'special') result.parsed.seasonNumber = 0
        }
      } else if (endpoint === 'releases/query') result = { items: [], total: 0, page: 1, pageSize: 100, match: 'none' }
      else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
      else { throw Error(`不允许的测试请求：${endpoint}`) }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (e) { errors.push(String(e)); res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../out/main/index.js')
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length)
  win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  if (process.argv.includes('--interactive')) {
    nativeTheme.themeSource = process.argv.includes('--dark') ? 'dark' : 'light'
    win.setSize(900, 780); win.show()
    console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-only', media, empty }))
    return
  }
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`${code}\n${error.message}`) }
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await until(async () => (await js('window.plutoWatch.snapshot()')).ffprobeAvailable, '视频检测就绪')
  await js(`window.plutoWatch.connect(${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-only' })})`)
  await js('window.plutoWatch.pauseAll()')
  await until(() => js("document.querySelector('.sidebar-bottom strong')?.textContent === '识别离线验收'"), '连接状态显示')
  const button = async label => {
    const selector = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`
    await until(() => js(`(() => { const b = ${selector}; return !!b && !b.disabled && !b.closest('fieldset:disabled') })()`), label)
    await js(`${selector}.click()`)
  }
  const input = (selector, value) => js(`{ const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); }`)
  const text = () => js('document.body.innerText')
  const add = async () => { await button('添加目录'); await until(() => js("!!document.querySelector('#recognition-file')")) }
  await until(async () => (await text()).includes('添加目录'))
  await add()
  await input('input[placeholder="选择包含视频文件的目录"]', media)
  await until(async () => (await text()).includes('已填入作品与分类'), '自动识别')
  assert.equal(await js("document.querySelector('.selected-work strong').textContent"), '星海纪行')
  assert.equal(await js("[...document.querySelectorAll('label')].find(e => e.textContent.startsWith('季号')).querySelector('input').value"), '2')
  assert.equal(await js("[...document.querySelectorAll('label')].find(e => e.textContent.startsWith('资源分类')).querySelector('select').value"), 'anime')
  assert.equal(recognitionCalls, 1)
  assert.deepEqual(recognizedNames, ['Stars/Stars.S02E03.mkv'])
  await button('使用目录名识别')
  await until(async () => (await text()).includes('已填入作品与分类'), '手动使用目录名')
  assert.equal(recognizedNames.at(-1), 'Stars')
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(150)
    fs.writeFileSync(path.resolve('.smoke', `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('recognition-light')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720); await screenshot('recognition-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)

  // 保存并出现新文件后，监控不再请求作品识别；编辑页也不挂载首次识别入口。
  await js("[...document.querySelectorAll('input[type=checkbox]')][0].click()")
  await button('创建并开始监控')
  await until(async () => (await js('window.plutoWatch.snapshot()')).watches.length === 1, '保存目录')
  fs.writeFileSync(path.join(media, 'Other.S05E01.mkv'), 'offline-other')
  await js('window.plutoWatch.scan()'); await sleep(500)
  assert.equal(recognitionCalls, 2)
  assert.equal((await js('window.plutoWatch.snapshot()')).watches[0].work.tmdbId, '123')

  await add(); await input('input[placeholder="选择包含视频文件的目录"]', empty)
  await until(async () => (await text()).includes('已填入作品与分类'), '空目录自动识别')
  assert.equal(recognitionCalls, 3)
  assert.equal(recognizedNames.at(-1), 'Stars.2024.S02')
  assert.equal(await js("document.querySelector('#recognition-file').value"), 'Stars.2024.S02')
  await input('#recognition-file', 'Stars.S02E03.mkv'); await button('识别并填入')
  await until(async () => (await text()).includes('已填入作品与分类'), '空目录输入识别')

  // 新目录的慢响应在返回页面后丢弃，手动填写路径仍然可用。
  await button('返回监控目录'); await add(); slow = true
  await input('input[placeholder="选择包含视频文件的目录"]', media)
  await until(() => recognitionCalls === 5)
  await button('直接填写 TMDB ID')
  await input('input[placeholder="作品名称"]', '手动保留名称')
  await input('input[placeholder="填写 TMDB ID"]', '456')
  await until(async () => (await text()).includes('当前已有填写内容'), '保护手动草稿')
  assert.equal(await js('document.querySelector("input[placeholder=作品名称]").value'), '手动保留名称')
  await button('替换当前作品信息')
  await until(async () => (await text()).includes('已填入作品与分类'))
  assert.equal(await js("document.querySelector('.selected-work strong').textContent"), '星海纪行')

  await button('返回监控目录'); await add(); await input('input[placeholder="选择包含视频文件的目录"]', media)
  await until(() => recognitionCalls === 6)
  mode = 'ambiguous'
  await input('input[placeholder="选择包含视频文件的目录"]', empty)
  await until(async () => (await text()).includes('识别结果需要确认')); await sleep(1100)
  assert.equal(await js("!!document.querySelector('.selected-work')"), false)
  slow = false; mode = 'ambiguous'
  await input('#recognition-file', 'Stars.S02E03.mkv'); await button('识别并填入')
  await until(async () => (await text()).includes('识别结果需要确认'))
  assert.equal(await js("!!document.querySelector('.selected-work')"), false)

  // 点选只预览，确认才覆盖手动草稿；电影、剧集、分类和季号一起采用当前候选。
  const chooseCandidate = index => js(`document.querySelectorAll('.recognition-candidate')[${index}].click()`)
  const categorySelector = "[...document.querySelectorAll('label')].find(e => e.textContent.startsWith('资源分类')).querySelector('select')"
  const mediaTypeSelector = "[...document.querySelectorAll('label')].find(e => e.textContent.startsWith('作品类型')).querySelector('select')"
  const seasonSelector = 'input[type=number][min="0"]'
  await button('直接填写 TMDB ID')
  await input('input[placeholder="作品名称"]', '确认前保留')
  await input('input[placeholder="填写 TMDB ID"]', '999')
  const callsBeforeSelection = recognitionCalls
  await chooseCandidate(0); await chooseCandidate(1)
  assert.equal(await js('document.querySelector("input[placeholder=作品名称]").value'), '确认前保留')
  assert.equal(await js(`document.querySelector(${JSON.stringify('input[placeholder="填写 TMDB ID"]')}).value`), '999')
  assert.ok((await text()).includes('年份不一致：文件名为「2024」，候选为「2025」'))
  assert.equal(await js("document.querySelectorAll('.recognition-candidate[aria-pressed=true]').length"), 1)
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840)
  await js("document.querySelector('.recognition-candidates').scrollIntoView({ block: 'center' })")
  await screenshot('recognition-candidates-light')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720)
  await js("document.querySelector('.candidate-confirmation').scrollIntoView({ block: 'center' })")
  await screenshot('recognition-candidates-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await button('确认并填入')
  await until(() => js("document.querySelector('.selected-work strong')?.textContent === '星海纪行：归途'"), '确认电影候选')
  assert.ok((await js("document.querySelector('.selected-work').textContent")).includes('TMDB 456'))
  assert.equal(await js(`${mediaTypeSelector}.value`), 'movie')
  assert.equal(await js(`${categorySelector}.value`), 'animation-movie')
  assert.equal(await js(`!!document.querySelector(${JSON.stringify(seasonSelector)})`), false)
  assert.equal(await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '已确认并填入').disabled"), true)
  await chooseCandidate(0); await button('确认并填入')
  await until(() => js("document.querySelector('.selected-work strong')?.textContent === '星海纪行'"), '切换剧集候选')
  assert.equal(await js(`${mediaTypeSelector}.value`), 'tv')
  assert.equal(await js(`${categorySelector}.value`), 'anime')
  assert.equal(await js(`document.querySelector(${JSON.stringify(seasonSelector)}).value`), '2')
  assert.equal(recognitionCalls, callsBeforeSelection)

  // 无效分类、缺失或跨季信息不会沿用旧作品的分类和季号，也不能直接保存。
  for (const incompleteMode of ['incomplete', 'missing-season']) {
    mode = incompleteMode; await button('识别并填入')
    await until(async () => (await text()).includes('识别结果需要确认'))
    assert.equal(await js("!!document.querySelector('.candidate-confirmation')"), false)
    await chooseCandidate(2); await button('确认并填入')
    await until(() => js("document.querySelector('.selected-work strong')?.textContent === '星海纪行：新篇'"))
    assert.equal(await js(`${categorySelector}.value`), '')
    assert.equal(await js(`document.querySelector(${JSON.stringify(seasonSelector)}).value`), '')
    assert.ok((await text()).includes('请在下方补充资源分类和季号'))
    assert.equal(await js('document.querySelector("form").checkValidity()'), false)
    await button('创建并开始监控')
    assert.equal((await js('window.plutoWatch.snapshot()')).watches.length, 1)
  }
  mode = 'special'; await button('识别并填入')
  await until(async () => (await text()).includes('识别结果需要确认'))
  await chooseCandidate(0); await button('确认并填入')
  await until(() => js(`document.querySelector(${JSON.stringify(seasonSelector)}).value === '0'`), '特别篇季号')

  // 改文件名或目录立即清除待确认候选，不能确认上一轮结果。
  await chooseCandidate(1); await input('#recognition-file', 'Other.S03.mkv')
  assert.equal(await js("!!document.querySelector('.candidate-confirmation')"), false)
  await button('识别并填入'); await until(async () => (await text()).includes('识别结果需要确认'))
  await chooseCandidate(1); await input('input[placeholder="选择包含视频文件的目录"]', '')
  assert.equal(await js("!!document.querySelector('.candidate-confirmation')"), false)
  await input('#recognition-file', 'Stars.S02E03.mkv')
  mode = 'old'; await button('识别并填入')
  await until(async () => (await text()).includes('尚不支持文件名识别'))
  await button('重新选择')
  await button('直接填写 TMDB ID')
  assert.ok(await js('!!document.querySelector("input[placeholder=作品名称]")'))

  // 实际保存使用人工确认的候选身份，不回退到自动识别的第一项。
  mode = 'ambiguous'; await input('input[placeholder="选择包含视频文件的目录"]', empty)
  await until(async () => (await text()).includes('识别结果需要确认'))
  await chooseCandidate(1); await button('确认并填入'); await button('创建并开始监控')
  await until(async () => (await js('window.plutoWatch.snapshot()')).watches.length === 2, '保存已确认候选')
  const saved = (await js('window.plutoWatch.snapshot()')).watches.find(w => w.path === empty)
  assert.deepEqual(saved.work, { mediaType: 'movie', tmdbId: '456', category: 'animation-movie' })
  assert.equal(saved.title, '星海纪行：归途'); assert.equal(saved.seasonNumber, undefined)
  assert.deepEqual(errors, [])
  assert.ok(endpoints.every(e => ['me', 'tmdb/recognize', 'releases/query', 'range-proofs/pending'].includes(e)))
  console.log(JSON.stringify({ ok: true, autoFill: true, emptyDirectory: true, manualFallback: true, candidateConfirmation: true, incompleteCandidate: true, staleProtection: true, savedBindingFixed: true, narrowDark: true, recognitionCalls, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => { console.log(JSON.stringify({ recognitionCalls, recognizedNames, endpoints, errors })); server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
