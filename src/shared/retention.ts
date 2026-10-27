import type { LocalRetentionSettings } from './model'

export const defaultRetention = (): LocalRetentionSettings => ({ enabled: false, days: 7 })
export const defaultOneTimeRetention = (): LocalRetentionSettings => ({ enabled: false, days: 1 })

export function validateRetention(value: unknown): LocalRetentionSettings {
  const settings = value as LocalRetentionSettings | null
  if (!settings || typeof settings.enabled !== 'boolean' || !Number.isSafeInteger(settings.days) || settings.days < 1 || settings.days > 365) {
    throw new Error('保留天数须为 1–365 的整数')
  }
  return { enabled: settings.enabled, days: settings.days }
}
