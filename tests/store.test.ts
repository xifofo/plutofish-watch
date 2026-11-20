/** 仅使用临时目录验证掉电损坏、备份恢复与写入失败，不读取正式运行数据。 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicJSON, WatchStore } from '../src/main/store'
import type { WatchRoot } from '../src/shared/model'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'plutofish-durable-store-'))
  directories.push(directory)
  const path = join(directory, 'watch-state.json')
  const store = new WatchStore(path)
  const root: WatchRoot = {
    id: 'watch-1', path: join(directory, 'media'), title: '本地测试', sourceAccountId: 'source',
    work: { mediaType: 'tv', tmdbId: '1', category: 'tv' }, seasonNumber: 1,
    releaseId: 'release-1', releaseName: '1080p', directoryId: '0', directoryPath: '/',
    includeExisting: false, stableSeconds: 10, initialized: true, enabled: true, createdAt: '2026-01-01T00:00:00Z',
    binding: { url: 'http://127.0.0.1:1', publisherId: 'publisher', sourceAccount: { id: 'source', alias: 'offline' } },
  }
  store.data.watches.push(root)
  store.data.jobs.push({
    id: 'job-1', watchId: root.id, path: join(root.path, 'E01.mp4'), relativePath: 'E01.mp4',
    signature: { size: 123, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }, status: 'completed',
    percent: 100, error: '', createdAt: root.createdAt, updatedAt: root.createdAt,
  })
  store.data.observations[root.id] = {
    [store.data.jobs[0].path]: { signature: store.data.jobs[0].signature, stableSince: 1, jobId: 'job-1' },
  }
  return { directory, path, store }
}

test('首次保存即有有效备份，后续备份保持上一份成功的任务记录', () => {
  const { path, store } = fixture()
  store.save()
  const original = fs.readFileSync(path)
  expect(fs.readFileSync(`${path}.bak`)).toEqual(original)
  store.data.watches[0].title = '修改后'
  store.save()
  expect(fs.readFileSync(`${path}.bak`)).toEqual(original)
  const restored = new WatchStore(path)
  expect(restored.data.watches[0].title).toBe('修改后')
  expect(restored.data.watches[0].enabled).toBe(true)
  expect(restored.recovery).toBeUndefined()
})

test('全零主文件从有效备份恢复，保留损坏原始字节且停止所有监控和上传', () => {
  const { path, store } = fixture()
  store.save()
  const backup = fs.readFileSync(`${path}.bak`)
  const corrupt = Buffer.alloc(784481)
  fs.writeFileSync(path, corrupt)
  const restored = new WatchStore(path)
  expect(restored.data.watches).toHaveLength(1)
  expect(restored.data.jobs).toEqual(store.data.jobs)
  expect(restored.data.observations).toEqual(store.data.observations)
  expect(restored.data.uploadsPaused).toBe(true)
  expect(restored.data.watches.every(root => !root.enabled)).toBe(true)
  expect(restored.recovery?.backupPath).toBe(`${path}.bak`)
  expect(fs.readFileSync(restored.recovery!.preservedPath!)).toEqual(corrupt)
  expect(fs.readFileSync(`${path}.bak`)).toEqual(backup)
  const nextStart = new WatchStore(path)
  expect(nextStart.recovery).toBeUndefined()
  expect(nextStart.data.uploadsPaused).toBe(true)
  expect(nextStart.data.watches[0].enabled).toBe(false)
})

test('主文件缺失时优先恢复备份，不能初始化空任务列表', () => {
  const { path, store } = fixture()
  store.save()
  fs.unlinkSync(path)
  const restored = new WatchStore(path)
  expect(restored.data.jobs).toEqual(store.data.jobs)
  expect(restored.data.uploadsPaused).toBe(true)
  expect(restored.data.watches[0].enabled).toBe(false)
  expect(restored.recovery?.preservedPath).toBeUndefined()
})

test('主文件和备份均损坏时停止，不能覆盖任一原件', () => {
  const { directory, path, store } = fixture()
  store.save()
  const corrupt = Buffer.alloc(500)
  fs.writeFileSync(path, corrupt)
  for (const backup of ['{', JSON.stringify({ ...store.data, watches: [null] }),
    JSON.stringify({ ...store.data, jobs: [store.data.jobs[0], store.data.jobs[0]] })]) {
    fs.writeFileSync(`${path}.bak`, backup)
    expect(() => new WatchStore(path)).toThrow('监控记录损坏，原文件已保留，请从备份恢复。')
    expect(fs.readFileSync(path)).toEqual(corrupt)
    expect(fs.readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
    expect(fs.readdirSync(directory).sort()).toEqual(['watch-state.json', 'watch-state.json.bak'])
  }
  fs.unlinkSync(`${path}.bak`)
  expect(() => new WatchStore(path)).toThrow('监控记录损坏')
  expect(fs.readFileSync(path)).toEqual(corrupt)
})

test('运行期间主文件被破坏时保存停止，保留有效备份和损坏原件', () => {
  const { path, store } = fixture()
  store.save()
  const backup = fs.readFileSync(`${path}.bak`)
  const corrupt = Buffer.alloc(200)
  fs.writeFileSync(path, corrupt)
  let failure: unknown
  store.onError = error => { failure = error }
  expect(() => store.save()).toThrow('监控记录损坏')
  expect(failure).toBeInstanceOf(Error)
  expect(fs.readFileSync(path)).toEqual(corrupt)
  expect(fs.readFileSync(`${path}.bak`)).toEqual(backup)
})

test('备份替换失败时不更新主文件，通知调用方停止处理', () => {
  const { directory, path, store } = fixture()
  store.save()
  const previous = fs.readFileSync(path)
  fs.unlinkSync(`${path}.bak`)
  fs.mkdirSync(`${path}.bak`)
  store.data.watches[0].title = '尚未保存'
  let failure: unknown
  store.onError = error => { failure = error }
  expect(() => store.save()).toThrow()
  expect(failure).toBeInstanceOf(Error)
  expect(fs.readFileSync(path)).toEqual(previous)
  expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false)
})

test('刷盘失败时原子写入保留已有文件并清理临时文件', () => {
  const { directory, path, store } = fixture()
  store.save()
  const previous = fs.readFileSync(path)
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('simulated disk sync failure') })
  try {
    expect(() => atomicJSON(path, { changed: true })).toThrow('simulated disk sync failure')
    expect(fs.readFileSync(path)).toEqual(previous)
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false)
  } finally { sync.mockRestore() }
})

test('恢复文件写入失败时保留损坏主文件、有效备份和已归档原件', () => {
  const { directory, path, store } = fixture()
  store.save()
  const backup = fs.readFileSync(`${path}.bak`)
  const corrupt = Buffer.alloc(300)
  fs.writeFileSync(path, corrupt)
  const realSync = fs.fsyncSync
  let count = 0
  // 保存原始字节后，让恢复主文件的刷盘失败；POSIX 另有一次目录同步。
  const sync = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if (++count === (process.platform === 'win32' ? 2 : 3)) throw new Error('simulated recovery sync failure')
    realSync(descriptor)
  })
  try {
    expect(() => new WatchStore(path)).toThrow('simulated recovery sync failure')
    expect(fs.readFileSync(path)).toEqual(corrupt)
    expect(fs.readFileSync(`${path}.bak`)).toEqual(backup)
    const archived = fs.readdirSync(directory).filter(name => name.startsWith('watch-state.json.corrupt-'))
    expect(archived).toHaveLength(1)
    expect(fs.readFileSync(join(directory, archived[0]))).toEqual(corrupt)
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false)
  } finally { sync.mockRestore() }
})

test('备份恢复关闭一次性任务及历史归属快照的清理，保留文件清单与季号', () => {
  const { path, store } = fixture()
  const root = store.data.watches[0], job = store.data.jobs[0]
  root.mode = 'once'; root.cleanup = { enabled: true, minutes: 3 * 1440 }
  root.selectedFiles = [job.path]
  root.batch = { files: [job.path], entries: [{ path: job.relativePath, kind: 'file', signature: job.signature, birthtimeMs: 1 }] }
  job.watchSnapshot = structuredClone(root)
  job.seasonNumber = 2
  store.data.retention.enabled = true
  store.save()
  fs.writeFileSync(path, Buffer.alloc(500))
  const restored = new WatchStore(path)
  const savedRoot = restored.data.watches[0], savedJob = restored.data.jobs[0]
  expect(savedRoot.enabled).toBe(false)
  expect(savedRoot.cleanup).toEqual({ enabled: false, minutes: 3 * 1440 })
  expect(savedRoot.batch).toEqual(root.batch)
  expect(savedRoot.selectedFiles).toEqual(root.selectedFiles)
  expect(savedJob.watchSnapshot?.enabled).toBe(false)
  expect(savedJob.watchSnapshot?.cleanup).toEqual({ enabled: false, minutes: 3 * 1440 })
  expect(savedJob.seasonNumber).toBe(2)
  expect(restored.data.retention.enabled).toBe(false)
  expect(restored.rootFor(savedJob)).toMatchObject({ enabled: false, seasonNumber: 2, versionMode: 'auto' })
})

test('备份必须通过一次性批次、多目录、历史归属快照和季号校验', () => {
  const { path, store } = fixture()
  store.save()
  const corrupt = Buffer.alloc(100)
  fs.writeFileSync(path, corrupt)
  for (const mutate of [
    (value: typeof store.data) => { value.watches[0].mode = 'once' },
    (value: typeof store.data) => { value.watches[0].additionalPaths = [''] },
    (value: typeof store.data) => { value.watches[0].initializedPaths = ['outside'] },
    (value: typeof store.data) => { value.jobs[0].watchSnapshot = { ...value.watches[0], mode: 'once' } },
    (value: typeof store.data) => { value.jobs[0].seasonNumber = -1 },
  ]) {
    const value = structuredClone(store.data)
    mutate(value)
    const backup = JSON.stringify(value)
    fs.writeFileSync(`${path}.bak`, backup)
    expect(() => new WatchStore(path)).toThrow('监控记录损坏')
    expect(fs.readFileSync(path)).toEqual(corrupt)
    expect(fs.readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
  }
})

test('保存与正常重启保留多目录和任务归属，实时速度不写入磁盘', () => {
  const { directory, path, store } = fixture()
  const root = store.data.watches[0], job = store.data.jobs[0]
  root.additionalPaths = [join(directory, 'media-2')]
  root.initializedPaths = [root.path, ...root.additionalPaths]
  job.watchSnapshot = structuredClone(root)
  job.seasonNumber = 1
  job.transfer = { sentBytes: 123, bytesPerSecond: 10, rateLimit: 50 }
  store.save()
  expect(job.transfer).toBeDefined()
  const disk = JSON.parse(fs.readFileSync(path, 'utf8'))
  expect(disk.jobs[0].transfer).toBeUndefined()
  // 兼容旧运行状态：读取时同样丢弃不再有效的实时速度。
  disk.jobs[0].transfer = job.transfer
  fs.writeFileSync(path, JSON.stringify(disk))
  const restored = new WatchStore(path)
  expect(restored.data.jobs[0].transfer).toBeUndefined()
  expect(restored.data.watches[0]).toEqual(root)
  expect(restored.rootFor(restored.data.jobs[0])).toMatchObject({ enabled: true, seasonNumber: 1, additionalPaths: root.additionalPaths })
})

for (const damaged of [false, true]) test(`取消的一次性文件启动迁移仍释放原路径，备份恢复=${damaged}`, () => {
  const { path, store } = fixture()
  const root = store.data.watches[0], job = store.data.jobs[0]
  root.mode = 'once'; root.cleanup = { enabled: true, minutes: 30 }
  root.selectedFiles = [job.path]
  root.batch = {
    files: [job.path], completedAt: 1, deleteAt: 1 + 30 * 60000,
    entries: [{ path: job.relativePath, kind: 'file', signature: job.signature, birthtimeMs: 1 }],
  }
  job.status = 'cancelled'
  store.save()
  if (damaged) fs.writeFileSync(path, Buffer.alloc(100))
  const restored = new WatchStore(path), migrated = restored.data.watches[0]
  expect(migrated.batch?.releasedFiles).toEqual([job.path])
  expect(migrated.batch?.deleteAt).toBeUndefined()
  expect(migrated.cleanup?.enabled).toBe(false)
  expect(restored.data.jobs[0].status).toBe('cancelled')
  expect(!!restored.recovery).toBe(damaged)
  restored.save()
  expect(new WatchStore(path).data.watches[0].batch?.releasedFiles).toEqual([job.path])
})
