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

type TestReply = { status?: number; body?: unknown; headers?: Record<string, string> } | 'disconnect' | undefined

async function setup(options: { check?: (body: any) => unknown; proofs?: boolean; diagnostics?: boolean; releases?: (body: any) => unknown; loseFirstReport?: boolean;
  reply?: (path: string, body: any) => TestReply | Promise<TestReply>;
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
  const createdReleases = new Map<string, { id: string; name: string; resolution: string; dynamicRange: string; status: string; seasonNumber?: number }>()
  const bindings = new Map<string, string>()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = body ? JSON.parse(body) : null
    const path = req.url!.replace('/api/v1/publisher/', '')
    calls.push({ path, body: payload, auth: req.headers.authorization })
    const injected = await options.reply?.(path, payload)
    if (injected === 'disconnect') { req.socket.destroy(); return }
    if (injected) { res.writeHead(injected.status ?? 200, { 'Content-Type': 'application/json', ...injected.headers }).end(JSON.stringify(injected.body ?? {})); return }
    // 对齐服务端 TaskReport.validate / validateEpisode，不能让假服务接受线上会拒绝的剧集。
    if (['tasks/report', 'files/report'].includes(path) && payload.episodeNumber !== undefined && !payload.episodeTitle?.trim()) {
      res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: {
        code: 'VALIDATION_FAILED', fieldErrors: { title: '内容为空、字符无效或长度超出限制' },
      } })); return
    }
    let result: unknown
    if (path === 'me') result = { id: 'publisher-1', name: '测试发布端', kind: 'publisher', sourceAccount: { id: 'source-1', name: '离线源', alias: 'main', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }], ...(options.diagnostics ? { capabilities: { taskDiagnostics: true } } : {}) }
    else if (path === 'files/check') result = options.check?.(payload) ?? { status: 'missing' }
    else if (path === 'releases/query') {
      result = options.releases?.(payload)
      if (result && typeof result === 'object' && 'items' in result && Array.isArray(result.items)) {
        const items = [...result.items, ...[...createdReleases.values()].filter(row => row.seasonNumber === payload.seasonNumber)]
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
            resolution: target.resolution, dynamicRange: target.dynamicRange, status: 'published', seasonNumber: target.seasonNumber }
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

test('整部剧跨季发布查询和登记各自季号，固定版本不串季，同集同内容跨季不去重', async () => {
  const f = await setup({ releases: () => releasePage([]) })
  sampleVideo(f.file, '1280x720'); f.job.signature = await safeFile(f.root.path, f.file)
  await until(f.publisher, () => f.job.status === 'completed')
  const file = join(f.root.path, 'Show.S02E01.mp4'); await copyFile(f.file, file)
  const second: WatchJob = { id: 'season-2', watchId: f.root.id, path: file, relativePath: 'Show.S02E01.mp4',
    signature: await safeFile(f.root.path, file), status: 'waiting', error: '', percent: 0, createdAt: f.job.createdAt, updatedAt: f.job.updatedAt }
  f.store.data.jobs.push(second)
  const watcher = new DirectoryWatcher(f.store, () => {}, async () => {}, e => { throw e })
  disposers.push(() => watcher.close())
  f.store.data.observations[f.root.id] = Object.fromEntries([f.job, second].map(j => [j.path, { jobId: j.id, signature: j.signature, stableSince: Date.now() - 20_000 }]))
  await watcher.scan()
  expect([second.seasonNumber, second.episodeNumber, second.status]).toEqual([2, 1, 'queued'])
  await until(f.publisher, () => second.status === 'completed')
  const reports = f.calls.filter(c => c.path === 'files/report')
  expect(reports.map(c => [c.body.releaseTarget.seasonNumber, c.body.episodeNumber])).toEqual([[1, 1], [2, 1]])
  expect(reports[0].body.releaseTarget.existingReleaseId).toBe(f.root.releaseId)
  expect(reports[1].body.releaseTarget.existingReleaseId).toBeUndefined()
  expect(reports[1].body.releaseTarget.name).toStartWith('S02.')
  expect(f.calls.filter(c => c.path === 'releases/query').every(c => c.body.seasonNumber === 2)).toBe(true)
  expect(second.targetKey).not.toBe(f.job.targetKey)
  const key = second.fileKey
  applyWatchEdit(f.store, f.root, { ...f.root, seasonNumber: 3 })
  const restored = new WatchStore(f.store.path)
  expect(restored.rootFor(restored.data.jobs[1])?.seasonNumber).toBe(2)
  expect(restored.data.jobs[1].fileKey).toBe(key)
})

test('单个电影按电影查询版本并登记，不发送季号集号；来源缺失显示来源确认', async () => {
  for (const missingSource of [false, true]) {
    const f = await setup({ releases: () => releasePage([]) })
    f.root.work = { mediaType: 'movie', tmdbId: '456', category: 'movie' }
    f.root.versionMode = 'auto'; f.root.releaseId = ''; delete f.root.seasonNumber
    if (missingSource) f.root.sourcePreset = {}
    const file = join(f.root.path, 'Movie.2023.mp4')
    await rename(f.file, file); sampleVideo(file, '1280x720')
    f.job.path = file; f.job.relativePath = 'Movie.2023.mp4'; f.job.signature = await safeFile(f.root.path, file)
    await until(f.publisher, () => ['completed', 'review'].includes(f.job.status))
    expect(f.job.seasonNumber).toBeUndefined(); expect(f.job.episodeNumber).toBeUndefined()
    const queries = f.calls.filter(c => c.path === 'releases/query')
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every(c => c.body.workTarget.mediaType === 'movie' && c.body.seasonNumber === undefined)).toBe(true)
    if (missingSource) {
      expect(f.job.status).toBe('review'); expect(f.job.versionReview?.sourceRequired).toBe(true)
      expect(f.job.error).not.toContain('集号')
      expect(f.calls.some(c => c.path === 'files/report')).toBe(false)
    } else {
      expect(f.job.status).toBe('completed')
      const report = f.calls.find(c => c.path === 'files/report')!.body
      expect(report.releaseTarget.workTarget.mediaType).toBe('movie')
      expect(report.releaseTarget.seasonNumber).toBeUndefined(); expect(report.episodeNumber).toBeUndefined()
      expect(report.releaseTarget.name).not.toStartWith('S01.')
    }
  }
})

test('一次性混传两季、两种画质和制作组，各自登记版本且同集号不冲突', async () => {
  const f = await setup({ releases: () => releasePage([]) })
  f.root.mode = 'once'; f.root.versionMode = 'auto'; f.root.releaseId = ''
  f.root.cleanup = { enabled: false, days: 1 }
  // 从第二季开始；整批默认季、发现顺序和首个文件不能决定其他文件的版本。
  f.root.seasonNumber = 2
  f.store.data.jobs = []
  const samples = [
    [2, 1, 720, 'Ftang'], [1, 1, 720, 'Ftang'], [1, 1, 1080, 'Ftang'], [2, 1, 1080, 'Ftang'],
    [2, 1, 720, 'Other'], [1, 1, 720, 'Other'], [2, 2, 720, 'Ftang'], [1, 2, 720, 'Ftang'],
  ] as const
  const files: string[] = []
  for (const [season, episode, height, group] of samples) {
    const folder = join(f.root.path, `Season 0${season}`)
    await mkdir(folder, { recursive: true })
    const file = join(folder, `Platonic.S0${season}E0${episode}.${height}p.APP.WEB-DL.AVC-${group}.mp4`)
    sampleVideo(file, height === 720 ? '1280x720' : '1920x1080')
    files.push(file)
  }
  f.root.batch = { files }
  const watcher = new DirectoryWatcher(f.store, () => {}, async () => {}, e => { throw e })
  disposers.push(() => watcher.close())
  await watcher.scan()
  for (const observation of Object.values(f.store.data.observations[f.root.id])) observation.stableSince = Date.now() - 20_000
  await watcher.scan()
  await until(f.publisher, () => f.store.data.jobs.every(job => job.status === 'completed'))

  const reports = f.calls.filter(call => call.path === 'files/report')
  expect(reports).toHaveLength(samples.length)
  expect(f.createdReleases.size).toBe(6)
  for (const [index, [season, episode, height, group]] of samples.entries()) {
    const job = f.store.data.jobs.find(item => item.path === files[index])!
    const report = reports.find(call => call.body.fileKey === job.fileKey)!.body
    expect([job.seasonNumber, job.episodeNumber]).toEqual([season, episode])
    expect(report.releaseTarget.seasonNumber).toBe(season)
    expect(report.episodeNumber).toBe(episode)
    expect(report.releaseTarget.name).toBe(`S0${season}.${height}p.APP.WEB-DL.SDR.AVC-${group}`)
  }
  expect(new Set(f.store.data.jobs.map(job => job.targetKey)).size).toBe(samples.length)
  const restored = new WatchStore(f.store.path)
  expect(restored.data.jobs.map(job => [job.seasonNumber, job.release?.key])).toEqual(
    f.store.data.jobs.map(job => [job.seasonNumber, job.release?.key]))
})

test('旧版排队文件已有跨季版本也先确认，不开始上传；已登记旧文件保留归属', async () => {
  const f = await setup()
  f.root.seasonNumber = 2
  f.job.release = { id: f.root.releaseId, name: 'S02.测试版本' }
  await f.publisher.tick()
  expect(f.job.status).toBe('review')
  expect(f.job.seasonReview).toContain('文件属于第 1 季')
  expect(f.job.fileKey).toBeUndefined()
  expect(f.calls.some(call => ['uploads/prepare', 'tasks/report', 'files/report'].includes(call.path))).toBe(false)

  // 先生成有效发布清单，再移除逐文件季号模拟升级前已登记的数据。
  f.job.status = 'queued'; f.job.seasonNumber = 2; delete f.job.seasonReview
  await f.publisher.tick()
  expect(f.job.fileKey).toBeDefined()
  delete f.job.seasonNumber
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.calls.find(call => call.path === 'files/report')!.body.releaseTarget.seasonNumber).toBe(2)
})

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

test.each([true, false])('旧任务缺少规格时使用 Watch 配置的本机 ffprobe，工具可用：%s', async available => {
  const f = await setup()
  await f.publisher.tick()
  const key = f.job.fileKey!
  await f.publisher.close()
  const path = join(f.temp, 'publications', key.replace(':', '-') + '.state.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  delete saved.draft.measured
  await writeFile(path, JSON.stringify(saved))
  f.store.data.ffprobe = available ? findProbe('') : join(f.temp, 'missing-ffprobe')
  const publisher = new WatchPublisher(f.store, f.connection, f.temp, () => {}, e => { throw e })
  disposers.push(() => publisher.close())
  await until(publisher, () => f.job.status === (available ? 'completed' : 'failed'))
  expect(f.job.fileKey).toBe(key)
  expect((await readFile(f.file)).length).toBe(f.job.signature.size)
  if (available) {
    const restored = JSON.parse(await readFile(path, 'utf8'))
    expect(restored.draft.measured.media).toMatchObject({ status: 'probed', width: 320, height: 180 })
    expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  } else {
    expect(f.job.error).toContain('检测媒体规格失败')
    expect(f.calls.filter(c => c.path === 'uploads/prepare')).toHaveLength(0)
  }
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

test.each(['retained', 'removed', 'symlink'] as const)('第二个本地目录可发布，清理仍检查当前目录归属和符号链接：%s', async kind => {
  let now = Date.now()
  const f = await setup({ retry: { now: () => now } })
  const original = f.root.path, primary = join(f.temp, 'primary')
  await mkdir(primary)
  f.root.path = primary; f.root.additionalPaths = [original]
  f.store.data.retention = { enabled: true, days: 1 }
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true && f.job.ed2kSaved === true)
  if (kind === 'removed') applyWatchEdit(f.store, f.root, { ...f.root, additionalPaths: [] })
  if (kind === 'symlink') { await rename(original, original + '-moved'); await symlink(original + '-moved', original) }
  now += 2 * 86400000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(kind !== 'retained')
  expect(f.job.retention?.state).toBe(kind === 'retained' ? 'deleted' : 'busy')
})

test('同一监控任务不同本地目录中的相同内容只发布一次', async () => {
  const f = await setup(), second = join(f.temp, 'second')
  await mkdir(second)
  const original = f.root.path
  f.root.path = second; f.root.additionalPaths = [original]
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true)
  const path = join(second, 'Copy.S01E01.mp4')
  await copyFile(f.file, path)
  const duplicate: WatchJob = { id: 'duplicate-second-directory', watchId: f.root.id, path, relativePath: 'Copy.S01E01.mp4',
    signature: await safeFile(second, path), episodeNumber: 1, status: 'queued', error: '', percent: 0,
    createdAt: f.job.createdAt, updatedAt: f.job.updatedAt }
  f.store.data.jobs.push(duplicate)
  await until(f.publisher, () => duplicate.status === 'duplicate')
  expect(duplicate.duplicateOf).toBe(f.job.id)
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

test('上传 502 详情落盘，重启后自动重建失效会话并沿用原文件和版本完成', async () => {
  let now = 100000, init = 0, unavailable = true, merged = 0, rejectFailures = true
  const options: NonNullable<Parameters<typeof setup>[0]>['retry'] = { now: () => now, baseMs: 100, factory: () => ({ close() {}, client: {
    async initMultipartUpload() { return { uploadId: `UPLOAD-${++init}` } as any },
    async listParts(_name, id) {
      expect(id).toBe('UPLOAD-1')
      throw Object.assign(new Error('expired secret'), { code: 'NoSuchUpload', status: 404 })
    },
    async uploadPart(_name, id, _number, buffer) {
      if (unavailable) throw Object.assign(new Error('SECRET https://private.invalid/?token=SECRET'), { code: 'ServiceUnavailable', status: 502, requestId: 'ABCDEF0123456789' })
      expect(id).toBe('UPLOAD-2')
      return { etag: createHash('md5').update(buffer).digest('hex') } as any
    },
    async completeMultipartUpload() { merged++; return { data: { state: true } } as any },
  } }) }
  const f = await setup({ diagnostics: true, retry: options, reply: (path, body) => {
    if (path === 'tasks/report' && body.stage === 'failed' && rejectFailures) return { status: 503 }
    if (path !== 'uploads/prepare') return undefined
    if (body.action === 'start') return { body: { dispatch: { status: 'uploading', bucket: 'bucket', object: 'original', pickCode: 'original', callback: '{}' } } }
    if (body.action === 'credentials') return { body: { credentials: { accessKeyId: 'fake', accessKeySecret: 'fake', securityToken: 'fake', expiration: new Date(Date.now() + 3600000).toISOString(), rate: 0 } } }
    return undefined
  } })
  await until(f.publisher, () => f.job.status === 'failed')
  const key = f.job.fileKey, release = structuredClone(f.job.release), signature = structuredClone(f.job.signature)
  const diagnostic = { stage: '上传第 1 片', partNumber: 1, code: 'ServiceUnavailable', httpStatus: 502, requestId: 'ABCDEF0123456789' }
  expect(f.job.error).toBe('上传第 1 片失败：存储服务暂不可用')
  expect(f.job.errorDetails).toEqual(diagnostic)
  await f.publisher.tick()
  expect(f.calls.some(c => c.path === 'tasks/report' && c.body.stage === 'failed')).toBe(true)
  expect(f.job.synced).toBe(false)
  expect(f.job.error).toBe('上传第 1 片失败：存储服务暂不可用')
  expect(f.job.errorDetails).toEqual(diagnostic)
  await f.publisher.close()
  const store = new WatchStore(f.store.path), job = store.data.jobs[0]
  expect(job.errorDetails).toEqual(diagnostic)
  const saved = await readFile(join(f.temp, 'publications', key!.replace(':', '-') + '.state.json'), 'utf8')
  expect(JSON.parse(saved).failure.diagnostic).toEqual(diagnostic)
  expect(saved).not.toContain('SECRET')
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, options)
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start(); unavailable = false; now = job.retry!.nextAt!
  await until(publisher, () => job.status === 'completed' && job.synced === true && job.ed2kSaved === true)
  expect(job.fileKey).toBe(key); expect(job.release).toEqual(release)
  expect(await safeFile(f.root.path, f.file)).toEqual(signature)
  expect(store.data.jobs).toHaveLength(1)
  expect(job.errorDetails).toBeUndefined(); expect(job.error).toBe('')
  expect(init).toBe(2); expect(merged).toBe(1)
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start').every(c => c.body.taskKey === key && c.body.directoryId === '42')).toBe(true)
  // 历史上报持续故障也不挡住恢复；成功后仍保留待补记录，重启补报原时间和序号。
  await publisher.close()
  const statePath = join(f.temp, 'publications', key!.replace(':', '-') + '.state.json')
  const pending = JSON.parse(await readFile(statePath, 'utf8')).pendingFailures
  expect(pending).toHaveLength(1)
  expect(pending[0].errorDetails).toMatchObject(diagnostic)
  expect(Number.isFinite(Date.parse(pending[0].errorDetails.occurredAt))).toBe(true)
  rejectFailures = false
  const recovered = new WatchStore(f.store.path)
  const replay = new WatchPublisher(recovered, f.connection, f.temp, () => {}, e => { throw e }, options)
  disposers.push(() => replay.close()); f.connection.validateFile = validateWatchedFile(recovered)
  replay.start(); await replay.tick()
  const reported = f.calls.filter(c => c.path === 'tasks/report' && c.body.stage === 'failed').at(-1)!.body
  expect(reported.errorDetails).toEqual(pending[0].errorDetails)
  expect(reported.sequence).toBe(pending[0].sequence)
  expect(JSON.parse(await readFile(statePath, 'utf8')).pendingFailures).toEqual([])
  expect(recovered.data.jobs[0].status).toBe('completed')
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
  await until(publisher, () => store.data.jobs.every(j => j.status === 'completed')).catch(error => { throw new Error(error.message + JSON.stringify(store.data.jobs.map(j => ({ id:j.id,status:j.status,error:j.error })))) })
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


/** 创建真实副本及独立任务，模拟升级前落盘的记录或后来发现的文件。 */
async function copyJob(f: Awaited<ReturnType<typeof setup>>, id: string, options: Partial<WatchJob> = {}, different = false): Promise<WatchJob> {
  const path = join(f.root.path, `${id}.S01E01.mp4`)
  await copyFile(f.file, path)
  if (different) await appendFile(path, 'different container metadata')
  const job: WatchJob = {
    id, watchId: f.root.id, path, relativePath: `${id}.S01E01.mp4`, signature: await safeFile(f.root.path, path),
    episodeNumber: 1, seasonNumber: 1, status: 'queued', error: '', percent: 0,
    createdAt: f.job.createdAt, updatedAt: f.job.updatedAt, ...options,
  }
  f.store.data.jobs.push(job)
  return job
}

test.each(['failed', 'paused', 'completed'] as const)('同集不同内容交给服务端裁定，本地 %s 记录不拦截', async status => {
  const winner = 'd'.repeat(32)
  const f = await setup({ check: () => status === 'completed' ? { status: 'existing', fileId: winner, ed2k: 'remote-winner-link' } : { status: 'missing' } })
  const old = await copyJob(f, 'old', {
    status, fileKey: 'gvs-f1:old', release: { id: f.root.releaseId, name: f.root.releaseName }, error: '历史任务',
  }, true)
  old.sha1 = createHash('sha1').update(await readFile(old.path)).digest('hex').toUpperCase()
  f.store.save()
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true)
  const check = f.calls.find(c => c.path === 'files/check')!.body
  expect(check).toMatchObject({ releaseId: f.root.releaseId, episodeNumber: 1, sha1: f.job.sha1 })
  expect(check.sha1).not.toBe(old.sha1)
  expect(f.calls.find(c => c.path === 'files/report')!.body).toMatchObject({ deduplicate: true, sha1: f.job.sha1 })
  expect(f.job.ed2k?.link).toBe((await ed2kFile(f.file)).link)
  if (status === 'completed') expect(f.job.duplicateOf).toBe(winner)
  expect(old.status).toBe(status)
})

test('同内容旧失败及重复链不占位，升级后被错误跳过的副本重新检查', async () => {
  const f = await setup()
  const old = await copyJob(f, 'old-failed', {
    status: 'failed', fileKey: 'gvs-f1:old', release: { id: f.root.releaseId, name: f.root.releaseName }, error: '上传失败',
  })
  old.sha1 = createHash('sha1').update(await readFile(old.path)).digest('hex').toUpperCase()
  const stale = await copyJob(f, 'stale-duplicate', { status: 'duplicate', sha1: old.sha1, duplicateOf: old.id })
  Object.assign(f.job, { status: 'duplicate', sha1: old.sha1, duplicateOf: stale.id, ed2kSaved: true,
    ed2k: { state: 'done', link: 'stale-link', pct: 100, message: '' }, error: '相同内容已有失败任务，请重试原任务' })
  f.store.save()
  await until(f.publisher, () => f.job.status === 'completed' && f.job.ed2kSaved === true && stale.status === 'duplicate')
  expect(old.status).toBe('failed')
  expect(f.job.fileKey).not.toBe(old.fileKey)
  expect(f.job.ed2k?.link).toBe((await ed2kFile(f.file)).link)
  expect(stale.duplicateOf).toBe(f.job.id)
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
})

test.each([false, true])('同内容副本等待原发布结果，原任务失败=%s 时也能收尾且不阻塞其他集', async fail => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await setup({ reply: async (path, body) => {
    if (path === 'uploads/prepare' && body.action === 'start' && body.taskKey === f.job.fileKey) {
      await gate
      if (fail) return { status: 409, body: { error: { code: 'UPLOAD_REJECTED', message: '原任务上传被拒绝' } } }
    }
  } })
  // 断言失败也要释放回环请求，避免关闭发布器时等在测试门闩上。
  disposers.push(async () => release())
  await f.publisher.tick()
  const copy = await copyJob(f, 'waiting-copy')
  await until(f.publisher, () => copy.duplicateOf === f.job.id)
  expect(copy.status).toBe('queued')
  expect(copy.fileKey).toBeUndefined()
  const next = await copyJob(f, 'next-episode', { episodeNumber: 2 })
  await until(f.publisher, () => !!next.fileKey)
  expect(copy.status).toBe('queued')
  release()
  await until(f.publisher, () => next.status === 'completed' && (fail ? copy.status === 'completed' : copy.status === 'duplicate'))
  expect(f.job.status).toBe(fail ? 'failed' : 'completed')
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(2)
  if (fail) expect(copy.fileKey).toBeDefined()
  else expect(copy.fileKey).toBeUndefined()
})

test('旧本地冲突失败重启后自动重查，保留版本和原任务身份', async () => {
  const f = await setup()
  Object.assign(f.job, { status: 'failed', error: '同一版本已有该集或电影的其他内容，请使用另一个版本绑定',
    release: { id: f.root.releaseId, name: f.root.releaseName } })
  f.store.save()
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e })
  disposers.push(() => publisher.close()); f.connection.validateFile = validateWatchedFile(store)
  publisher.start()
  await until(publisher, () => store.data.jobs[0].status === 'completed' && store.data.jobs[0].synced === true)
  expect(store.data.jobs[0].id).toBe(f.job.id)
  expect(store.data.jobs[0].release).toMatchObject({ id: f.root.releaseId })
  expect(new WatchStore(f.store.path).data.jobs[0].error).toBe('')
  expect(f.calls.filter(c => c.path === 'files/check')).toHaveLength(1)
})

test.each(['manual', 'directory', 'global', 'changed', 'cancelled', 'server'] as const)('旧冲突恢复尊重 %s 停止原因', async reason => {
  const f = await setup()
  f.job.status = reason === 'cancelled' ? 'cancelled' : 'failed'
  f.job.error = reason === 'server' ? '此版本的同一集或电影已有其他内容，请检查版本绑定' : '同一版本已有该集或电影的其他内容，请使用另一个版本绑定'
  if (reason === 'manual') f.job.manuallyPaused = true
  if (reason === 'directory') f.root.enabled = false
  if (reason === 'global') f.store.data.uploadsPaused = true
  if (reason === 'changed') f.job.changed = true
  const before = structuredClone(f.job)
  await f.publisher.tick(); await f.publisher.tick()
  expect(f.job).toEqual(before)
  expect(f.calls.some(c => c.path === 'files/check' || c.path === 'files/report')).toBe(false)
})

test('已有上传回执的失败任务不被相同内容历史记录截断，重试沿用原断点', async () => {
  let reject = true
  const f = await setup({ reply: path => path === 'files/report' && reject
    ? { status: 409, body: { error: { code: 'REPORT_REJECTED', message: '资源登记暂时拒绝' } } } : undefined })
  await until(f.publisher, () => f.job.status === 'failed')
  const key = f.job.fileKey
  await copyJob(f, 'completed-copy', {
    status: 'completed', fileKey: 'gvs-f1:other', sha1: f.job.sha1, release: structuredClone(f.job.release), synced: true,
  })
  f.job.status = 'queued'; reject = false
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true)
  expect(f.job.fileKey).toBe(key)
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(2)
})

test('电影不同内容仍遵守服务端冲突回执，后续 tick 不自动绕过', async () => {
  const f = await setup({ check: () => ({ status: 'conflict' }) })
  f.root.work.mediaType = 'movie'; delete f.root.seasonNumber
  await f.publisher.tick(); await f.publisher.tick()
  expect(f.calls.find(c => c.path === 'files/check')!.body.episodeNumber).toBeUndefined()
  expect(f.job.status).toBe('failed')
  expect(f.job.error).toBe('此版本的同一集或电影已有其他内容，请检查版本绑定')
  expect(f.calls.filter(c => c.path === 'files/check')).toHaveLength(1)
  expect(f.calls.some(c => c.path === 'uploads/prepare' || c.path === 'files/report')).toBe(false)
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


test('115 限流停止当前上传，不自动重试；已就绪响应不重复核验', async () => {
  let now = 100000
  const limited = await setup({ retry: { now: () => now }, reply: (path, body) => path === 'uploads/prepare' && body.action === 'start'
    ? { status: 502, body: { error: { code: 'CLOUD_ACCESS_LIMIT' } } } : undefined })
  await until(limited.publisher, () => limited.job.status === 'failed')
  expect(limited.job.retry).toBeUndefined()
  const count = limited.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start').length
  now += 3600000
  for (let i = 0; i < 5; i++) await limited.publisher.tick()
  expect(limited.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(count)
  const ready = await setup()
  await until(ready.publisher, () => ready.job.status === 'completed')
  expect(ready.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'verify')).toHaveLength(0)
})

test('可恢复失败最多自动重试八次，耗尽后仍保留失败状态', async () => {
  let now = 100000
  const f = await setup({ retry: { now: () => now, baseMs: 1, maxMs: 1 }, reply: path => path === 'files/check' ? { status: 503 } : undefined })
  for (let attempt = 1; attempt <= 9; attempt++) {
    await until(f.publisher, () => f.job.status === 'failed' && f.job.retry?.attempt === attempt)
    now += 10
  }
  expect(f.job.retry?.nextAt).toBeUndefined()
  expect(f.job.error).toContain('HTTP 503')
  expect(f.job.errorDetails).toMatchObject({ stage: '检查重复文件', httpStatus: 503 })
  const calls = f.calls.length
  now += 3600000
  for (let i = 0; i < 5; i++) await f.publisher.tick()
  expect(f.calls).toHaveLength(calls)
})

test('115 访问受限暂停账号队列，重启与自动重连不恢复，冷却后手动继续', async () => {
  let now = 100000, limited = true
  const f = await setup({
    retry: { now: () => now },
    reply: (path, body) => limited && path === 'uploads/prepare' && body.action === 'start'
      ? { status: 502, body: { error: { code: 'CLOUD_ACCESS_LIMIT' } } } : undefined,
  })
  const secondPath = join(f.root.path, 'Show.S01E02.mp4')
  await copyFile(f.file, secondPath)
  const second: WatchJob = { ...f.job, id: 'second-job', path: secondPath, relativePath: 'Show.S01E02.mp4', episodeNumber: 2, signature: await safeFile(f.root.path, secondPath) }
  f.store.data.jobs.push(second); f.store.save()
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.job.error).toContain('队列已暂停')
  expect(f.job.error).not.toContain('private')
  expect(f.job.retry).toBeUndefined()
  expect(f.publisher.worker.uploadPaused(f.root.binding)).toBe(true)
  const starts = () => f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start').length
  expect(starts()).toBe(1)
  for (let i = 0; i < 8; i++) await f.publisher.tick()
  expect(starts()).toBe(1)
  expect(() => f.publisher.worker.resumeAccount(f.root.binding)).toThrow('冷却')
  await f.publisher.close()
  const store = new WatchStore(f.store.path)
  f.connection.validateFile = validateWatchedFile(store)
  const publisher = new WatchPublisher(store, f.connection, f.temp, () => {}, e => { throw e }, { now: () => now })
  disposers.push(() => publisher.close()); publisher.start()
  now += 3600000
  publisher.resume()
  for (let i = 0; i < 8; i++) await publisher.tick()
  expect(publisher.worker.uploadPaused(f.root.binding)).toBe(true)
  expect(starts()).toBe(1)
  limited = false
  publisher.worker.resumeAccount(f.root.binding)
  // 用户明确恢复被暂停的两条任务；解除账号阻断本身不自动重放失败文件。
  for (const job of store.data.jobs) { job.status = 'queued'; delete job.retry }
  await until(publisher, () => store.data.jobs.every(j => j.status === 'completed'))
})

test('OSS SlowDown 进入有限退避，不暂停账号队列，等待后自动恢复', async () => {
  let now = 100000, limited = true, ossCalls = 0
  const f = await setup({
    retry: { now: () => now, baseMs: 1000, maxMs: 1000, factory: () => ({ close() {}, client: {
      async initMultipartUpload() { ossCalls++; throw Object.assign(new Error('private OSS response'), { code: 'SlowDown', status: 503 }) },
      async listParts() { throw new Error('unexpected list') },
      async uploadPart() { throw new Error('unexpected put') },
      async completeMultipartUpload() { throw new Error('unexpected complete') },
    } }) },
    reply: (path, body) => {
      if (!limited || path !== 'uploads/prepare') return undefined
      if (body.action === 'start') return { body: { dispatch: { status: 'uploading', bucket: 'bucket', object: 'object', pickCode: 'original', callback: '{}' } } }
      if (body.action === 'credentials') return { body: { credentials: { accessKeyId: 'fake', accessKeySecret: 'fake', securityToken: 'fake', expiration: new Date(Date.now() + 3600000).toISOString(), rate: 0 } } }
      return undefined
    },
  })
  await until(f.publisher, () => f.job.status === 'failed')
  expect(f.job.retry?.attempt).toBe(1)
  expect(f.job.retry?.nextAt).toBe(now + 1000)
  expect(f.publisher.worker.uploadPaused(f.root.binding)).toBe(false)
  expect(f.job.error).not.toContain('private')
  expect(ossCalls).toBe(1)
  for (let i = 0; i < 4; i++) await f.publisher.tick()
  expect(ossCalls).toBe(1)
  limited = false
  now += 1001
  await until(f.publisher, () => f.job.status === 'completed')
  expect(f.publisher.worker.uploadPaused(f.root.binding)).toBe(false)
})

test('准备期间账号被暂停，未登记任务保留排队状态，解除后继续而不滞留处理中', async () => {
  const f = await setup()
  const original = f.publisher.worker.uploadPaused.bind(f.publisher.worker)
  let pauseDuringPrepare = true
  // 模拟另一上传任务恰好在本文件探测期间触发同账号暂停。
  f.publisher.worker.uploadPaused = binding => (pauseDuringPrepare && f.job.status === 'preparing') || original(binding)
  await f.publisher.tick()
  expect(f.job.fileKey).toBeUndefined()
  expect(f.job.status).toBe('queued')
  expect(f.calls.some(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toBe(false)
  pauseDuringPrepare = false
  await until(f.publisher, () => f.job.status === 'completed')
})

test('历史候选已清理后自动重试同一任务，不需要移动文件或重建监控项', async () => {
  let starts = 0
  const f = await setup({ retry: { baseMs: 1, maxMs: 1 }, reply: (path, body) => {
    if (path === 'uploads/prepare' && body.action === 'start' && ++starts === 1) {
      return { status: 409, body: { error: { code: 'CLOUD_UPLOAD_REUSE_INVALID' } },
        headers: { 'x-plutofish-upload-stage': 'verify_reuse', 'x-plutofish-provider-code': '430004' } }
    }
  } })
  await until(f.publisher, () => f.job.status === 'completed' && f.job.synced === true)
  const requests = f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')
  expect(requests).toHaveLength(2)
  expect(new Set(requests.map(c => c.body.taskKey)).size).toBe(1)
  expect(new Set(requests.map(c => c.body.directoryId))).toEqual(new Set(['42']))
  expect(f.calls.filter(c => c.path === 'files/report')).toHaveLength(1)
  expect(existsSync(f.file)).toBe(true)
})

test('115 普通核验拒绝持久化具体原因并停止自动重试', async () => {
  const f = await setup({ retry: { baseMs: 1, maxMs: 1 }, reply: (path, body) => {
    if (path === 'uploads/prepare' && body.action === 'start') {
      return { status: 502, body: { error: { code: 'CLOUD_PROVIDER_REJECTED', message: 'PRIVATE-BODY' } },
        headers: { 'x-plutofish-upload-stage': 'verify_reuse', 'x-plutofish-provider-code': '400123' } }
    }
  } })
  await until(f.publisher, () => f.job.status === 'failed')
  for (let i = 0; i < 10; i++) await f.publisher.tick()
  expect(f.calls.filter(c => c.path === 'uploads/prepare' && c.body.action === 'start')).toHaveLength(1)
  expect(f.job.retry).toBeUndefined()
  const saved = new WatchStore(join(f.temp, 'state.json')).data.jobs[0]!
  expect(saved.errorDetails?.stage).toBe('核验历史文件')
  expect(saved.error).toContain('115 错误码：400123')
  expect(saved.error).not.toContain('PRIVATE')
  expect(f.calls.find(c => c.path === 'tasks/report' && c.body.stage === 'failed')?.body.errorDetails).toBeUndefined()
})

for (const cleanup of [false, true]) test(`一次性发布完成并同步 ED2K，独立目录清理 enabled=${cleanup}`, async () => {
  let now = Date.now()
  const f = await setup({ retry: { now: () => now } })
  const { createOneTimeBatch } = await import('../src/main/one-time')
  await writeFile(join(f.root.path, 'poster.nfo'), 'sidecar')
  f.root.mode = 'once'; f.root.cleanup = { enabled: cleanup, days: 3 }
  f.root.batch = await createOneTimeBatch(f.root.path, f.root.cleanup)
  f.store.data.retention = { enabled: true, days: 1 }; f.store.save()
  await until(f.publisher, () => f.root.batch!.completedAt !== undefined)
  expect(f.job.ed2kSaved).toBe(true); expect(f.job.ed2k?.state).toBe('done')
  expect(f.job.synced).toBe(true)
  now += 2 * 24 * 3600_000; await f.publisher.tick()
  expect(existsSync(f.file)).toBe(true) // 全局一天清理不能删除一次性文件。
  const due = f.root.batch!.deleteAt
  expect(due).toBe(cleanup ? f.root.batch!.completedAt! + 3 * 24 * 3600_000 : undefined)
  now += 2 * 24 * 3600_000; await f.publisher.tick()
  expect(existsSync(f.root.path)).toBe(!cleanup)
  if (cleanup) {
    now += 60_001
    await until(f.publisher, () => f.calls.some(c => c.path === 'range-proofs/forget'))
    expect(f.job.retention?.state).toBe('deleted')
    expect(f.job.status).toBe('completed'); expect(f.job.ed2k!.link).toContain('ed2k:')
  }
})
