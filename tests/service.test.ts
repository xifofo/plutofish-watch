/** 主进程服务回归：临时目录、模拟系统加密与本机 HTTP，验证编辑与恢复的完整调用链。 */
import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, realpath, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createServer } from 'node:http'

mock.module('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
  getSelectedStorageBackend: () => 'test-keyring',
} }))
const { WatchService } = await import('../src/main/service')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function setup() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'watch-service-')))
  cleanup.push(() => rm(temp, { recursive: true, force: true }))
  const media = join(temp, 'media'); await mkdir(media)
  const file = join(media, 'Show.S01E01.mp4'); await writeFile(file, 'offline fixture')
  const calls: string[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}, route = req.url!.replace('/api/v1/publisher/', '')
    calls.push(route)
    const result = route === 'me' ? { id: 'p', name: '离线服务测试', kind: 'publisher',
      sourceAccount: { id: 's', alias: 'source', name: 'Source', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
      : route === 'releases/query' ? { items: [], total: 0, page: body.page, pageSize: 100 } : null
    res.writeHead(result ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const service = new WatchService(join(temp, 'app'), () => {})
  cleanup.push(() => service.close())
  const port = (server.address() as { port: number }).port
  await service.connect({ url: `http://127.0.0.1:${port}`, key: 'offline-only' })
  await service.add({ path: media, title: '原作品', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    sourceAccountId: 's', versionMode: 'auto', releaseId: '', directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 10 })
  const root = service.store.data.watches[0], job = service.store.data.jobs[0]
  const observation = () => service.store.data.observations[root.id][file]
  return { service, root, job, observation, calls, temp }
}

test('延长稳定等待时间后，已排队但尚未发布的文件重新检查稳定窗口', async () => {
  const { service, root, job, observation } = await setup()
  observation().stableSince = Date.now() - 20_000
  await service.watcher.scanOne(root)
  expect(job.status).toBe('queued')
  await service.updateWatch({ id: root.id, watch: { ...root, stableSeconds: 3600 } })
  expect(job.status).toBe('waiting')
  expect(root.enabled).toBe(true)
})

test('暂停任务修改季号后，继续可进入集号确认，不会卡在无输入框的暂停状态', async () => {
  const { service, root, job, observation } = await setup()
  await service.job({ id: job.id, action: 'pause' })
  await service.updateWatch({ id: root.id, watch: { ...root, seasonNumber: 2 } })
  expect(job.status).toBe('paused'); expect(job.manuallyPaused).toBe(true)
  expect(job.episodeNumber).toBeUndefined()
  observation().stableSince = Date.now() - 20_000
  await service.job({ id: job.id, action: 'resume' })
  expect(job.status).toBe('review')
  await service.job({ id: job.id, action: 'confirm', episodeNumber: 4 })
  expect(job.status).toBe('queued'); expect(job.episodeNumber).toBe(4)
})

test('暂停尚未稳定的文件后继续，不能绕过稳定等待', async () => {
  const { service, job } = await setup()
  await service.job({ id: job.id, action: 'pause' })
  await service.job({ id: job.id, action: 'resume' })
  expect(job.status).toBe('waiting')
  expect(job.manuallyPaused).toBe(false)
})

test('等待来源确认的任务暂停再继续，仍显示原确认表单', async () => {
  const { service, job, observation } = await setup()
  observation().stableSince = Date.now() - 20_000
  job.status = 'review'; job.episodeNumber = 1
  job.versionReview = { sourceRequired: true, reason: '请确认来源', detected: '1080p', choices: [] }
  await service.job({ id: job.id, action: 'pause' })
  await service.job({ id: job.id, action: 'resume' })
  expect(job.status).toBe('review'); expect(job.error).toBe('请确认来源')
})

test('已登记任务不能在继续时更改集号', async () => {
  const { service, job } = await setup()
  job.status = 'paused'; job.fileKey = 'registered'; job.episodeNumber = 1
  await expect(service.job({ id: job.id, action: 'confirm', episodeNumber: 2 })).rejects.toThrow('已登记任务不能修改集号')
  expect(job.episodeNumber).toBe(1); expect(job.status).toBe('paused')
})

test('界面先完成连接后，启动检测结束不能再次验证并打断用户请求', async () => {
  const { service, calls } = await setup()
  expect(calls.filter(p => p === 'me')).toHaveLength(1)
  await service.start()
  expect(calls.filter(p => p === 'me')).toHaveLength(1)
  expect(service.snapshot().connection.status).toBe('verified')
})

test('一个监控任务支持超过两个目录，保存恢复并拒绝重复、嵌套、数据目录和空路径', async () => {
  const { service, root, job, temp } = await setup()
  const paths = [join(temp, 'second'), join(temp, 'third'), join(temp, 'fourth')]
  for (const [index, path] of paths.entries()) { await mkdir(path); await writeFile(join(path, `E0${index + 2}.mp4`), 'offline fixture') }
  await service.updateWatch({ id: root.id, watch: { ...root, additionalPaths: paths } })
  expect(root.additionalPaths).toEqual(paths)
  expect(service.store.data.jobs).toHaveLength(4)
  expect(service.store.data.jobs[0].id).toBe(job.id)
  for (const additionalPaths of [[root.path], [paths[0], paths[0]], [temp], [join(temp, 'app')], [''], 'invalid', [1]]) {
    await expect(service.updateWatch({ id: root.id, watch: { ...root, additionalPaths } as never })).rejects.toThrow()
    expect(root.additionalPaths).toEqual(paths)
  }
  await expect(service.add({ ...root, path: paths[0], additionalPaths: [] })).rejects.toThrow('监控目录不能重复')
  // 删除第一个目录后，原第二个目录成为首个；原第一目录的未开始任务取消，其他任务保留。
  await service.updateWatch({ id: root.id, watch: { ...root, path: paths[0], additionalPaths: paths.slice(1) } })
  expect(job.status).toBe('cancelled')
  expect(service.store.data.jobs.slice(1).every(j => j.status === 'waiting')).toBe(true)
})

test('固定版本的剧集目录首次未补传时，按 PlutoFish 已就绪集号只补版本里缺的集', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'watch-history-')))
  cleanup.push(() => rm(temp, { recursive: true, force: true }))
  const media = join(temp, 'media'); await mkdir(media)
  for (const n of [1, 2, 3, 4, 5]) await writeFile(join(media, `Show.S01E0${n}.mp4`), `episode ${n}`)
  await writeFile(join(media, 'Show.S01E00.mp4'), 'special before the version starts')
  const extra = join(temp, 'Season 9', 'extra'); await mkdir(extra, { recursive: true })
  await rename(join(media, 'Show.S01E04.mp4'), join(extra, 'Show.S01E04.mp4'))
  const release = { id: 'a'.repeat(32), name: 'S01.1080p.TX.WEB-DL.HEVC', resolution: '1080p', dynamicRange: 'SDR', status: 'published', latestEpisode: 5, episodes: [1, 2, 3, 5] }
  let queries = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}, route = req.url!.replace('/api/v1/publisher/', '')
    if (route === 'releases/query') queries++
    const result = route === 'me' ? { id: 'p', name: '离线服务测试', kind: 'publisher',
      sourceAccount: { id: 's', alias: 'source', name: 'Source', provider: '115' }, categories: [{ value: 'tv', label: '剧集' }] }
      : route === 'releases/query' ? { items: [release], total: 1, page: body.page, pageSize: 100 } : null
    res.writeHead(result ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const service = new WatchService(join(temp, 'app'), () => {})
  cleanup.push(() => service.close())
  await service.connect({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, key: 'offline-only' })
  await service.add({ path: media, additionalPaths: [extra], title: '尚公主', work: { mediaType: 'tv', tmdbId: '286171', category: 'tv' }, seasonNumber: 1,
    sourceAccountId: 's', versionMode: 'fixed', releaseId: release.id, directoryId: '0', directoryPath: '/', includeExisting: false, stableSeconds: 10 })
  expect(service.store.data.jobs).toHaveLength(0)
  const now = Date.now()
  expect(await service.syncHistory(now)).toBe(1)
  expect(service.store.data.jobs.map(j => j.relativePath)).toEqual(['Show.S01E04.mp4'])
  expect(service.store.data.jobs[0].path).toBe(join(extra, 'Show.S01E04.mp4'))
  const root = service.store.data.watches[0]!
  const ignored = Object.entries(service.store.data.observations[root.id]!).filter(([, o]) => o.ignored).map(([path]) => relative(media, path)).sort()
  expect(ignored).toEqual(['Show.S01E00.mp4', 'Show.S01E01.mp4', 'Show.S01E02.mp4', 'Show.S01E03.mp4', 'Show.S01E05.mp4'])
  // 6 小时内不重复查询；到点再查也不会重复建任务
  const before = queries
  expect(await service.syncHistory(now + 60_000)).toBe(0)
  expect(queries).toBe(before)
  expect(await service.syncHistory(now + 6 * 3600_000)).toBe(0)
  expect([queries, service.store.data.jobs.length]).toEqual([before + 1, 1])
})

test('一次性任务通过服务创建，默认保留一天且不自动删除，配置固定并可取消清理', async () => {
  const { service, root, temp } = await setup()
  const media = join(temp, 'once'); await mkdir(media); await writeFile(join(media, 'Show.S01E01.mp4'), 'once')
  await service.add({ ...root, path: media, mode: 'once', includeExisting: false })
  const once = service.store.data.watches.find(w => w.mode === 'once')!
  expect(once.cleanup).toEqual({ enabled: false, days: 1 }); expect(once.includeExisting).toBe(true)
  expect(once.batch!.files).toHaveLength(1)
  expect(service.store.data.jobs.filter(j => j.watchId === once.id)).toHaveLength(1)
  await expect(service.updateWatch({ id: once.id, watch: once })).rejects.toThrow('已固定')
  await expect(service.updateWatch({ id: root.id, watch: { ...root, mode: 'once' } })).rejects.toThrow('已固定')
  await service.removeWatch(once.id)
  await service.add({ ...root, path: media, mode: 'once', cleanup: { enabled: true, days: 5 } })
  const next = service.store.data.watches.find(w => w.mode === 'once')!
  expect(next.cleanup).toEqual({ enabled: true, days: 5 })
  expect(next.batch!.entries?.length).toBe(2)
  await service.cancelCleanup(next.id)
  expect(next.cleanup!.enabled).toBe(false); expect(next.batch!.deleteAt).toBeUndefined()
  await expect(service.add({ ...root, path: media, mode: 'once', cleanup: { enabled: true, days: 0 } })).rejects.toThrow('保留天数')
})


test('一次性文件任务允许同目录不同文件，拒绝重复、监控范围和整目录清理冲突', async () => {
  const { service, root, job, temp } = await setup()
  const path = join(temp, 'selected'); await mkdir(path)
  const files = [1, 2, 3].map(n => join(path, `Show.S01E0${n}.mp4`))
  for (const file of files) await writeFile(file, 'selected fixture')
  await service.add({ ...root, mode: 'once', path, selectedFiles: files.slice(0, 2), cleanup: { enabled: true, days: 1 } })
  const once = service.store.data.watches.at(-1)!
  expect(once.batch!.files).toEqual(files.slice(0, 2))
  expect(service.store.data.jobs.filter(j => j.watchId === once.id).map(j => j.path)).toEqual(files.slice(0, 2))
  await service.add({ ...root, mode: 'once', path, selectedFiles: [files[2]] })
  for (const input of [
    { ...root, mode: 'once' as const, path, selectedFiles: [files[0]] },
    { ...root, mode: 'once' as const, selectedFiles: [job.path] },
    { ...root, mode: 'once' as const, path, cleanup: { enabled: true, days: 1 } },
  ]) await expect(service.add(input)).rejects.toThrow('重叠')
  await expect(service.add({ ...root, mode: 'once', path, selectedFiles: [job.path] })).rejects.toThrow('不属于')
  await expect(service.add({ ...root, path, selectedFiles: [files[0]] })).rejects.toThrow('一次性上传文件')
  // 旧目录批次固定清单之外的新文件可以另建任务。
  await service.removeWatch(once.id)
  await service.removeWatch(service.store.data.watches.at(-1)!.id)
  await service.add({ ...root, mode: 'once', path })
  const later = join(path, 'Show.S01E04.mp4'); await writeFile(later, 'later')
  await service.add({ ...root, mode: 'once', path, selectedFiles: [later] })
  expect(service.store.data.watches.at(-1)!.batch!.files).toEqual([later])
})
