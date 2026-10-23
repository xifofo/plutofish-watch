import type { ReleaseSource } from '../../vendor/publisher/src/integrations/plutofish/release-specs'
import type { RetentionProgress } from '../../vendor/publisher/src/integrations/plutofish/publication-types'
import type { UploadTransfer } from '../../vendor/publisher/src/integrations/plutofish/upload-traffic'
export type { ReleaseSource }
/** IPC 只传业务快照，凭据及上传临时密钥不出主进程。 */
export type Source = { id: string; alias: string; name: string; provider?: string; enabled?: boolean }
export type Identity = {
  id: string; name: string; kind: 'publisher'; sourceAccount: Source; sourceAccounts?: Source[]
  categories?: Array<{ value: string; label: string }>
}
export type Connection = { url: string; hasKey: boolean; status: string; error: string; identity: Identity | null; reconnect?: { attempt: number; nextAt: number } }
export type LocalRetentionSettings = { enabled: boolean; days: number }
export type Binding = {
  url: string; publisherId: string; sourceAccount: { id: string; alias: string }
}
export type Work = { mediaType: 'movie' | 'tv'; tmdbId: string; category: string }
export type WorkOption = { tmdbId: string; title: string; originalTitle: string; year?: number }
/** 识别只产生草稿，目录保存后不再根据后续文件重新绑定。 */
export type { CategoryMatch, RecognizedWork, Recognition } from '../../vendor/publisher/src/integrations/plutofish/recognition-types'
import type { Recognition } from '../../vendor/publisher/src/integrations/plutofish/recognition-types'
export type RecognitionSample = { directoryName: string; fileName: string | null; truncated: boolean }
export type WorkSearch = { sourceAccountId: string; mediaType: Work['mediaType']; query: string; page: number }
export type WorkPage = { items: WorkOption[]; page: number; totalPages: number; total: number }
export type Release = { id: string; name: string; resolution: string; dynamicRange: string; status: string; latestEpisode?: number }
export type WatchInput = {
  path: string; title: string; sourceAccountId: string; work: Work; seasonNumber?: number
  releaseId: string; directoryId: string; directoryPath: string
  /** 旧记录省略时保持固定版本，新增目录默认可选自动归类。 */
  versionMode?: 'fixed' | 'auto'
  sourcePreset?: ReleaseSource
  includeExisting: boolean; stableSeconds: number
}
export type WatchRoot = WatchInput & {
  id: string; binding: Binding; releaseName: string; releaseVersion?: { name: string; resolution: string; dynamicRange: string }; enabled: boolean
  initialized: boolean; createdAt: string; lastScan?: string; error?: string
}
export type Signature = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
export type Observation = {
  signature: Signature; stableSince: number; jobId?: string; ignored?: boolean
}
export type JobStatus = 'waiting' | 'queued' | 'preparing' | 'review' | 'processing' | 'uploading' | 'paused' | 'failed' | 'completed' | 'duplicate' | 'cancelled'
export type WatchJob = {
  id: string; watchId: string; path: string; relativePath: string; signature: Signature
  /** 编辑目录后，已开始发布的任务继续沿用原路径和发布归属。 */
  watchSnapshot?: WatchRoot
  status: JobStatus; createdAt: string; updatedAt: string; episodeNumber?: number
  fileKey?: string; sha1?: string; percent: number; phase?: string; error: string
  uploadedBytes?: number; transfer?: UploadTransfer
  /** 跨目录和重命名的内容归属；不使用本地路径或监控目录 ID。 */
  targetKey?: string; duplicateOf?: string; reused?: boolean
  /** 失败次数与下次重试时间落盘；主动暂停、取消或文件改变不会自动入队。 */
  retry?: { attempt: number; nextAt?: number; failureId?: string }
  /** 恢复前校验失败时保留原因，旧发布快照不能覆盖它或重新放行任务。 */
  preparationError?: string
  synced?: boolean
  ed2k?: { state: 'queued' | 'running' | 'done' | 'failed'; pct: number; link: string; message?: string }
  ed2kSaved?: boolean
  retention?: RetentionProgress
  /** 每个文件的版本一经确认即持久化，重试与重启不重新归类。 */
  release?: {
    id?: string; name: string
    /** 待创建版本使用稳定键；服务端登记时创建，后续集数复用同一绑定。 */
    key?: string; version?: { name: string; resolution: string; dynamicRange: string }
  }
  sourceOverride?: ReleaseSource
  versionReview?: { reason: string; detected: string; choices: Release[]; source?: ReleaseSource; sourceRequired?: boolean }
  /** 用户暂停与目录暂停分开，恢复目录不会恢复用户主动暂停的任务。 */
  manuallyPaused?: boolean; changed?: boolean
}
export type DiskState = {
  schemaVersion: 1; watches: WatchRoot[]; jobs: WatchJob[]
  observations: Record<string, Record<string, Observation>>
  uploadsPaused: boolean; ffprobe: string; retention: LocalRetentionSettings
}
export type Snapshot = {
  connection: Connection; watches: WatchRoot[]; jobs: WatchJob[]
  uploadsPaused: boolean; ffprobe: string; ffprobeAvailable: boolean; fatalError: string; retention: LocalRetentionSettings
}
export type DirectoryPage = {
  sourceAccountId: string; path: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string }>; nextCursor: string
}
export interface WatchAPI {
  snapshot(): Promise<Snapshot>
  connect(input: { url: string; key: string }): Promise<void>
  chooseDirectory(): Promise<string | null>
  chooseProbe(): Promise<string | null>
  searchWorks(input: WorkSearch): Promise<WorkPage>
  recognitionSample(path: string): Promise<RecognitionSample>
  recognizeFile(input: { sourceAccountId: string; fileName: string }): Promise<Recognition>
  releases(input: Omit<WatchInput, 'path' | 'includeExisting' | 'stableSeconds' | 'releaseId'>): Promise<Release[]>
  directories(input: { sourceAccountId: string; directoryId: string; cursor?: string }): Promise<DirectoryPage>
  add(input: WatchInput): Promise<void>
  updateWatch(input: { id: string; watch: WatchInput }): Promise<void>
  setSourcePreset(input: { id: string; source: ReleaseSource }): Promise<void>
  setRetention(input: LocalRetentionSettings): Promise<void>
  toggleWatch(id: string): Promise<void>
  removeWatch(id: string): Promise<void>
  scan(): Promise<void>
  backfill(id: string): Promise<number>
  pauseAll(): Promise<void>
  job(input: { id: string; action: 'pause' | 'resume' | 'cancel' | 'confirm' | 'selectVersion' | 'refreshVersion' | 'confirmSource'; episodeNumber?: number; releaseId?: string; source?: ReleaseSource }): Promise<void>
  reveal(id: string): Promise<void>
  onChange(callback: (state: Snapshot) => void): () => void
}
