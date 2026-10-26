/* 真实 Electron + IPC + OSS SDK；所有请求在本机模拟，文件始终留在原目录。 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let temp, server, failed = false, win, apiFailed = true, partFailed = true, inits = 0, merges = 0
const calls = [], putIds = [], listIds = []
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  throw Error('重试 UI 验收超时')
}

;(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutofish-retry-ui-')))
  fs.mkdirSync(path.join(temp, 'app'))
  app.setPath('userData', path.join(temp, 'app'))
  process.argv.push(`--watch-data=${path.join(temp, 'app')}`)
  const urllib = require(require.resolve('urllib', { paths: [require.resolve('ali-oss')] }))
  urllib.request = async (url, options) => {
    const u = new URL(url)
    assert.equal(u.hostname, 'up-file.115.com')
    let data = '', status = 200, etag = ''
    if (u.searchParams.has('uploads')) data = `<InitiateMultipartUploadResult><UploadId>UPLOAD-${++inits}</UploadId></InitiateMultipartUploadResult>`
    else if (options.method === 'GET') {
      listIds.push(u.searchParams.get('uploadId'))
      status = 404; data = '<Error><Code>NoSuchUpload</Code><Message>SECRET</Message><RequestId>0123456789ABCDEF</RequestId></Error>'
    } else if (options.method === 'PUT') {
      putIds.push(u.searchParams.get('uploadId'))
      const md5 = createHash('md5')
      for await (const chunk of options.stream) md5.update(chunk)
      etag = md5.digest('hex').toUpperCase()
      if (partFailed) { status = 502; data = '<Error><Code>ServiceUnavailable</Code><Message>SECRET</Message><RequestId>0123456789ABCDEF</RequestId></Error>' }
    } else { merges++; data = '{"state":true}' }
    const headers = { etag, 'x-oss-request-id': '0123456789ABCDEF' }
    return { status, headers, data: Buffer.from(data), res: { status, headers } }
  }
  server = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    const body = text ? JSON.parse(text) : {}, endpoint = req.url.replace('/api/v1/publisher/', '')
    calls.push({ endpoint, body })
    let result
    if (endpoint === 'me') result = { id: 'publisher', name: '重试离线验收', kind: 'publisher', sourceAccount: { id: 'source', alias: 'offline', name: '离线网盘', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    else if (endpoint === 'releases/query') result = { items: [{ id: 'a'.repeat(32), name: 'S01.720p.WEB.WEB-DL.SDR.AVC', resolution: '720p', dynamicRange: 'SDR', status: 'published' }], total: 1, page: 1, pageSize: 100 }
    else if (endpoint === 'files/check') result = { status: 'missing' }
    else if (endpoint === 'tasks/report') result = { outcome: 'applied' }
    else if (endpoint === 'range-proofs/pending') result = { jobs: [] }
    else if (['files/report', 'files/ed2k', 'range-proofs/forget'].includes(endpoint)) result = { accepted: true }
    else if (endpoint === 'uploads/prepare') {
      if (body.action === 'start' && apiFailed) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'x-request-id': '12345678-1234-1234-1234-123456789abc' }).end(JSON.stringify({ error: { code: 'CLOUD_PROVIDER_RESPONSE', message: 'SECRET' } })); return
      }
      result = { dispatch: { status: body.action === 'verify' ? 'ready' : 'uploading', fileId: '123', pickCode: body.taskKey, bucket: 'bucket', object: body.taskKey, endpoint: 'https://up-file.115.com', callback: '{}' } }
      if (body.action === 'credentials') result.credentials = { accessKeyId: 'TEST-ID', accessKeySecret: 'TEST-SECRET', securityToken: 'TEST-TOKEN', expiration: new Date(Date.now() + 3600000).toISOString(), endpoint: 'https://up-file.115.com', rate: 0 }
    } else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const media = path.join(temp, 'media'); fs.mkdirSync(media)
  const original = path.join(media, 'Test.S01E01.mp4')
  assert.equal(spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=0.1', '-c:v', 'mpeg4', '-y', original]).status, 0)
  const originalStat = fs.statSync(original)
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
  await js(`window.plutoWatch.add(${JSON.stringify({ path: media, title: '上传失败重试验收', sourceAccountId: 'source', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1, versionMode: 'fixed', releaseId: 'a'.repeat(32), directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 10 })})`)
  await js("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '传输任务').click()")
  const screenshot = async name => {
    fs.mkdirSync(path.resolve('.smoke'), { recursive: true }); win.show(); win.webContents.invalidate(); await sleep(250)
    fs.writeFileSync(path.resolve('.smoke', name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG())
  }
  const retry = () => js("[...document.querySelectorAll('.task-actions button')].find(b => /^(立即)?重试$/.test(b.textContent.trim())).click()")
  await until(async () => (await snapshot()).jobs[0]?.status === 'failed')
  const first = (await snapshot()).jobs[0]
  assert.equal(first.errorDetails.code, 'CLOUD_PROVIDER_RESPONSE')
  await until(() => js("document.body.innerText.includes('CLOUD_PROVIDER_RESPONSE')"))
  assert.ok(await js("document.body.innerText.includes('HTTP 502') && document.body.innerText.includes('12345678-1234-1234-1234-123456789abc')"))
  nativeTheme.themeSource = 'light'; win.setSize(1240, 840); await screenshot('37-upload-api-error-light')
  nativeTheme.themeSource = 'dark'; win.setSize(760, 720); await screenshot('38-upload-api-error-narrow-dark')
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth'), false)
  apiFailed = false; await retry()
  await until(async () => (await snapshot()).jobs[0]?.errorDetails?.code === 'ServiceUnavailable')
  await until(() => js("document.body.innerText.includes('ServiceUnavailable')"))
  const part = (await snapshot()).jobs[0]
  assert.equal(part.error, '上传第 1 片失败：存储服务暂不可用')
  assert.equal(part.errorDetails.httpStatus, 502)
  assert.equal(part.errorDetails.requestId, '0123456789ABCDEF')
  assert.equal(part.fileKey, first.fileKey)
  await screenshot('39-upload-part-error-narrow-dark')
  partFailed = false; await retry()
  await until(async () => { const job = (await snapshot()).jobs[0]; return job?.status === 'completed' && job.synced && job.ed2kSaved })
  const final = await snapshot(), done = final.jobs[0]
  assert.equal(final.jobs.length, 1); assert.equal(done.id, first.id); assert.equal(done.fileKey, first.fileKey)
  assert.equal(done.path, original); assert.deepEqual(done.release, first.release)
  assert.equal(done.error, ''); assert.equal(done.errorDetails, undefined)
  assert.equal(fs.statSync(original).ino, originalStat.ino); assert.equal(fs.statSync(original).mtimeMs, originalStat.mtimeMs)
  assert.equal(inits, 2); assert.equal(merges, 1)
  assert.deepEqual(listIds, ['UPLOAD-1']); assert.deepEqual(putIds, ['UPLOAD-1', 'UPLOAD-2'])
  assert.equal(calls.filter(c => c.endpoint === 'files/report').length, 1)
  assert.ok(calls.filter(c => c.endpoint === 'uploads/prepare').every(c => c.body.taskKey === first.fileKey))
  await until(() => js("!document.querySelector('.task-error-details')"))
  await screenshot('40-upload-retry-completed')
  assert.equal(await js('document.body.innerText.includes("SECRET")'), false)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, originalTaskRetried: true, expiredSessionRecovered: true, concreteApiAndOssErrors: true, fileNeverMoved: true, rendererErrors: errors }))
  app.quit()
})().catch(error => { failed = true; console.error(error); app.quit() })
app.on('will-quit', () => { server?.closeAllConnections(); server?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }) })
app.on('quit', () => { if (failed) process.exit(1) })
