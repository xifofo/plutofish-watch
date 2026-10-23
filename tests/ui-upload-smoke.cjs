/* 实际 Electron、IPC、两路共享上传与 ED2K 工作线程；所有 HTTP 均为回环假服务，OSS 只消费本地流。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, win
const puts = new Set(), calls = []
let maxPuts = 0
let grouped = true
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  throw Error('上传 UI 验收超时')
}

;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-upload-ui-')))
  fs.mkdirSync(path.join(temp, 'app'), { recursive: true })
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  // 替换 SDK 的 HTTP 传输，保留真实 SDK 签名、分片流和共享限速；绝不发送真实 OSS 请求。
  const urllib = require(require.resolve('urllib', { paths: [require.resolve('ali-oss')] }))
  urllib.request = async (url, options) => {
    const u = new URL(url), key = decodeURIComponent(u.pathname.slice(1))
    assert.equal(u.hostname, 'up-file.115.com')
    assert.equal(options.httpsAgent.options.keepAlive, true)
    let data, etag = ''
    if (u.searchParams.has('uploads')) {
      assert.equal(u.searchParams.has('sequential'), true)
      data = `<InitiateMultipartUploadResult><UploadId>${key}</UploadId></InitiateMultipartUploadResult>`
    } else if (options.method === 'GET') {
      data = `<ListPartsResult><Bucket>bucket</Bucket><Key>${key}</Key><UploadId>${key}</UploadId><IsTruncated>false</IsTruncated></ListPartsResult>`
    } else if (options.method === 'PUT') {
      puts.add(key); maxPuts = Math.max(maxPuts, puts.size)
      assert.equal(options.headers['x-oss-traffic-limit'], '4194304')
      const md5 = createHash('md5')
      try { for await (const chunk of options.stream) md5.update(chunk) }
      finally { puts.delete(key) }
      etag = md5.digest('hex').toUpperCase(); data = ''
    } else data = '{"state":true}'
    const headers = { etag }
    return { status: 200, headers, data: Buffer.from(data), res: { status: 200, headers } }
  }
  server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    const body = text ? JSON.parse(text) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
    calls.push({ endpoint, body })
    let result
    if (endpoint === 'me') result = { id: 'publisher', name: '上传离线验收', kind: 'publisher', sourceAccount: { id: 'source', alias: 'offline', name: '离线网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }], ...(grouped ? { capabilities: { uploadClientGrouping: true } } : {}) }
    else if (endpoint === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: 'S01.720p.WEB.WEB-DL.SDR.AVC', resolution: '720p', dynamicRange: 'SDR', status: 'published' }], total: 1, page: 1, pageSize: 100 }
    else if (endpoint === 'files/check') result = { status: 'missing' }
    else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
    else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
    else if (['files/report', 'files/ed2k', 'range-proofs/forget'].includes(endpoint)) result = { accepted: true }
    else if (endpoint === 'uploads/prepare') {
      assert.match(body.clientId, /^[a-f0-9-]{36}$/)
      result = { dispatch: { status: body.action === 'verify' ? 'ready' : 'uploading', fileId: '123', pickCode: body.taskKey, bucket: 'bucket', object: body.taskKey, endpoint: 'https://up-file.115.com', callback: '{}' } }
      if (body.action === 'credentials') result.credentials = { accessKeyId: 'TEST-ID', accessKeySecret: 'TEST-SECRET', securityToken: 'TEST-TOKEN', expiration: new Date(Date.now() + 3600000).toISOString(), endpoint: 'https://up-file.115.com', rate: 524288, rateScope: 'shared-account' }
    } else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const media = path.join(temp, 'media'); fs.mkdirSync(media)
  const original = path.join(media, 'Test.S01E01.mp4')
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=0.1', '-c:v', 'mpeg4', '-y', original]).status, 0)
  fs.appendFileSync(original, Buffer.alloc(3 * 1024 * 1024))
  fs.copyFileSync(original, path.join(media, 'Test.S01E02.mp4'))
  fs.copyFileSync(original, path.join(media, 'Test.S01E03.mp4'))
  require('../out/main/index.js')
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length)
  win = BrowserWindow.getAllWindows()[0]
  win.setIgnoreMouseEvents(true); win.webContents.setBackgroundThrottling(false)
  const errors = []
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  const snapshot = () => js('window.plutoWatch.snapshot()')
  await until(() => js('!!window.plutoWatch').catch(() => false))
  await js(`window.plutoWatch.connect(${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-ui-only' })})`)
  await js(`window.plutoWatch.add(${JSON.stringify({ path: media, title: '双文件上传验收', sourceAccountId: 'source', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1, versionMode: 'fixed', releaseId: 'a'.repeat(32), directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 10 })})`)
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '传输任务').click()")
  await until(async () => (await snapshot()).jobs.filter(j => j.transfer?.bytesPerSecond > 0).length === 2)
  const running = (await snapshot()).jobs.filter(j => j.transfer)
  assert.equal(maxPuts, 2)
  assert.equal((await snapshot()).jobs.filter(j => j.status === 'processing').length, 1)
  assert.ok(running.every(j => j.uploadedBytes === 0 && j.transfer.sentBytes > 0))
  assert.ok(await js("document.querySelectorAll('.transfer-stats').length === 2 && document.body.innerText.includes('/s') && document.body.innerText.includes('剩余约')"))
  assert.equal(fs.readFileSync(path.join(temp, 'app/watch-state.json'), 'utf8').includes('bytesPerSecond'), false)
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(250)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('32-two-uploads-light')
  nativeTheme.themeSource = 'dark'; win.setSize(840, 720); await screenshot('33-two-uploads-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  await js(`window.plutoWatch.job(${JSON.stringify({ id: running[0].id, action: 'pause' })})`)
  await until(async () => (await snapshot()).jobs.some(j => j.id === running[0].id && j.status === 'paused' && !j.transfer))
  assert.ok((await snapshot()).jobs.find(j => j.id === running[1].id).transfer)
  await until(async () => (await snapshot()).jobs.filter(j => j.transfer?.bytesPerSecond > 0).length === 2)
  await screenshot('34-pause-one-continue-next')
  await js('window.plutoWatch.pauseAll()')
  await until(() => puts.size === 0)
  assert.equal((await snapshot()).jobs.some(j => j.transfer), false)
  assert.ok((await snapshot()).jobs.some(j => j.ed2k?.state === 'done'))
  grouped = false
  await js(`window.plutoWatch.connect(${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, key: 'offline-ui-only' })})`)
  await until(() => js("document.body.innerText.includes('单文件兼容模式')"))
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('35-upload-compatibility-light')
  nativeTheme.themeSource = 'dark'; win.setSize(760, 720); await screenshot('36-upload-compatibility-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  assert.equal((await snapshot()).uploadsPaused, true)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, maximumUploads: maxPuts, preparedWhileUploading: true, liveSpeed: true, transientNotPersisted: true, isolatedPause: true, backgroundED2K: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
