/** 独立发布清单保留任务身份和成品检测，清空下载列表不会丢失后续上传所需信息。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { configPath } from '../../lib/config.ts'
import type { PublicationDraft } from './publication-types.ts'

export const publicationDirectory = () => join(dirname(configPath()), 'plutofish-publications')

/** 写失败向调用方报错；入队必须先落盘，再开始下载。 */
export function savePublication(draft: PublicationDraft, directory = publicationDirectory()): void {
  if (!/^gvs-f1:[a-f0-9]{64}$/.test(draft.fileKey)) throw new Error('发布文件标识无效')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, `${draft.fileKey.replace(':', '-')}.json`)
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    // 同一视频重新下载时保留上次成品；新任务实际完成后再替换，避免入队失败损失已有检测。
    if (!draft.output && existsSync(target) && JSON.parse(readFileSync(target, 'utf8')).output) return
    writeFileSync(tmp, JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, target)
  } catch {
    throw new Error('发布信息保存失败，请检查本机目录权限后重试')
  } finally {
    rmSync(tmp, { force: true })
  }
}
