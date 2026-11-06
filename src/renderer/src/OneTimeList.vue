<script setup lang="ts">
import type { WatchRoot, WatchJob } from '../../shared/model'
import Icon from './Icon.vue'
import { formatRetention } from '../../shared/retention'
import { oneTimeProgress } from '../../shared/one-time-progress'
defineProps<{ roots: WatchRoot[]; jobs: WatchJob[]; busy: boolean }>()
const emit = defineEmits<{ toggle: [id: string]; remove: [id: string]; cancelCleanup: [id: string]; jobs: [] }>()
function cleanupLabel(root: WatchRoot) {
  const batch = root.batch!, target = root.selectedFiles ? '所选文件' : '文件夹'
  if (batch.deletedAt) return `本地${target}已删除 · ${new Date(batch.deletedAt).toLocaleString('zh-CN')}`
  if (!root.cleanup?.enabled) return `保留本地${target}`
  if (batch.cleanupError) return batch.cleanupError
  if (batch.deleteAt) return `预计 ${new Date(batch.deleteAt).toLocaleString('zh-CN')} 删除${target}${root.enabled ? '' : ' · 已暂停'}`
  return `全部上传并同步 ED2K 后 ${formatRetention(root.cleanup.minutes)}删除${target}`
}
function state(root: WatchRoot, jobs: WatchJob[]) {
  const progress = oneTimeProgress(root, jobs)
  if (root.batch?.deletedAt) return { label: '已清理', badge: 'completed' }
  if (progress.allCancelled) return { label: '已取消', badge: 'cancelled' }
  if (progress.settled && progress.cancelled) return { label: '已结束', badge: 'completed' }
  if (root.batch?.cleanupError) return { label: '清理已停止', badge: 'review' }
  if (!root.enabled) return { label: '已暂停', badge: 'paused' }
  return root.batch?.completedAt ? { label: '已完成', badge: 'completed' } : { label: '处理中', badge: 'processing' }
}
</script>
<template>
  <section class="panel">
    <div class="panel-heading"><h2>一次性上传 <span class="count">{{ roots.length }}</span></h2><button class="link" @click="emit('jobs')">查看文件队列 <Icon name="arrow" :size="15" /></button></div>
    <p v-if="!roots.length" class="once-empty">选择视频文件或目录，确认作品后上传并制作 ED2K。</p>
    <article v-for="root in roots" :key="root.id" class="watch-row">
      <div class="watch-folder"><Icon name="upload" :size="24" /></div>
      <div class="watch-details">
        <h3>{{ root.title }} <span v-if="root.work.mediaType === 'tv'">按文件识别季 · 默认第 {{ root.seasonNumber }} 季</span></h3>
        <div class="path" :title="root.selectedFiles?.join('、') || root.path">{{ root.selectedFiles?.join('、') || root.path }}</div>
        <div class="watch-tags"><span>{{ root.releaseName }}</span><span>{{ root.binding.sourceAccount.alias }} → {{ root.directoryPath || root.directoryId }}</span></div>
        <small>{{ oneTimeProgress(root, jobs).processed }} / {{ root.batch?.files.length }} 个视频已处理<template v-if="oneTimeProgress(root, jobs).cancelled"> · {{ oneTimeProgress(root, jobs).cancelled }} 个已取消</template> · {{ cleanupLabel(root) }}</small>
        <p v-if="root.error && !root.batch?.completedAt" class="task-error">{{ root.error }}</p>
      </div>
      <div class="watch-actions">
        <span class="badge" :class="state(root, jobs).badge">{{ state(root, jobs).label }}</span>
        <div><button v-if="root.cleanup?.enabled && !root.batch?.deletedAt" class="link" :disabled="busy" @click="emit('cancelCleanup', root.id)">取消删除</button><button v-if="!root.batch?.deletedAt && !oneTimeProgress(root, jobs).allCancelled" class="link" :disabled="busy" @click="emit('toggle', root.id)">{{ root.enabled ? '暂停' : '恢复' }}</button><button class="link muted" :disabled="busy" @click="emit('remove', root.id)">移除</button></div>
      </div>
    </article>
  </section>
</template>
<style scoped>
.once-empty{padding:24px;color:var(--muted);line-height:1.7}
.watch-details small{display:block;line-height:1.7;overflow-wrap:anywhere}
</style>
