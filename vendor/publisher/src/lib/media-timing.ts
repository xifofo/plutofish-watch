import { spawn } from 'node:child_process'
import { isEac3CompatibilityDiagnostic, validateEac3WithAudioToolbox } from './eac3-validation.ts'

export function isEac3ProbeError(message: string): boolean {
  const detail = message.match(/读取原始时间戳失败 \(0\)[\s\S]*?: (\[eac3 @ [\s\S]*)$/)?.[1]
  if (!detail) return false
  const lines = detail.trim().split(/\r?\n/)
  return lines.some(line => /exponent -?\d+ is out-of-range/.test(line)) && lines.every(line =>
    /^\[eac3 @ [^\]]+\] (?:exponent -?\d+ is out-of-range|error decoding the audio block)$/.test(line.trim()))
}

/** Drop exactly one compressed packet, preserving all remaining packet PTS.
 * Decode the entire candidate before accepting it: later corruption is fatal.
 */
export async function dropFirstAudioPacket(ffmpeg: string, source: string, dest: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const run = (args: string[], probing: boolean) => new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', ...args],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
    let errors = '', overflow = false
    child.stderr.on('data', (b: Buffer) => {
      errors += b.toString()
      if (errors.length > 16000) { overflow = true; errors = errors.slice(-16000) }
    })
    child.once('error', e => reject(signal?.aborted ? signal.reason ?? e : e))
    child.once('close', code => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('已停止')); return }
      const known = probing && isEac3ProbeError(`读取原始时间戳失败 (0) a:0 source: ${errors}`)
      if (code !== 0 || overflow || (errors.trim() && !known)) reject(new Error(`首帧修复校验失败 (${code}): ${errors.slice(-4000)}`))
      else resolve()
    })
  })
  await run(['-copyts', '-i', source, '-map', '0:a:0', '-c', 'copy', '-bsf:a', 'noise=drop=eq(n\\,0)',
    '-avoid_negative_ts', 'disabled', '-y', dest], true)
  await run(['-i', dest, '-map', '0:a:0', '-f', 'null', '-'], false)
}

export type TrackTiming = {
  id: number
  type: string
  packets: number
  firstMs: number
  endMs: number
  maxGapMs: number
  maxOverlapMs: number
}

/** Parse packet PTS, not DTS or the container's advertised duration. */
export function frameCrcTiming() {
  const tracks = new Map<number, TrackTiming & { scale: number; previousEnd?: number }>()
  let tail = ''
  const line = (value: string) => {
    const tb = /^#tb (\d+): (\d+)\/(\d+)/.exec(value)
    if (tb) {
      tracks.set(Number(tb[1]), { id: Number(tb[1]), type: '', scale: 1000 * Number(tb[2]) / Number(tb[3]),
        packets: 0, firstMs: Infinity, endMs: -Infinity, maxGapMs: 0, maxOverlapMs: 0 })
      return
    }
    const type = /^#media_type (\d+): (\w+)/.exec(value)
    if (type) { const t = tracks.get(Number(type[1])); if (t) t.type = type[2]!; return }
    if (!/^\d+,/.test(value)) return
    const fields = value.split(',')
    const track = tracks.get(Number(fields[0]))
    if (!track) throw new Error('缺少轨道时基')
    const pts = Number(fields[2]) * track.scale
    const duration = Number(fields[3]) * track.scale
    if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration < 0) throw new Error('媒体时间戳无效')
    if (track.type === 'audio' && track.previousEnd !== undefined) {
      track.maxGapMs = Math.max(track.maxGapMs, pts - track.previousEnd)
      track.maxOverlapMs = Math.max(track.maxOverlapMs, track.previousEnd - pts)
    }
    track.packets++
    track.firstMs = Math.min(track.firstMs, pts)
    track.endMs = Math.max(track.endMs, pts + duration)
    track.previousEnd = pts + duration
  }
  return {
    feed(chunk: string) {
      const lines = (tail + chunk).split(/\r?\n/)
      tail = lines.pop() ?? ''
      lines.forEach(line)
    },
    finish(): TrackTiming[] {
      if (tail.trim()) line(tail)
      return [...tracks.values()].map(({ scale, previousEnd, ...t }) => t)
    },
  }
}

/** Read packet presentation time after MP4 edit lists/composition offsets.
 * A small reorder window is needed because the first decoded video packet
 * need not have the earliest PTS. Missing timestamps are an error, never zero.
 */
export async function firstPresentationMs(ffmpeg: string, path: string, stream: string, signal?: AbortSignal): Promise<number> {
  if (!/^[va]:\d+$/.test(stream)) throw new Error('无效媒体轨道选择')
  return new Promise((resolve, reject) => {
    const parser = frameCrcTiming()
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-copyts', '-i', path,
      '-map', `0:${stream}`, '-c', 'copy', '-frames:0', '64', '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let errors = '', overflow = false, parseError: unknown
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try { parser.feed(chunk) } catch (e) { parseError = e; child.kill() }
    })
    child.stderr.on('data', (b: Buffer) => {
      errors += b.toString()
      if (errors.length > 4000) { overflow = true; errors = errors.slice(-4000) }
    })
    child.once('error', (e) => reject(signal?.aborted ? (signal.reason ?? e) : e))
    child.once('close', async (code) => {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('已停止')
        if (parseError) throw parseError
        const compatible = process.platform === 'darwin' && !overflow && isEac3CompatibilityDiagnostic(errors)
        if (code !== 0 || overflow || (errors.trim() && !compatible)) throw new Error(`读取原始时间戳失败 (${code}) ${stream} ${path}: ${errors.trim()}`)
        const track = parser.finish()[0]
        if (!track?.packets || !Number.isFinite(track.firstMs)) throw new Error('轨道没有有效的呈现时间戳')
        // A valid packet PTS plus full independent audio checks allows stream
        // copy without dropping the opening packet or altering its timestamps.
        if (compatible) await validateEac3WithAudioToolbox(ffmpeg, path, signal)
        resolve(track.firstMs)
      } catch (e) { reject(e) }
    })
  })
}

/** All streams share one origin; audio that starts earlier delays the video.
 * Never clamp each track independently, which would destroy relative timing.
 */
export function relativePresentationStarts(videoMs: number, audioMs: number[], delays: number[]): number[] {
  if (audioMs.length !== delays.length) throw new Error('音轨偏移数量不匹配')
  const starts = [videoMs, ...audioMs.map((v, i) => v + delays[i]!)]
  if (starts.some(v => !Number.isFinite(v))) throw new Error('无法确定音视频相对起点')
  const origin = Math.min(...starts)
  return starts.map(v => v - origin)
}

/** Codec probes can emit recoverable diagnostics even during stream copy.
 * Demuxer/container errors are deliberately excluded. */
export function isCodecProbeDiagnostic(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  return lines.length > 0 && lines.every(line => /^\[(?:aac|eac3|ac3|h264|hevc|av1|dav1d) @ [^\]]+\] /i.test(line.trim()))
}

/** Uses bundled ffmpeg, without decoding/re-encoding or depending on ffprobe.
 * A caller that already sampled readability may retain codec-only probe messages. */
export async function inspectMediaTiming(ffmpeg: string, path: string, signal?: AbortSignal,
  options: { onCodecDiagnostic?: (diagnostic: string) => void } = {}): Promise<TrackTiming[]> {
  return new Promise((resolve, reject) => {
    const parser = frameCrcTiming()
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-copyts', '-i', path,
      '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-f', 'framecrc', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let errors = '', diagnosticTail = '', codecOnly = true, overflow = false
    let parseError: unknown
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try { parser.feed(chunk) } catch (e) { parseError = e; child.kill() }
    })
    child.stderr.on('data', (b: Buffer) => {
      const text = b.toString()
      if (errors.length + text.length > 4000) overflow = true
      errors = (errors + text).slice(-4000)
      const lines = (diagnosticTail + text).split(/\r?\n/)
      diagnosticTail = lines.pop() ?? ''
      for (const line of lines) if (line.trim() && !isCodecProbeDiagnostic(line)) codecOnly = false
      // Never let a discarded earlier demuxer error be hidden by later codec hints.
      if (diagnosticTail.length > 4000) { codecOnly = false; diagnosticTail = diagnosticTail.slice(-4000) }
    })
    child.once('error', (e) => reject(signal?.aborted ? (signal.reason ?? e) : e))
    child.once('close', async (code) => {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('已停止')
        if (parseError) throw parseError
        // FFmpeg may return 0 even after "File ended prematurely".
        if (diagnosticTail.trim() && !isCodecProbeDiagnostic(diagnosticTail)) codecOnly = false
        const compatible = code === 0 && process.platform === 'darwin' && !overflow && codecOnly && isEac3CompatibilityDiagnostic(errors)
        const recoverable = code === 0 && options.onCodecDiagnostic && codecOnly && !!errors.trim()
        if (code !== 0 || (errors.trim() && !recoverable && !compatible)) throw new Error(`媒体包校验失败 (${code}): ${errors.trim()}`)
        const tracks = parser.finish()
        if (!tracks.length || tracks.some(t => !t.packets)) throw new Error('媒体轨道为空')
        if (compatible) await validateEac3WithAudioToolbox(ffmpeg, path, signal)
        if (recoverable) options.onCodecDiagnostic!(errors)
        resolve(tracks)
      } catch (e) { reject(e) }
    })
  })
}

export function assertAudioContinuity(tracks: TrackTiming[]): void {
  if (!tracks.some(t => t.type === 'audio')) throw new Error('没有音轨')
  for (const t of tracks.filter(t => t.type === 'audio')) {
    if (t.maxGapMs > 100 || t.maxOverlapMs > 100) {
      throw new Error(`音轨 ${t.id} 时间戳不连续：空洞 ${t.maxGapMs.toFixed(1)}ms，重叠 ${t.maxOverlapMs.toFixed(1)}ms`)
    }
  }
}

export function assertMediaDuration(tracks: TrackTiming[], expectedMs: number): void {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) throw new Error('无法确认媒体预期时长')
  const end = Math.max(...tracks.map(t => t.endMs))
  if (!Number.isFinite(end) || Math.abs(end - expectedMs) > 2000) {
    throw new Error(`实际媒体结束于 ${(end / 1000).toFixed(3)}s，预期 ${(expectedMs / 1000).toFixed(3)}s`)
  }
}
