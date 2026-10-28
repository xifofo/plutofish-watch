import { writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { removeScratch, scratchDir } from './scratch.ts'

/** Use the task's saved group, just like its filename; settings are the legacy fallback. */
export function releaseGroup(task: { group?: string }, cfg?: { releaseGroup: string }): string {
  return (task.group?.trim() || cfg?.releaseGroup || '').trim()
}

function groupValue(group: string): string {
  // XML 1.0 and process arguments cannot carry these control characters.
  return group.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').trim()
}

export function groupTagsXML(group: string): string {
  const value = groupValue(group).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Tags><Tag><Targets/><Simple><Name>GROUP</Name><String>${value}</String></Simple></Tag></Tags>\n`
}

/** Add a global tag during the existing MKV mux, without a second media copy. */
export async function withMkvGroupTags<T>(out: string, group: string, mux: (args: string[]) => Promise<T>): Promise<T> {
  const value = groupValue(group)
  if (!value || extname(out).toLowerCase() !== '.mkv') return mux([])
  const work = scratchDir(out, 'group-tags-')
  try {
    const tags = join(work, 'group.xml')
    writeFileSync(tags, groupTagsXML(value), 'utf8')
    return await mux(['--global-tags', tags])
  } finally {
    removeScratch(work)
  }
}

/** FFmpeg's Matroska muxer stores arbitrary global metadata as SimpleTags. */
export function ffmpegGroupArgs(out: string, group = ''): string[] {
  const value = groupValue(group)
  return value && extname(out).toLowerCase() === '.mkv' ? ['-metadata', `GROUP=${value}`] : []
}
