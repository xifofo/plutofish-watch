/** 下载完成事件的共享契约；发布引擎只依赖事件，不依赖下载平台实现。 */
import type { ActualVersion, CompletedMedia } from './actual-version.ts'

/** note: non-fatal warning on a finished job, e.g. a skipped audio track. */
export type JobEvt = {
  id: number
  status: string
  pct: number
  log: string
  err: string
  done?: boolean
  note?: string
  /** Present only on successful completion; requested quality remains separate. */
  actualVersion?: ActualVersion
  completedMedia?: CompletedMedia
  /** Explicit expiry reported by Youku; never inferred from a decode failure. */
  requiresReauth?: boolean
  /** Final event only: the user stopped the job instead of it failing. */
  stopped?: 'pause' | 'cancel'
}
