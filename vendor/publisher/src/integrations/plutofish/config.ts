/** 单独保存 PlutoFish 凭据，避免改变上游 GVS 配置结构。 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath } from '../../lib/config.ts'
import type { PlutoFishInput } from './types.ts'

export const plutoFishConfigPath = () => join(dirname(configPath()), 'plutofish.json')

export function loadPlutoFishConfig(path = plutoFishConfigPath()): PlutoFishInput {
  if (!existsSync(path)) return { url: '', key: '' }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value.url !== 'string' || typeof value.key !== 'string') throw new Error('invalid config')
  return { url: value.url, key: value.key }
}

export function savePlutoFishConfig(value: PlutoFishInput, path = plutoFishConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
