import { expect, test } from 'bun:test'
import type { PlutoFishConnection } from '../vendor/publisher/src/integrations/plutofish/connection'
import { searchWorks } from '../src/main/work-search'
import type { Binding, WorkSearch } from '../src/shared/model'

const binding: Binding = { url: 'http://127.0.0.1:1234', publisherId: 'test', sourceAccount: { id: 'source', alias: 'source-alias' } }
const input: WorkSearch = { sourceAccountId: 'source', query: ' 星海 ', mediaType: 'tv', page: 1 }
const valid = () => ({ page: 1, total: 1, totalPages: 1, items: [{ tmdbId: '123', title: '星海', originalTitle: 'Stars', year: 2023 }] })

test('搜索仅使用固定绑定的源账号，返回有限作品资料', async () => {
  const calls: unknown[][] = []
  const connection = { request: async (...args: unknown[]) => { calls.push(args); return { ...valid(), secret: 'private' } } } as unknown as PlutoFishConnection
  const result = await searchWorks(connection, binding, input)
  expect(calls[0].slice(0, 3)).toEqual([binding, 'tmdb/search', { sourceAccount: 'source-alias', mediaType: 'tv', query: '星海', page: 1 }])
  expect(result).toEqual(valid())
  expect(JSON.stringify(result)).not.toContain('private')
})

test('错误输入在网络请求前被拒绝', async () => {
  let called = false
  const connection = { request: async () => { called = true; return valid() } } as unknown as PlutoFishConnection
  for (const change of [{ query: '' }, { query: '字'.repeat(101) }, { mediaType: 'person' }, { page: 0 }, { page: 501 }, { page: 1.5 }]) {
    await expect(searchWorks(connection, binding, { ...input, ...change } as WorkSearch)).rejects.toThrow('请输入作品名称')
  }
  expect(called).toBe(false)
})

test('无效作品身份与错误分页不能成为可选结果', async () => {
  const invalid = [
    null, { ...valid(), page: 2 }, { ...valid(), totalPages: 501 }, { ...valid(), total: 0 },
    { ...valid(), items: [{ ...valid().items[0], tmdbId: '2147483648' }] },
    { ...valid(), items: [{ ...valid().items[0], title: '' }] },
    { ...valid(), items: [{ ...valid().items[0], year: -1 }] },
  ]
  for (const response of invalid) {
    const connection = { request: async () => response } as unknown as PlutoFishConnection
    await expect(searchWorks(connection, binding, input)).rejects.toThrow('作品搜索结果无效')
  }
})
