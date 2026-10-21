/** 使用本机 ffprobe 检测实际媒体，不从文件名虚构画质，也不自动下载执行工具。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { CompletedMedia } from '../../vendor/publisher/src/lib/actual-version'

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
export async function probeFile(tool: string, path: string, size: number, signal: AbortSignal): Promise<CompletedMedia> {
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
    media: {
      status: 'probed', width: video.width, height: video.height, codec: String(video.codec_name),
      ...(fps ? { fps } : {}),
      dynamicRange: dv ? 'DV' : transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR',
      audio: audio ? { status: 'confirmed', codec: audio.codec_name, channels: audio.channels, evidence: audios.length === 1 ? 'single_track' : 'container' }
        : { status: audios.length ? 'ambiguous' : 'none' },
    },
  }
}
