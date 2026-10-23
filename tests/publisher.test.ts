/** 本地 HTTP 假服务 + 真实小视频：验证发布协议、内容去重和重启恢复；绝不访问 115。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, copyFile, readFile, writeFile, appendFile, rename, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { ed2kFile } from '../vendor/publisher/src/lib/ed2k'
import { WatchConnection, validateWatchedFile } from '../src/main/connection'
import { WatchStore } from '../src/main/store'
import { WatchPublisher } from '../src/main/publisher'
import { safeFile } from '../src/main/files'
import { findProbe, probeFile } from '../src/main/probe'
import type { WatchRoot, WatchJob } from '../src/shared/model'
import { DirectoryWatcher } from '../src/main/watcher'
import { applyWatchEdit } from '../src/main/watch-edit'

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

async function setup(options: { check?: (body: any) => unknown; proofs?: boolean; releases?: (body: any) => unknown; loseFirstReport?: boolean;
  reply?: (path: string, body: any) => { status?: number; body?: unknown; headers?: Record<string, string> } | 'disconnect' | undefined;
  retry?: ConstructorParameters<typeof WatchPublisher>[5]; connection?: ConstructorParameters<typeof WatchConnection>[0]
} = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'pluto-publish-')))
  disposers.push(() => rm(temp, { recursive: true, force: true }))
  await mkdir(join(temp, 'media'))
  const file = join(temp, 'media', 'Show.S01E01.mp4')
  const ffmpeg = Bun.which('ffmpeg')
  if (!ffmpeg) throw new Error('离线集成测试需要本机 ffmpeg')
  const generated = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=0.1', '-c:v', 'mpeg4', '-y', file])
  if (generated.status !== 0) throw new Error('生成本地测试视频失败')
  const calls: Array<{ path: string; body: any; auth: string | undefined }> = []
  const createdReleases = new Map<string, { id: string; name: string; resolution: string; dynamicRange: string; status: string }>()
  const bindings = new Map<string, string>()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = body ? JSON.parse(body) : null
    const path = req.url!.replace('/api/v1/publisher/', '')
    calls.push({ path, body: payload, auth: req.headers.authorization })
    const injected = options.reply?.(path, payload)
    if (injected === 'disconnect') { req.socket.destroy(); return }
    if (injected) { res.writeHead(injected.status ?? 200, { 'Content-Type': 'application/json', ...injected.headers }).end(JSON.stringify(injected.body ?? {})); return }
    // 对齐服务端 TaskReport.validate / validateEpisode，不能让假服务接受线上会拒绝的剧集。
    if (['tasks/report', 'files/report'].includes(path) && payload.episodeNumber !== undefined && !payload.episodeTitle?.trim()) {
      res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: {
        code: 'VALIDATION_FAILED', fieldErrors: { title: '内容为空、字符无效或长度超出限制' },
      } })); return
    }
    let result: unknown
    if (path === 'me') result = { id: 'publisher-1', name: '测试发布端', kind: 'publisher', sourceAccount: { id: 'source-1', name: '离线源', alias: 'main', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
    else if (path === 'files/check') result = options.check?.(payload) ?? { status: 'missing' }
    else if (path === 'releases/query') {
      result = options.releases?.(payload)
      if (result && typeof result === 'object' && 'items' in result && Array.isArray(result.items)) {
        const items = [...result.items, ...createdReleases.values()]
        result = { ...result, items, total: items.length, boundReleaseId: bindings.get(payload.releaseKey) }
      }
    }
    else if (path === 'tasks/report') result = { outcome: 'applied' }
    else if (path === 'uploads/prepare') result = { dispatch: { status: 'ready', fileId: '123', pickCode: 'original', filePickCode: 'finishedfile' } }
    else if (path === 'files/report') {
      const target = payload.releaseTarget
      if (!bindings.has(target.releaseKey)) {
        if (target.existingReleaseId) bindings.set(target.releaseKey, target.existingReleaseId)
        else {
          const row = { id: String(createdReleases.size + 1).padStart(32, '0'), name: target.name,
            resolution: target.resolution, dynamicRange: target.dynamicRange, status: 'published' }
          createdReleases.set(target.releaseKey, row)
          bindings.set(target.releaseKey, row.id)
        }
      }
      if (options.loseFirstReport && calls.filter(c => c.path === 'files/report').length === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'PlutoFish 上报回执丢失' } }))
        return
      }
      result = { accepted: true }
    }
    else if (path === 'files/ed2k' || path === 'range-proofs/forget' || path === 'range-proofs/report') result = { accepted: true }
    else if (path === 'range-proofs/pending') {
      const done = calls.find(c => c.path === 'files/report')?.body
      const reported = calls.some(c => c.path === 'range-proofs/report')
      result = { jobs: options.proofs && done && !reported ? [{ id: 'b'.repeat(32), taskKey: done.fileKey, sha1: done.sha1, sizeBytes: done.sizeBytes, signCheck: '0-31' }] : [], waitSupported: options.proofs === true }
    }
    else { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  disposers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  const connection = new WatchConnection({ load: () => ({ url: '', key: '' }), save: () => {}, ...options.connection })
  disposers.push(async () => connection.close())
  await connection.verify({ url, key: 'offline-test-only' })
  const root: WatchRoot = {
    id: 'watch-1', path: join(temp, 'media'), title: '本地测试', sourceAccountId: 'source-1',
    work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    sourcePreset: { platform: 'WEB', type: 'WEB-DL' }, releaseId: 'a'.repeat(32), releaseName: '测试版本', directoryId: '42', directoryPath: '/test',
    includeExisting: true, stableSeconds: 10, initialized: true, enabled: true, createdAt: new Date().toISOString(),
    binding: { url, publisherId: 'publisher-1', sourceAccount: { id: 'source-1', alias: 'main' } },
  }
  const store = new WatchStore(join(temp, 'state.json'))
  connection.validateFile = validateWatchedFile(store)
  store.data.watches.push(root)
  const job: WatchJob = { id: 'job-1', watchId: root.id, path: file, relativePath: 'Show.S01E01.mp4', signature: await safeFile(root.path, file),
    episodeNumber: 1, status: 'queued', error: '', percent: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  store.data.jobs.push(job); store.save()
  const publisher = new WatchPublisher(store, connection, temp, () => {}, e => { throw e }, options.retry)
  disposers.push(() => publisher.close())
  return { temp, file, root, store, job, connection, publisher, calls, createdReleases }
}

async function until(publisher: WatchPublisher, ready: () => boolean) {
  for (let i = 0; i < 240; i++) {
    await publisher.tick()
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('本地发布任务未完成')
}

test('旧版缺集标题任务升级后沿用任务键，完成任务上报与资源登记', async () => {
  const f = await setup()
  await f.publisher.tick()
  const key = f.job.fileKey!
  expect(key).toBeTruthy()
  await f.publisher.close()
  const path = join(f.temp, 'publications', key.replace(':', '-') + '.state.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  delete saved.draft.episodeTitle; delete saved.snapshot.episodeTitle
  const sequence = saved.snapshot.sequence
  await writeFile(path, JSON.stringify(saved))
  const publisher = new WatchPublisher(f.store, f.connection, f.temp, () => {}, e => { throw e })
  disposers.push(() => publisher.close())
  publisher.start()
  await until(publisher, () => f.job.status === 'completed' && f.job.synced === true)
  expect(f.job.fileKey).toBe(key)
  const reports = f.calls.filter(c => c.path === 'tasks/report')
  expect(reports.length).toBeGreaterThan(0)
  expect(reports.every(c => c.body.episodeTitle === '第 1 集' && c.body.taskKey === key)).toBe(true)
  expect(reports[0].body.sequence).toBeGreaterThan(sequence)
  expect(f.calls.find(c => c.path === 'files/report')!.body.episodeTitle).toBe('第 1 集')
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
})

test('编辑目录后已登记任务恢复时仍使用原作品、版本和网盘目录', async () => {
  const f = await setup()
  await f.publisher.tick()
  const key = f.job.fileKey!
  await f.publisher.pause(f.root.id)
  applyWatchEdit(f.store, f.root, { ...f.root, work: { ...f.root.work, tmdbId: '456' }, directoryId: '99', releaseId: 'b'.repeat(32) })
  f.publisher.resume(f.root.id)
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true)
  expect(f.job.fileKey).toBe(key)
  const done = f.calls.find(c => c.path === 'files/report')!.body
  expect(done.releaseTarget.workTarget.tmdbId).toBe('123')
  expect(done.releaseTarget.existingReleaseId).toBe('a'.repeat(32))
  expect(f.calls.find(c => c.path === 'uploads/prepare' && c.body.action === 'start')!.body.directoryId).toBe('42')
})

test('422 提示指出接口及字段，不暴露响应中的凭据、地址和未知字段', async () => {
  const f = await setup({ reply: path => path === 'tasks/report' ? { status: 422, body: { error: {
    code: 'VALIDATION_FAILED', message: 'private-secret-url', fieldErrors: { title: 'private-token', 'secret-field': 'private-value' },
  } } } : undefined })
  await f.publisher.tick(); await f.publisher.tick()
  expect(f.job.error).toBe('PlutoFish 任务上报失败：作品或集标题校验未通过（HTTP 422）')
  expect(f.job.synced).toBe(false)
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
})

test('按天清理只删除已完成且 ED2K 已同步的原视频，保留历史与链接并通知服务端', async () => {
  let now = Date.now()
  const f = await setup({ retry: { now: () => now } })
  f.store.data.retention = { enabled: true, days: 2 }
  const sidecar = join(f.root.path, 'Show.S01E01.nfo'); await writeFile(sidecar, 'keep')
  f.store.data.observations[f.root.id] = { [f.file]: { signature: f.job.signature, stableSince: now, jobId: f.job.id } }
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true && f.job.ed2kSaved === true)
  const ed2k = f.job.ed2k!.link, deleteAt = f.job.retention!.deleteAt!
  expect(deleteAt).toBeGreaterThan(now + 47 * 3600000)
  now = deleteAt - 1; await f.publisher.tick(); expect(existsSync(f.file)).toBe(true)
  now += 60001; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(false); expect(existsSync(sidecar)).toBe(true)
  expect(f.job.retention?.state).toBe('deleted'); expect(f.job.status).toBe('completed')
  expect(f.job.ed2k?.link).toBe(ed2k)
  expect(f.calls.filter(c => c.path === 'range-proofs/forget')).toHaveLength(1)
  expect(f.calls.find(c => c.path === 'range-proofs/forget')!.body.taskKeys).toEqual([f.job.fileKey])
  const watcher = new DirectoryWatcher(f.store, () => {}, async () => {}, e => { throw e }, () => now)
  await watcher.scan(); await watcher.close()
  expect(f.store.data.jobs).toHaveLength(1); expect(f.job.status).toBe('completed')
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, { now: () => now })
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start(); await publisher.tick()
  expect(store.data.jobs[0].retention?.state).toBe('deleted')
  expect(store.data.jobs[0].ed2k?.link).toBe(ed2k)
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
})

test('关闭清理或延长天数立即阻止删除，重新开启后按原完成时间判断', async () => {
  let now = Date.now()
  const f = await setup({ retry: { now: () => now } })
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  now += 10 * 86400000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true); expect(f.job.retention?.state).toBe('disabled')
  f.store.data.retention = { enabled: true, days: 20 }; now += 60001; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true); expect(f.job.retention?.state).toBe('retained')
  f.store.data.retention = { enabled: false, days: 1 }; now += 60001; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true)
  f.store.data.retention.enabled = true; now += 60001; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(false)
})

test.each(['directory', 'global', 'removed', 'changed', 'symlink'] as const)('清理遵守暂停、归属与文件身份边界：%s', async kind => {
  let now = Date.now()
  const f = await setup({ retry: { now: () => now } })
  f.store.data.retention = { enabled: true, days: 1 }
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  if (kind === 'directory') f.root.enabled = false
  if (kind === 'global') f.store.data.uploadsPaused = true
  if (kind === 'removed') f.store.data.watches = []
  if (kind === 'changed') await appendFile(f.file, 'replacement')
  if (kind === 'symlink') { const moved = join(f.temp, 'moved'); await rename(f.root.path, moved); await symlink(moved, f.root.path) }
  now += 2 * 86400000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true)
  expect(f.job.retention?.state).toBe(kind === 'changed' ? 'changed' : 'busy')
  expect(f.calls.some(c => c.path === 'range-proofs/forget')).toBe(false)
})

test('ED2K 已生成但同步失败时到期也不删除；恢复同步后才清理', async () => {
  let now = Date.now(), fail = true
  const f = await setup({ retry: { now: () => now }, reply: path => path === 'files/ed2k' && fail ? { status: 503 } : undefined })
  f.store.data.retention = { enabled: true, days: 1 }
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true && f.job.ed2k?.state === 'done')
  now += 2 * 86400000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true); expect(f.job.ed2kSaved).toBe(false)
  await Bun.sleep(20); fail = false; now += 60001
  await until(f.publisher, () => f.job.ed2kSaved === true)
  now += 60001; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(false)
})

test('删除后通知服务端失败保留清单，重启补发通知而不重新上传', async () => {
  let now = Date.now(), fail = true
  const f = await setup({ retry: { now: () => now }, reply: path => path === 'range-proofs/forget' && fail ? { status: 503 } : undefined })
  f.store.data.retention = { enabled: true, days: 1 }
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  now += 2 * 86400000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(false); expect(f.job.retention?.state).toBe('deleted')
  expect(f.calls.filter(c => c.path === 'range-proofs/forget')).toHaveLength(1)
  await f.publisher.close(); fail = false
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, { now: () => now })
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start(); await publisher.tick()
  expect(f.calls.filter(c => c.path === 'range-proofs/forget')).toHaveLength(2)
  expect(store.data.jobs[0].retention?.state).toBe('deleted')
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
})

test('预检查临时失败持久化递增重试，遵守 Retry-After；恢复后自动完成', async () => {
  let now = 100000, unavailable = true
  const f = await setup({ retry: { now: () => now, baseMs: 100, maxMs: 250 },
    reply: path => path === 'files/check' && unavailable ? { status: 503 } : undefined })
  for (const [attempt, delay] of [[1, 100], [2, 200], [3, 250]]) {
    await until(f.publisher, () => f.job.status === 'failed' && f.job.retry?.attempt === attempt)
    expect(f.job.retry?.nextAt).toBe(now + delay)
    expect(new WatchStore(f.store.path).data.jobs[0].retry).toEqual(f.job.retry)
    const calls = f.calls.length
    now += delay - 1; await f.publisher.tick(); expect(f.calls.length).toBe(calls)
    now++
  }
  unavailable = false
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.job.retry).toBeUndefined()
  const throttled = await setup({ retry: { now: () => now, baseMs: 100 },
    reply: path => path === 'files/check' ? { status: 429, headers: { 'Retry-After': '120' } } : undefined })
  await until(throttled.publisher, () => throttled.job.status === 'failed')
  expect(throttled.job.retry?.nextAt).toBe(now + 120000)
})

test('上传回执丢失后重启保留重试时间、版本与原文件键，自动补报不重复上传', async () => {
  let now = 100000
  const options = { now: () => now, baseMs: 1000 }
  const f = await setup({ loseFirstReport: true, retry: options })
  await until(f.publisher, () => f.job.status === 'failed' && !!f.job.retry)
  const key = f.job.fileKey, retry = structuredClone(f.job.retry), release = structuredClone(f.job.release)
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, options)
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start()
  const job = store.data.jobs[0]
  expect(job.retry).toEqual(retry)
  now = retry!.nextAt! - 1
  await publisher.tick()
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  now++
  await until(publisher, () => job.status === 'completed' && job.ed2kSaved === true)
  expect(job.fileKey).toBe(key); expect(job.release).toEqual(release)
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
  const reports = f.calls.filter(c => c.path === 'files/report')
  expect(reports).toHaveLength(2); expect(reports[0].body).toEqual(reports[1].body)
  expect(job.retry).toBeUndefined()
})

test('真正断开本地 HTTP 连接后自动重连并完成任务，无需点击继续', async () => {
  let offline = false, now = 100000
  const f = await setup({ retry: { now: () => now, baseMs: 100 }, connection: { retryBaseMs: 20, retryMaxMs: 40 },
    reply: path => offline && ['me', 'files/check'].includes(path) ? 'disconnect' : undefined })
  offline = true
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.connection.ready).toBe(false)
  expect(f.connection.view().reconnect?.attempt).toBe(1)
  expect(f.job.retry?.nextAt).toBe(now + 100)
  offline = false; now += 100
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.connection.ready).toBe(true)
  expect(f.calls.filter(c => c.path === 'me').length).toBeGreaterThan(1)
})

test('等待重试期间暂停目录、全局暂停或手动暂停均不放行；取消任务不复活', async () => {
  let now = 100000
  const f = await setup({ loseFirstReport: true, retry: { now: () => now, baseMs: 100 } })
  await until(f.publisher, () => f.job.status === 'failed')
  now += 1000
  for (const paused of ['root', 'global', 'manual']) {
    f.root.enabled = paused !== 'root'; f.store.data.uploadsPaused = paused === 'global'; f.job.manuallyPaused = paused === 'manual'
    f.publisher.resume(); await f.publisher.tick()
    expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  }
  f.job.manuallyPaused = true
  await f.publisher.stopJob(f.job, 'cancel'); f.job.status = 'cancelled'; f.publisher.resume()
  await f.publisher.tick()
  expect(f.job.status).toBe('cancelled')
  expect(f.job.retry).toBeUndefined()
})

test.each([403, 409])('HTTP %s 权限或冲突错误保持待处理，不自动重试', async status => {
  let now = 100000
  const f = await setup({ retry: { now: () => now, baseMs: 100 }, reply: path => path === 'files/check' ? { status } : undefined })
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.job.retry).toBeUndefined()
  now += 100000; await f.publisher.tick()
  expect(f.calls.filter(c => c.path === 'files/check')).toHaveLength(1)
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
})

test('重试前文件被替换时停止，旧失败快照不得恢复自动重试', async () => {
  let now = 100000
  const f = await setup({ loseFirstReport: true, retry: { now: () => now, baseMs: 100 } })
  await until(f.publisher, () => f.job.status === 'failed')
  await appendFile(f.file, 'changed')
  now += 100
  await f.publisher.tick()
  expect(f.job.error).toContain('文件已改变')
  for (let i = 0; i < 3; i++) { now += 100000; await f.publisher.tick() }
  expect(f.job.status).toBe('failed')
  expect(f.job.retry?.nextAt).toBeUndefined()
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, { now: () => now, baseMs: 100 })
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start(); await publisher.tick()
  expect(store.data.jobs[0].error).toContain('文件已改变')
  expect(store.data.jobs[0].retry?.nextAt).toBeUndefined()
})

test('分片断网后自动续传原 uploadId，已确认第一片不重传，ED2K 与完成状态正常同步', async () => {
  let now = 100000, failed = false, init = 0, merges = 0
  const parts = new Map<number, { PartNumber: number; ETag: string; Size: string }>(), puts: number[] = []
  const f = await setup({
    retry: { now: () => now, baseMs: 100, factory: () => ({ close() {}, client: {
      async initMultipartUpload() { init++; return { uploadId: 'UPLOAD-1' } as any },
      async listParts() { return { uploadId: 'UPLOAD-1', bucket: 'bucket', name: 'object', parts: [...parts.values()], isTruncated: false } as any },
      async uploadPart(_name, id, number, buffer) {
        expect(id).toBe('UPLOAD-1'); puts.push(number)
        if (number === 2 && !failed) { failed = true; throw Object.assign(new Error('local test disconnect'), { code: 'ECONNRESET' }) }
        const etag = createHash('md5').update(buffer).digest('hex')
        parts.set(number, { PartNumber: number, ETag: etag, Size: String(buffer.length) })
        return { etag } as any
      },
      async completeMultipartUpload() { merges++; return { data: { state: true } } as any },
    } }) },
    reply: (path, body) => {
      if (path !== 'uploads/prepare') return undefined
      if (body.action === 'start') return { body: { dispatch: { status: 'uploading', bucket: 'bucket', object: 'object', pickCode: 'original', callback: '{}' } } }
      if (body.action === 'credentials') return { body: { credentials: { accessKeyId: 'fake', accessKeySecret: 'fake', securityToken: 'fake', expiration: new Date(Date.now() + 3600000).toISOString(), rate: 0 } } }
      return undefined
    },
  })
  await appendFile(f.file, Buffer.alloc(16 * 1024 * 1024))
  f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.job.retry?.nextAt).toBe(now + 100)
  expect(puts).toEqual([1, 2])
  expect(parts.get(1)?.Size).toBe(String(16 * 1024 * 1024))
  const key = f.job.fileKey
  now += 100
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true && f.job.synced === true)
  expect(f.job.fileKey).toBe(key)
  expect(puts).toEqual([1, 2, 2]); expect(init).toBe(1); expect(merges).toBe(1)
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
})

test('真实检测本地视频，通过模拟服务完成核验与资源登记，保留本地原文件', async () => {
  const f = await setup()
  const measured = await probeFile(findProbe(''), f.file, f.job.signature.size, new AbortController().signal)
  expect(measured.media.width).toBe(320)
  await until(f.publisher, () => f.job.status === 'completed')
  await f.publisher.tick()
  const report = f.calls.find(c => c.path === 'files/report')!.body
  expect(report.deduplicate).toBe(true)
  expect(report.releaseTarget.existingReleaseId).toBe(f.root.releaseId)
  expect(report.releaseTarget.name).toBe(f.root.releaseName)
  expect(report.releaseTarget.workTarget.tmdbId).toBe('123')
  expect(report.episodeNumber).toBe(1)
  expect(report.resource.pickCode).toBe('finishedfile')
  expect(report.sizeBytes).toBe(f.job.signature.size)
  expect(f.calls.find(c => c.path === 'uploads/prepare' && c.body.action === 'start')?.body.directoryId).toBe('42')
  expect(f.calls.every(c => c.auth === 'Bearer offline-test-only')).toBe(true)
  expect((await readFile(f.file)).length).toBe(f.job.signature.size)
})

const automaticOptions = () => [
  { id: 'a'.repeat(32), name: 'S01.720p.WEB.WEB-DL.SDR.AVC', resolution: '720p', dynamicRange: 'SDR', status: 'published' },
  { id: 'b'.repeat(32), name: 'S01.1080p.WEB.WEB-DL.SDR.AVC', resolution: '1080p', dynamicRange: 'SDR', status: 'published' },
]
const releasePage = (items = automaticOptions()) => ({ items, total: items.length, page: 1, pageSize: 100 })
function sampleVideo(file: string, size: string) {
  expect(spawnSync(Bun.which('ffmpeg')!, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=green:s=${size}:d=0.08`, '-c:v', 'libx264', '-preset', 'ultrafast', '-y', file]).status).toBe(0)
}

test('自动归类在同一目录分开画质；同版本重复内容仍跳过，重启保持归属', async () => {
  const f = await setup({ releases: () => releasePage() })
  f.root.versionMode = 'auto'; f.root.releaseId = ''; f.root.releaseName = '自动归类'
  sampleVideo(f.file, '1280x720')
  f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.job.release?.id).toBe('a'.repeat(32))
  const secondFile = join(f.root.path, 'Another.S01E01.mp4')
  sampleVideo(secondFile, '1920x1080')
  const next: WatchJob = { id: 'job-hd', watchId: f.root.id, path: secondFile, relativePath: 'Another.S01E01.mp4',
    signature: await safeFile(f.root.path, secondFile), episodeNumber: 1, status: 'queued', error: '', percent: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  f.store.data.jobs.push(next)
  await until(f.publisher, () => next.status === 'completed')
  expect(next.release?.id).toBe('b'.repeat(32))
  const reports = f.calls.filter(c => c.path === 'files/report')
  expect(reports.map(c => c.body.releaseTarget.existingReleaseId)).toEqual(['a'.repeat(32), 'b'.repeat(32)])
  expect(new Set(f.calls.filter(c => c.path === 'files/check').map(c => c.body.releaseId)).size).toBe(2)
  expect(reports[0].body.releaseTarget.releaseKey).not.toBe(reports[1].body.releaseTarget.releaseKey)
  const copy = join(f.root.path, 'Renamed.S01E01.mp4')
  await copyFile(secondFile, copy)
  const duplicate: WatchJob = { ...next, id: 'duplicate', path: copy, relativePath: 'Renamed.S01E01.mp4',
    fileKey: undefined, release: undefined, targetKey: undefined, sha1: undefined, status: 'queued', signature: await safeFile(f.root.path, copy) }
  f.store.data.jobs.push(duplicate)
  await until(f.publisher, () => duplicate.status === 'duplicate')
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(2)
  expect(new WatchStore(f.store.path).data.jobs.find(j => j.id === 'job-hd')?.release?.id).toBe('b'.repeat(32))
})

test('版本有歧义时不上传；查询响应损坏不当作空版本', async () => {
  for (const response of [releasePage([automaticOptions()[0], { ...automaticOptions()[0], id: 'c'.repeat(32) }]), { error: 'broken' }]) {
    const f = await setup({ releases: () => response })
    f.root.versionMode = 'auto'; f.root.releaseId = ''
    sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
    await until(f.publisher, () => ['review', 'failed'].includes(f.job.status))
    expect(f.job.status).toBe('error' in response ? 'failed' : 'review')
    expect(f.calls.some(c => ['uploads/prepare', 'files/report', 'files/check'].includes(c.path))).toBe(false)
    expect(f.job.fileKey).toBeUndefined()
  }
})

test('无匹配自动新建；后续集数跨目录复用，改名重复仍跳过并持久化绑定', async () => {
  const f = await setup({ releases: () => releasePage([]) })
  f.root.versionMode = 'auto'; f.root.releaseId = ''
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  // 从中间集开始补传也能创建版本。
  f.job.episodeNumber = 5
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  expect(f.createdReleases.size).toBe(1)
  const first = f.calls.find(c => c.path === 'files/report')!.body
  expect(first.releaseTarget.existingReleaseId).toBeUndefined()
  expect(first.releaseTarget.name).toBe('S01.720p.WEB.WEB-DL.SDR.AVC')
  expect(first.releaseTarget.autoPublish).toBe(true)
  expect(f.calls.some(c => c.path === 'files/check')).toBe(false)
  const key = f.job.release!.key
  const secondRoot = { ...f.root, id: 'watch-2', path: join(f.temp, 'second'), directoryId: '43' }
  await mkdir(secondRoot.path); f.store.data.watches.push(secondRoot)
  const nextFile = join(secondRoot.path, 'Other.S01E06.mp4')
  await copyFile(f.file, nextFile)
  const next: WatchJob = { ...f.job, id: 'job-next', watchId: secondRoot.id, path: nextFile, relativePath: 'Other.S01E06.mp4',
    episodeNumber: 6, status: 'queued', fileKey: undefined, sha1: undefined, release: undefined, targetKey: undefined,
    signature: await safeFile(secondRoot.path, nextFile) }
  f.store.data.jobs.push(next)
  await until(f.publisher, () => next.status === 'completed')
  expect(next.release?.key).toBe(key)
  expect(f.job.release?.id).toBe(next.release?.id)
  expect(f.calls.filter(c => c.path === 'files/report')[1].body.releaseTarget.existingReleaseId).toBe(next.release?.id)
  expect(f.createdReleases.size).toBe(1)
  const duplicate: WatchJob = { ...next, id: 'copy', episodeNumber: 5, status: 'queued', fileKey: undefined, sha1: undefined, release: undefined, targetKey: undefined }
  f.store.data.jobs.push(duplicate)
  await until(f.publisher, () => duplicate.status === 'duplicate')
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(2)
  expect(new WatchStore(f.store.path).data.jobs.find(j => j.id === next.id)?.release?.id).toBe(next.release?.id)
})

test('自动上报保留完整制作组，同组续集复用，不同组和无组版本不混用', async () => {
  const f = await setup({ releases: () => releasePage([automaticOptions()[0]]) })
  f.root.versionMode = 'auto'; f.root.releaseId = ''
  const groups = ['Team.Web-Release', 'Team.Web-Release', '制作组']
  const jobs: WatchJob[] = []
  for (const [index, group] of groups.entries()) {
    const name = `Show.S01E0${index + 1}.720p.WEB.WEB-DL.AVC-${group}.mp4`
    const path = join(f.root.path, name)
    sampleVideo(path, '1280x720')
    const job: WatchJob = { ...f.job, id: `group-${index}`, path, relativePath: name, episodeNumber: index + 1,
      status: 'queued', fileKey: undefined, sha1: undefined, release: undefined, targetKey: undefined,
      signature: await safeFile(f.root.path, path) }
    if (index === 0) f.store.data.jobs = []
    f.store.data.jobs.push(job); jobs.push(job)
    await until(f.publisher, () => job.status === 'completed')
    const report = f.calls.filter(c => c.path === 'files/report').at(-1)!.body
    expect(report.releaseTarget.name).toBe(`S01.720p.WEB.WEB-DL.SDR.AVC-${group}`)
    expect(job.release?.id).not.toBe('a'.repeat(32))
  }
  expect(f.createdReleases.size).toBe(2)
  expect(jobs[0].release?.id).toBe(jobs[1].release?.id)
  expect(jobs[0].release?.key).toBe(jobs[1].release?.key)
  expect(jobs[2].release?.id).not.toBe(jobs[0].release?.id)
  expect(jobs[2].release?.key).not.toBe(jobs[0].release?.key)
  expect(new WatchStore(f.store.path).data.jobs[2].release).toEqual(jobs[2].release)
})

test('新版本等待上传时重启、并发发现和不同画质不会产生重复版本', async () => {
  const f = await setup({ releases: () => releasePage([]) })
  f.root.versionMode = 'auto'; f.root.releaseId = ''
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  await f.publisher.tick()
  expect(f.job.release?.key).toBeDefined()
  const key = f.job.release!.key
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e })
  f.connection.validateFile = validateWatchedFile(store)
  disposers.push(() => publisher.close()); publisher.start()
  const original = store.data.jobs[0]
  await until(publisher, () => original.status === 'completed')
  expect(original.release?.key).toBe(key)
  for (const [id, size, episode] of [['same', '1280x720', 2], ['hd', '1920x1080', 1]] as const) {
    const path = join(f.root.path, `${id}.mp4`)
    sampleVideo(path, size)
    store.data.jobs.push({ ...original, id, path, relativePath: `${id}.mp4`, episodeNumber: episode,
      status: 'queued', fileKey: undefined, sha1: undefined, release: undefined, targetKey: undefined,
      signature: await safeFile(f.root.path, path) })
  }
  await until(publisher, () => store.data.jobs.every(j => j.status === 'completed'))
  expect(f.createdReleases.size).toBe(2)
  expect(store.data.jobs[1].release?.key).toBe(key)
  expect(store.data.jobs[2].release?.key).not.toBe(key)
})

test('新版本文件名矛盾、下架绑定和同名资料冲突都不会再建版本', async () => {
  for (const response of [
    releasePage([{ ...automaticOptions()[0], status: 'unpublished' }]),
    releasePage([{ ...automaticOptions()[0], dynamicRange: 'HDR10' }]),
  ]) {
    const f = await setup({ releases: () => response })
    f.root.versionMode = 'auto'; f.root.releaseId = ''
    sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
    await until(f.publisher, () => f.job.status === 'review')
    expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
  }
  const f = await setup({ releases: () => releasePage([]) })
  f.root.versionMode = 'auto'; f.root.releaseId = ''
  f.job.path = join(f.root.path, 'Show.2160p.WEB.WEB-DL.HEVC.mp4')
  sampleVideo(f.job.path, '1280x720'); f.job.signature = await safeFile(f.root.path, f.job.path)
  await until(f.publisher, () => f.job.status === 'review')
  expect(f.createdReleases.size).toBe(0)
})

test('新版本已创建但上报回执丢失，重试复用原绑定且不再次上传', async () => {
  const f = await setup({ releases: () => releasePage([]), loseFirstReport: true })
  f.root.versionMode = 'auto'; f.root.releaseId = ''
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.createdReleases.size).toBe(1)
  const key = f.job.release!.key
  const fileKey = f.job.fileKey
  // 与服务层一致：重试先重新核对文件，旧失败快照仍可能等待同步。
  f.job.status = 'queued'
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  expect(f.job.release?.key).toBe(key)
  expect(f.job.fileKey).toBe(fileKey)
  expect(f.job.release?.id).toBe([...f.createdReleases.values()][0].id)
  expect(f.createdReleases.size).toBe(1)
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(2)
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
})

test('重启不重复登记；相同内容换文件名再次发现会跳过', async () => {
  const f = await setup()
  await until(f.publisher, () => f.job.status === 'completed')
  await f.publisher.tick()
  await f.publisher.close()
  const restored = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(restored, f.connection, f.temp, () => {}, e => { throw e })
  disposers.push(() => publisher.close())
  publisher.start()
  await publisher.tick()
  const newPath = join(f.root.path, 'Another.S01E01.mp4')
  await copyFile(f.file, newPath)
  const second: WatchJob = { ...restored.data.jobs[0], id: 'job-2', path: newPath, signature: await safeFile(f.root.path, newPath),
    fileKey: undefined, sha1: undefined, percent: 0, status: 'queued', relativePath: 'Another.S01E01.mp4' }
  restored.data.jobs.push(second); restored.save()
  await until(publisher, () => second.status === 'duplicate')
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
})

test('上传总开关与目录暂停均阻止准备文件', async () => {
  const f = await setup()
  f.store.data.uploadsPaused = true
  await f.publisher.tick()
  expect(f.job.status).toBe('queued')
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
  f.store.data.uploadsPaused = false
  f.root.enabled = false
  await f.publisher.tick()
  expect(f.job.status).toBe('queued')
  expect(f.calls.some(c => c.path === 'files/report')).toBe(false)
})

test('绑定不匹配或文件变更时失败，不发出上传初始化', async () => {
  const f = await setup()
  f.root.binding.publisherId = 'other-publisher'
  await f.publisher.tick()
  expect(f.job.status).toBe('failed')
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
  f.root.binding.publisherId = 'publisher-1'
  f.job.status = 'queued'; f.job.signature.size += 1
  await f.publisher.tick()
  expect(f.job.status).toBe('failed')
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
})

test('用户暂停或取消的未完成任务，重启后不能自动恢复上传', async () => {
  for (const action of ['pause', 'cancel'] as const) {
    const f = await setup()
    await f.publisher.tick()
    expect(f.job.fileKey).toBeDefined()
    f.job.manuallyPaused = true
    await f.publisher.stopJob(f.job, action)
    f.store.save()
    await f.publisher.close()
    const restored = new WatchStore(f.store.path)
    const publisher = new WatchPublisher(restored, f.connection, f.temp, () => {}, e => { throw e })
    disposers.push(() => publisher.close())
    publisher.start()
    await publisher.tick()
    expect(restored.data.jobs[0].status).toBe(action === 'pause' ? 'paused' : 'cancelled')
    expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
  }
})

test.each(['cancelled', 'paused', 'failed', 'changed'] as const)('异常退出后本地停止决定优先于旧上传快照：%s', async status => {
  const f = await setup()
  await f.publisher.tick()
  await f.publisher.close()
  // 模拟两份持久化记录间中断：发布清单仍为 processing，本地已记录停止决定。
  f.job.status = status === 'changed' ? 'cancelled' : status
  f.job.manuallyPaused = status === 'paused' || status === 'cancelled'
  f.job.changed = status === 'changed'
  f.job.error = status === 'failed' ? '恢复前校验失败' : '保留停止原因'
  f.store.save()
  const restored = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(restored, f.connection, f.temp, () => {}, e => { throw e })
  disposers.push(() => publisher.close())
  publisher.start()
  await publisher.tick(); await publisher.tick()
  expect(restored.data.jobs[0].status).toBe(status === 'changed' ? 'cancelled' : status)
  if (status === 'failed') expect(restored.data.jobs[0].error).toBe('恢复前校验失败')
  expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
  expect(f.calls.some(c => c.path === 'files/report')).toBe(false)
})

test('媒体校验之后被同大小内容替换，上传请求前拦截', async () => {
  const f = await setup()
  await f.publisher.tick()
  expect(f.job.fileKey).toBeDefined()
  const bytes = await readFile(f.file)
  bytes[bytes.length - 1] ^= 1
  await writeFile(f.file, bytes)
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.calls.some(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toBe(false)
  expect(f.calls.some(c => c.path === 'files/report')).toBe(false)
})


test('跨监控目录和改名仍按目标内容去重，不依赖目录 ID', async () => {
  const f = await setup()
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  const secondRoot = { ...f.root, id: 'watch-2', path: join(f.temp, 'second') }
  await mkdir(secondRoot.path)
  f.store.data.watches.push(secondRoot)
  const path = join(secondRoot.path, 'Renamed.S01E01.mp4')
  await copyFile(f.file, path)
  const second: WatchJob = { ...f.job, id: 'job-2', watchId: secondRoot.id, path, signature: await safeFile(secondRoot.path, path), status: 'queued', fileKey: undefined, sha1: undefined }
  f.store.data.jobs.push(second)
  await until(f.publisher, () => second.status === 'duplicate')
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  expect(f.calls.filter(c => c.path === 'files/check')).toHaveLength(1)
  expect(second.ed2kSaved).toBe(true)
})

test('服务端已有内容继续共享后续流程，补记 ED2K 并响应客户端校验通知', async () => {
  const f = await setup({ check: () => ({ status: 'existing', fileId: 'd'.repeat(32) }), proofs: true })
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  const expected = await ed2kFile(f.file)
  expect(f.job.reused).toBe(true)
  expect(f.job.ed2k?.link).toBe(expected.link)
  expect(f.job.ed2k?.state).toBe('done')
  expect(f.calls.find(c => c.path === 'files/ed2k')?.body.ed2k).toBe(expected.link)
  expect(f.calls.some(c => c.path === 'tasks/report' && c.body.stage === 'completed')).toBe(true)
  await until(f.publisher, () => f.calls.some(c => c.path === 'range-proofs/report'))
  const proof = f.calls.find(c => c.path === 'range-proofs/report')!.body
  expect(proof.unavailable).toBeUndefined()
  expect(proof.signValue).toBe(createHash('sha1').update((await readFile(f.file)).subarray(0, 32)).digest('hex').toUpperCase())
  expect((await readFile(f.file)).length).toBe(f.job.signature.size)
})

test('服务端冲突或查重响应损坏时停止，不能当作不存在而上传', async () => {
  for (const result of [{ status: 'conflict' }, { status: 'bad' }, { status: 'existing' }]) {
    const f = await setup({ check: () => result })
    await f.publisher.tick()
    expect(f.job.status).toBe('failed')
    expect(f.calls.some(c => c.path === 'uploads/prepare')).toBe(false)
    expect(f.calls.some(c => c.path === 'files/report')).toBe(false)
  }
})

test('原文件移走后重新发现相同内容，接续本地发布能力而非永久跳过', async () => {
  const f = await setup()
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  const path = join(f.root.path, 'Moved.S01E01.mp4')
  await copyFile(f.file, path)
  await rm(f.file)
  const second: WatchJob = { ...f.job, id: 'job-2', path, signature: await safeFile(f.root.path, path), status: 'queued', fileKey: undefined, sha1: undefined }
  f.store.data.jobs.push(second)
  await until(f.publisher, () => second.status === 'completed')
  expect(second.fileKey).not.toBe(f.job.fileKey)
  expect(f.calls.filter(c => c.path === 'files/check')).toHaveLength(2)
})

test('无来源的旧目录和历史文件待确认；重启不上传，明确来源后才继续', async () => {
  const f = await setup({ releases: () => releasePage() })
  f.root.versionMode = 'auto'; f.root.releaseId = ''; delete f.root.sourcePreset
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'review')
  expect(f.job.versionReview?.sourceRequired).toBe(true)
  expect(f.job.release).toBeUndefined()
  expect(f.calls.some(c => ['uploads/prepare', 'files/check', 'files/report'].includes(c.path))).toBe(false)
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e })
  f.connection.validateFile = validateWatchedFile(store)
  disposers.push(() => publisher.close()); publisher.start(); await publisher.tick()
  const job = store.data.jobs[0]
  expect(job.status).toBe('review')
  // 模拟已通过服务层校验的逐文件确认；真实 IPC 路径由 Electron 验收覆盖。
  job.sourceOverride = { platform: 'WEB', type: 'WEB-DL' }; job.status = 'queued'
  await until(publisher, () => job.status === 'completed')
  expect(job.release?.id).toBe('a'.repeat(32))
  expect(new WatchStore(store.path).data.jobs[0].sourceOverride).toEqual(job.sourceOverride)
})

test('文件名覆盖目录预设，BluRay 和 REMUX 不会按默认 WEB-DL 登记', async () => {
  for (const [name, expected] of [
    ['Show.S01E01.720p.YK.WEB-DL.AVC.mp4', 'S01.720p.YOUKU.WEB-DL.SDR.AVC'],
    ['Show.S01E01.720p.BluRay.REMUX.AVC.mp4', 'S01.720p.BluRay.REMUX.SDR.AVC'],
    ['Show.S01E01.720p.REMUX.AVC.mp4', 'S01.720p.REMUX.SDR.AVC'],
  ]) {
    const f = await setup({ releases: () => releasePage() })
    f.root.versionMode = 'auto'; f.root.releaseId = ''
    f.job.path = join(f.root.path, name)
    sampleVideo(f.job.path, '1280x720'); f.job.signature = await safeFile(f.root.path, f.job.path)
    await until(f.publisher, () => f.job.status === 'completed')
    const report = f.calls.find(c => c.path === 'files/report')!.body
    expect(report.releaseTarget.name).toBe(expected)
    expect(report.releaseTarget.existingReleaseId).toBeUndefined()
  }
})

test('同下载器一样复用旧别名和缺少音轨标签的版本，不额外创建', async () => {
  const f = await setup({ releases: () => releasePage([{ ...automaticOptions()[0], name: 'S01.720p.YK.WEB-DL.H264' }]) })
  f.root.versionMode = 'auto'; f.root.releaseId = ''; f.root.sourcePreset = { platform: 'YOUKU', type: 'WEB-DL' }
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.job.release?.id).toBe('a'.repeat(32))
  expect(f.createdReleases.size).toBe(0)
})
