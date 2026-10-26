/** 使用临时真实目录验证新增层级、稳定窗口、补扫、删除与重启，全部离线。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, realpath, rename, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from '../src/main/store'
import { DirectoryWatcher } from '../src/main/watcher'
import { episodeFromName } from '../src/main/files'
import { applyWatchEdit } from '../src/main/watch-edit'
import type { WatchRoot } from '../src/shared/model'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

export async function fixture(includeExisting = true) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'plutofish-watch-')))
  const rootPath = join(temp, 'media')
  await mkdir(rootPath)
  const store = new WatchStore(join(temp, 'state.json'))
  const root: WatchRoot = {
    id: 'watch-1', path: rootPath, title: '测试剧集', sourceAccountId: 'source-1',
    work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    releaseId: 'a'.repeat(32), releaseName: '1080p', directoryId: '0', directoryPath: '/',
    includeExisting, stableSeconds: 10, initialized: false, enabled: true, createdAt: new Date().toISOString(),
    binding: { url: 'http://127.0.0.1:1', publisherId: 'publisher-1', sourceAccount: { id: 'source-1', alias: 'main' } },
  }
  store.data.watches.push(root)
  let now = Date.now()
  const cancelled: string[] = []
  const watcher = new DirectoryWatcher(store, () => {}, async j => { cancelled.push(j.id) }, e => { throw e }, () => now)
  cleanups.push(() => rm(temp, { recursive: true, force: true }))
  cleanups.push(() => watcher.close())
  return { temp, rootPath, root, store, watcher, cancelled, advance: (ms: number) => { now += ms } }
}

test('新建多层目录、移入已有目录后持续监控，重复事件不重复入队', async () => {
  const f = await fixture()
  await f.watcher.scan()
  await mkdir(join(f.rootPath, 'new', 'Season 1'), { recursive: true })
  await writeFile(join(f.rootPath, 'new', 'Season 1', 'Show.S01E02.mkv'), 'video-one')
  const incoming = join(f.temp, 'incoming')
  await mkdir(incoming)
  await writeFile(join(incoming, 'EP03.mp4'), 'video-two')
  await rename(incoming, join(f.rootPath, 'imported'))
  await f.watcher.scan()
  expect(f.store.data.jobs.map(j => j.status)).toEqual(['waiting', 'waiting'])
  f.advance(10001)
  await f.watcher.scan()
  expect(f.store.data.jobs.map(j => j.episodeNumber).sort()).toEqual([2, 3])
  expect(f.store.data.jobs.every(j => j.status === 'queued')).toBe(true)
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(2)
})

test('持续写入重置稳定窗口，替换文件停止旧任务；移走文件也停止', async () => {
  const f = await fixture()
  const file = join(f.rootPath, 'E01.mp4')
  await writeFile(file, 'first')
  await f.watcher.scan()
  f.advance(9000)
  await writeFile(file, 'first-and-more')
  await f.watcher.scan()
  expect(f.cancelled).toHaveLength(1)
  f.advance(2000)
  await f.watcher.scan()
  expect(f.store.data.jobs.at(-1)?.status).toBe('waiting')
  f.advance(8001)
  await f.watcher.scan()
  expect(f.store.data.jobs.at(-1)?.status).toBe('queued')
  await rm(file)
  await f.watcher.scan()
  expect(f.store.data.jobs.every(j => j.status === 'cancelled')).toBe(true)
})

test('首次忽略已有文件，重启不重建基线，离线新增文件仍被发现', async () => {
  const f = await fixture(false)
  await writeFile(join(f.rootPath, 'E01.mp4'), 'old')
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(0)
  await f.watcher.close()
  await mkdir(join(f.rootPath, 'offline'))
  await writeFile(join(f.rootPath, 'offline', 'E02.mp4'), 'new')
  const restored = new WatchStore(f.store.path)
  let now = Date.now()
  const watcher = new DirectoryWatcher(restored, () => {}, async () => {}, e => { throw e }, () => now)
  cleanups.push(() => watcher.close())
  await watcher.scan()
  now += 10001
  await watcher.scan()
  expect(restored.data.jobs).toHaveLength(1)
  expect(restored.data.jobs[0].episodeNumber).toBe(2)
  expect(JSON.parse(await readFile(f.store.path, 'utf8')).watches[0].initialized).toBe(true)
})

test('目录失联保留队列与基线，恢复后发现新文件', async () => {
  const f = await fixture()
  await writeFile(join(f.rootPath, 'E01.mp4'), 'original')
  await f.watcher.scan()
  await rename(f.rootPath, f.rootPath + '-offline')
  await f.watcher.scan()
  expect(f.root.error).toContain('不可访问')
  expect(f.cancelled).toHaveLength(0)
  expect(f.store.data.jobs[0].status).toBe('waiting')
  await rename(f.rootPath + '-offline', f.rootPath)
  await writeFile(join(f.rootPath, 'E02.mp4'), 'after-reconnect')
  await f.watcher.scan()
  expect(f.root.error).toBe('')
  expect(f.store.data.jobs).toHaveLength(2)
})

test('临时文件、隐藏目录及越界符号链接不被上传，集号不明确进入待确认', async () => {
  const f = await fixture()
  await writeFile(join(f.rootPath, 'Title.2026.mp4'), 'review')
  await writeFile(join(f.rootPath, 'E02.part.mp4'), 'temporary')
  await mkdir(join(f.rootPath, '.hidden'))
  await writeFile(join(f.rootPath, '.hidden', 'E03.mp4'), 'hidden')
  await writeFile(join(f.temp, 'E04.mp4'), 'outside')
  await symlink(join(f.temp, 'E04.mp4'), join(f.rootPath, 'E04.mp4'))
  await symlink(f.temp, join(f.rootPath, 'loop'))
  await f.watcher.scan()
  f.advance(10001)
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(1)
  expect(f.store.data.jobs[0].status).toBe('review')
})

test('暂停监控期间不入队，恢复后补扫', async () => {
  const f = await fixture()
  await f.watcher.scan()
  f.root.enabled = false
  await writeFile(join(f.rootPath, 'E01.mp4'), 'content')
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(0)
  f.root.enabled = true
  await f.watcher.scan()
  f.advance(10001)
  await f.watcher.scan()
  expect(f.store.data.jobs[0].status).toBe('queued')
})

test('保守识别集号，季号错配与多集合并必须确认', () => {
  expect(episodeFromName('Show.S01E02.1080p.mkv', 1)).toBe(2)
  expect(episodeFromName('Season 1/第0集.mp4', 1)).toBe(0)
  expect(episodeFromName('EP007.mp4', 1)).toBe(7)
  for (const name of ['S02E01.mp4', 'Season 2/E01.mp4', 'S01E02E03.mkv', 'S01E02-E04.mkv', 'E02E03.mp4', 'Title.2026.mp4']) {
    expect(episodeFromName(name, 1)).toBeUndefined()
  }
})

test('损坏状态停止加载，不能默认为空队列', async () => {
  const f = await fixture()
  await writeFile(f.store.path, '{"schemaVersion":1}')
  expect(() => new WatchStore(f.store.path)).toThrow()
})


test('历史补传只入队首次忽略的文件，重复点击和重启不重复建任务', async () => {
  const f = await fixture(false)
  await mkdir(join(f.rootPath, 'history'))
  await writeFile(join(f.rootPath, 'history', 'S01E01.mp4'), 'old-one')
  await writeFile(join(f.rootPath, 'history', 'S01E02.mp4'), 'old-two')
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(0)
  expect(await f.watcher.backfill(f.root.id)).toBe(2)
  expect(f.store.data.jobs.every(j => j.status === 'waiting')).toBe(true)
  expect(await f.watcher.backfill(f.root.id)).toBe(0)
  f.advance(10001)
  await f.watcher.scan()
  expect(f.store.data.jobs.every(j => j.status === 'queued')).toBe(true)
  const restored = new WatchStore(f.store.path)
  expect(restored.data.jobs).toHaveLength(2)
  expect(Object.values(restored.data.observations[f.root.id]).every(o => !o.ignored)).toBe(true)
})

test('暂停或失联的目录不能补传旧观察记录', async () => {
  const f = await fixture(false)
  await writeFile(join(f.rootPath, 'E01.mp4'), 'old')
  await f.watcher.scan()
  f.root.enabled = false
  await expect(f.watcher.backfill(f.root.id)).rejects.toThrow('恢复目录监控')
  f.root.enabled = true
  await rename(f.rootPath, f.rootPath + '-offline')
  await expect(f.watcher.backfill(f.root.id)).rejects.toThrow('不可访问')
  expect(f.store.data.jobs).toHaveLength(0)
})

test('同一任务可扫描三个本地目录，集号相对各自根目录解析，失联不影响其他目录', async () => {
  const f = await fixture()
  const second = join(f.temp, 'Season 9', 'second'), third = join(f.temp, 'third')
  await mkdir(second, { recursive: true }); await mkdir(third)
  f.root.additionalPaths = [second, third]
  for (const dir of [f.rootPath, second, third]) await writeFile(join(dir, 'E01.mp4'), 'video')
  await f.watcher.scan(); f.advance(10001); await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(3)
  expect(f.store.data.jobs.every(j => j.status === 'queued' && j.episodeNumber === 1 && j.relativePath === 'E01.mp4')).toBe(true)
  const old = f.store.data.jobs.find(j => j.path.startsWith(second))!
  await rename(second, second + '-offline')
  await writeFile(join(third, 'E02.mp4'), 'new')
  await f.watcher.scan(); f.advance(10001); await f.watcher.scan()
  expect(f.root.error).toContain(second); expect(old.status).toBe('queued')
  expect(f.cancelled).toHaveLength(0)
  expect(f.store.data.jobs.find(j => j.episodeNumber === 2)?.status).toBe('queued')
  await rename(second + '-offline', second)
  await rm(join(third, 'E01.mp4')); await f.watcher.scan()
  expect(f.root.error).toBe(''); expect(old.status).toBe('queued')
  expect(f.cancelled).toHaveLength(1)
})

test('各目录首次基线独立持久化，部分失联后重启不会忽略可访问目录中的新文件', async () => {
  const f = await fixture(false), second = join(f.temp, 'offline')
  f.root.additionalPaths = [second]
  await writeFile(join(f.rootPath, 'E01.mp4'), 'old')
  await f.watcher.scan()
  expect(f.root.initialized).toBe(false)
  expect(f.root.initializedPaths).toEqual([f.rootPath])
  await f.watcher.close()
  await writeFile(join(f.rootPath, 'E02.mp4'), 'new-after-baseline')
  await mkdir(second); await writeFile(join(second, 'E03.mp4'), 'old-on-first-scan')
  const restored = new WatchStore(f.store.path)
  const watcher = new DirectoryWatcher(restored, () => {}, async () => {}, e => { throw e })
  cleanups.push(() => watcher.close())
  await watcher.scan()
  expect(restored.data.jobs.map(j => j.relativePath)).toEqual(['E02.mp4'])
  expect(restored.data.watches[0].initialized).toBe(true)
  expect(await watcher.backfill(f.root.id)).toBe(2)
  expect(await watcher.backfill(f.root.id)).toBe(0)
})

test('新增目录只初始化新路径，保留原目录队列和基线；暂停恢复后扫描所有目录', async () => {
  const f = await fixture(false), second = join(f.temp, 'second')
  await writeFile(join(f.rootPath, 'E01.mp4'), 'history')
  await f.watcher.scan()
  await writeFile(join(f.rootPath, 'E02.mp4'), 'new'); await f.watcher.scan()
  const pending = f.store.data.jobs[0]
  await mkdir(second); await writeFile(join(second, 'E03.mp4'), 'new-root-history')
  applyWatchEdit(f.store, f.root, { ...f.root, additionalPaths: [second], includeExisting: false })
  await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(1); expect(pending.status).toBe('waiting')
  f.root.enabled = false
  await writeFile(join(second, 'E04.mp4'), 'paused'); await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(1)
  f.root.enabled = true; await f.watcher.scan(); f.advance(10001); await f.watcher.scan()
  expect(f.store.data.jobs.map(j => j.episodeNumber)).toEqual([2, 4])
  expect(await f.watcher.backfill(f.root.id)).toBe(2)
})
