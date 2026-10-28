import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A uniquely named folder for one temp operation, inside `base`. */
function uniqueDir(base: string, prefix: string): string {
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

/**
 * Working directory for a download or mux, beside `anchor` so the bytes stay
 * on the same volume as the user's library. System temp is the fallback only
 * when that folder cannot be created.
 */
export function scratchDir(anchor: string, prefix: string): string {
  const base = join(dirname(anchor), '.gvs-tmp')
  try {
    return uniqueDir(base, prefix)
  } catch {
    return mkdtempSync(join(tmpdir(), prefix))
  }
}

/**
 * Working directory under an explicit root (the configured tmpDir / job work
 * dir). The system temp fallback still exists, but it is reported through
 * `note` so a configured folder never silently spills onto the system drive.
 */
export function scratchDirIn(root: string | undefined, prefix: string, note?: (msg: string) => void): string {
  if (!root) return mkdtempSync(join(tmpdir(), prefix))
  try {
    return uniqueDir(root, prefix)
  } catch (e) {
    note?.(`无法在 ${root} 创建工作目录（${e instanceof Error ? e.message : String(e)}），改用系统临时目录`)
    return mkdtempSync(join(tmpdir(), prefix))
  }
}

/** Reuse fragments only after the provider has supplied a matching content identity. */
export function resumeScratchDir(root: string, identity: string, note?: (msg: string) => void): string {
  if (!/^[a-f\d]{64}$/.test(identity)) throw new Error('下载续传身份格式无效')
  let names: string[] = []
  try { names = readdirSync(root) } catch { /* first download */ }
  for (const name of names) {
    if (!name.startsWith('re-')) continue
    const dir = join(root, name)
    try {
      const state = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8'))
      if (state.version === 1 && state.identity === identity) return dir
    } catch { /* unknown or incompatible cache stays intact */ }
  }
  const dir = scratchDirIn(root, 're-', note)
  writeFileSync(join(dir, 'resume.json'), JSON.stringify({ version: 1, identity }))
  return dir
}

/** Remove a scratch directory and the `.gvs-tmp` parent when nothing else is using it. */
export function removeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  try { rmdirSync(dirname(dir)) } catch { /* another download still has a folder here */ }
}
