<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WatchJob, WatchRoot, WatchAPI, ReleaseSource, LocalRetentionSettings } from '../../shared/model'
import Icon from './Icon.vue'
import SourceFields from './SourceFields.vue'
import { uploadBytes, uploadRemaining } from '../../../vendor/publisher/src/integrations/plutofish/upload-display'
import transferTrayArt from './assets/transfer-tray.png'
const props = defineProps<{ jobs: WatchJob[]; watches?: WatchRoot[]; retention: LocalRetentionSettings; busy: boolean; compact?: boolean }>()
const emit = defineEmits<{ action: [input: Parameters<WatchAPI['job']>[0]]; reveal: [id: string] }>()
const filter = ref('all'), search = ref(''), page = ref(1), episode = ref<Record<string, string | number>>({})
const sources = ref<Record<string, ReleaseSource>>({})
const versions = ref<Record<string, string>>({})
const labels: Record<string, string | number> = { waiting: '等待文件稳定', queued: '等待上传', preparing: '检测与校验', review: '待确认集号', processing: '准备上传', uploading: '上传中', paused: '已暂停', failed: '失败', completed: '已完成', duplicate: '重复已跳过', cancelled: '已取消' }
const filtered = computed(() => [...props.jobs].reverse().filter(j =>
  (filter.value === 'all' || (filter.value === 'active' ? ['waiting', 'queued', 'preparing', 'processing', 'uploading', 'paused'].includes(j.status)
    : filter.value === 'attention' ? ['failed', 'review'].includes(j.status) : j.status === filter.value))
  && j.relativePath.toLowerCase().includes(search.value.toLowerCase())))
const visible = computed(() => filtered.value.slice(0, props.compact ? 6 : page.value * 40))
const size = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`
const percent = (job: WatchJob) => Math.max(0, Math.min(100, job.transfer && job.signature.size > 0 ? job.transfer.sentBytes / job.signature.size * 100 : job.percent))
const phase = (j: WatchJob) => j.status === 'failed' && j.retry?.nextAt ? '等待自动重试' : j.versionReview && j.status === 'review' ? (j.versionReview.sourceRequired ? '待确认来源' : '待确认版本') : j.reused && j.status === 'completed' ? '已复用' : ({ probing: '检测媒体规格', checking: '检查是否已上传', hashing: '计算文件校验', uploading: j.reused ? '复用已有文件' : '上传中', verifying: '核验网盘文件', reporting: '登记资源' })[j.phase ?? ''] || labels[j.status] || j.status
const ed2kLabel = (j: WatchJob) => j.ed2k?.state === 'running' ? `ED2K ${Math.floor(j.ed2k.pct * 100)}%`
  : j.ed2k?.state === 'done' ? (j.ed2kSaved ? 'ED2K 已同步' : 'ED2K 待同步')
  : j.ed2k?.state === 'failed' ? 'ED2K 待重试' : 'ED2K 排队中'
function retentionLabel(job: WatchJob): string {
  if (job.retention?.state === 'deleted') return '本地文件已清理'
  const root = props.watches?.find(w => w.id === job.watchId) ?? job.watchSnapshot
  if (root?.mode === 'once') {
    const target = root.selectedFiles ? '所选文件' : '整个文件夹'
    if (root.batch?.deletedAt) return `${target}已清理`
    if (!root.cleanup?.enabled) return `一次性上传 · 保留${target}`
    if (root.batch?.cleanupError) return root.batch.cleanupError
    if (root.batch?.deleteAt) return `预计 ${new Date(root.batch.deleteAt).toLocaleString('zh-CN')} 清理${target}`
    return '等待整批上传与 ED2K 同步后开始保留计时'
  }
  if (!props.retention.enabled || job.status !== 'completed') return ''
  if (job.changed || job.retention?.state === 'changed') return '文件已改变，保留本地文件'
  if (!job.ed2kSaved) return '等待 ED2K 同步，保留本地文件'
  if (job.retention?.state === 'busy') return '自动清理暂缓'
  if (job.retention?.state === 'failed') return '清理失败，稍后自动重试'
  if (job.retention?.deleteAt) return `预计 ${new Date(job.retention.deleteAt).toLocaleString('zh-CN')} 清理本地文件`
  return ''
}
</script>
<template>
  <div v-if="!compact" class="task-toolbar">
    <div class="segmented"><button v-for="f in [['all', '全部'], ['active', '进行中'], ['attention', '需处理'], ['completed', '已完成']]" :key="f[0]" :class="{ selected: filter === f[0] }" @click="filter = f[0]; page = 1">{{ f[1] }}</button></div>
    <input v-model="search" class="search" aria-label="搜索文件" placeholder="搜索文件名…" />
  </div>
  <div v-if="!visible.length" class="small-empty" :class="{ 'queue-empty': !compact }">
    <Icon v-if="jobs.length" name="list" :size="30" />
    <img v-else class="queue-illustration" :src="transferTrayArt" alt="" aria-hidden="true" draggable="false" />
    <strong>{{ jobs.length ? '没有匹配的文件' : '暂无传输任务' }}</strong>
  </div>
  <div v-else class="task-list">
    <article v-for="job in visible" :key="job.id" class="task">
      <div class="file-icon" :class="{ done: job.status === 'completed' }"><Icon :name="job.status === 'completed' ? 'check' : 'upload'" :size="19" /></div>
      <div class="task-body"><div class="task-title" :title="job.path">{{ job.relativePath }}</div><div class="task-meta"><span>{{ size(job.signature.size) }}</span><span v-if="job.episodeNumber !== undefined">第 {{ job.episodeNumber }} 集</span><span>{{ new Date(job.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span></div>
        <p v-if="job.status === 'failed' && job.retry?.nextAt" class="hint">{{ new Date(job.retry.nextAt).toLocaleTimeString('zh-CN') }} 重试 · 第 {{ job.retry.attempt }} 次</p>
        <p v-else-if="job.status === 'failed' && job.retry && job.retry.attempt > 8" class="hint warning">自动重试已达上限，请处理下方原因后点击重试。</p>
        <p v-if="job.release" class="version-caption">{{ job.release.name }}</p>
        <p v-if="job.watchSnapshot" class="hint original-target">沿用原配置：{{ job.watchSnapshot.title }}<template v-if="job.watchSnapshot.work.mediaType === 'tv'"> · 第 {{ job.watchSnapshot.seasonNumber }} 季</template> · {{ job.watchSnapshot.binding.sourceAccount.alias }} · {{ job.watchSnapshot.directoryPath || `目录 ${job.watchSnapshot.directoryId}` }}</p>
        <p v-if="retentionLabel(job)" class="hint retention-caption">{{ retentionLabel(job) }}</p>
        <div v-if="job.status === 'uploading'" class="progress" role="progressbar" aria-label="上传进度" :aria-valuenow="percent(job)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent(job)}%` }" /></div>
        <div v-if="job.status === 'uploading' && job.phase === 'uploading' && !job.reused" class="transfer-stats" aria-label="上传速度与进度">
          <strong>{{ job.transfer ? `${uploadBytes(job.transfer.bytesPerSecond)}/s` : '测速中…' }}</strong>
          <span>已发送 {{ uploadBytes(job.transfer?.sentBytes ?? job.uploadedBytes ?? 0) }} / {{ uploadBytes(job.signature.size) }}</span>
          <span>{{ job.transfer?.sentBytes === job.signature.size ? '等待分片确认' : `剩余${uploadRemaining(job.transfer?.etaSeconds)}` }}</span>
          <span v-if="job.transfer && job.transfer.rateLimit > 0" class="account-limit">账号共享上限 {{ uploadBytes(job.transfer.rateLimit) }}/s</span>
        </div>
        <p v-if="job.error" class="task-error" :class="{ muted: !['failed', 'review'].includes(job.status) }">{{ job.error }}</p>
        <div v-if="job.error && job.errorDetails" class="task-error-details" aria-label="错误详情">
          <span>{{ job.errorDetails.stage }}</span>
          <code v-if="job.errorDetails.httpStatus">HTTP {{ job.errorDetails.httpStatus }}</code>
          <code v-if="job.errorDetails.code">{{ job.errorDetails.code }}</code>
          <span v-if="job.errorDetails.requestId" class="request-id">请求 ID：<code>{{ job.errorDetails.requestId }}</code></span>
        </div>
        <details v-if="job.ed2k" class="ed2k-details"><summary>{{ ed2kLabel(job) }}</summary><input v-if="job.ed2k.link" readonly :value="job.ed2k.link" aria-label="ED2K 链接" @focus="($event.target as HTMLInputElement).select()" /><p v-else-if="job.ed2k.message" class="hint">{{ job.ed2k.message }}</p></details>
        <div v-if="job.status === 'review' && job.versionReview" class="version-review">
          <p class="hint">{{ job.versionReview.detected }}</p>
          <div v-if="job.versionReview.sourceRequired" class="source-review"><SourceFields :model-value="sources[job.id] ?? job.versionReview.source" :disabled="busy" @update:model-value="sources[job.id] = $event" /><button class="button secondary small" :disabled="busy" @click="emit('action', { id: job.id, action: 'confirmSource', source: { ...(sources[job.id] ?? job.versionReview.source) } })">确认来源并重试</button></div>
          <div class="version-controls">
            <select v-if="job.versionReview.choices.length" :value="versions[job.id] ?? ''" :aria-label="`${job.relativePath} 的版本`" @change="versions[job.id] = ($event.target as HTMLSelectElement).value"><option value="" disabled>选择已有版本</option><option v-for="r in job.versionReview.choices" :key="r.id" :value="r.id">{{ r.name }}</option></select>
            <span v-else-if="!job.versionReview.sourceRequired" class="hint">请检查媒体规格与文件名，再刷新。</span>
            <button v-if="job.versionReview.choices.length" class="button secondary small" :disabled="busy || !versions[job.id]" @click="emit('action', { id: job.id, action: 'selectVersion', releaseId: versions[job.id] })">确认版本</button>
            <button class="link" :disabled="busy" @click="versions[job.id] = ''; emit('action', { id: job.id, action: 'refreshVersion' })">刷新版本</button>
          </div>
        </div>
        <div v-else-if="job.status === 'review'" class="review-row"><input v-model="episode[job.id]" type="number" min="0" max="100000" placeholder="集号" :aria-label="`${job.relativePath} 的集号`" /><button class="button secondary small" :disabled="busy || !String(episode[job.id] ?? '').trim()" @click="emit('action', { id: job.id, action: 'confirm', episodeNumber: Number(episode[job.id]) })">确认入队</button></div>
      </div>
      <div class="task-end"><span v-if="job.synced === false" class="sync-label">待同步</span><span class="badge" :class="job.status">{{ phase(job) }}{{ job.status === 'uploading' ? ` ${percent(job).toFixed(1)}%` : '' }}</span>
        <div v-if="!compact" class="task-actions">
          <button v-if="['failed', 'paused'].includes(job.status)" class="link" :disabled="busy" @click="emit('action', { id: job.id, action: 'resume' })">{{ job.status === 'failed' ? (job.retry?.nextAt ? '立即重试' : '重试') : '继续' }}</button>
          <button v-if="['queued', 'preparing', 'processing', 'uploading'].includes(job.status) || (job.status === 'failed' && job.retry?.nextAt)" class="link" :disabled="busy" @click="emit('action', { id: job.id, action: 'pause' })">暂停</button>
          <button v-if="!['completed', 'cancelled', 'duplicate'].includes(job.status)" class="link muted" :disabled="busy" @click="emit('action', { id: job.id, action: 'cancel' })">取消</button>
          <button v-if="job.retention?.state !== 'deleted'" class="link muted" @click="emit('reveal', job.id)">定位</button>
        </div>
      </div>
    </article>
  </div>
  <button v-if="!compact && filtered.length > visible.length" class="button secondary load-more" @click="page++">加载更多（剩余 {{ filtered.length - visible.length }} 个）</button>
</template>
<style scoped>
.transfer-stats{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px 12px;margin-top:7px;font-size:10px;color:var(--secondary);font-variant-numeric:tabular-nums}
.transfer-stats strong{color:var(--accent);font-size:11px}
.account-limit{color:var(--muted)}
.version-caption{font-size:10px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}
.retention-caption{margin-top:6px;overflow-wrap:anywhere}
.original-target{margin-top:6px;overflow-wrap:anywhere}
.task-error-details{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px;font-size:10px;color:var(--muted);overflow-wrap:anywhere;user-select:text}
.task-error-details code{font-size:inherit;white-space:normal;overflow-wrap:anywhere}
.task-error-details .request-id{flex-basis:100%;min-width:0}
.version-review{margin-top:8px}
.version-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px}
.version-controls select{flex:1;min-width:160px;width:auto;margin:0;max-width:100%}
</style>
