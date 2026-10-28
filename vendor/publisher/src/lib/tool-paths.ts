import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Both src/lib and the compiled dist use the checkout's shared bin directory.
 * Prefer the repository over stale bin folders from an earlier packaged build.
 */
export function toolDirectoryFrom(modulePath: string): string {
  const here = dirname(modulePath)
  if (existsSync(join(here, '..', '..', 'package.json'))) return join(here, '..', '..', 'bin')
  if (existsSync(join(here, '..', 'package.json'))) return join(here, '..', 'bin')
  return join(here, 'bin')
}

export function tuiBinDir(): string {
  return toolDirectoryFrom(fileURLToPath(import.meta.url))
}

/** Managed downloader follows the checkout, or the desktop app's resources. */
export function m3u8dlPath(): string {
  return join(tuiBinDir(), process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE')
}

/** Read-only helper bundled with the app; separate from writable media wrappers. */
export function iqcnLocalPath(): string {
  return join(tuiBinDir(), process.platform === 'win32' ? 'iqcn-local.exe' : 'iqcn-local')
}
