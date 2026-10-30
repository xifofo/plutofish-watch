/** 使用本机 ffprobe 检测实际媒体，不从文件名虚构画质，也不自动下载执行工具。
 * 同一次探测顺带读出全部音轨与字幕轨（语言、标题、编码、默认与强制标记），资源登记后补报给 PlutoFish。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { CompletedMedia } from '../../vendor/publisher/src/lib/actual-version'
import type { MediaTracks } from '../shared/model'

const execute = promisify(execFile)
export function findProbe(saved: string): string {
  if (saved) return saved
  const candidates = process.platform === 'win32'
    ? ['C:\\ffmpeg\\bin\\ffprobe.exe']
    : ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
  return candidates.find(existsSync) ?? 'ffprobe'
}
export async function probeAvailable(path: string): Promise<boolean> {
  try { await execute(path, ['-version'], { timeout: 5000, maxBuffer: 128 * 1024 }); return true }
  catch { return false }
}
// 与服务端 files/media 契约的上限一致：超出数量的轨道不报，过长的标题截断，控制字符去掉。
const trackLimits = { audio: 32, subtitles: 64, codec: 32, profile: 64, language: 16, title: 160, channels: 32 }

function trackText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = [...value.replace(/\p{Cc}/gu, '').trim()].slice(0, limit).join('').trim()
  return text || undefined
}

// MKV 与 MP4 的标签键大小写不一（language / LANGUAGE），按小写匹配。
function tag(stream: any, key: string): unknown {
  const tags = stream?.tags
  if (!tags || typeof tags !== 'object') return undefined
  const match = Object.keys(tags).find(name => name.toLowerCase() === key)
  return match === undefined ? undefined : tags[match]
}

/** 从 ffprobe 的 streams 读出音轨与字幕轨；只保留服务端生成标签需要的字段，没有编码名的轨道记为 unknown。 */
export function readTracks(streams: any[]): MediaTracks {
  const base = (stream: any) => {
    const language = trackText(tag(stream, 'language'), trackLimits.language)?.toLowerCase()
    const title = trackText(tag(stream, 'title'), trackLimits.title)
    return {
      codec: trackText(stream.codec_name, trackLimits.codec) ?? 'unknown',
      ...(language ? { language } : {}), ...(title ? { title } : {}),
      default: stream.disposition?.default === 1,
    }
  }
  const audio = streams.filter(s => s?.codec_type === 'audio').slice(0, trackLimits.audio).map(stream => {
    const profile = trackText(stream.profile, trackLimits.profile)
    const channels = Number.isInteger(stream.channels) && stream.channels > 0 && stream.channels <= trackLimits.channels ? stream.channels as number : undefined
    return { ...base(stream), ...(profile ? { profile } : {}), ...(channels ? { channels } : {}) }
  })
  const subtitles = streams.filter(s => s?.codec_type === 'subtitle').slice(0, trackLimits.subtitles)
    .map(stream => ({ ...base(stream), forced: stream.disposition?.forced === 1 }))
  return { audio, subtitles }
}

export async function probeFile(tool: string, path: string, size: number, signal: AbortSignal): Promise<CompletedMedia & { tracks: MediaTracks }> {
  let output: string
  try {
    const result = await execute(tool, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', '-i', path], {
      signal, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    })
    output = result.stdout
  } catch {
    signal.throwIfAborted()
    throw new Error('媒体检测失败，请检查 ffprobe 路径，以及文件是否已完整写入')
  }
  const data = JSON.parse(output)
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width <= 0 || video.height <= 0 || !video.codec_name) {
    throw new Error('未检测到有效视频轨道，请检查文件')
  }
  const transfer = video.color_transfer
  const dv = video.side_data_list?.some((s: any) => /dovi/i.test(s.side_data_type ?? ''))
  const audios = streams.filter((s: any) => s.codec_type === 'audio')
  const audio = audios.length === 1 ? audios[0] : audios.filter((s: any) => s.disposition?.default === 1).length === 1
    ? audios.find((s: any) => s.disposition?.default === 1) : null
  const fps = [video.avg_frame_rate, video.r_frame_rate].map(value => {
    const parts = String(value ?? '').split('/').map(Number)
    return parts.length === 2 ? parts[0] / parts[1] : parts[0]
  }).find(value => Number.isFinite(value) && value > 0)
  return {
    file: { size },
    tracks: readTracks(streams),
    media: {
      status: 'probed', width: video.width, height: video.height, codec: String(video.codec_name),
      ...(fps ? { fps } : {}),
      dynamicRange: dv ? 'DV' : transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR',
      audio: audio ? { status: 'confirmed', codec: audio.codec_name, channels: audio.channels, evidence: audios.length === 1 ? 'single_track' : 'container' }
        : { status: audios.length ? 'ambiguous' : 'none' },
    },
  }
}
