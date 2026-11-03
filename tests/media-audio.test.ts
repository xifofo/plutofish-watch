/** MPEG 音轨回归：本机 ffmpeg 生成 MP2/MP3 成品，经监控器自己的 ffprobe 检测后应能自动归类，不进入人工确认。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findProbe, probeFile } from '../src/main/probe'
import { matchMeasuredRelease, measuredReleaseVersion } from '../vendor/publisher/src/integrations/plutofish/release-selection'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

test('MP2（电视录制 TS）与 MP3 音轨按实测规格自动新建并匹配版本', async () => {
  const ffmpeg = Bun.which('ffmpeg')
  if (!ffmpeg) throw new Error('离线集成测试需要本机 ffmpeg')
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'watch-mpeg-audio-')))
  cleanup.push(() => rm(temp, { recursive: true, force: true }))
  const preset = { platform: 'TX', type: 'WEB-DL' }
  for (const [codec, encoder, name] of [['mp2', 'mp2', 'Show.S01E01.ts'], ['mp3', 'libmp3lame', 'Show.S01E02.mkv']]) {
    const file = join(temp, name)
    const generated = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=25:d=0.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', encoder, '-ac', '2', '-y', file])
    expect(generated.status).toBe(0)
    const probed = await probeFile(findProbe(''), file, (await stat(file)).size, new AbortController().signal)
    expect(probed.media.audio).toMatchObject({ status: 'confirmed', codec, channels: 2 })
    expect(probed.tracks.audio).toEqual([expect.objectContaining({ codec, channels: 2 })])
    expect(matchMeasuredRelease([], probed.media, file, preset)).toEqual({ canCreate: true, reason: '未匹配到已有版本' })
    const version = measuredReleaseVersion(probed.media, file, 1, preset)
    expect(version.name).toBe(`S01.1080p.TX.WEB-DL.SDR.AVC.${codec.toUpperCase()}.2.0`)
    const existing = { id: 'r'.repeat(32), name: version.name, resolution: '1080p', dynamicRange: 'SDR', status: 'published' }
    expect(matchMeasuredRelease([existing], probed.media, file, preset).matchedId).toBe(existing.id)
  }
})
