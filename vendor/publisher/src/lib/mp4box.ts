import { spawn } from 'node:child_process'
import { defaultAudioIndex, orderedMuxAudios } from './audio-selection.ts'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { mkvLang, type MuxAudio } from './mkvmerge.ts'
import { removeScratch, scratchDir } from './scratch.ts'
import { isUnknownAudioLanguage, resolveAudioLanguage } from './audio-language.ts'

export function isDtsAudio(track: { id?: string; label?: string; codec?: string }): boolean {
  return /dts/i.test(`${track.id ?? ''} ${track.label ?? ''} ${track.codec ?? ''}`)
}

export function mp4Lang(lang: string): string {
  const mapped = mkvLang(lang)
  // GPAC expects terminology codes; 'chi' is interpreted differently by some builds.
  if (mapped === 'chi') return 'zho'
  if (/^(aac|dts)$/.test(mapped) || /dolby|atmos/i.test(lang)) return 'und'
  return mapped
}

type Edit = { duration: number; mediaTime: number }
export type Mp4Track = {
  id: number; type: string; codec: string; scale: number; movieScale: number
  edits: Edit[]; language: string; name: string; duration: number
  enabled?: boolean
  /** Decoded channel count from codec configuration, not the legacy sample-entry placeholder. */
  channels?: number
}
export type Mp4TrackScan = Mp4Track & {
  samples: number; bytes: number; firstMs: number; timelineHash: string; payloadHash?: string
}

function attr(tag: string, key: string): string {
  return new RegExp(`\\b${key}="([^"]*)"`).exec(tag)?.[1] ?? ''
}

/** MP4Box's box dump is codec independent; FFmpeg need not recognize DTS-UHD. */
export function parseMp4Tracks(xml: string): Mp4Track[] {
  const movieScale = Number(attr(/<MovieHeaderBox\b[^>]*>/.exec(xml)?.[0] ?? '', 'TimeScale'))
  if (!(movieScale > 0)) throw new Error('MP4 缺少有效 movie timescale')
  return [...xml.matchAll(/<TrackBox\b[^>]*>([\s\S]*?)<\/TrackBox>/g)].map((match) => {
    const block = match[1]!
    const header = /<TrackHeaderBox\b[^>]*>/.exec(block)?.[0] ?? ''
    const media = /<MediaHeaderBox\b[^>]*>/.exec(block)?.[0] ?? ''
    const handler = /<HandlerBox\b[^>]*\bhdlrType="(?:vide|soun)"[^>]*>/.exec(block)?.[0] ?? ''
    const descriptions = /<SampleDescriptionBox\b[^>]*>([\s\S]*?)<\/SampleDescriptionBox>/.exec(block)?.[1] ?? ''
    const description = /<\w+\b[^>]*\bType="[^"]+"[^>]*>/.exec(descriptions)?.[0] ?? ''
    const edits = [...block.matchAll(/<EditListEntry\b[^>]*\/>/g)].map(([entry]) => {
      if (Number(attr(entry, 'MediaRate')) !== 1) throw new Error('暂不支持变速 MP4 编辑列表')
      return { duration: Number(attr(entry, 'Duration')), mediaTime: Number(attr(entry, 'MediaTime')) }
    })
    if (edits.filter(e => e.mediaTime !== -1).length > 1 || edits.some((e, i) => e.mediaTime === -1 && i === edits.length - 1)) {
      throw new Error('暂不支持多段 MP4 编辑列表')
    }
    const track = { id: Number(attr(header, 'TrackID')), type: attr(handler, 'hdlrType'), codec: attr(description, 'Type'),
      scale: Number(attr(media, 'TimeScale')), movieScale, edits, language: attr(media, 'LanguageCode'), name: attr(handler, 'Name'), duration: Number(attr(media, 'Duration')) }
    const flags = attr(header, 'Flags')
    const enabled = flags ? (Number.parseInt(flags, flags.startsWith('0x') ? 16 : 10) & 1) !== 0 : undefined
    let channels: number | undefined
    if (track.codec === 'dtsx' || track.codec === 'dtsy') {
      const count = Number(attr(description, 'Channels'))
      if (Number.isSafeInteger(count) && count > 0) channels = count
    } else if (track.codec === 'ec-3') {
      // ISO sample-entry Channels is commonly 2 even for DDP 5.1. Only use
      // dec3's actual independent stream configuration, without dependents.
      const configs = [...descriptions.matchAll(/<EC3StreamConfig\b[^>]*\/>/g)]
      if (configs.length === 1 && attr(configs[0]![0], 'num_sub_dep') === '0') {
        const config = configs[0]![0], acmod = attr(config, 'acmod'), lfe = attr(config, 'lfon')
        if (/^[0-7]$/.test(acmod) && /^[01]$/.test(lfe)) channels = [2, 1, 2, 3, 3, 4, 4, 5][Number(acmod)]! + Number(lfe)
      }
    }
    if (!track.id || !(track.scale > 0) || !track.codec || !track.type) throw new Error('MP4 轨道信息不完整')
    if (track.codec === 'enca' || track.codec === 'encv') throw new Error('MP4 轨道仍处于加密状态')
    return { ...track, ...(enabled !== undefined ? { enabled } : {}), ...(channels ? { channels } : {}) }
  })
}

export function presentationMs(track: Mp4Track, cts: number): number {
  const lead = track.edits.filter(e => e.mediaTime === -1).reduce((n, e) => n + e.duration, 0)
  const mediaTime = track.edits.find(e => e.mediaTime !== -1)?.mediaTime ?? 0
  return 1000 * (lead / track.movieScale + (cts - mediaTime) / track.scale)
}

type Mp4RunOpts = {
  consume?: (chunk: string) => void
  phase?: { out: string; total: number; cb?: (n: number, total: number) => void }
  signal?: AbortSignal
  /** Resolve early — killing MP4Box — once the consumer has what it needs. */
  done?: () => boolean
}

function run(bin: string, args: string[], opts: Mp4RunOpts = {}): Promise<void> {
  const { consume, phase, signal, done } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '0', '-noprog', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let error = '', parseError: unknown
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearInterval(timer)
      resolve()
    }
    const timer = phase?.cb ? setInterval(() => {
      try { phase.cb?.(statSync(phase.out).size, phase.total) } catch { /* not created yet */ }
    }, 250) : undefined
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s: string) => {
      if (finished) return
      try { consume?.(s) } catch (e) { parseError = e; child.kill(); return }
      // `-disox` keeps dumping after </MovieBox>; nothing reads it, so stop.
      if (done?.()) { child.kill(); finish() }
    })
    child.stderr.on('data', b => { error = (error + b.toString()).slice(-4000) })
    child.once('error', e => { clearInterval(timer); reject(signal?.aborted ? (signal.reason ?? e) : e) })
    child.once('close', code => {
      clearInterval(timer)
      if (finished) return
      if (signal?.aborted) { reject(signal.reason ?? new Error('已停止')); return }
      if (parseError) reject(parseError)
      else if (code !== 0) reject(new Error(`MP4Box: exit ${code} ${error.trim()}`))
      else resolve()
    })
  })
}

export async function readMp4Tracks(mp4box: string, path: string, signal?: AbortSignal): Promise<Mp4Track[]> {
  // Only retain moov metadata, not the potentially huge list of fragments.
  let xml = '', moovDone = false
  await run(mp4box, ['-std', '-disox', path], {
    signal,
    consume: chunk => {
      if (moovDone) return
      xml += chunk
      const end = xml.indexOf('</MovieBox>')
      if (end !== -1) { xml = xml.slice(0, end + 11); moovDone = true }
      if (xml.length > 8 * 1024 * 1024) throw new Error('MP4 元数据过大')
    },
    done: () => moovDone,
  })
  return parseMp4Tracks(xml)
}

export async function inspectMp4(mp4box: string, path: string, signal?: AbortSignal): Promise<Mp4TrackScan[]> {
  const metadata = await readMp4Tracks(mp4box, path, signal)
  if (!metadata.length) throw new Error('MP4 没有媒体轨道')
  const tracks = metadata.map(t => ({ ...t, samples: 0, bytes: 0, minCts: Infinity,
    firstDts: NaN, lastDts: -Infinity, timeline: createHash('sha256'),
    payload: t.type === 'soun' ? createHash('sha256') : undefined }))
  const fd = openSync(path, 'r'), length = statSync(path).size, buffer = Buffer.alloc(1024 * 1024)
  let current: typeof tracks[number] | undefined, tail = ''
  const line = (s: string) => {
    const id = /^#dumping track ID (\d+) timing:/.exec(s)
    if (id) { current = tracks.find(t => t.id === Number(id[1])); return }
    if (!s.startsWith('Sample ')) return
    const m = /^Sample (\d+)\tDTS (\d+)\tCTS (-?\d+)\t(\d+)\t\d+\t(\d+)/.exec(s)
    if (!m || !current) throw new Error('MP4Box 返回了无效分片时间戳')
    const [, sample, dtsText, ctsText, sizeText, offsetText] = m
    const dts = Number(dtsText), cts = Number(ctsText), size = Number(sizeText), offset = Number(offsetText)
    if (![dts, cts, size, offset].every(Number.isSafeInteger) || size <= 0 || offset < 0 || offset + size > length
      || dts <= current.lastDts || Number(sample) !== current.samples + 1) throw new Error('MP4 样本缺失或时间戳损坏')
    if (!current.samples) current.firstDts = dts
    current.samples++; current.bytes += size; current.minCts = Math.min(current.minCts, cts); current.lastDts = dts
    current.timeline.update(`${dts - current.firstDts},${cts - current.firstDts},${size}\n`)
    if (current.payload) {
      for (let n = 0; n < size;) {
        const got = readSync(fd, buffer, 0, Math.min(buffer.length, size - n), offset + n)
        if (!got) throw new Error('MP4 音频样本被截断')
        current.payload.update(buffer.subarray(0, got)); n += got
      }
    }
  }
  try {
    await run(mp4box, ['-std', '-dts', path], {
      signal,
      consume: chunk => {
        const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() ?? ''; lines.forEach(line)
      },
    })
    if (tail.trim()) line(tail)
    return tracks.map(({ minCts, firstDts, lastDts, timeline, payload, ...t }) => {
      if (!t.samples) throw new Error('MP4 轨道没有有效样本')
      return { ...t, firstMs: presentationMs(t, minCts), timelineHash: timeline.digest('hex'), payloadHash: payload?.digest('hex') }
    })
  } finally { closeSync(fd) }
}

export function assertMp4Preserved(source: Mp4TrackScan[], output: Mp4TrackScan[]): void {
  if (source.length !== output.length) throw new Error('MP4 封装轨道数量不符')
  source.forEach((a, i) => {
    const b = output[i]!
    if (a.type !== b.type || a.codec !== b.codec || a.scale !== b.scale || a.samples !== b.samples || a.bytes !== b.bytes
      || a.timelineHash !== b.timelineHash || a.payloadHash !== b.payloadHash || Math.abs(a.firstMs - b.firstMs) > 2) {
      throw new Error(`MP4 第 ${i + 1} 条轨道内容或时间戳未保留，已保留中间文件`)
    }
  })
}

/** Shift edit lists without overwriting the existing media trim (as -delay does). */
export function shiftedEdits(track: Mp4Track, deltaMs: number): string {
  const lead = track.edits.filter(e => e.mediaTime === -1).reduce((n, e) => n + e.duration, 0) / track.movieScale + deltaMs / 1000
  const regular = track.edits.find(e => e.mediaTime !== -1)
  const trim = Math.max(0, -lead)
  const start = Math.max(0, lead)
  const media = (regular?.mediaTime ?? 0) / track.scale + trim
  const duration = (regular ? regular.duration / track.movieScale : track.duration / track.scale) - trim
  if (![start, media, duration].every(Number.isFinite) || duration <= 0) throw new Error('无法保留 MP4 编辑列表')
  const time = (n: number) => `${Math.round(n * 1000000)}/1000000`
  return `r${start ? `e0-${time(start)}` : ''}e${time(start)}-${time(duration)},${time(media)}`
}

/** Import MP4 tracks directly, retaining edit lists and original coded samples.
 * Do not set :delay=0: MP4Box would replace the source edit list (including B-frame trims).
 */
export async function mp4boxMux(mp4box: string, video: string, audios: MuxAudio[], out: string,
  progress?: (n: number, total: number) => void, signal?: AbortSignal, languageFallback = ''): Promise<void> {
  audios = orderedMuxAudios(audios)
  const tmp = scratchDir(out, 'gvs-mp4box-')
  const report: Record<string, unknown> = { version: 1, muxer: 'MP4Box', verified: false }
  try {
    if (audios.some(a => a.delayMs)) throw new Error('MP4Box 使用源时间轴，不接受额外音轨偏移')
    const sources = [video, ...audios.map(a => a.path)]
    const before: Mp4TrackScan[] = []
    const args: string[] = ['-tmp', tmp]
    const defaultIndex = defaultAudioIndex(audios)
    const probed = await Promise.all(sources.map(path => inspectMp4(mp4box, path, signal)))
    for (const [i, path] of sources.entries()) {
      const type = i === 0 ? 'vide' : 'soun'
      const tracks = probed[i]!.filter(t => t.type === type)
      if (tracks.length !== 1) throw new Error('MP4Box 输入必须包含一条所选类型轨道')
      before.push(tracks[0]!)
      args.push('-add', `${path}#trackID=${tracks[0]!.id}:ID=${i + 1}${i ? ':group=1' : ''}`)
      if (!i && languageFallback && isUnknownAudioLanguage(tracks[0]!.language)) {
        args.push('-lang', `${i + 1}=${mp4Lang(languageFallback)}`)
      }
      if (i) {
        args.push('-lang', `${i + 1}=${mp4Lang(resolveAudioLanguage(audios[i - 1]!.lang, tracks[0]!.language, languageFallback))}`)
        args.push('-name', `${i + 1}=`)
        args.push(i - 1 === defaultIndex ? '-enable' : '-disable', String(i + 1))
      }
    }
    args.push('-timescale', '1000000', '-new', out)
    report.source = before
    await run(mp4box, args, { signal, phase: { out, total: sources.reduce((n, p) => n + statSync(p).size, 0), cb: progress } })
    let after = await inspectMp4(mp4box, out, signal)
    if (after.length !== before.length) throw new Error('MP4 封装轨道数量不符')
    // Importing fragmented MP4 can discard the original first tfdt even when
    // the existing edit list is retained. Restore only the measured shift.
    const edits: string[] = []
    after.forEach((track, i) => {
      const delta = before[i]!.firstMs - track.firstMs
      if (Math.abs(delta) > 0.01) edits.push('-edits', `${track.id}=${shiftedEdits(track, delta)}`)
    })
    if (edits.length) {
      report.initialOutput = after
      // GPAC otherwise stages its rewrite in the system %TEMP% (C:), which
      // would copy the whole file across volumes.
      await run(mp4box, [...edits, '-tmp', tmp, out], { signal })
      after = await inspectMp4(mp4box, out, signal)
    }
    report.output = after
    assertMp4Preserved(before, after)
    report.verified = true
    writeFileSync(`${out}.timing.json`, JSON.stringify(report, null, 2) + '\n')
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e)
    try { writeFileSync(`${out}.timing.json`, JSON.stringify(report, null, 2) + '\n') } catch { /* preserve original failure */ }
    throw e
  } finally {
    try { removeScratch(tmp) } catch { /* output already written */ }
  }
}
