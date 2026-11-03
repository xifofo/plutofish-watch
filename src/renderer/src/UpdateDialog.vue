<!-- 新版本提示：用户选择立即更新或暂不更新；下载、校验与安装状态全部来自主进程。状态显示在底栏，弹窗高度不随状态跳动。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { UpdateState } from '../../shared/model'
import { releaseNotes } from '../../shared/update'
import brandIcon from '../../../resources/icon.png'

const props = defineProps<{ update: UpdateState; transfers: number }>()
const api = window.plutoWatch.update
const dialog = ref<HTMLDialogElement>(), error = ref('')
const release = computed(() => props.update.release!)
const download = computed(() => props.update.download)
const status = computed(() => download.value?.status)
const busy = computed(() => status.value === 'downloading' || status.value === 'installing')
const notes = computed(() => releaseNotes(release.value.notes))
const percent = computed(() => download.value?.total ? Math.min(100, Math.floor(download.value.received / download.value.total * 100)) : 0)
const published = computed(() => {
  const date = new Date(release.value.publishedAt)
  return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}发布`
})
const failure = computed(() => error.value || (status.value === 'failed' ? download.value?.error || '下载失败，请重试' : ''))
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const hint = computed(() => release.value.mode === 'install' ? '下载并校验后自动退出安装，完成后重新打开。设置、目录和传输记录保持不变。'
  : release.value.mode === 'open' ? '下载并校验后打开安装包，把新版拖入“应用程序”替换旧版。设置、目录和传输记录保持不变。'
    : '当前系统没有可直接安装的安装包，将打开下载页面。')
const primaryLabel = computed(() => status.value === 'downloading' ? '正在下载…' : status.value === 'installing' ? '正在安装…'
  : release.value.mode === 'page' ? '前往下载' : status.value === 'ready' ? '退出并打开安装包' : status.value === 'failed' ? '重新下载' : '立即更新')

async function call(fn: () => Promise<unknown>) {
  error.value = ''
  try { await fn() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败，请重试' }
}
const later = () => { if (!busy.value) void call(api.dismiss) }
const primary = () => void call(release.value.mode === 'page' ? api.openPage : status.value === 'ready' ? api.install : api.download)
// 焦点落在弹窗本身：Esc 即暂不更新，Tab 进入按钮，避免打开时主按钮出现焦点框。
onMounted(() => { dialog.value?.showModal(); dialog.value?.focus() })
onUnmounted(() => dialog.value?.close())
</script>
<template>
  <dialog ref="dialog" class="update-dialog" tabindex="-1" aria-labelledby="update-title" aria-describedby="update-summary" @cancel.prevent="later">
    <div class="update-header">
      <img class="update-mark" :src="brandIcon" width="52" height="52" alt="" aria-hidden="true" :draggable="false" />
      <div><h2 id="update-title">发现新版本</h2><p id="update-summary">PlutoFish Watch v{{ release.version }} 已发布，当前 v{{ update.current }}</p></div>
    </div>
    <div class="update-body">
      <div class="update-meta"><span class="version-pill">v{{ release.version }}</span><span v-if="published">{{ published }}</span><span v-if="release.size">安装包 {{ megabytes(release.size) }}</span></div>
      <section class="update-notes" aria-labelledby="update-notes-title">
        <div class="notes-heading"><h3 id="update-notes-title">更新内容</h3><button type="button" class="link" @click="call(api.openPage)">在 GitHub 查看</button></div>
        <div class="notes-scroll">
          <template v-for="(block, index) in notes" :key="index"><p v-if="block.kind === 'text'">{{ block.text }}</p><ul v-else><li v-for="(item, line) in block.items" :key="line">{{ item }}</li></ul></template>
          <p v-if="!notes.length" class="hint">本次发布没有附加说明。</p>
        </div>
      </section>
      <div v-if="transfers" class="notice" role="status">有 {{ transfers }} 个文件正在传输。更新会先保存进度再退出，重新打开后从断点继续。</div>
    </div>
    <div class="update-footer">
      <div class="update-status" role="status" aria-live="polite">
        <template v-if="busy">
          <div class="progress-line"><span>{{ status === 'installing' ? (release.mode === 'install' ? '已校验，正在退出并启动安装程序…' : '正在退出并打开安装包…') : `正在下载 ${megabytes(download!.received)} / ${megabytes(download!.total)}` }}</span><strong>{{ percent }}%</strong></div>
          <div class="update-bar" role="progressbar" aria-label="下载进度" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><span :style="{ transform: `scaleX(${percent / 100})` }" /></div>
        </template>
        <template v-else-if="failure"><p class="status-error" role="alert">{{ failure }}</p><button type="button" class="link" @click="call(api.openPage)">在浏览器中下载</button></template>
        <template v-else-if="status === 'ready'"><p class="status-ready">安装包已下载并校验</p><p class="hint">退出后，在打开的窗口中把新版拖入“应用程序”替换旧版。</p></template>
        <p v-else class="hint">{{ hint }}</p>
      </div>
      <div class="update-actions">
        <button v-if="status === 'downloading'" type="button" class="button secondary" @click="call(api.cancel)">取消下载</button>
        <button v-else type="button" class="button secondary" :disabled="busy" @click="later">{{ status === 'ready' ? '稍后' : '暂不更新' }}</button>
        <button type="button" class="button primary" :disabled="busy" @click="primary">{{ primaryLabel }}</button>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.update-dialog{width:min(540px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--text);box-shadow:0 22px 80px #0006;overflow:auto;outline:none}
.update-dialog[open]{animation:update-in .2s cubic-bezier(.2,.8,.2,1)}
.update-dialog::backdrop{background:#080d1980;animation:update-fade .2s ease-out}
@keyframes update-in{from{opacity:0;transform:translateY(8px) scale(.98)}}
@keyframes update-fade{from{opacity:0}}
.update-header{display:flex;align-items:center;gap:14px;padding:24px 26px 18px}
.update-mark{flex:none;width:52px;height:52px;object-fit:contain;user-select:none}
.update-header h2{font-size:18px;letter-spacing:-.3px}
.update-header p{font-size:12px;margin-top:5px}
.update-body{padding:0 26px 20px}
.update-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:11px;color:var(--muted);margin-bottom:14px}
.version-pill{font-weight:600;color:var(--accent);background:var(--accent-soft);border-radius:5px;padding:2px 8px}
.update-notes{background:var(--surface-subtle);border-radius:9px;padding:14px 6px 14px 16px}
.notes-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 10px 8px 0}
.notes-heading h3{font-size:12px;font-weight:600}
.notes-scroll{max-height:min(230px,34vh);overflow:auto;padding-right:10px;scrollbar-width:thin;scrollbar-color:var(--border-hover) transparent}
.notes-scroll p,.notes-scroll li{font-size:12px;line-height:1.75;color:var(--secondary);overflow-wrap:anywhere}
.notes-scroll ul{margin:0;padding-left:18px}
.notes-scroll :is(p,ul)+:is(p,ul){margin-top:8px}
.notes-scroll li+li{margin-top:4px}
.notes-scroll li::marker{color:var(--subtle)}
.update-body .notice{margin:14px 0 0;line-height:1.6}
.update-footer{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 26px 20px;background:var(--panel);border-top:1px solid var(--line)}
.update-status{flex:1;min-width:0;min-height:40px;display:flex;flex-direction:column;justify-content:center;gap:6px}
.update-status .hint{line-height:1.6}
.update-status .link{align-self:flex-start}
.status-error,.status-ready{font-size:12px;font-weight:550;line-height:1.5}
.status-error{color:var(--danger)}
.status-ready{color:var(--success)}
.progress-line{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--secondary);font-variant-numeric:tabular-nums}
.progress-line span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.progress-line strong{font-weight:600;color:var(--text)}
.update-bar{height:6px;border-radius:3px;background:var(--surface-subtle);overflow:hidden}
.update-bar span{display:block;height:100%;background:var(--primary);border-radius:3px;transform-origin:left;transition:transform .25s linear}
.update-actions{display:flex;gap:10px;flex-shrink:0}
.update-actions .button{min-width:96px}
@media(max-width:600px){.update-header{padding:20px 18px 16px}.update-body{padding:0 18px 16px}.update-footer{flex-direction:column;align-items:stretch;padding:14px 18px 18px}.update-actions{justify-content:flex-end}}
@media(prefers-reduced-motion:reduce){.update-dialog[open],.update-dialog::backdrop{animation:none}.update-bar span{transition:none}}
</style>
