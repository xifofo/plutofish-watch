/* 实际 Electron 窗口 + 本机假服务验收，截图写入已忽略的 .smoke；不使用真实凭据或网盘。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const syncFS = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')

let temp, server, failed = false
const calls = []
const newVersions = new Map()
const releaseBindings = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(100) }
  throw new Error('UI 验收等待超时')
}

;(async () => {
  temp = syncFS.realpathSync(syncFS.mkdtempSync(path.join(os.tmpdir(), 'plutofish-watch-ui-')))
  syncFS.mkdirSync(path.join(temp, 'app', 'Shared Dictionary', 'cache'), { recursive: true })
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {}
    const endpoint = req.url.replace('/api/v1/publisher/', '')
    calls.push({ endpoint, body })
    let result
    if (endpoint === 'me') result = { id: 'ui-publisher', name: '离线验收发布端', kind: 'publisher',
      sourceAccount: { id: 'ui-source', name: '离线模拟网盘', alias: 'offline', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    else if (endpoint === 'tmdb/search') {
      if (body.query === '故障') { res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'TMDB_UPSTREAM_ERROR', message: 'private-upstream-body' } })); return }
      if (body.query === '旧查询') await sleep(500)
      result = { items: body.query === '空结果' ? [] : [
        { tmdbId: body.page === 2 ? '124' : '123', title: body.query === '旧查询' ? '过期结果不应出现' : '漫长的季节', originalTitle: 'The Long Season', year: 2023 },
        { tmdbId: '125', title: '同名作品 · 很长的名称也能完整显示并在窄窗口自动换行', originalTitle: 'A very long original title for narrow window validation', year: 1999 },
      ], page: body.page, total: body.query === '空结果' ? 0 : 21, totalPages: body.query === '空结果' ? 0 : 2 }
    }
    else if (endpoint === 'releases/query') {
      const items = body.workTarget.tmdbId === '456'
        ? [
          { id: 'd'.repeat(32), name: 'S01.1080p.WEB.WEB-DL.SDR.AVC', resolution: '1080p', dynamicRange: 'SDR', status: 'published' },
          ...newVersions.values(),
        ] : [{ id: 'a'.repeat(32), name: 'S01.1080p.WEB.WEB-DL.H264', resolution: '1080p', dynamicRange: 'SDR', status: 'published', latestEpisode: 1 }]
      result = { items, total: items.length, page: 1, pageSize: 100, boundReleaseId: releaseBindings.get(body.releaseKey) }
    }
    else if (endpoint === 'files/check') result = body.episodeNumber === 1
      ? { status: 'existing', fileId: 'b'.repeat(32) } : { status: 'missing' }
    else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
    else if (endpoint === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'mockupload', filePickCode: 'mockfile' } }
    else if (endpoint === 'files/report') {
      const target = body.releaseTarget
      if (!releaseBindings.has(target.releaseKey)) {
        if (target.existingReleaseId) releaseBindings.set(target.releaseKey, target.existingReleaseId)
        else {
          assert.equal(target.workTarget.tmdbId, '456')
          assert.equal(target.name, 'S01.720p.WEB.WEB-DL.SDR.AVC')
          newVersions.set(target.releaseKey, { id: 'c'.repeat(32), name: target.name, resolution: target.resolution, dynamicRange: target.dynamicRange, status: 'published' })
          releaseBindings.set(target.releaseKey, 'c'.repeat(32))
        }
      }
      result = { accepted: true }
    }
    else if (endpoint === 'files/ed2k' || endpoint === 'range-proofs/forget') result = { accepted: true }
    else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
    else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0]
  // 验收通过 webContents 驱动，避免截图置前时桌面鼠标误触测试窗口。
  win.setIgnoreMouseEvents(true)
  win.webContents.setBackgroundThrottling(false)
  const errors = []
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  await until(() => js("!!window.plutoWatch && document.querySelector('h1')?.textContent === '概览'").catch(() => false))
  const out = path.resolve('.smoke')
  await fs.mkdir(out, { recursive: true })
  const screenshot = async name => {
    win.show(); win.focus()
    win.webContents.invalidate()
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    await sleep(150)
    await fs.writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  const click = text => js(`(() => {const b=[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if(!b) throw Error('找不到按钮: ' + ${JSON.stringify(text)}); b.click()})()`)
  const fill = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('找不到输入框'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await screenshot('01-empty')
  await click('连接与设置')
  await fill('input[type=url]', `http://127.0.0.1:${server.address().port}`)
  await fill('input[type=password]', 'offline-ui-only-key')
  await click('保存并连接')
  await until(() => js("document.body.innerText.includes('已验证发布端')"))
  assert.equal(await js("JSON.stringify(await window.plutoWatch.snapshot()).includes('offline-ui-only-key')"), false)
  await screenshot('02-connection')
  await click('监控目录')
  await click('添加目录')
  await fill('select[aria-label="版本归类"]', 'fixed')
  const media = path.join(temp, 'media')
  await fs.mkdir(media)
  const historical = path.join(media, 'History.S01E01.mp4')
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', historical]).status, 0)
  await fill('input[placeholder="选择包含视频文件的目录"]', media)
  await fill('input[type=number]', '10')
  await fill('#work-query', '旧查询')
  await click('搜索')
  await until(() => calls.some(c => c.endpoint === 'tmdb/search' && c.body.query === '旧查询'))
  await fill('#work-query', '空结果')
  await sleep(600)
  assert.equal(await js("document.body.innerText.includes('过期结果不应出现')"), false)
  await click('搜索')
  await until(() => js("document.body.innerText.includes('没有找到作品')"))
  await fill('#work-query', '故障')
  await click('搜索')
  await until(() => js("document.body.innerText.includes('作品搜索失败')"))
  assert.equal(await js("document.body.innerText.includes('private-upstream-body')"), false)
  await fill('#work-query', '漫长的季节')
  await js("(() => { document.querySelector('#work-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()")
  await until(() => js("document.querySelectorAll('.work-option').length === 2"))
  await js("document.querySelector('.work-picker').scrollIntoView({ block: 'center' })")
  await screenshot('12-work-search')
  win.setSize(840, 720)
  nativeTheme.themeSource = 'dark'
  await screenshot('13-work-search-narrow-dark')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'light'
  win.setSize(1200, 840)
  await click('下一页')
  await until(() => js("document.querySelector('.work-pages')?.innerText.includes('2 / 2')"))
  await click('上一页')
  await until(() => js("document.querySelector('.work-pages')?.innerText.includes('1 / 2')"))
  await js("document.querySelector('.work-option').click()")
  await until(() => js("document.querySelector('option[value=\"' + 'a'.repeat(32) + '\"]') !== null"))
  assert.equal(calls.filter(c => c.endpoint === 'releases/query').at(-1).body.workTarget.tmdbId, '123')
  assert.equal(await js("document.querySelector('.selected-work').innerText.includes('TMDB 123')"), true)
  await click('重新选择')
  assert.equal(await js("document.querySelector('.version-row select').value"), '')
  assert.equal(await js("document.querySelector('.version-row button').disabled"), true)
  await click('直接填写 TMDB ID')
  await fill('input[placeholder="作品名称"]', '手动作品')
  await fill('input[placeholder="填写 TMDB ID"]', '888')
  await click('返回片名搜索')
  await click('搜索')
  await until(() => js("document.querySelector('.work-option') !== null"))
  await js("document.querySelector('.work-option').click()")
  await until(() => js("document.querySelector('.version-row select').value === 'a'.repeat(32)"))
  await fill('select:has(option[value="movie"])', 'movie')
  assert.equal(await js("document.querySelector('.selected-work') === null && document.querySelector('.version-row select').value === ''"), true)
  await fill('select:has(option[value="movie"])', 'tv')
  await click('搜索')
  await until(() => js("document.querySelector('.work-option') !== null"))
  await js("document.querySelector('.work-option').click()")
  await until(() => js("document.querySelector('.version-row select').value === 'a'.repeat(32)"))
  await screenshot('03-binding')
  await js("(() => { const checkbox = document.querySelector('input[type=checkbox]'); if (!checkbox?.checked) throw Error('历史补传默认值错误'); checkbox.click(); })()")
  await click('创建并开始监控')
  await until(() => js("document.body.innerText.includes('监控中') && !document.body.innerText.includes('创建并开始监控')"))
  assert.equal(await js("(await window.plutoWatch.snapshot()).jobs.length"), 0)

  // 实际创建并移入已含文件的深层子目录，交由原生监控与稳定等待触发任务。
  const incoming = path.join(temp, 'incoming')
  await fs.mkdir(path.join(incoming, 'Season 1'), { recursive: true })
  const video = path.join(incoming, 'Season 1', 'Show.S01E02.mp4')
  const generated = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', video])
  assert.equal(generated.status, 0)
  await fs.copyFile(video, path.join(incoming, 'Season 1', '待确认的视频.mp4'))
  await fs.rename(incoming, path.join(media, '新加入的目录'))
  await click('传输任务')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.status === 'completed')"), 30000)
  await until(() => js("document.body.innerText.includes('待确认集号')"))
  await screenshot('04-review')
  await fill('.review-row input', '3')
  await click('确认入队')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.filter(j => j.status === 'completed').length === 2"))
  await screenshot('05-completed')
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 2)
  await click('监控目录')
  await click('补传历史')
  await until(() => js("document.body.innerText.includes('已加入 1 个历史文件')"))
  await click('补传历史')
  await until(() => js("document.body.innerText.includes('没有待补传的历史文件')"))
  await screenshot('09-backfill')
  await click('传输任务')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.filter(j => j.status === 'completed' && j.ed2kSaved).length === 3"), 30000)
  assert.equal(await js("(await window.plutoWatch.snapshot()).jobs.find(j => j.episodeNumber === 1).reused"), true)
  assert.equal(await js("document.body.innerText.includes('已复用') && document.body.innerText.includes('ED2K 已同步')"), true)
  await js("(() => { document.querySelector('.ed2k-details').open = true })()")
  await screenshot('10-ed2k')
  await fs.copyFile(video.replace(incoming, path.join(media, '新加入的目录')), path.join(media, 'Renamed.S01E02.mp4'))
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.status === 'duplicate')"), 30000)
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 3)
  assert.equal(calls.filter(c => c.endpoint === 'files/ed2k').length, 3)
  assert.equal(calls.filter(c => c.endpoint === 'files/report').every(c => c.body.deduplicate === true), true)
  await screenshot('11-duplicate')
  await click('暂停上传')
  await until(() => js("(await window.plutoWatch.snapshot()).uploadsPaused"))
  await click('继续上传')
  await until(() => js("!(await window.plutoWatch.snapshot()).uploadsPaused"))

  // 同一目录自动分开画质；规格矛盾的成品停在版本确认，不会直接上传。
  await click('监控目录')
  await click('添加目录')
  assert.equal(await js("document.querySelector('select[aria-label=\"版本归类\"]').value"), 'auto')
  const automatic = path.join(temp, 'automatic')
  await fs.mkdir(automatic)
  for (const [name, size] of [['Low.S01E01.mp4', '1280x720'], ['High.S01E01.mp4', '1920x1080'], ['Wrong.S01E02.2160p.WEB.WEB-DL.HEVC.mp4', '1280x720']]) {
    assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=0.08`, '-c:v', 'libx264', '-preset', 'ultrafast', '-y', path.join(automatic, name)]).status, 0)
  }
  await fill('input[placeholder="选择包含视频文件的目录"]', automatic)
  await fill('input[type=number]', '10')
  await click('直接填写 TMDB ID')
  await fill('input[placeholder="作品名称"]', '多画质自动归类')
  await fill('input[placeholder="填写 TMDB ID"]', '456')
  await js("[...document.querySelectorAll('summary')].find(e => e.textContent === '目录来源预设').click()")
  await fill('input[aria-label="来源平台"]', 'WEB')
  await fill('select[aria-label="来源类型"]', 'WEB-DL')
  await screenshot('14-auto-mode')
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await js("document.querySelector('.source-fields').scrollIntoView({block:'center'})")
  await screenshot('19-source-preset-narrow-dark')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  await click('创建并开始监控')
  await until(() => js("(await window.plutoWatch.snapshot()).watches.length === 2 && document.querySelector('h1')?.textContent === '监控目录'"))
  await click('传输任务')
  await until(() => js("document.querySelector('h1')?.textContent === '传输任务'"))
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.versionReview)"), 30000)
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.filter(j => j.release?.name?.includes('WEB-DL.SDR.AVC') && j.status === 'completed').length === 2"))
  const autoReports = calls.filter(c => c.endpoint === 'files/report' && c.body.releaseTarget.workTarget.tmdbId === '456')
  assert.equal(autoReports.filter(c => c.body.releaseTarget.existingReleaseId === 'd'.repeat(32)).length, 1)
  assert.equal(autoReports.filter(c => !c.body.releaseTarget.existingReleaseId).length, 1)
  assert.equal(newVersions.size, 1)
  // 待确认任务可能在前一文件登记前查询，刷新后应可选择刚创建的版本。
  await until(() => js("document.querySelector('.version-review') !== null"))
  const queryCount = calls.filter(c => c.endpoint === 'releases/query').length
  await click('刷新版本')
  await until(() => calls.filter(c => c.endpoint === 'releases/query').length > queryCount)
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.status === 'review' && j.versionReview?.choices.some(r => r.id === 'c'.repeat(32)))"))
  // 快照 IPC 可能先于节流后的界面广播返回，等待真正渲染出的控件再验收。
  await until(() => js("document.querySelector('.version-review select')?.selectedOptions[0]?.textContent === '选择已有版本'"))
  await screenshot('15-version-review')
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await screenshot('16-version-review-narrow-dark')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  const rejected = await js("(async () => { const job = (await window.plutoWatch.snapshot()).jobs.find(j => j.versionReview); try { await window.plutoWatch.job({id:job.id, action:'selectVersion', releaseId:'f'.repeat(32)}); return '' } catch(e) { return e.message } })()")
  assert.match(rejected, /版本已变化/)
  await fill('.version-review select', 'c'.repeat(32))
  await click('确认版本')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.filter(j => j.status === 'completed' && j.ed2kSaved).length === 6"), 30000)
  assert.equal(await js("(await window.plutoWatch.snapshot()).jobs.some(j => j.versionReview)"), false)
  await screenshot('17-auto-completed')
  // 新建版本后移入下一集，必须沿用目录 ID 和发布键；不能每集新建。
  await fs.copyFile(path.join(automatic, 'Low.S01E01.mp4'), path.join(automatic, 'Next.S01E03.mp4'))
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.filter(j => j.status === 'completed' && j.ed2kSaved).length === 7"), 30000)
  const nextReport = calls.find(c => c.endpoint === 'files/report' && c.body.releaseTarget.workTarget.tmdbId === '456' && c.body.episodeNumber === 3)
  assert.equal(nextReport.body.releaseTarget.existingReleaseId, 'c'.repeat(32))
  assert.equal(nextReport.body.releaseTarget.releaseKey, autoReports.find(c => !c.body.releaseTarget.existingReleaseId).body.releaseTarget.releaseKey)
  assert.equal(newVersions.size, 1)
  await screenshot('18-created-version-next-episode')
  console.log('UI：基础发布、版本复用和人工版本确认通过')
  // 无来源历史文件停住；逐文件确认与目录预设通过真实 IPC 继续。
  const unknown = path.join(temp, 'unknown-source')
  await fs.mkdir(unknown)
  await fs.copyFile(path.join(automatic, 'Low.S01E01.mp4'), path.join(unknown, 'Unknown.S01E04.mp4'))
  await js(`window.plutoWatch.add({ path: ${JSON.stringify(unknown)}, title: '来源待确认', sourceAccountId: 'ui-source', work: {mediaType:'tv',tmdbId:'456',category:'tv'}, seasonNumber:1, versionMode:'auto', releaseId:'', directoryId:'0', directoryPath:'/', includeExisting:true, stableSeconds:10 })`)
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.episodeNumber === 4 && j.versionReview?.sourceRequired)"), 30000)
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 7)
  await until(() => js("document.querySelector('.source-review') !== null"))
  await fill('.source-review select[aria-label="来源类型"]', 'WEB-DL')
  await click('确认来源并重试')
  await until(() => js("!!document.querySelector('[role=alert]')"))
  assert.match(await js("document.querySelector('[role=alert]').textContent"), /来源平台不明/)
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 7)
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await js("document.querySelector('.source-review').scrollIntoView({block:'center'})")
  await screenshot('20-source-review-narrow-dark')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  await fill('.source-review input[aria-label="来源平台"]', 'WEB')
  await click('确认来源并重试')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.episodeNumber === 4 && j.status === 'completed' && j.ed2kSaved)"), 30000)
  const confirmed = await js("(await window.plutoWatch.snapshot()).jobs.find(j => j.episodeNumber === 4)")
  assert.equal(confirmed.release.id, 'c'.repeat(32))
  await fs.copyFile(path.join(automatic, 'Low.S01E01.mp4'), path.join(unknown, 'Preset.S01E05.mp4'))
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.episodeNumber === 5 && j.versionReview?.sourceRequired)"), 30000)
  await click('监控目录')
  await until(() => js("document.querySelectorAll('.watch-row').length === 3"))
  await js("[...document.querySelectorAll('.watch-row')].find(row => row.textContent.includes('来源待确认')).querySelector('.watch-actions button').click()")
  await fill('input[aria-label="来源平台"]', 'WEB')
  await fill('select[aria-label="来源类型"]', 'WEB-DL')
  win.setSize(840, 720); nativeTheme.themeSource = 'dark'
  await js("document.querySelector('.source-fields').scrollIntoView({block:'center'})")
  await screenshot('21-edit-source-preset-narrow-dark')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'light'; win.setSize(1200, 840)
  await click('保存来源预设')
  await until(() => js("(await window.plutoWatch.snapshot()).jobs.some(j => j.episodeNumber === 5 && j.status === 'completed' && j.ed2kSaved)"), 30000)
  const completedSource = await js("(await window.plutoWatch.snapshot()).jobs.find(j => j.episodeNumber === 4)")
  assert.deepEqual(completedSource.release, confirmed.release)
  assert.deepEqual(completedSource.sourceOverride, { platform: 'WEB', type: 'WEB-DL' })
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 9)
  assert.equal(newVersions.size, 1)
  await click('概览')
  await screenshot('06-overview')
  win.setSize(840, 720)
  await screenshot('07-narrow')
  assert.equal(await js("document.documentElement.scrollWidth > window.innerWidth"), false)
  nativeTheme.themeSource = 'dark'
  await screenshot('08-dark')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, localMockRequests: calls.length, fileReports: 9, sourceReviewConfirmed: 1, directoryPresetResumed: 1, automaticVersions: 2, createdVersions: newVersions.size, nextEpisodeReusedVersion: true, manualVersionConfirmed: 1, backfilled: 1, duplicate: 1, ed2kSaved: 9, screenshots: out, rendererErrors: errors }))
  app.quit()
})().catch(error => { console.error(error); failed = true; app.quit() })
app.on('will-quit', () => {
  server?.closeAllConnections()
  server?.close()
  if (temp) require('node:fs').rmSync(temp, { recursive: true, force: true })
})
app.on('quit', () => { if (failed) process.exit(1) })
