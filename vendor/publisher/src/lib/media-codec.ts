/**
 * 音视频编码的统一写法：ffprobe 编码名与发布名别名都归到同一比较代码，
 * 成品命名、版本新建与版本匹配共用，避免一端认得、另一端认不得。
 */

type Family = { code: string; label: string; aliases: string[]; prefixes?: string[] }

/** 键为去掉分隔符后的大写写法。label 是写进文件名和版本名的拼写，不能含横线（横线是制作组分隔符）。 */
const audioFamilies: Family[] = [
  { code: 'AAC', label: 'AAC', aliases: ['AAC', 'AACLATM', 'AACFIXED', 'AACLC', 'HEAAC', 'HEAACV2'] },
  { code: 'DD', label: 'AC3', aliases: ['AC3', 'DD', 'AC3FIXED'] },
  { code: 'DDP', label: 'DDP', aliases: ['EAC3', 'DDP'] },
  { code: 'AC4', label: 'AC4', aliases: ['AC4'] },
  { code: 'DTS', label: 'DTS', aliases: ['DTS', 'DCA', 'DTSX'] },
  { code: 'TRUEHD', label: 'TrueHD', aliases: ['TRUEHD', 'MLP'] },
  { code: 'FLAC', label: 'FLAC', aliases: ['FLAC'] },
  { code: 'ALAC', label: 'ALAC', aliases: ['ALAC'] },
  // 蓝光 / DVD / 广播的各种 PCM 及 DV 音频都是未压缩 PCM。
  { code: 'LPCM', label: 'LPCM', aliases: ['LPCM', 'PCM', 'S302M', 'DVAUDIO'], prefixes: ['PCM'] },
  { code: 'OPUS', label: 'Opus', aliases: ['OPUS'] },
  { code: 'VORBIS', label: 'Vorbis', aliases: ['VORBIS'] },
  { code: 'MP1', label: 'MP1', aliases: ['MP1', 'MP1FLOAT'] },
  { code: 'MP2', label: 'MP2', aliases: ['MP2', 'MP2FLOAT', 'MP2FIXED'] },
  { code: 'MP3', label: 'MP3', aliases: ['MP3', 'MP3FLOAT', 'MP3ADU', 'MP3ADUFLOAT', 'MP3ON4', 'MP3ON4FLOAT'] },
  { code: 'WMA', label: 'WMA', aliases: ['WMA', 'WMAV1', 'WMAV2', 'WMAPRO', 'WMALOSSLESS', 'WMAVOICE', 'XMA1', 'XMA2'] },
  { code: 'AMR', label: 'AMR', aliases: ['AMR', 'AMRNB', 'AMRWB'] },
  { code: 'APE', label: 'APE', aliases: ['APE'] },
  { code: 'WAVPACK', label: 'WavPack', aliases: ['WAVPACK'] },
  { code: 'TAK', label: 'TAK', aliases: ['TAK'] },
  { code: 'TTA', label: 'TTA', aliases: ['TTA'] },
  { code: 'MPC', label: 'MPC', aliases: ['MPC', 'MUSEPACK7', 'MUSEPACK8'] },
  { code: 'DSD', label: 'DSD', aliases: ['DSD', 'DST'], prefixes: ['DSD'] },
  { code: 'MPEGH', label: 'MPEGH', aliases: ['MPEGH', 'MPEGH3DAUDIO'] },
  { code: 'SPEEX', label: 'Speex', aliases: ['SPEEX'] },
  { code: 'ADPCM', label: 'ADPCM', aliases: ['ADPCM'], prefixes: ['ADPCM'] },
]

const videoFamilies: Family[] = [
  { code: 'AVC', label: 'AVC', aliases: ['AVC', 'H264', 'X264', 'AVC1'] },
  { code: 'HEVC', label: 'HEVC', aliases: ['HEVC', 'H265', 'X265'] },
  { code: 'AV1', label: 'AV1', aliases: ['AV1'] },
  { code: 'VP9', label: 'VP9', aliases: ['VP9'] },
  { code: 'VP8', label: 'VP8', aliases: ['VP8'] },
  { code: 'VVC', label: 'VVC', aliases: ['VVC', 'H266', 'X266'] },
  // DVD、电视录制与早期压制常见的编码。
  { code: 'MPEG2', label: 'MPEG2', aliases: ['MPEG2', 'MPEG2VIDEO', 'H262'] },
  { code: 'MPEG1', label: 'MPEG1', aliases: ['MPEG1', 'MPEG1VIDEO'] },
  { code: 'XVID', label: 'XviD', aliases: ['XVID', 'DIVX', 'MPEG4'] },
  { code: 'VC1', label: 'VC1', aliases: ['VC1', 'WMV3', 'WVC1'] },
]

const key = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
const lookup = (families: Family[]) => {
  const byAlias = new Map(families.flatMap(f => f.aliases.map(alias => [alias, f] as const)))
  return (value = ''): Family | undefined => {
    const k = key(value)
    return byAlias.get(k) ?? families.find(f => f.prefixes?.some(prefix => k.startsWith(prefix)))
  }
}
const audioFamily = lookup(audioFamilies)
const videoFamily = lookup(videoFamilies)

/**
 * 音轨比较代码。表外的实测编码按编码名本身保留（如 cook → COOK），
 * 只拒绝 ffprobe 认不出的 unknown，因此任何可识别的音轨都能参与自动归类。
 */
export function audioCodecCode(value = ''): string | undefined {
  const family = audioFamily(value)
  if (family) return family.code
  const k = key(value)
  return /^(?=.*[A-Z])[A-Z0-9]{2,16}$/.test(k) && !['UNKNOWN', 'NONE', 'NULL'].includes(k) ? k : undefined
}

/** 写进文件名与版本名的音轨拼写；DTS:X 单独写成 DTS.X。 */
export function audioCodecLabel(value = ''): string | undefined {
  if (key(value) === 'DTSX') return 'DTS.X'
  return audioFamily(value)?.label ?? audioCodecCode(value)
}

/** 视频编码只认表内写法：版本匹配必须能从版本名读回同一编码，表外编码仍需人工选择。 */
export const videoCodecCode = (value = ''): string | undefined => videoFamily(value)?.code
export const videoCodecLabel = (value = ''): string | undefined => videoFamily(value)?.label

/** 这些编码不承载 HDR；DVD 与电视录制常缺色彩标记，按 SDR 归类。 */
export const sdrOnlyVideo = (value = '') => ['MPEG2', 'MPEG1', 'XVID', 'VC1', 'VP8'].includes(videoCodecCode(value) ?? '')

/** 发布名中按音轨识别的写法（已统一大写、去掉横线），长的在前以免 DD 抢先匹配 DDP。 */
export const releaseAudioTokens = ['AAC', 'AC3', 'AC4', 'EAC3', 'DDP', 'DD', 'DTS', 'TRUEHD', 'FLAC', 'ALAC', 'LPCM', 'PCM',
  'OPUS', 'VORBIS', 'MP1', 'MP2', 'MP3', 'WMA', 'AMR', 'APE', 'WAVPACK', 'TAK', 'TTA', 'DSD', 'MPEGH', 'SPEEX', 'ADPCM']
  .sort((a, b) => b.length - a.length)
export const releaseVideoTokens = ['AVC', 'HEVC', 'AV1', 'VP9', 'VP8', 'VVC', 'MPEG2', 'MPEG1', 'XVID', 'DIVX', 'VC1']
