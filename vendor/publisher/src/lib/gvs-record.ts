import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import type { ActualVersion, CompletedMedia, GVSActualRecord, MediaSpecs } from './actual-version.ts'
import { readMp4Tracks, type Mp4Track } from './mp4box.ts'
import { lookHostFFmpeg, lookMP4Box, tuiBinDir } from './tools.ts'

/** Bounded content sampling survives rename/move and detects many accidental record/file mismatches. */
export function fileFingerprint(path: string): GVSActualRecord['file'] {
  const size = statSync(path).size
  const length = Math.min(65536, size)
  const offsets = [...new Set([0, Math.floor((size - length) / 2), size - length])]
  const hash = createHash('sha256').update(`${size}\n`)
  const fd = openSync(path, 'r')
  try {
    for (const offset of offsets) {
      const bytes = Buffer.alloc(length)
      let count = 0
      while (count < length) {
        const n = readSync(fd, bytes, count, length - count, offset + count)
        if (!n) throw new Error('成品文件在读取期间发生变化')
        count += n
      }
      hash.update(`${offset}\n`).update(bytes)
    }
  } finally { closeSync(fd) }
  return { size, fingerprint: { algorithm: 'sha256-samples-v1', value: hash.digest('hex') } }
}

const positive = (v: unknown): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
const ratio = (v: unknown): number => {
  const [a, b] = String(v || '').split('/').map(Number)
  return a && b ? a / b : 0
}
const trackDuration = (v: unknown): number => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v || ''))
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}

export type ProbeAudioOptions = {
  /** Position among the audio tracks that were actually muxed, after any soft skips. */
  muxAudio?: { index: number; count: number }
  /** MP4 tkhd enable flags, independent of FFmpeg's inferred default disposition. */
  enabledAudioTrackIds?: number[]
  /** Codec-independent MP4 metadata, matched by track ID rather than position. */
  mp4AudioTracks?: Mp4Track[]
}

function defaultAudio(streams: Array<Record<string, any>>, options: ProbeAudioOptions): NonNullable<MediaSpecs['audio']> {
  const tracks = streams.filter(s => s.codec_type === 'audio')
  if (!tracks.length) return { status: 'none' }
  if (options.enabledAudioTrackIds?.length === 0) return { status: 'ambiguous' }
  let index = -1, evidence: NonNullable<MediaSpecs['audio']>['evidence']
  if (options.enabledAudioTrackIds !== undefined) {
    const enabled = tracks.map((s, i) => options.enabledAudioTrackIds!.includes(Number(s.id)) ? i : -1).filter(i => i >= 0)
    if (enabled.length === 1 && options.enabledAudioTrackIds.length === 1) { index = enabled[0]!; evidence = 'mp4_enabled' }
  } else {
    const defaults = tracks.map((s, i) => s.disposition?.default === 1 || s.disposition?.default === true ? i : -1).filter(i => i >= 0)
    if (defaults.length === 1) { index = defaults[0]!; evidence = 'container' }
  }
  const mux = options.muxAudio
  if (index < 0 && mux && mux.count === tracks.length && Number.isSafeInteger(mux.index) && mux.index >= 0 && mux.index < tracks.length) {
    index = mux.index; evidence = 'mux_order'
  }
  if (index < 0 && tracks.length === 1 && (options.enabledAudioTrackIds === undefined || options.enabledAudioTrackIds.length === 1)) {
    index = 0; evidence = 'single_track'
  }
  if (index < 0) return { status: 'ambiguous' }
  const audio = tracks[index]!
  const mp4 = options.mp4AudioTracks?.find(t => t.type === 'soun' && t.id === Number(audio.id))
  const tag = mp4?.codec || audio.codec_tag_string
  const codec = /^dts[xy]$/.test(tag || '') ? 'dtsx'
    : typeof audio.codec_name === 'string' && audio.codec_name !== 'unknown' ? audio.codec_name : undefined
  const channels = positive(audio.channels) || positive(mp4?.channels)
  return { status: 'confirmed', index, evidence, ...(positive(audio.id) ? { trackId: Number(audio.id) } : {}),
    ...(codec ? { codec } : {}), ...(channels ? { channels } : {}),
    ...(/atmos|\bjoc\b/i.test(String(audio.profile || '')) ? { atmos: true } : {}) }
}

export function mediaSpecsFromProbe(payload: string, options: ProbeAudioOptions = {}): MediaSpecs {
  try {
    const data = JSON.parse(payload)
    const v = data.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video' && !(s.disposition as Record<string, unknown>)?.attached_pic)
    if (!v) return { status: 'unavailable' }
    const result: MediaSpecs = { status: 'probed', codec: String(v.codec_name || 'unknown') }
    const fields = {
      width: positive(v.width), height: positive(v.height), fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate),
      durationSeconds: positive(v.duration) || trackDuration(v.tags?.DURATION || v.tags?.['DURATION-eng']),
      videoBitrate: positive(v.bit_rate) || positive(v.tags?.BPS) || positive(v.tags?.['BPS-eng']),
    }
    for (const [key, value] of Object.entries(fields)) if (value) (result as Record<string, unknown>)[key] = value
    if (v.side_data_list?.some((s: Record<string, unknown>) => /dovi|dolby vision/i.test(String(s.side_data_type)))) result.dynamicRange = 'DV'
    else if (v.color_transfer === 'smpte2084') result.dynamicRange = 'HDR'
    else if (v.color_transfer === 'arib-std-b67') result.dynamicRange = 'HLG'
    else if (['bt709', 'smpte170m', 'smpte240m', 'bt2020-10', 'bt2020-12', 'iec61966-2-1'].includes(v.color_transfer)) result.dynamicRange = 'SDR'
    result.audio = defaultAudio(data.streams, options)
    return result
  } catch { return { status: 'unavailable' } }
}

/** Bundled ffprobe (repo bin / installed resources\\bin) first, then PATH; never downloaded. */
export function hostFFprobe(): string | undefined {
  const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return [tuiBinDir(), ...(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')]
    .map(dir => join(dir, executable)).find(p => { try { return statSync(p).isFile() } catch { return false } })
}

const channelLayouts: Record<string, number> = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, quad: 4, '4.0': 4, '4.1': 5, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 }

/**
 * Stream header that FFmpeg prints for `ffmpeg -i` (stderr), as ffprobe-shaped
 * streams. Windows installs ship ffmpeg but no ffprobe; this reads the same
 * container/codec headers without decoding. Unrecognized lines are ignored, so
 * missing fields stay missing instead of being guessed.
 */
export function ffprobeStreamsFromFFmpegInfo(text: string): Array<Record<string, any>> {
  const streams: Array<Record<string, any>> = []
  let current: Record<string, any> | undefined
  let section: 'metadata' | 'side' | '' = ''
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*Stream #\d+:(\d+)(?:\[(0x[0-9a-f]+)\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/i.exec(line)
    if (head) {
      const [, index, id, language, kind, rest] = head
      const codecType = kind!.toLowerCase()
      const codec = /^([\w-]+)(?: \(([^)]*)\))?/.exec(rest!)
      current = { index: Number(index), codec_type: codecType, codec_name: codec?.[1] || 'unknown',
        ...(codec?.[2] && !/ \/ 0x/.test(codec[2]) ? { profile: codec[2] } : {}),
        ...(id ? { id } : {}), tags: language && language !== 'und' ? { language } : {},
        disposition: { default: / \(default\)/.test(rest!) ? 1 : 0, attached_pic: / \(attached pic\)/.test(rest!) ? 1 : 0 } }
      const bitrate = /(?:^|, )(\d+) kb\/s/.exec(rest!)
      if (bitrate) current.bit_rate = String(Number(bitrate[1]) * 1000)
      if (codecType === 'video') {
        const size = /(?:^|[ ,])(\d{2,5})x(\d{2,5})(?=[ ,\[]|$)/.exec(rest!)
        if (size) { current.width = Number(size[1]); current.height = Number(size[2]) }
        const fps = /, ([\d.]+) fps/.exec(rest!)
        if (fps) {
          // FFmpeg rounds NTSC rates to two decimals (23.98); restore the exact x/1001 rate.
          const value = Number(fps[1]), ntsc = Math.round(value * 1.001)
          current.avg_frame_rate = value % 1 && Math.abs(ntsc * 1000 / 1001 - value) < 0.006 ? `${ntsc * 1000}/1001` : `${Math.round(value * 1000)}/1000`
        }
        // Pixel format details: "(tv, bt2020nc/bt2020/smpte2084)" or "(tv, bt709, progressive)".
        const color = /^[\w-]+(?: \([^)]*\))*(?: \([^)]*\))?, \w+\(([^)]*)\)/.exec(rest!)
        for (const part of color?.[1]?.split(',').map(s => s.trim()) ?? []) {
          const triple = part.split('/')
          if (triple.length === 3) current.color_transfer = triple[2]
          else if (/^(bt709|bt470bg|smpte170m|smpte240m|bt2020nc|bt2020c)$/.test(part) && !current.color_transfer) current.color_transfer = part === 'bt2020nc' || part === 'bt2020c' ? '' : part
        }
        if (!current.color_transfer) delete current.color_transfer
      } else if (codecType === 'audio') {
        const parts = rest!.split(', ').map(s => s.trim())
        for (const part of parts) {
          const layout = /^([\w.]+)(?:\([^)]*\))?$/.exec(part)?.[1]
          if (layout && channelLayouts[layout]) { current.channels = channelLayouts[layout]; break }
          const count = /^(\d+) channels$/.exec(part)
          if (count) { current.channels = Number(count[1]); break }
        }
      }
      streams.push(current)
      section = ''
      continue
    }
    if (/^\S/.test(line) || /^\s{0,2}\S/.test(line)) { current = undefined; section = ''; continue }
    if (!current) continue
    if (/^\s+Metadata:\s*$/.test(line)) { section = 'metadata'; continue }
    if (/^\s+Side data:\s*$/.test(line)) { section = 'side'; continue }
    if (section === 'metadata') {
      const tag = /^\s+([^:]+?)\s*:\s(.*)$/.exec(line)
      if (tag) current.tags[tag[1]!] = tag[2]
    } else if (section === 'side') {
      const side = /^\s+([^:]+?):/.exec(line)?.[1]
      if (side) (current.side_data_list ||= []).push({ side_data_type: side })
    }
  }
  return streams
}

function captureTool(command: string, args: string[], stream: 'stdout' | 'stderr', signal?: AbortSignal): Promise<{ output: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', stream === 'stdout' ? 'pipe' : 'ignore', stream === 'stderr' ? 'pipe' : 'ignore'], signal })
    let output = '', settled = false
    const finish = (code: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ output: code === null ? '' : output, code }) } }
    const timer = setTimeout(() => { child.kill(); finish(null) }, 15000)
    const pipe = child[stream]!
    pipe.setEncoding('utf8')
    pipe.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 524288) { child.kill(); finish(null) }
    })
    child.once('error', () => finish(null))
    child.once('close', code => finish(code))
  })
}

/**
 * Host ffprobe when present; otherwise the ffmpeg the app already uses for
 * muxing (Windows installs bundle ffmpeg only). No tool download and no
 * decoding of the full video.
 */
export async function probeFinishedMedia(path: string, signal?: AbortSignal, options: ProbeAudioOptions = {}): Promise<MediaSpecs> {
  const candidate = hostFFprobe()
  let payload = ''
  if (candidate) {
    const run = await captureTool(candidate, ['-v', 'error', '-probesize', '8M', '-analyzeduration', '8000000',
      '-show_streams', '-show_format', '-of', 'json', path], 'stdout', signal)
    payload = run.code === 0 ? run.output : ''
  } else {
    const ffmpeg = lookHostFFmpeg()
    if (!ffmpeg) return { status: 'unavailable' }
    // Without an output file ffmpeg exits non-zero after printing the input header.
    const run = await captureTool(ffmpeg, ['-hide_banner', '-nostdin', '-probesize', '8M', '-analyzeduration', '8000000', '-i', path], 'stderr', signal)
    const streams = run.code === null ? [] : ffprobeStreamsFromFFmpegInfo(run.output)
    payload = streams.length ? JSON.stringify({ streams }) : ''
  }
  signal?.throwIfAborted()
  const mp4box = payload && extname(path).toLowerCase() === '.mp4' ? lookMP4Box() : ''
  if (mp4box) {
    try {
      const timeout = AbortSignal.timeout(15000)
      const tracks = (await readMp4Tracks(mp4box, path, signal ? AbortSignal.any([signal, timeout]) : timeout)).filter(t => t.type === 'soun')
      options = { ...options, mp4AudioTracks: tracks }
      if (tracks.length && tracks.every(t => t.enabled !== undefined)) {
        options = { ...options, enabledAudioTrackIds: tracks.filter(t => t.enabled).map(t => t.id) }
      }
    } catch { signal?.throwIfAborted() /* Fall back to the actual mux mapping or container metadata. */ }
  }
  return mediaSpecsFromProbe(payload, options)
}

export async function finishedVersionRecord(path: string, actual: ActualVersion, signal?: AbortSignal, probed?: MediaSpecs): Promise<GVSActualRecord> {
  const media = probed || await probeFinishedMedia(path, signal)
  signal?.throwIfAborted()
  return { ...actual, file: fileFingerprint(path), media }
}

/** Reuse the naming probe; older queued tasks can read specs without changing their filename. */
export async function finishedMediaRecord(path: string, signal?: AbortSignal, probed?: MediaSpecs,
  probe = probeFinishedMedia): Promise<CompletedMedia> {
  let media = probed
  if (!media) {
    try { media = await probe(path, signal) } catch {
      signal?.throwIfAborted()
      media = { status: 'unavailable' }
    }
  }
  signal?.throwIfAborted()
  return { media, file: { size: statSync(path).size } }
}

/** Shared by desktop and TUI; kept outside all video directories and task-list cleanup. */
export function versionRecordsPath(): string {
  if (process.env.GVS_VERSION_RECORDS_PATH) return process.env.GVS_VERSION_RECORDS_PATH
  const root = process.env.GVS_PROFILE_DIR || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'GVS')
    : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'GVS')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'GVS'))
  return join(root, 'actual-versions.jsonl')
}

export function saveVersionRecord(output: string, actualVersion: GVSActualRecord, destination = versionRecordsPath()): void {
  mkdirSync(dirname(destination), { recursive: true })
  // One append avoids concurrent completions replacing each other's records. A leading
  // newline also isolates a previous interrupted write; readers skip malformed lines.
  appendFileSync(destination, '\n' + JSON.stringify({ schemaVersion: 1, output, actualVersion }) + '\n', { encoding: 'utf8', mode: 0o600 })
}
