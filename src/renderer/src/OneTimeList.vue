<script setup lang="ts">
import type { WatchRoot, WatchJob } from '../../shared/model'
import Icon from './Icon.vue'
defineProps<{ roots: WatchRoot[]; jobs: WatchJob[]; busy: boolean }>()
const emit = defineEmits<{ toggle: [id: string]; remove: [id: string]; cancelCleanup: [id: string]; jobs: [] }>()
function cleanupLabel(root: WatchRoot) {
  const batch = root.batch!
  if (batch.deletedAt) return `本地文件夹已删除 · ${new Date(batch.deletedAt).toLocaleString('zh-CN')}`
  if (!root.cleanup?.enabled) return '保留本地文件夹'
  if (batch.cleanupError) return batch.cleanupError
  if (batch.deleteAt) return `预计 ${new Date(batch.deleteAt).toLocaleString('zh-CN')} 删除文件夹${root.enabled ? '' : ' · 已暂停'}`
  return `全部上传并同步 ED2K 后 ${root.cleanup.days} 天删除文件夹`
}
function processed(root: WatchRoot, jobs: WatchJob[]) {
  return root.batch!.files.filter(path => ['completed', 'duplicate'].includes(jobs.findLast(j => j.watchId === root.id && j.path === path)?.status ?? '')).length
}
</script>
<template>
  <section class="panel">
    <div class="panel-heading"><h2>一次性上传 <span class="count">{{ roots.length }}</span></h2><button class="link" @click="emit('jobs')">查看文件队列 <Icon name="arrow" :size="15" /></button></div>
    <p v-if="!roots.length" class="once-empty">选择一个目录，确认识别结果后上传并制作 ED2K。</p>
    <article v-for="root in roots" :key="root.id" class="watch-row">
      <div class="watch-folder"><Icon name="upload" :size="24" /></div>
      <div class="watch-details">
        <h3>{{ root.title }} <span v-if="root.work.mediaType === 'tv'">第 {{ root.seasonNumber }} 季</span></h3>
        <div class="path" :title="root.path">{{ root.path }}</div>
        <div class="watch-tags"><span>{{ root.releaseName }}</span><span>{{ root.binding.sourceAccount.alias }} → {{ root.directoryPath || root.directoryId }}</span></div>
        <small>{{ processed(root, jobs) }} / {{ root.batch?.files.length }} 个视频已处理 · {{ cleanupLabel(root) }}</small>
        <p v-if="root.error && !root.batch?.completedAt" class="task-error">{{ root.error }}</p>
      </div>
      <div class="watch-actions">
        <span class="badge" :class="root.batch?.cleanupError ? 'review' : !root.enabled ? 'paused' : root.batch?.completedAt ? 'completed' : 'processing'">{{ root.batch?.deletedAt ? '已清理' : root.batch?.cleanupError ? '清理已停止' : !root.enabled ? '已暂停' : root.batch?.completedAt ? '已完成' : '处理中' }}</span>
        <div><button v-if="root.cleanup?.enabled && !root.batch?.deletedAt" class="link" :disabled="busy" @click="emit('cancelCleanup', root.id)">取消删除</button><button v-if="!root.batch?.deletedAt" class="link" :disabled="busy" @click="emit('toggle', root.id)">{{ root.enabled ? '暂停' : '恢复' }}</button><button class="link muted" :disabled="busy" @click="emit('remove', root.id)">移除</button></div>
      </div>
    </article>
  </section>
</template>
<style scoped>
.once-empty{padding:24px;color:var(--muted);line-height:1.7}
.watch-details small{display:block;line-height:1.7;overflow-wrap:anywhere}
</style>
