/** 仅使用临时目录和假时钟，覆盖整目录删除的边界及中断恢复。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, writeFile, appendFile, rm, symlink, rename } from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from '../src/main/store'
import { createOneTimeBatch, OneTimeBatches } from '../src/main/one-time'
import { DirectoryWatcher } from '../src/main/watcher'
import { defaultOneTimeRetention } from '../src/shared/retention'
import { useLocalFile } from '../vendor/publisher/src/lib/local-file-use'
import type { WatchRoot } from '../src/shared/model'
const DAY = 24 * 3600_000
const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

async function fixture(enabled = true, selected = false) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'watch-once-')))
  disposers.push(() => rm(temp, { recursive: true, force: true }))
  const directory = join(temp, 'media'), sub = join(directory, 'Season 1')
  await mkdir(sub, { recursive: true })
  const file = join(sub, 'Show.S01E01.mkv'), sidecar = join(selected ? sub : directory, '.metadata')
  await writeFile(file, 'offline video'); await writeFile(sidecar, 'offline sidecar')
  const selectedFiles = selected ? [file, join(sub, 'Show.S01E02.mkv')] : undefined
  if (selectedFiles) await writeFile(selectedFiles[1], 'second video')
  const path = selected ? sub : directory
  const cleanup = { enabled, days: 3 }
  const root: WatchRoot = { mode: 'once', selectedFiles, cleanup, batch: await createOneTimeBatch(path, cleanup, selectedFiles),
    id: 'once', path, title: 'Once', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    sourceAccountId: 's', releaseId: 'a'.repeat(32), releaseName: '1080p', directoryId: '0', directoryPath: '/', includeExisting: true,
    stableSeconds: 10, enabled: true, initialized: false, createdAt: new Date().toISOString(),
    binding: { url: 'http://127.0.0.1:1', publisherId: 'p', sourceAccount: { id: 's', alias: 's' } } }
  const store = new WatchStore(join(temp, 'state.json')); store.data.watches.push(root)
  let now = Date.now()
  const watcher = new DirectoryWatcher(store, () => {}, async () => {}, error => { throw error }, () => now)
  disposers.push(() => watcher.close())
  await watcher.scan()
  now += 10_001; await watcher.scan()
  const manager = new OneTimeBatches(store, () => {}, r => r.enabled && !store.data.uploadsPaused, () => now)
  const complete = () => { for (const j of store.data.jobs) Object.assign(j, { status: 'completed', sha1: 'A'.repeat(40), synced: true, ed2kSaved: true,
    ed2k: { state: 'done', pct: 1, link: 'ed2k://|file|fixture|13|0123456789abcdef0123456789abcdef|/' } }) }
  return { temp, root, file, sidecar, store, watcher, manager, complete, now: () => now, advance: (ms: number) => { now += ms } }
}

test('一次性只入队初始视频，补扫和重启均不增加后来文件', async () => {
  const f = await fixture(false)
  expect(defaultOneTimeRetention()).toEqual({ enabled: false, days: 1 })
  await writeFile(join(f.root.path, 'Show.S01E02.mkv'), 'later')
  await f.watcher.scan(); expect(f.store.data.jobs).toHaveLength(1)
  await expect(f.watcher.backfill(f.root.id)).rejects.toThrow('一次性')
  const restored = new WatchStore(f.store.path)
  const watcher = new DirectoryWatcher(restored, () => {}, async () => {}, error => { throw error })
  disposers.push(() => watcher.close()); await watcher.scan()
  expect(restored.data.jobs).toHaveLength(1)
  expect(restored.data.jobs[0].path).toBe(f.file)
  expect(restored.data.jobs[0].status).toBe('queued')
})

test('所有上传、状态和 ED2K 同步完成才计时，三天未到不删，到期删除目录和附属文件', async () => {
  const f = await fixture()
  const job = f.store.data.jobs[0]
  for (const partial of [{ status: 'failed' }, { status: 'completed', synced: false }, { synced: true, ed2kSaved: false }, { ed2kSaved: true }]) {
    Object.assign(job, partial); f.manager.tick(); expect(f.root.batch!.completedAt).toBeUndefined()
  }
  f.complete(); f.manager.tick()
  expect(f.root.batch!.deleteAt).toBe(f.now() + 3 * DAY)
  f.advance(3 * DAY - 1); f.manager.tick(); expect(existsSync(f.file)).toBe(true)
  f.advance(60_001); f.manager.tick()
  expect(existsSync(f.root.path)).toBe(false)
  expect(f.root.batch!.deletedAt).toBe(f.now())
  expect(job.status).toBe('completed'); expect(job.ed2k!.link).toContain('ed2k:')
  expect(new WatchStore(f.store.path).data.watches[0].batch!.deletedAt).toBe(f.now())
})

test('倒计时落盘，重启不重新计时，暂停和关闭删除均阻止清理', async () => {
  const f = await fixture(); f.complete(); f.manager.tick()
  const due = f.root.batch!.deleteAt!
  const store = new WatchStore(f.store.path), root = store.data.watches[0]
  const batches = new OneTimeBatches(store, () => {}, r => r.enabled && !store.data.uploadsPaused, f.now)
  f.advance(4 * DAY); store.data.uploadsPaused = true; batches.tick()
  expect(root.batch!.deleteAt).toBe(due); expect(existsSync(f.file)).toBe(true)
  store.data.uploadsPaused = false; root.enabled = false; f.advance(60_001); batches.tick()
  expect(existsSync(f.file)).toBe(true)
  root.enabled = true; root.cleanup!.enabled = false; f.advance(60_001); batches.tick()
  expect(existsSync(f.file)).toBe(true)
  root.cleanup!.enabled = true; f.advance(60_001); batches.tick(); expect(existsSync(root.path)).toBe(false)
})

for (const kind of ['new', 'changed', 'missing', 'symlink', 'replaced'] as const) test(`目录 ${kind} 时整批保留，不递归误删`, async () => {
  const f = await fixture(); f.complete(); f.manager.tick()
  const outside = join(f.temp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'protected')
  if (kind === 'new') await writeFile(join(f.root.path, '.new'), 'keep')
  if (kind === 'changed') await appendFile(f.sidecar, 'new data')
  if (kind === 'missing') await rm(f.sidecar)
  if (kind === 'symlink') await symlink(outside, join(f.root.path, 'linked'))
  if (kind === 'replaced') { await rename(f.root.path, join(f.temp, 'old')); await mkdir(f.root.path); await writeFile(join(f.root.path, 'keep'), 'replacement') }
  f.advance(4 * DAY); f.manager.tick()
  expect(f.root.batch!.deletedAt).toBeUndefined(); expect(f.root.batch!.cleanupError).toBeTruthy()
  expect(existsSync(f.root.path)).toBe(true); expect(existsSync(join(outside, 'keep'))).toBe(true)
  if (kind !== 'replaced') expect(existsSync(f.file)).toBe(true)
})

test('本地片段校验持有读取租约时暂缓整个目录的清理，释放后继续', async () => {
  const f = await fixture(); f.complete(); f.manager.tick(); f.advance(4 * DAY)
  const release = useLocalFile(f.file)
  try { f.manager.tick(); expect(existsSync(f.file)).toBe(true); expect(existsSync(f.sidecar)).toBe(true) }
  finally { release() }
  expect(f.root.batch!.cleanupError).toBeUndefined()
  f.advance(60_001); f.manager.tick(); expect(existsSync(f.root.path)).toBe(false)
})

test('一次性选择保留不受全局文件清理设置影响', async () => {
  const f = await fixture(false); f.store.data.retention = { enabled: true, days: 1 }; f.complete(); f.manager.tick()
  expect(f.root.batch!.completedAt).toBeDefined(); expect(f.root.batch!.deleteAt).toBeUndefined()
  f.advance(30 * DAY); f.manager.tick(); expect(existsSync(f.file)).toBe(true)
})

test('删除中断后只清理清单中剩余的原文件', async () => {
  const f = await fixture(); f.complete(); f.manager.tick(); f.advance(4 * DAY)
  f.root.batch!.deletingAt = f.now(); f.store.save(); unlinkSync(f.sidecar)
  const restored = new WatchStore(f.store.path)
  new OneTimeBatches(restored, () => {}, () => true, f.now).tick()
  expect(existsSync(f.root.path)).toBe(false); expect(restored.data.watches[0].batch!.deletedAt).toBe(f.now())
})

test('空目录拒绝创建；含链接的目录不能授权整目录删除', async () => {
  const f = await fixture(false), empty = join(f.temp, 'empty'); await mkdir(empty)
  await expect(createOneTimeBatch(empty, defaultOneTimeRetention())).rejects.toThrow('没有可上传')
  await symlink(empty, join(f.root.path, 'link'))
  await expect(createOneTimeBatch(f.root.path, { enabled: true, days: 3 })).rejects.toThrow('链接')
  expect((await createOneTimeBatch(f.root.path, defaultOneTimeRetention())).files).toHaveLength(1)
})

test('损坏的清单或提前的删除时间不能通过重启验证', async () => {
  const f = await fixture(); f.complete(); f.manager.tick()
  const data = structuredClone(f.store.data)
  for (const mutate of [
    () => { f.root.batch!.files = [join(f.temp, 'outside.mkv')] },
    () => { f.root.batch!.deleteAt = f.root.batch!.completedAt! + DAY },
    () => { f.root.batch!.entries![1].path = '../outside' },
  ]) {
    Object.assign(f.root, structuredClone(data.watches[0])); mutate(); f.store.save()
    expect(() => new WatchStore(f.store.path)).toThrow()
  }
})

test('目录临时失联保留待上传任务，路径恢复后继续', async () => {
  const f = await fixture(false), moved = join(f.temp, 'unmounted')
  await rename(f.root.path, moved); await f.watcher.scan()
  expect(f.store.data.jobs[0].status).toBe('queued'); expect(f.root.error).toBeTruthy()
  await rename(moved, f.root.path); await f.watcher.scan()
  expect(f.store.data.jobs).toHaveLength(1); expect(f.root.error).toBe('')
})

test('重复文件必须等原任务的上传与 ED2K 均同步，跨批次引用不会提前删除', async () => {
  const f = await fixture(), job = f.store.data.jobs[0]
  f.complete()
  const original = { ...structuredClone(job), id: 'original', watchId: 'another', ed2kSaved: false }
  f.store.data.jobs.push(original); job.status = 'duplicate'; job.duplicateOf = original.id
  job.ed2k = undefined; job.ed2kSaved = false
  f.manager.tick(); expect(f.root.batch!.completedAt).toBeUndefined()
  original.ed2kSaved = true; f.manager.tick(); expect(f.root.batch!.completedAt).toBeDefined()
  expect(job.ed2k).toEqual(original.ed2k); expect(job.ed2kSaved).toBe(true)
  f.advance(4 * DAY); f.manager.tick(); expect(existsSync(f.root.path)).toBe(false)
})


test('文件选择只入队所选视频，重启和新增同目录视频不扩大清单', async () => {
  const f = await fixture(false, true)
  await writeFile(join(f.root.path, 'Show.S01E03.mkv'), 'unselected')
  await f.watcher.scan()
  const restored = new WatchStore(f.store.path)
  const watcher = new DirectoryWatcher(restored, () => {}, async () => {}, error => { throw error })
  disposers.push(() => watcher.close()); await watcher.scan()
  expect(restored.data.jobs.map(j => j.path)).toEqual(f.root.selectedFiles!)
  expect(restored.data.watches[0].selectedFiles).toEqual(f.root.selectedFiles!)
  f.complete(); f.manager.tick(); f.advance(30 * DAY); f.manager.tick()
  expect(existsSync(f.file)).toBe(true)
})

test('所选文件清理等待读取租约，到期只删已选文件，保留目录、未选视频和附属文件', async () => {
  const f = await fixture(true, true), sibling = join(f.root.path, 'Show.S01E03.mkv')
  await writeFile(sibling, 'keep'); f.complete(); f.manager.tick(); f.advance(4 * DAY)
  const release = useLocalFile(f.root.selectedFiles![1])
  try { f.manager.tick(); expect(f.root.selectedFiles!.every(existsSync)).toBe(true) }
  finally { release() }
  f.advance(60_001); f.manager.tick()
  expect(f.root.selectedFiles!.some(existsSync)).toBe(false)
  for (const path of [f.root.path, f.sidecar, sibling]) expect(existsSync(path)).toBe(true)
  expect(new WatchStore(f.store.path).data.watches[0].batch!.deletedAt).toBe(f.now())
})

for (const kind of ['changed', 'symlink', 'missing'] as const) test(`所选文件 ${kind} 时停止整批清理`, async () => {
  const f = await fixture(true, true); f.complete(); f.manager.tick()
  const second = f.root.selectedFiles![1]
  if (kind === 'changed') await appendFile(second, 'changed')
  else { await rm(second); if (kind === 'symlink') await symlink(f.sidecar, second) }
  f.advance(4 * DAY); f.manager.tick()
  expect(f.root.batch!.cleanupError).toBeTruthy(); expect(existsSync(f.file)).toBe(true)
  expect(existsSync(f.sidecar)).toBe(true)
})

test('文件清理中断后恢复只删除剩余已选文件', async () => {
  const f = await fixture(true, true); f.complete(); f.manager.tick(); f.advance(4 * DAY)
  f.root.batch!.deletingAt = f.now(); f.store.save(); unlinkSync(f.file)
  const restored = new WatchStore(f.store.path)
  new OneTimeBatches(restored, () => {}, () => true, f.now).tick()
  expect(restored.data.watches[0].batch!.deletedAt).toBe(f.now())
  expect(existsSync(f.root.selectedFiles![1])).toBe(false); expect(existsSync(f.sidecar)).toBe(true)
})

test('拒绝空文件选择、非视频、临时文件、链接和跨目录；损坏清单不能扩大删除范围', async () => {
  const f = await fixture(true, true), partial = join(f.root.path, 'Show.part.mkv'), empty = join(f.root.path, 'empty.mp4')
  const linked = join(f.root.path, 'link.mkv')
  await writeFile(partial, 'partial'); await writeFile(empty, ''); await symlink(f.file, linked)
  for (const files of [[], [f.sidecar], [partial], [empty], [linked], [f.file, join(f.temp, 'outside.mp4')]]) {
    await expect(createOneTimeBatch(f.root.path, f.root.cleanup!, files)).rejects.toThrow()
  }
  const original = structuredClone(f.root)
  for (const mutate of [
    () => { f.root.selectedFiles = [] },
    () => { f.root.batch!.files.push(join(f.root.path, 'outside.mkv')) },
    () => { f.root.batch!.entries![0].path = '.metadata' },
    () => { f.root.batch!.entries![0].path = ''; f.root.batch!.entries![0].kind = 'directory' },
    () => { delete f.root.selectedFiles },
  ]) {
    Object.assign(f.root, structuredClone(original)); mutate(); f.store.save()
    expect(() => new WatchStore(f.store.path)).toThrow()
  }
})
