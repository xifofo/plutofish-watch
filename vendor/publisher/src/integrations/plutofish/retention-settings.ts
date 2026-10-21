/** 本地成品保留策略由发布端保存；默认发布完成后 24 小时，0 表示关闭自动删除。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath } from '../../lib/config'

export type RetentionSettings = { hours: number }
export const retentionSettingsPath = () => join(dirname(configPath()), 'plutofish-retention.json')

export function validateRetentionSettings(value: RetentionSettings): RetentionSettings {
  if (!value || !Number.isSafeInteger(value.hours) || value.hours < 0 || value.hours > 8760) throw new Error('保留时间须为 0 至 8760 的整数小时，0 表示关闭自动删除')
  return { hours: value.hours }
}

export function loadRetentionSettings(path = retentionSettingsPath()): RetentionSettings {
  if (!existsSync(path)) return { hours: 24 }
  return validateRetentionSettings(JSON.parse(readFileSync(path, 'utf8')))
}

export function saveRetentionSettings(value: RetentionSettings, path = retentionSettingsPath()): RetentionSettings {
  const settings = validateRetentionSettings(value)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(settings) + '\n', { mode: 0o600 })
  renameSync(path + '.tmp', path)
  return settings
}
