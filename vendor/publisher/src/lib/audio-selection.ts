type SelectableAudio = { id: string; label?: string; codec?: string; isDefault?: boolean; embedded?: boolean }

/** The app's audio preference: DTS, Dolby, AAC, then unrecognized formats. */
function audioTier(a: SelectableAudio): number {
  const text = `${a.id} ${a.codec ?? ''} ${a.label ?? ''}`.toLowerCase()
  if (/dts|cmfa3/.test(text)) return 0
  if (/atmos|cmfa4|dolby|杜比|全景声|e-?ac-?3|\bac-?3\b/.test(text)) return 1
  if (/aac|cmfa1/.test(text)) return 2
  return 3
}

function highestAudio(audios: readonly SelectableAudio[]): SelectableAudio | undefined {
  // Keep the probe's language/order preference when two tracks have the same tier.
  return audios.reduce<SelectableAudio | undefined>((best, a) =>
    !best || audioTier(a) < audioTier(best) ? a : best, undefined)
}

/** Only a selected, separately downloaded track can become the output default. */
export function resolveDefaultAudioId(
  audios: readonly SelectableAudio[], selectedIds: readonly string[], preferredId = '',
): string {
  const selected = audios.filter(a => !a.embedded && selectedIds.includes(a.id))
  return selected.find(a => a.id === preferredId)?.id
    ?? highestAudio(selected)?.id
    ?? ''
}

/** Clone the probe tracks and stamp exactly one output default onto the selection. */
export function selectAudioTracks<T extends SelectableAudio>(
  audios: readonly T[], selectedIds: readonly string[], preferredId?: string,
): Array<T & { isDefault: boolean }> {
  let selected = audios.filter(a => !a.embedded && selectedIds.includes(a.id))
  if (!selected.length) {
    const id = resolveDefaultAudioId(audios, audios.map(a => a.id))
    selected = audios.filter(a => !a.embedded && a.id === id).slice(0, 1)
  }
  if (preferredId && !selected.some(a => a.id === preferredId)) {
    throw new Error('默认音轨必须是已选音轨，请重新选择')
  }
  const id = resolveDefaultAudioId(selected, selected.map(a => a.id), preferredId)
  return selected.map(a => ({ ...a, isDefault: a.id === id }))
}

/** A batch episode may omit the preferred track; use the first available one. */
export function defaultAudioIndex(audios: readonly { isDefault?: boolean }[]): number {
  const index = audios.findIndex(a => a.isDefault)
  return index === -1 ? 0 : index
}

/** Put the chosen output default first without changing the other tracks' order.
 * Clone and normalize flags so old queues with missing/duplicate defaults also
 * have exactly one default. The saved selection and source metadata stay intact.
 */
export function orderedMuxAudios<T extends { isDefault?: boolean }>(audios: readonly T[]): Array<Omit<T, 'isDefault'> & { isDefault: boolean }> {
  if (!audios.length) return []
  const index = defaultAudioIndex(audios)
  return [audios[index]!, ...audios.filter((_, i) => i !== index)]
    .map((audio, i) => ({ ...audio, isDefault: i === 0 }))
}
