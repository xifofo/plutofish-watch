import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath } from './config.ts'
import { truncate } from './util.ts'

const MAX_BYTES = 3 * 1024 * 1024
const KEEP_ON_ROTATE = 512 * 1024

let disabled = false
let started = false
let hooksInstalled = false

/** Override for tests; empty = beside tui.json under AppData/gvs (or XDG). */
export function runLogPath(): string {
  const override = process.env.GVS_TUI_LOG_PATH?.trim()
  if (override) return override
  return join(dirname(configPath()), 'tui-run.log')
}

export function runLogEnabled(): boolean {
  if (disabled) return false
  const v = (process.env.GVS_TUI_LOG ?? '').trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return true
}

/** Tests / simulate mode can silence logging without touching env. */
export function setRunLogDisabled(off: boolean): void {
  disabled = off
}

function stamp(): string {
  return new Date().toISOString()
}

function rotateIfNeeded(path: string): void {
  try {
    const st = statSync(path)
    if (st.size < MAX_BYTES) return
    const bak = `${path}.1`
    try {
      renameSync(path, bak)
    } catch {
      try {
        writeFileSync(path, '')
      } catch {
        /* ignore */
      }
      return
    }
    try {
      const prev = readFileSync(bak)
      const tail = prev.subarray(Math.max(0, prev.length - KEEP_ON_ROTATE))
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from(`--- rotated ${stamp()} kept=${tail.length}B ---\n`),
          tail,
          Buffer.from('\n'),
        ]),
      )
    } catch {
      writeFileSync(path, `--- rotated ${stamp()} ---\n`)
    }
  } catch {
    // missing file is fine
  }
}

export function runLog(line: string): void {
  if (!runLogEnabled()) return
  const path = runLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    rotateIfNeeded(path)
    appendFileSync(path, `${stamp()} ${line}\n`)
  } catch {
    // never break the TUI for logging
  }
}

export function runLogStartup(info: {
  host: string
  version?: string
  git?: string
  scene?: string
}): void {
  if (!runLogEnabled()) return
  if (started) return
  started = true
  const bits = [
    'startup',
    `host=${info.host || '-'}`,
    info.version ? `ver=${info.version}` : '',
    info.git ? `git=${info.git}` : '',
    info.scene ? `scene=${info.scene}` : '',
    `log=${runLogPath()}`,
    `pid=${process.pid}`,
  ].filter(Boolean)
  runLog(bits.join(' '))
}

/** Reset startup latch (tests). */
export function resetRunLogStartup(): void {
  started = false
}

export function runLogScene(from: string, to: string): void {
  if (from === to) return
  runLog(`scene ${from} -> ${to}`)
}

/** Summarize invoke input: keys + safe values; redact secret-looking fields. */
export function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '-'
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (/cookie|token|sign|auth|passwd|password|secret|authorization|binding|phone|code|pin|flowId|challenge|license|payload|key|username|email/i.test(k)) {
      parts.push(`${k}=***`)
      continue
    }
    if (v == null) {
      parts.push(`${k}=`)
      continue
    }
    if (typeof v === 'string') {
      parts.push(`${k}=${truncateUrlish(v)}`)
      continue
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`)
      continue
    }
    parts.push(`${k}=[${typeof v}]`)
  }
  return parts.join(',') || '-'
}

function truncateUrlish(s: string): string {
  if (/^https?:\/\//i.test(s) || /vkey=|sign=|token=/i.test(s)) {
    return truncate(s, 96)
  }
  return s.length > 120 ? truncate(s, 100) : s
}

export function summarizeResult(data: Record<string, unknown> | undefined): string {
  if (!data) return 'data=-'
  const bits: string[] = []
  if (data.code != null) bits.push(`code=${data.code}`)
  if (data.msg != null) bits.push(`msg=${truncate(String(data.msg), 80)}`)
  if (data.error != null) bits.push(`error=${truncate(String(data.error), 80)}`)
  if (data.em != null) bits.push(`em=${truncate(String(data.em), 80)}`)
  if (data.network_error != null) bits.push(`network_error=${data.network_error}`)
  if (data.has_url != null) bits.push(`has_url=${data.has_url}`)
  const nFmt = Array.isArray(data.formats) ? data.formats.length : 0
  if (nFmt) bits.push(`n_formats=${nFmt}`)
  const nVid = Array.isArray(data.videos) ? data.videos.length : 0
  if (nVid) bits.push(`n_videos=${nVid}`)
  const hasTop =
    (typeof data.url === 'string' && !!data.url) ||
    (data.video != null && typeof data.video === 'object')
  if (hasTop) bits.push('has_top_url=1')
  return bits.join(' ') || 'ok'
}

export function installRunLogProcessHooks(): void {
  if (!runLogEnabled() || hooksInstalled) return
  hooksInstalled = true
  const once = (label: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    runLog(`uncaught ${label}: ${truncate(msg, 400)}`)
  }
  process.on('uncaughtException', (e) => once('exception', e))
  process.on('unhandledRejection', (e) => once('rejection', e))
}
