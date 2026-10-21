/**
 * ed2k 哈希（MD4，按 9728000 字节分块）。
 * - 文件 < 1 块：hash = MD4(数据)
 * - 否则 hash = MD4(各块 MD4 拼接)
 * - 大小恰为块长整数倍时，按 eMule 的做法再追加一个空块的 MD4（"red" 算法，eMule/aMule 实际使用）
 */
import { createReadStream, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { useLocalFile } from './local-file-use.ts'
import { basename } from 'node:path'

export const ED2K_CHUNK = 9728000

/** 增量 MD4（RFC 1320）。Node/OpenSSL 3 默认不再提供 md4，这里自己实现。 */
export class Md4 {
  private h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476])
  private buf = new Uint8Array(64)
  private bufLen = 0
  private total = 0
  private x = new Uint32Array(16)

  update(data: Uint8Array): this {
    let i = 0
    this.total += data.length
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, data.length)
      this.buf.set(data.subarray(0, n), this.bufLen)
      this.bufLen += n
      i = n
      if (this.bufLen < 64) return this
      this.block(this.buf, 0)
      this.bufLen = 0
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i)
    if (i < data.length) { this.buf.set(data.subarray(i), 0); this.bufLen = data.length - i }
    return this
  }

  digest(): Uint8Array {
    const bits = this.total * 8
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen
    const pad = new Uint8Array(padLen + 8)
    pad[0] = 0x80
    const lo = bits >>> 0, hi = Math.floor(bits / 0x100000000) >>> 0
    for (let k = 0; k < 4; k++) { pad[padLen + k] = (lo >>> (8 * k)) & 0xff; pad[padLen + 4 + k] = (hi >>> (8 * k)) & 0xff }
    const t = this.total
    this.update(pad)
    this.total = t
    const out = new Uint8Array(16)
    for (let k = 0; k < 4; k++) for (let b = 0; b < 4; b++) out[k * 4 + b] = (this.h[k]! >>> (8 * b)) & 0xff
    return out
  }

  private block(d: Uint8Array, o: number): void {
    const x = this.x
    for (let k = 0; k < 16; k++) x[k] = d[o + k * 4]! | (d[o + k * 4 + 1]! << 8) | (d[o + k * 4 + 2]! << 16) | (d[o + k * 4 + 3]! << 24)
    let [a, b, c, e] = [this.h[0]!, this.h[1]!, this.h[2]!, this.h[3]!]
    const rl = (v: number, s: number) => (v << s) | (v >>> (32 - s))
    const F = (p: number, q: number, r: number) => (p & q) | (~p & r)
    const G = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r)
    const H = (p: number, q: number, r: number) => p ^ q ^ r
    for (const k of [0, 4, 8, 12]) {
      a = rl((a + F(b, c, e) + x[k]!) | 0, 3); e = rl((e + F(a, b, c) + x[k + 1]!) | 0, 7)
      c = rl((c + F(e, a, b) + x[k + 2]!) | 0, 11); b = rl((b + F(c, e, a) + x[k + 3]!) | 0, 19)
    }
    for (const k of [0, 1, 2, 3]) {
      a = rl((a + G(b, c, e) + x[k]! + 0x5a827999) | 0, 3); e = rl((e + G(a, b, c) + x[k + 4]! + 0x5a827999) | 0, 5)
      c = rl((c + G(e, a, b) + x[k + 8]! + 0x5a827999) | 0, 9); b = rl((b + G(c, e, a) + x[k + 12]! + 0x5a827999) | 0, 13)
    }
    for (const k of [0, 2, 1, 3]) {
      a = rl((a + H(b, c, e) + x[k]! + 0x6ed9eba1) | 0, 3); e = rl((e + H(a, b, c) + x[k + 8]! + 0x6ed9eba1) | 0, 9)
      c = rl((c + H(e, a, b) + x[k + 4]! + 0x6ed9eba1) | 0, 11); b = rl((b + H(c, e, a) + x[k + 12]! + 0x6ed9eba1) | 0, 15)
    }
    this.h[0] = (this.h[0]! + a) | 0; this.h[1] = (this.h[1]! + b) | 0; this.h[2] = (this.h[2]! + c) | 0; this.h[3] = (this.h[3]! + e) | 0
  }
}

export const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')
export const md4hex = (data: Uint8Array) => hex(new Md4().update(data).digest())

/** 流式 ed2k：喂任意大小的数据片段，内部按块切分 */
export class Ed2kHasher {
  private cur = new Md4()
  private curLen = 0
  private chunks: Uint8Array[] = []
  size = 0
  update(data: Uint8Array): this {
    let i = 0
    while (i < data.length) {
      const n = Math.min(ED2K_CHUNK - this.curLen, data.length - i)
      this.cur.update(data.subarray(i, i + n))
      this.curLen += n
      i += n
      if (this.curLen === ED2K_CHUNK) { this.chunks.push(this.cur.digest()); this.cur = new Md4(); this.curLen = 0 }
    }
    this.size += data.length
    return this
  }
  digest(): string {
    // 剩余不足一块的尾巴；大小恰为整块时这里是空块的 MD4（eMule 约定）
    const tail = this.cur.digest()
    if (!this.chunks.length) return hex(tail)
    const all = new Md4()
    for (const c of this.chunks) all.update(c)
    all.update(tail)
    return hex(all.digest())
  }
}

export const ed2kLink = (name: string, size: number, hash: string) =>
  `ed2k://|file|${name.replace(/\|/g, '_')}|${size}|${hash.toUpperCase()}|/`

/** 同一遍读取计算 ED2K 与 SHA1，并保存普通文件身份；不接受符号链接或计算期间变动。 */
export async function ed2kFile(path: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const release = useLocalFile(path)
  try {
    signal?.throwIfAborted()
    const before = lstatSync(path)
    if (!before.isFile() || before.size < 1) throw new Error('成品文件不存在或大小无效')
    const h = new Ed2kHasher(), sha1 = createHash('sha1')
    let last = 0
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024, signal })) {
      signal?.throwIfAborted()
      h.update(chunk as Uint8Array)
      sha1.update(chunk)
      if (onProgress && (h.size - last >= 16 << 20 || h.size === before.size)) { last = h.size; onProgress(h.size, before.size) }
    }
    const after = lstatSync(path)
    const fields = ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'] as const
    if (!after.isFile() || h.size !== before.size || fields.some(key => before[key] !== after[key])) throw new Error('成品在校验过程中发生变化')
    const hash = h.digest()
    return { hash, size: h.size, link: ed2kLink(basename(path), h.size, hash), sha1: sha1.digest('hex').toUpperCase(),
      file: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev } }
  } finally { release() }
}
