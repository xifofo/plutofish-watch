/** 临时目录与离线连接验证取样、响应边界，不读真实配置或访问网盘。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { recognitionSample, recognizeFile, validateRecognition } from '../src/main/recognition'
import type { Binding, Recognition } from '../src/shared/model'
import type { PlutoFishConnection } from '../vendor/publisher/src/integrations/plutofish/connection'

const temporary: string[] = []
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }) })
const binding: Binding = { url: 'http://127.0.0.1:1234', publisherId: 'test', sourceAccount: { id: 'source', alias: 'offline' } }
function valid(): Recognition {
  const work = { tmdbId: '123', mediaType: 'tv' as const, title: '星海', originalTitle: 'Stars', englishTitle: 'Stars', year: 2024, posterUrl: '', category: { name: '动画番剧', value: 'anime', label: '动画番剧', status: 'matched' as const } }
  return { status: 'compatible', canAutoFill: true, reasons: [], truncated: false, selectionBasis: '',
    parsed: { title: 'Stars', mediaType: 'tv', seasonNumber: 2, episodeNumber: 3, resolution: '1080p', source: 'WEB-DL', warnings: [] },
    work, workTarget: { tmdbId: '123', mediaType: 'tv', category: 'anime' }, candidates: [{ work, conflicts: [] }] }
}

test('空目录返回目录名作为识别来源；视频只传相对名称，跳过临时、空文件和链接', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-recognition-')); temporary.push(dir)
  expect(await recognitionSample(dir)).toEqual({ directoryName: basename(dir), fileName: null, truncated: false })
  await writeFile(join(dir, 'empty.mkv'), '')
  await writeFile(join(dir, 'hidden.part.mp4'), 'partial')
  await mkdir(join(dir, '.hidden')); await writeFile(join(dir, '.hidden', 'skip.mp4'), 'data')
  await symlink(join(dir, '.hidden', 'skip.mp4'), join(dir, 'link.mp4'))
  expect((await recognitionSample(dir)).fileName).toBeNull()
  await mkdir(join(dir, 'Season 02')); await writeFile(join(dir, 'Season 02', 'Stars.S02E03.mkv'), 'data')
  const sample = await recognitionSample(dir)
  expect(sample.directoryName).toBe(basename(dir))
  expect(sample.fileName).toEndWith('/Season 02/Stars.S02E03.mkv')
  expect(sample.fileName).not.toStartWith('/')
})

test('空影视目录保留年份与季号，扫描截断仍能使用目录名，无效路径不伪装为空目录', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'watch-recognition-')); temporary.push(temp)
  const dir = join(temp, '星海纪行.2024.S02')
  await mkdir(dir)
  expect(await recognitionSample(`${dir}/`)).toEqual({ directoryName: '星海纪行.2024.S02', fileName: null, truncated: false })
  const nested = join(dir, ...Array(9).fill('child'))
  await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'ignored.mkv'), 'data')
  expect(await recognitionSample(dir)).toEqual({ directoryName: '星海纪行.2024.S02', fileName: null, truncated: true })
  await expect(recognitionSample(join(temp, 'missing'))).rejects.toThrow()
})

test('文件名识别复用授权绑定；无效输入不发送请求', async () => {
  const calls: unknown[][] = []
  const connection = { request: async (...args: unknown[]) => { calls.push(args); return valid() } } as unknown as PlutoFishConnection
  expect((await recognizeFile(connection, binding, 'Stars.S02E03.mkv')).workTarget?.category).toBe('anime')
  expect(calls[0].slice(0, 3)).toEqual([binding, 'tmdb/recognize', { sourceAccount: 'offline', fileName: 'Stars.S02E03.mkv' }])
  for (const name of ['', ' ', 'x\n.mkv', 'x'.repeat(1001)]) await expect(recognizeFile(connection, binding, name)).rejects.toThrow('请输入')
  expect(calls).toHaveLength(1)
  expect((await recognizeFile(connection, binding, '星海纪行.2024.S02')).workTarget?.category).toBe('anime')
  expect(calls[1].slice(0, 3)).toEqual([binding, 'tmdb/recognize', { sourceAccount: 'offline', fileName: '星海纪行.2024.S02' }])
})

test('歧义、禁用分类、身份错配和跨季结果不能伪造自动回填', () => {
  for (const mutate of [
    (r: Recognition) => { r.status = 'ambiguous' },
    (r: Recognition) => { r.work!.category.status = 'disabled' },
    (r: Recognition) => { r.workTarget!.tmdbId = '999' },
    (r: Recognition) => { r.workTarget!.category = 'wrong' },
    (r: Recognition) => { r.parsed.seasonEnd = 3 },
    (r: Recognition) => { delete r.parsed.seasonNumber },
    (r: Recognition) => { r.truncated = true },
    (r: Recognition) => { r.selectionBasis = 'tmdb_order' },
  ]) {
    const value = valid(); mutate(value)
    expect(() => validateRecognition(value)).toThrow('识别结果无效')
  }
  const review = valid(); review.canAutoFill = false; review.workTarget = null; review.status = 'review'; review.reasons = ['category_disabled']
  expect(validateRecognition(review).canAutoFill).toBe(false)
})


test('直接选择文件只使用该文件名识别，不采样同目录其他视频', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-recognition-')); temporary.push(dir)
  await writeFile(join(dir, 'Unrelated.S01E01.mp4'), 'other')
  const selected = join(dir, 'Stars.S02E03.mkv'); await writeFile(selected, 'selected')
  expect(await recognitionSample(selected)).toEqual({ directoryName: basename(dir), fileName: 'Stars.S02E03.mkv', truncated: false })
})
