import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adjustCreationTarget, creationDraftForParent, creationSegments, directoryCreated, directoryCreationPending, rememberCreatedDirectory, validateDirectoryCreation } from '../src/shared/directory-creation'
import { WatchStore } from '../src/main/store'
import type { DirectoryPage, WatchInput, WatchRoot } from '../src/shared/model'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const input = (): WatchInput => ({ path: '/local', title: 'Doctor X', sourceAccountId: 'source', work: { mediaType: 'tv', tmdbId: '45951', category: 'japan' },
  seasonNumber: 1, releaseId: '', versionMode: 'auto', directoryId: '10', directoryPath: '/影视资源', includeExisting: true, stableSeconds: 30 })
const page: DirectoryPage = { sourceAccountId: 'source', path: [{ id: '0', name: '/' }, { id: '10', name: '影视资源' },
  { id: '20', name: '日韩剧集' }, { id: '30', name: 'Doctor X {tmdbid-45951}' }, { id: '40', name: 'season 01' }], items: [], nextCursor: '' }

test('手动创建记住真实目录 ID，改标题和分类、重新选相同 ID 不允许重复套娃', () => {
  const form = input()
  expect(creationSegments(form, '日韩剧集')).toEqual(['日韩剧集', 'Doctor X {tmdbid-45951}', 'season 01'])
  rememberCreatedDirectory(form, page)
  expect(form.directoryId).toBe('40'); expect(directoryCreated(form)).toBe(true)
  form.title = '新译名'; form.work.category = 'other'; form.directoryId = '40'; adjustCreationTarget(form)
  expect(directoryCreated(form)).toBe(true)
  expect(form.directoryPath).toContain('Doctor X')
  expect(validateDirectoryCreation(form)).toEqual(form.directoryCreation)
})

test('同作品新季使用已知作品 ID；改作品回到原父目录，切账号不会复用旧父目录', () => {
  const form = input(); rememberCreatedDirectory(form, page)
  form.title = '新译名'; form.seasonNumber = 2; adjustCreationTarget(form)
  expect(form.directoryId).toBe('30'); expect(directoryCreated(form)).toBe(false)
  expect(directoryCreationPending(form)).toBe(true)
  expect(() => validateDirectoryCreation(form)).toThrow('请创建本季文件夹')
  expect(creationSegments(form, '新分类')).toEqual(['season 02'])
  form.seasonNumber = 1; adjustCreationTarget(form)
  expect(form.directoryId).toBe('40'); expect(directoryCreated(form)).toBe(true)
  expect(form.directoryPath).toBe('/影视资源/日韩剧集/Doctor X {tmdbid-45951}/season 01')
  form.seasonNumber = 2; adjustCreationTarget(form)
  const nextPage = { ...page, path: [...page.path.slice(0, -1), { id: '41', name: 'season 02' }] }
  rememberCreatedDirectory(form, nextPage)
  expect(form.directoryCreation?.parentId).toBe('10'); expect(form.directoryPath).toContain('Doctor X')
  form.work.tmdbId = '999'; adjustCreationTarget(form)
  expect(form.directoryId).toBe('10'); expect(form.directoryCreation).toBeUndefined()
  const other = input(); rememberCreatedDirectory(other, page)
  other.sourceAccountId = 'other'; other.directoryId = '0'; other.directoryPath = '/'; adjustCreationTarget(other)
  expect(other.directoryId).toBe('0'); expect(other.directoryCreation).toBeUndefined()
})

test('手选不同目录清除创建记忆，旧监控不引入创建状态', () => {
  const form = input(); expect(validateDirectoryCreation(form)).toBeUndefined()
  rememberCreatedDirectory(form, page); form.directoryId = '99'; adjustCreationTarget(form)
  expect(form.directoryCreation).toBeUndefined(); expect(form.directoryId).toBe('99')
})

test('手动创建记忆随监控保存和重启，不能接受其他账号的记忆', () => {
  const directory = mkdtempSync(join(tmpdir(), 'watch-created-')); temporary.push(directory)
  const store = new WatchStore(join(directory, 'state.json')), form = input(); rememberCreatedDirectory(form, page)
  const root: WatchRoot = { ...form, id: 'watch', binding: { url: 'https://example.invalid', publisherId: 'p', sourceAccount: { id: 'source', alias: 'source' } },
    releaseName: '自动归类', enabled: true, initialized: true, createdAt: '2026-10-24T00:00:00Z' }
  store.data.watches.push(root); store.save()
  const restored = new WatchStore(store.path).data.watches[0]
  expect(directoryCreated(restored)).toBe(true); expect(restored.directoryId).toBe('40')
  restored.sourceAccountId = 'other'
  expect(() => validateDirectoryCreation(restored)).toThrow('记录无效')
})

test('弹窗浏览只改独立草稿，取消或创建失败保留原目标和创建记忆', () => {
  const form = input(); rememberCreatedDirectory(form, page)
  form.seasonNumber = 2; adjustCreationTarget(form)
  const before = JSON.parse(JSON.stringify(form))
  const selected = creationDraftForParent(form, { id: '99', path: '/另一上级' })
  expect(selected.directoryId).toBe('99'); expect(selected.directoryCreation).toBeUndefined()
  expect(creationSegments(selected, '新分类')).toEqual(['新分类', 'Doctor X {tmdbid-45951}', 'season 02'])
  expect(form).toEqual(before)
  const originalWork = creationDraftForParent(form, { id: '30', path: '/影视资源/日韩剧集/Doctor X {tmdbid-45951}' })
  expect(creationSegments(originalWork, '新分类')).toEqual(['season 02'])
  originalWork.directoryCreation!.parentPath = '/改动只在草稿'
  expect(form).toEqual(before)
})

test('新季明确选择其他父目录时，创建路径和新记忆采用所选父目录', () => {
  const form = input(); rememberCreatedDirectory(form, page)
  form.title = '更新译名'; form.seasonNumber = 2; adjustCreationTarget(form)
  const draft = creationDraftForParent(form, { id: '99', path: '/另一上级' })
  const created: DirectoryPage = { sourceAccountId: 'source', path: [{ id: '0', name: '/' }, { id: '99', name: '另一上级' },
    { id: '100', name: '日韩剧集' }, { id: '101', name: '更新译名 {tmdbid-45951}' }, { id: '102', name: 'season 02' }], items: [], nextCursor: '' }
  rememberCreatedDirectory(draft, created)
  expect(draft.directoryId).toBe('102'); expect(draft.directoryCreation?.parentId).toBe('99')
  expect(draft.directoryCreation?.parentPath).toBe('/另一上级'); expect(draft.directoryCreation?.workDirectoryId).toBe('101')
  expect(form.directoryId).toBe('30'); expect(form.directoryCreation?.parentId).toBe('10')
})
