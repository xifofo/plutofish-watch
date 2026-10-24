import { expect, test } from 'bun:test'
import { directoryPreview } from '../src/shared/directory-preview'

test('预览采用分类、首次作品名、TMDB ID 与两位季号，并清理网盘禁用字符', () => {
  expect(directoryPreview({ rootPath: '/影视资源/', title: ' Doctor X / 外科医生 ', categoryLabel: '日韩剧集', tmdbId: '45951', seasonNumber: 1 }))
    .toBe('/影视资源/日韩剧集/Doctor X _ 外科医生 {tmdbid-45951}/season 01')
  expect(directoryPreview({ rootPath: '/', title: '..', categoryLabel: '.', tmdbId: '1', seasonNumber: 0 }))
    .toBe('/_/_ {tmdbid-1}/season 00')
})

test('长名称按完整 UTF8 字符截断并为 TMDB 标记预留空间，电影不附加季目录', () => {
  const preview = directoryPreview({ rootPath: '/', title: '剧'.repeat(200), categoryLabel: '电影', tmdbId: '123' })
  const work = preview.split('/').at(-1)!
  expect(new TextEncoder().encode(work).length).toBeLessThanOrEqual(255)
  expect(work.endsWith(' {tmdbid-123}')).toBe(true)
  expect(work.includes('\uFFFD')).toBe(false)
  expect(preview.includes('season')).toBe(false)
})
