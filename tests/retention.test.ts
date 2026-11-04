/** 本地策略默认关闭，旧状态迁移与非法输入不会意外开启删除。 */
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from '../src/main/store'
import { defaultRetention, formatRetention, retentionParts, retentionRange, validateRetention } from '../src/shared/retention'

const DAY = 1440

test('新安装和旧状态默认关闭，开关与时长独立保存并跨重启保留', () => {
  const temp = mkdtempSync(join(tmpdir(), 'watch-retention-')), path = join(temp, 'state.json')
  try {
    const store = new WatchStore(path)
    expect(store.data.retention).toEqual({ enabled: false, minutes: 7 * DAY })
    store.save()
    const old = JSON.parse(readFileSync(path, 'utf8')); delete old.retention
    writeFileSync(path, JSON.stringify(old))
    const migrated = new WatchStore(path)
    expect(migrated.data.retention).toEqual(defaultRetention())
    migrated.data.retention = validateRetention({ enabled: true, minutes: 30 }); migrated.save()
    expect(new WatchStore(path).data.retention).toEqual({ enabled: true, minutes: 30 })
    migrated.data.retention = validateRetention({ enabled: false, minutes: 30 }); migrated.save()
    expect(new WatchStore(path).data.retention).toEqual({ enabled: false, minutes: 30 })
    writeFileSync(path, JSON.stringify({ ...old, retention: { enabled: true, minutes: -1 } }))
    expect(() => new WatchStore(path)).toThrow('保留时长')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('旧版按天保存的策略升级后换算为分钟，保存时不再写入天数', () => {
  const temp = mkdtempSync(join(tmpdir(), 'watch-retention-')), path = join(temp, 'state.json')
  try {
    new WatchStore(path).save()
    const old = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...old, retention: { enabled: true, days: 3 } }))
    const store = new WatchStore(path)
    expect(store.data.retention).toEqual({ enabled: true, minutes: 3 * DAY })
    store.save()
    expect(JSON.parse(readFileSync(path, 'utf8')).retention).toEqual({ enabled: true, minutes: 3 * DAY })
    writeFileSync(path, JSON.stringify({ ...old, retention: { enabled: true, days: -1 } }))
    expect(() => new WatchStore(path)).toThrow('保留时长')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('删除策略拒绝空值、字符串、负数、小数及超范围时长', () => {
  const invalid = [0, -1, 1.5, 29, 365 * DAY + 1, NaN, Infinity, '30', null].map(minutes => ({ enabled: true, minutes }))
  const legacy = [0, -1, 1.5, 366, NaN, Infinity, '2', null].map(days => ({ enabled: true, days }))
  for (const value of [null, {}, { enabled: 'true', minutes: 30 }, ...invalid, ...legacy]) expect(() => validateRetention(value)).toThrow()
  expect(validateRetention({ enabled: true, minutes: 30, unrelated: true })).toEqual({ enabled: true, minutes: 30 })
  expect(validateRetention({ enabled: true, minutes: 365 * DAY })).toEqual({ enabled: true, minutes: 365 * DAY })
  expect(validateRetention({ enabled: true, days: 365 })).toEqual({ enabled: true, minutes: 365 * DAY })
})

test('时长按能整除的最大单位显示，各单位范围不超出 30 分钟至 365 天', () => {
  expect([30, 45, 60, 90, 120, 1440, 1500, 2880].map(formatRetention))
    .toEqual(['30 分钟', '45 分钟', '1 小时', '90 分钟', '2 小时', '1 天', '25 小时', '2 天'])
  expect(retentionParts(90)).toEqual({ amount: 90, unit: 1 })
  expect(retentionParts(3 * DAY)).toEqual({ amount: 3, unit: DAY })
  expect(retentionRange(1)).toEqual({ min: 30, max: 365 * DAY })
  expect(retentionRange(60)).toEqual({ min: 1, max: 8760 })
  expect(retentionRange(DAY)).toEqual({ min: 1, max: 365 })
})
