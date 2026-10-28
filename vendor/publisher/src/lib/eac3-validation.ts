import { spawn } from 'node:child_process'

type DecodeResult = { stdout: string; stderr: string }

/** AudioToolbox can conceal corrupt data, so its exit code alone is insufficient. */
function decode(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<DecodeResult> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal,
    })
    let stdout = '', stderr = '', overflow = false
    const collect = (text: string, data: Buffer) => {
      if (text.length + data.length > 262144) { overflow = true; child.kill(); return text }
      return text + data.toString()
    }
    child.stdout.on('data', (data: Buffer) => { stdout = collect(stdout, data) })
    child.stderr.on('data', (data: Buffer) => { stderr = collect(stderr, data) })
    child.once('error', error => reject(signal?.aborted ? signal.reason ?? error : error))
    child.once('close', code => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('已停止')); return }
      if (overflow || code !== 0) {
        reject(new Error(`E-AC-3 复核失败：ffmpeg exit ${code} ${stderr.slice(0, 500)}`))
      } else resolve({ stdout, stderr })
    })
  })
}

function completedDuration(output: string): number {
  if (!/^progress=end\r?$/m.test(output)) return 0
  const values = [...output.matchAll(/^out_time_us=(\d+)\r?$/gm)]
  return Number(values.at(-1)?.[1] ?? 0)
}

/** Only retry the observed E-AC-3 exponent error, never missing/truncated inputs. */
export function isEac3ExponentError(message: string): boolean {
  return /\[eac3 @[^\]]+\] expacc (?:125|126|127) is out-of-range/.test(message)
    && !/CRC mismatch|partial file|File ended prematurely|Error during demuxing/i.test(message)
}

/** Eligibility alone is not validation: require the bounded CRC diagnostics below. */
export function isEac3CompatibilityError(message: string): boolean {
  return (isEac3ExponentError(message)
    || /\[eac3 @[^\]]+\] exponent (?:-1|28) is out-of-range/.test(message)
    || /\[eac3 @[^\]]+\] invalid spectral extension range \(11 >= 11\)/.test(message))
    && !/CRC mismatch|partial file|File ended prematurely|Error during demuxing/i.test(message)
}

/** Only the observed diagnostics with bounded probe/decode counts. */
export function isEac3CompatibilityDiagnostic(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  // Observed stereo stream: the opening frame (-1) is reported during probe
  // and decode; frame 13 (28) is reported once during full decode. Keep the
  // exact values and counts bounded; CRC and independent decode remain required.
  if (lines.length > 0 && lines.length <= 6 && lines.length % 2 === 0) {
    const values: string[] = []
    for (let i = 0; i < lines.length; i += 2) {
      const value = /^\[eac3 @[^\]]+\] exponent (-1|28) is out-of-range$/.exec(lines[i]!)?.[1]
      if (!value || !/^\[eac3 @[^\]]+\] error decoding the audio block$/.test(lines[i + 1]!)) break
      values.push(value)
    }
    if (values.length === lines.length / 2 && values.filter(v => v === '-1').length <= 2
      && values.filter(v => v === '28').length <= 1) return true
  }
  const detail = /^\[eac3 @[^\]]+\] (?:expacc (?:125|126|127) is out-of-range|invalid spectral extension range \(11 >= 11\))$/
  const block = /^\[eac3 @[^\]]+\] error decoding the audio block$/
  return lines.length > 0 && lines.length <= 4 && lines.some(line => detail.test(line))
    && lines.every(line => detail.test(line) || block.test(line))
}

/**
 * Rare opening E-AC-3 frames fail FFmpeg's software decoder despite valid CRCs.
 * Require a full CRC-checked decode with only that bounded error, then a full
 * AudioToolbox decode with no system-decoder errors and the same duration.
 * Never rewrite audio.
 */
export async function validateEac3WithAudioToolbox(ffmpeg: string, path: string, signal?: AbortSignal): Promise<void> {
  const output = ['-map', '0:a', '-progress', 'pipe:1', '-stats_period', '10', '-f', 'null', '-']
  const crc = await decode(ffmpeg, ['-err_detect', 'crccheck', '-i', path, ...output], signal)
  const duration = completedDuration(crc.stdout)
  // Bound the observed fault combinations. Additional repetitions, CRC
  // mismatches and unrelated errors fail before trying the system decoder.
  if (!duration || !isEac3CompatibilityDiagnostic(crc.stderr)) {
    throw new Error(`E-AC-3 数据复核未通过：${crc.stderr.slice(0, 500) || '未确认完整解码'}`)
  }
  // The muxed file may also contain AAC. Identify each audio codec by stream
  // copy and override only E-AC-3 inputs; forcing eac3_at on AAC corrupts probing.
  const probe = await decode(ffmpeg, ['-i', path, '-map', '0:a', '-c', 'copy', '-frames:a', '1', '-f', 'framecrc', 'pipe:1'], signal)
  const streams = [...probe.stdout.matchAll(/^#codec_id (\d+): (\w+)\r?$/gm)]
  const eac3 = streams.filter(row => row[2] === 'eac3')
  if (!eac3.length || streams.some((row, i) => Number(row[1]) !== i)
    || (probe.stderr.trim() && !isEac3CompatibilityDiagnostic(probe.stderr))) {
    throw new Error('E-AC-3 数据复核未通过：无法确认音频轨道编码')
  }
  const decoders = eac3.flatMap(row => [`-c:a:${row[1]}`, 'eac3_at'])
  const native = await decode(ffmpeg, ['-xerror', '-err_detect', 'explode', ...decoders, '-i', path, ...output], signal)
  const nativeDuration = completedDuration(native.stdout)
  // An indexed input decoder is applied after demux probing. FFmpeg can still
  // report the same two software-decoder probe lines before eac3_at opens.
  // Any eac3_at error, additional fault, or incomplete decode remains fatal.
  const probeOnly = isEac3CompatibilityDiagnostic(native.stderr)
    && native.stderr.trim().split(/\r?\n/).length <= 2
  if ((native.stderr.trim() && !probeOnly) || !nativeDuration || Math.abs(nativeDuration - duration) > 100000) {
    throw new Error(`macOS E-AC-3 解码复核未通过：${native.stderr.slice(0, 500) || '完整解码时长不符'}`)
  }
}
