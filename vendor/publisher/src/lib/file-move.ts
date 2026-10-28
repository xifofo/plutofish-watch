import { copyFileSync, renameSync, unlinkSync } from 'node:fs'

/** Move a completed artifact even when source and destination are on different volumes. */
export function moveFileSync(source: string, destination: string): void {
  try {
    renameSync(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  try {
    copyFileSync(source, destination)
    unlinkSync(source)
  } catch (error) {
    // Do not leave a partial destination that could be mistaken for a finished file.
    try { unlinkSync(destination) } catch { /* preserve the copy error */ }
    throw error
  }
}
