import type { LocalRetentionSettings } from './model'

const HOUR = 60, DAY = 24 * HOUR

/** 服务端最多等待 30 分钟让发布端完成本地挑战，更短的保留时间可能赶在校验之前删除文件。 */
export const minRetentionMinutes = 30
export const maxRetentionMinutes = 365 * DAY
export const retentionUnits = [{ minutes: 1, label: '分钟' }, { minutes: HOUR, label: '小时' }, { minutes: DAY, label: '天' }] as const

export const defaultRetention = (): LocalRetentionSettings => ({ enabled: false, minutes: 7 * DAY })
export const defaultOneTimeRetention = (): LocalRetentionSettings => ({ enabled: false, minutes: DAY })

/** 按能整除的最大单位拆分：24 小时显示为 1 天，90 分钟保持 90 分钟。 */
export function retentionParts(minutes: number): { amount: number; unit: number } {
  const unit = retentionUnits.findLast(item => minutes % item.minutes === 0)?.minutes ?? 1
  return { amount: minutes / unit, unit }
}

export function retentionRange(unit: number): { min: number; max: number } {
  return { min: Math.ceil(minRetentionMinutes / unit), max: Math.floor(maxRetentionMinutes / unit) }
}

export function formatRetention(minutes: number): string {
  const { amount, unit } = retentionParts(minutes)
  return `${amount} ${retentionUnits.find(item => item.minutes === unit)!.label}`
}

/** 0.1.21 及更早版本按天保存，读取时换算，下次保存写入分钟。 */
function storedMinutes(settings: Partial<LocalRetentionSettings> & { days?: number }): number | undefined {
  return settings.minutes === undefined && Number.isSafeInteger(settings.days) ? settings.days! * DAY : settings.minutes
}

export function validateRetention(value: unknown): LocalRetentionSettings {
  const settings = value as LocalRetentionSettings | null
  const minutes = settings ? storedMinutes(settings) : undefined
  if (!settings || typeof settings.enabled !== 'boolean' || minutes === undefined || !Number.isSafeInteger(minutes)
    || minutes < minRetentionMinutes || minutes > maxRetentionMinutes) {
    throw new Error('保留时长须在 30 分钟至 365 天之间')
  }
  return { enabled: settings.enabled, minutes }
}
