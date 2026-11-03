/* 真实 Electron + 回环发布清单：新版本弹窗、暂不更新、重新打开、下载进度、取消、校验失败与安装交接，不访问 GitHub。 */
const { app, BrowserWindow, nativeTheme, shell } = require('electron')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, mode = 'slow', finished = false
const launched = []
async function until(fn, timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(50) }
  throw new Error('更新弹窗验收超时')
}

// 安装交接只记录参数，不运行任何程序；其他子进程（ffprobe 等）照常执行。
const spawn = childProcess.spawn
childProcess.spawn = (file, args, options) => {
  if (!Array.isArray(args) || !args.includes('--updated')) return spawn(file, args, options)
  launched.push({ file, args, options, size: fs.statSync(file).size })
  const child = new EventEmitter(); child.unref = () => {}
  setImmediate(() => child.emit('spawn'))
  return child
}
shell.openPath = async file => { launched.push({ file, args: [], size: fs.statSync(file).size }); return '' }

const installer = crypto.randomBytes(4 * 1024 * 1024)
;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-update-ui-')))
  app.setPath('userData', path.join(temp, 'app')); app.setPath('temp', path.join(temp, 'tmp'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/latest.json') {
      const file = (platform, arch, name) => ({ platform, arch, name, url: `${base}/${name}`, size: installer.length, sha256: crypto.createHash('sha256').update(installer).digest('hex') })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        version: '9.9.9', publishedAt: '2026-11-02T08:00:00Z', page: 'https://github.com/xifofo/plutofish-watch/releases/tag/v9.9.9',
        notes: fs.readFileSync(path.join(__dirname, '../docs/release-v0.1.19.md'), 'utf8'),
        files: [file('win32', 'x64', 'PlutoFish-Watch-9.9.9-windows-x64-setup.exe'), file('darwin', 'arm64', 'PlutoFish-Watch-9.9.9-macos-arm64.dmg'), file('darwin', 'x64', 'PlutoFish-Watch-9.9.9-macos-x64.dmg')],
      }))
      return
    }
    res.writeHead(200, { 'Content-Length': installer.length })
    if (mode === 'corrupt') return void res.end(Buffer.alloc(installer.length))
    const chunk = mode === 'slow' ? 64 * 1024 : installer.length
    for (let offset = 0; offset < installer.length && !res.destroyed; offset += chunk) {
      res.write(installer.subarray(offset, offset + chunk))
      if (mode === 'slow') await sleep(40)
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.PLUTOFISH_WATCH_UPDATE_URL = `http://127.0.0.1:${server.address().port}/latest.json`
  require('../out/main/index.js')
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length)
  const win = BrowserWindow.getAllWindows()[0], errors = []
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(`(async () => { return ${code}; })()`, true)
  const text = () => js('document.body.innerText')
  const dialogOpen = () => js("!!document.querySelector('dialog.update-dialog[open]')")
  // offsetHeight 不受打开动画缩放影响。
  const dialogHeight = () => js("document.querySelector('dialog.update-dialog').offsetHeight")
  const click = label => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw Error('按钮不可用：' + ${JSON.stringify(label)}); b.click() })()`)
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true })
    win.show(); win.webContents.invalidate(); await sleep(250)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  await until(() => js('!!window.plutoWatch').catch(() => false))

  // 启动后自动检查，发现新版本直接弹出，说明按列表渲染。
  await until(dialogOpen)
  assert.match(await text(), /发现新版本/)
  assert.match(await text(), /PlutoFish Watch v9\.9\.9 已发布，当前 v0\.1\.\d+/)
  assert.ok(await js("document.querySelectorAll('.update-notes li').length >= 3"))
  assert.equal(await js("document.activeElement?.matches('dialog.update-dialog')"), true)
  await screenshot('01-update-prompt')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 640)
  await screenshot('02-update-prompt-narrow-dark')
  assert.equal(await js("(() => { const r = document.querySelector('dialog.update-dialog').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()"), true)
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840)

  // 暂不更新：关闭弹窗，侧栏保留入口；设置页可以重新打开。
  await click('暂不更新')
  await until(async () => !(await dialogOpen()))
  assert.match(await text(), /新版本 v9\.9\.9/)
  await screenshot('03-update-dismissed')
  await click('连接与设置')
  await until(async () => /可更新到 v9\.9\.9/.test(await text()))
  await js("[...document.querySelectorAll('h2')].find(h => h.textContent === '版本更新').scrollIntoView({ block: 'center' })")
  await screenshot('04-update-settings')
  await click('查看更新')
  await until(dialogOpen)
  // Esc 等同暂不更新，侧栏入口可以再次打开。
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(async () => !(await dialogOpen()))
  await click('新版本 v9.9.9')
  await until(dialogOpen)
  const height = await dialogHeight()

  // 下载显示进度，可以取消并回到提示。
  await click('立即更新')
  await until(() => js("(() => { const s = document.querySelector('.progress-line strong')?.textContent; return !!s && parseInt(s) > 5 && parseInt(s) < 90 })()"))
  assert.match(await text(), /正在下载 [\d.]+ MB \/ 4\.0 MB/)
  assert.equal(await dialogHeight(), height, '下载中弹窗高度不应跳动')
  await screenshot('05-update-downloading')
  await click('取消下载')
  await until(async () => /立即更新/.test(await text()))
  assert.ok(await dialogOpen())

  // 校验失败显示原因，可重新下载或在浏览器下载。
  mode = 'corrupt'
  await click('立即更新')
  await until(async () => /安装包校验失败/.test(await text()))
  assert.match(await text(), /在浏览器中下载/)
  assert.equal(await dialogHeight(), height, '失败时弹窗高度不应跳动')
  await screenshot('06-update-failed')
  nativeTheme.themeSource = 'dark'
  await screenshot('07-update-failed-dark')
  nativeTheme.themeSource = 'light'

  // 校验通过后：Windows 自动退出并在任务保存后启动安装程序；macOS 等用户确认后打开安装包。
  mode = 'fast'
  await click('重新下载')
  if (process.platform === 'darwin') {
    await until(async () => /退出并打开安装包/.test(await text()))
    await screenshot('08-update-ready')
    await click('退出并打开安装包')
  } else {
    await until(async () => /正在退出并启动安装程序/.test(await text()))
    assert.deepEqual(errors, [])
    finished = true
    // 0.8 秒后自动退出，截图赶不上时不影响验收。
    await screenshot('08-update-installing').catch(() => {})
  }
  assert.deepEqual(errors, [])
  finished = true
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => {
  server?.closeAllConnections(); server?.close()
  // Windows 上 Chromium 退出前仍占用临时配置目录，删除失败不影响验收结果。
  try { if (temp) fs.rmSync(temp, { recursive: true, force: true }) } catch {}
})
app.on('quit', () => {
  try {
    if (!failed) {
      assert.ok(finished, '安装交接前应用提前退出')
      if (process.platform === 'win32' || process.platform === 'darwin') {
        assert.equal(launched.length, 1)
        assert.equal(launched[0].size, installer.length)
        if (process.platform === 'win32') assert.deepEqual(launched[0].args, ['--updated', '--force-run'])
      }
      console.log(JSON.stringify({ ok: true, prompted: true, dismissed: true, reopened: true, cancelled: true, checksumRejected: true, launched: launched.map(l => path.basename(l.file)) }))
    }
  } catch (error) { failed = true; console.error(error) }
  if (failed) process.exit(1)
})
