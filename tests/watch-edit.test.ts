/** 编辑目录只重定向未开始发布的文件；已登记身份、暂停与扫描基线跨重启保留。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from '../src/main/store'
import { applyWatchEdit } from '../src/main/watch-edit'
import type { WatchJob, WatchRoot } from '../src/shared/model'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'watch-edit-')); directories.push(dir)
  const store = new WatchStore(join(dir, 'state.json'))
  const root: WatchRoot = {
    id: 'root', path: '/old', title: '原作品', work: { mediaType: 'tv', tmdbId: '123', category: 'tv' }, seasonNumber: 1,
    binding: { url: 'https://example.invalid', publisherId: 'p', sourceAccount: { id: 's', alias: 'original' } },
    sourceAccountId: 's', versionMode: 'fixed', releaseId: 'a'.repeat(32), releaseName: '旧版本',
    directoryId: '42', directoryPath: '/旧目录', includeExisting: false, stableSeconds: 30,
    enabled: true, initialized: true, createdAt: '2026-10-23T00:00:00Z',
  }
  store.data.watches.push(root)
  const job = (id: string, fields: Partial<WatchJob> = {}): WatchJob => {
    const item: WatchJob = { id, watchId: root.id, path: `/old/${id}.S01E01.mp4`, relativePath: `${id}.S01E01.mp4`,
      signature: { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1 }, status: 'queued', percent: 0, error: '',
      createdAt: root.createdAt, updatedAt: root.createdAt, episodeNumber: 1, ...fields }
    store.data.jobs.push(item)
    store.data.observations.root ??= {}
    store.data.observations.root[item.path] = { signature: item.signature, stableSince: 1, jobId: id }
    return item
  }
  return { store, root, job }
}

test('已登记任务固定原作品账号路径，后续编辑和重启不改身份；暂停仍服从当前目录', () => {
  const { store, root, job } = setup()
  const registered = job('registered', { fileKey: 'stable-key', status: 'paused', release: { id: 'a'.repeat(32), name: '旧版本' } })
  const completed = job('completed', { status: 'completed' })
  const next = { ...root, work: { ...root.work, tmdbId: '456' }, path: '/new', directoryId: '99', sourceAccountId: 'new',
    binding: { ...root.binding, sourceAccount: { id: 'new', alias: 'new' } } }
  applyWatchEdit(store, root, next)
  expect(store.rootFor(registered)?.work.tmdbId).toBe('123')
  expect(store.rootFor(registered)?.binding.sourceAccount.alias).toBe('original')
  expect(store.rootFor(registered)?.directoryId).toBe('42')
  expect(store.rootFor(completed)?.path).toBe('/old')
  applyWatchEdit(store, root, { ...root, directoryId: '100', enabled: false })
  const restored = new WatchStore(store.path)
  expect(restored.rootFor(restored.data.jobs[0])?.directoryId).toBe('42')
  expect(restored.rootFor(restored.data.jobs[0])?.enabled).toBe(false)
  expect(restored.data.jobs[0].fileKey).toBe('stable-key')
})

test('待发布任务重新归类，保留人工暂停与已确认集号；电影转换清掉季集号', () => {
  const { store, root, job } = setup()
  const waiting = job('pending', { release: { name: '旧版本', id: 'a'.repeat(32) }, episodeNumber: 8 })
  const manual = job('paused', { status: 'paused', manuallyPaused: true })
  const cancelled = job('cancelled', { status: 'cancelled' })
  applyWatchEdit(store, root, { ...root, versionMode: 'auto', releaseId: '', sourcePreset: { platform: 'NF', type: 'WEB-DL' } }, 100)
  expect(waiting.status).toBe('waiting'); expect(waiting.release).toBeUndefined()
  expect(waiting.episodeNumber).toBe(8)
  expect(store.data.observations.root[waiting.path].stableSince).toBe(100)
  expect(manual.status).toBe('paused'); expect(cancelled.status).toBe('cancelled')
  applyWatchEdit(store, root, { ...root, work: { mediaType: 'movie', tmdbId: '456', category: 'movie' }, seasonNumber: undefined })
  expect(root.seasonNumber).toBeUndefined(); expect(waiting.episodeNumber).toBeUndefined()
  expect(store.rootFor(waiting)?.work.tmdbId).toBe('456')
})

test('更换路径只停止未登记任务并重新建立扫描基线，历史记录保留', () => {
  const { store, root, job } = setup()
  const pending = job('pending')
  const registered = job('registered', { fileKey: 'stable-key', status: 'paused' })
  applyWatchEdit(store, root, { ...root, path: '/new', includeExisting: true })
  expect(pending.status).toBe('cancelled'); expect(registered.status).toBe('paused')
  expect(root.initialized).toBe(false); expect(root.includeExisting).toBe(true)
  expect(store.data.observations.root).toBeUndefined()
  expect(store.data.jobs).toHaveLength(2)
})
