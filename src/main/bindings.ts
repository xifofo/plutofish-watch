/** 监控绑定只接受已授权源账号和服务端返回的同作品同季版本。 */
import { normalizePlatform, releaseTypes, type ReleaseSource } from '../../vendor/publisher/src/integrations/plutofish/release-specs'
import { createHash } from 'node:crypto'
import type { Binding, Connection, WatchInput, WatchRoot, Work } from '../shared/model'
import { normalizePlutoFishURL } from '../../vendor/publisher/src/integrations/plutofish/client'
import { validateDirectoryCreation } from '../shared/directory-creation'
import { validateWatchPaths } from '../shared/watch-paths'

export const stableKey = (prefix: string, data: unknown) =>
  `${prefix}:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`

export function validateWork(value: Work, season?: number): Work {
  if (!value || !['movie', 'tv'].includes(value.mediaType) || typeof value.tmdbId !== 'string'
    || !/^[1-9]\d{0,9}$/.test(value.tmdbId) || Number(value.tmdbId) > 2147483647
    || typeof value.category !== 'string' || !value.category || value.category.length > 128) {
    throw new Error('请填写作品类型、有效 TMDB ID 和资源分类')
  }
  if (value.mediaType === 'tv' && (!Number.isInteger(season) || season! < 0 || season! > 10000)) {
    throw new Error('剧集必须填写 0–10000 的季号')
  }
  return { mediaType: value.mediaType, tmdbId: value.tmdbId, category: value.category }
}

export function bindingFor(view: Connection, sourceId: string): Binding {
  if (view.status !== 'verified' || !view.identity) throw new Error('请先连接 PlutoFish')
  const source = (view.identity.sourceAccounts ?? [view.identity.sourceAccount]).find(s => s.id === sourceId && s.enabled !== false)
  if (!source || (source.provider && source.provider !== '115')) throw new Error('请选择已授权的 115 源网盘')
  return { url: normalizePlutoFishURL(view.url), publisherId: view.identity.id, sourceAccount: { id: source.id, alias: source.alias } }
}

export function validateInput(input: WatchInput, view: Connection): WatchInput {
  const paths = validateWatchPaths(input)
  validateWork(input?.work, input?.seasonNumber)
  bindingFor(view, input.sourceAccountId)
  if (!view.identity?.categories?.some(c => c.value === input.work.category)) throw new Error('所选资源分类已不可用')
  const versionMode = input.versionMode ?? 'fixed'
  if (!['fixed', 'auto'].includes(versionMode)) throw new Error('版本归类方式无效')
  if (typeof input.path !== 'string' || input.path.length > 4096
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200
    || typeof input.directoryId !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(input.directoryId)
    || typeof input.directoryPath !== 'string' || input.directoryPath.length > 4096
    || typeof input.releaseId !== 'string' || (versionMode === 'fixed' && !/^[a-f0-9]{32}$/.test(input.releaseId))
    || typeof input.includeExisting !== 'boolean'
    || !Number.isInteger(input.stableSeconds) || input.stableSeconds < 10 || input.stableSeconds > 3600) {
    throw new Error('请完整填写目录绑定；稳定等待时间为 10–3600 秒')
  }
  return {
    path: paths[0], additionalPaths: paths.slice(1), title: input.title.trim(), work: validateWork(input.work, input.seasonNumber),
    sourceAccountId: input.sourceAccountId, versionMode, sourcePreset: validateSource(input.sourcePreset), releaseId: versionMode === 'auto' ? '' : input.releaseId, directoryId: input.directoryId,
    directoryPath: input.directoryPath, includeExisting: input.includeExisting, stableSeconds: input.stableSeconds,
    directoryCreation: validateDirectoryCreation(input),
    ...(input.work.mediaType === 'tv' ? { seasonNumber: input.seasonNumber } : {}),
  }
}

export const releaseKey = (root: WatchRoot, releaseId = root.releaseId) => stableKey('gvs-r1', [root.id, root.binding, root.work, root.seasonNumber, releaseId, root.directoryId])

/** 新版本身份不依赖本地目录、文件名、集号或重试次数。 */
export const automaticReleaseKey = (root: WatchRoot, version: { name: string; resolution: string; dynamicRange: string }) =>
  stableKey('watch-r1', [root.binding.url, root.binding.publisherId, root.binding.sourceAccount.id, root.work,
    root.seasonNumber ?? null, version.name.toUpperCase(), version.resolution.toUpperCase(), version.dynamicRange.toUpperCase()])

/** 目录移动、重建监控、文件改名都不改变发布目标；不同作品版本或源账号保持独立。 */
export const targetKey = (root: WatchRoot, episode?: number, releaseId = root.releaseId) =>
  stableKey('watch-target', [root.binding.url, root.binding.sourceAccount.id, releaseId, episode ?? null])

/** 目录及逐文件确认共用输入校验；空值代表继续从文件名判断。 */
export function validateSource(value?: ReleaseSource): ReleaseSource {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('来源预设无效')
  if (value?.platform !== undefined && typeof value.platform !== 'string') throw new Error('来源平台无效')
  if (value?.type !== undefined && typeof value.type !== 'string') throw new Error('来源类型无效')
  const platform = normalizePlatform(value?.platform)
  const type = value?.type ? releaseTypes.find(t => t.toUpperCase() === value.type!.toUpperCase()) : undefined
  if (platform && !/^[A-Z][A-Z0-9]{0,19}$/.test(platform)) throw new Error('平台请使用 1–20 位字母或数字标签')
  if (value?.type && !type) throw new Error('请选择有效来源类型')
  return { platform: platform || undefined, type }
}
