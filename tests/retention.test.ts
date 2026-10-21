/** 本地策略默认关闭，旧状态迁移与非法输入不会意外开启删除。 */
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from '../src/main/store'
import { defaultRetention, validateRetention } from '../src/shared/retention'

test('新安装和旧状态默认关闭，开关与天数独立保存并跨重启保留', () => {
  const temp = mkdtempSync(join(tmpdir(), 'watch-retention-')), path = join(temp, 'state.json')
  try {
    const store = new WatchStore(path)
    expect(store.data.retention).toEqual({ enabled: false, days: 7 })
    store.save()
    const old = JSON.parse(readFileSync(path, 'utf8')); delete old.retention
    writeFileSync(path, JSON.stringify(old))
    const migrated = new WatchStore(path)
    expect(migrated.data.retention).toEqual(defaultRetention())
    migrated.data.retention = validateRetention({ enabled: true, days: 3 }); migrated.save()
    expect(new WatchStore(path).data.retention).toEqual({ enabled: true, days: 3 })
    migrated.data.retention = validateRetention({ enabled: false, days: 3 }); migrated.save()
    expect(new WatchStore(path).data.retention).toEqual({ enabled: false, days: 3 })
    writeFileSync(path, JSON.stringify({ ...old, retention: { enabled: true, days: -1 } }))
    expect(() => new WatchStore(path)).toThrow('保留天数')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('删除策略拒绝空值、字符串、负数、小数及超范围天数', () => {
  for (const value of [null, {}, { enabled: 'true', days: 1 }, ...[0, -1, 1.5, 366, NaN, Infinity, '2', null].map(days => ({ enabled: true, days }))]) {
    expect(() => validateRetention(value)).toThrow()
  }
  expect(validateRetention({ enabled: true, days: 365, unrelated: true })).toEqual({ enabled: true, days: 365 })
})
