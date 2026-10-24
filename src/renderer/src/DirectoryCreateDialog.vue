<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DirectoryPage, WatchInput } from '../../shared/model'
import { creationDraftForParent, creationSegments, rememberCreatedDirectory } from '../../shared/directory-creation'
import Icon from './Icon.vue'

const props = defineProps<{ input: WatchInput; categoryLabel: string }>()
const emit = defineEmits<{ close: []; created: [input: WatchInput] }>()
const dialog = ref<HTMLDialogElement>(), page = ref<DirectoryPage | null>(null)
const loading = ref(false), creating = ref(false), error = ref(''), failedBrowse = ref(false)
let active = true, generation = 0, requestedId = props.input.directoryId, requestedCursor = ''
const draft = computed(() => page.value ? creationDraftForParent(props.input, {
  id: page.value.path.at(-1)!.id, path: '/' + page.value.path.slice(1).map(p => p.name).join('/'),
}) : null)
const segments = computed(() => draft.value ? creationSegments(draft.value, props.categoryLabel) : [])
const preview = computed(() => draft.value ? [draft.value.directoryPath.replace(/\/+$/, ''), ...segments.value].join('/') : '')

async function browse(id: string, cursor = '') {
  if (loading.value || creating.value) return
  const current = ++generation
  requestedId = id; requestedCursor = cursor; loading.value = true; error.value = ''; failedBrowse.value = false
  try {
    const result = await window.plutoWatch.directories({ sourceAccountId: props.input.sourceAccountId, directoryId: id, cursor })
    if (!active || current !== generation) return
    page.value = cursor && page.value ? { ...result, items: [...page.value.items, ...result.items] } : result
  } catch (cause) {
    if (!active || current !== generation) return
    error.value = cause instanceof Error ? cause.message : '读取目录失败，请重试'; failedBrowse.value = true
  } finally { if (active && current === generation) loading.value = false }
}
async function create() {
  if (!draft.value || loading.value || creating.value || failedBrowse.value || !active) return
  const current = ++generation, selected = JSON.parse(JSON.stringify(draft.value)) as WatchInput
  const names = [...segments.value]
  creating.value = true; error.value = ''
  try {
    const result = await window.plutoWatch.createDirectories({ sourceAccountId: selected.sourceAccountId, directoryId: selected.directoryId, segments: names })
    if (!active || current !== generation) return
    rememberCreatedDirectory(selected, result)
    emit('created', selected)
  } catch (cause) {
    if (active && current === generation) error.value = cause instanceof Error ? cause.message : '创建目录失败，请重试'
  } finally { if (active && current === generation) creating.value = false }
}
function close() { if (!creating.value) emit('close') }
onMounted(() => { dialog.value?.showModal(); void browse(props.input.directoryId) })
onUnmounted(() => { active = false; generation++; dialog.value?.close() })
</script>
<template>
  <dialog ref="dialog" class="directory-dialog" aria-labelledby="directory-dialog-title" aria-describedby="directory-dialog-description" @cancel.prevent="close">
    <div class="dialog-header"><div><h2 id="directory-dialog-title">选择上级目录</h2><p id="directory-dialog-description">选好存放位置，确认下方完整路径后创建文件夹。</p></div><button type="button" class="icon-button" aria-label="关闭目录选择" :disabled="creating" @click="close"><Icon name="close" /></button></div>
    <div class="dialog-body">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <div class="directory-toolbar"><button type="button" class="link" :disabled="loading || creating" @click="browse('0')">网盘顶层</button><button v-if="failedBrowse" type="button" class="link" :disabled="loading || creating" @click="browse(requestedId, requestedCursor)">重新读取</button></div>
      <p v-if="loading" class="hint" role="status">正在读取网盘目录…</p>
      <fieldset v-if="page" :disabled="loading || creating">
        <div class="cloud-path"><button v-for="part in page.path" :key="part.id" type="button" class="link" @click="browse(part.id)">{{ part.name || '/' }} /</button></div>
        <div class="directory-list"><button v-for="item in page.items" :key="item.id" type="button" class="folder-option" @click="browse(item.id)"><Icon name="folder" /><span>{{ item.name }}</span><Icon name="arrow" :size="15" /></button><p v-if="!page.items.length && !loading" class="hint">此目录下没有子目录，可以在这里创建。</p></div>
        <button v-if="page.nextCursor" type="button" class="link" @click="browse(page.path.at(-1)!.id, page.nextCursor)">加载更多</button>
      </fieldset>
      <div v-if="draft" class="directory-preview"><span>确认创建路径</span><p>{{ preview }}</p></div>
      <p v-if="draft" class="hint">{{ segments.length === 1 ? '在已有作品目录下添加本季，保留原作品名称。' : '按上方路径创建，已有同名目录会复用。' }}</p>
    </div>
    <div class="dialog-footer"><button type="button" class="button secondary" :disabled="creating" @click="close">取消</button><button type="button" class="button primary" :disabled="!draft || loading || creating || failedBrowse" @click="create"><Icon name="folder" :size="17" />{{ creating ? '正在创建…' : '确认创建文件夹' }}</button></div>
  </dialog>
</template>
<style scoped>
.directory-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;border:1px solid var(--line);border-radius:13px;background:var(--panel);color:var(--text);box-shadow:0 18px 80px #0005;overflow:auto}
.directory-dialog::backdrop{background:#080d1980}
.dialog-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:22px 24px 18px;border-bottom:1px solid var(--line)}
.dialog-header p{font-size:12px;margin-top:7px;line-height:1.7}
.dialog-body{padding:18px 24px}
.directory-toolbar{display:flex;justify-content:space-between;gap:12px;margin-bottom:13px}
.cloud-path{margin-top:9px;overflow-wrap:anywhere}
.cloud-path .link{max-width:100%;text-align:left;overflow-wrap:anywhere}
.directory-list{max-height:220px;overflow:auto;margin:6px 0 12px}
.folder-option span{min-width:0;overflow-wrap:anywhere}
.directory-preview{background:var(--surface-subtle);border-radius:7px;padding:12px 14px;margin-top:18px;overflow-wrap:anywhere}
.directory-preview span{font-size:11px;color:var(--muted)}
.directory-preview p{font-size:13px;color:var(--text);margin-top:5px}
.dialog-body>.hint{margin-top:9px}
.dialog-footer{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding:16px 24px;background:var(--panel);border-top:1px solid var(--line)}
@media(max-width:600px){.dialog-header{padding:18px}.dialog-body{padding:16px 18px}.dialog-footer{padding:14px 18px}.directory-list{max-height:180px}}
</style>
