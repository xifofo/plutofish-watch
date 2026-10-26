<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { Snapshot, WatchInput, WatchRoot, Release, DirectoryPage, Recognition, RecognizedWork } from '../../shared/model'
import Icon from './Icon.vue'
import WorkPicker from './WorkPicker.vue'
import SourceFields from './SourceFields.vue'
import DirectoryRecognition from './DirectoryRecognition.vue'
import DirectoryCreateDialog from './DirectoryCreateDialog.vue'
import { adjustCreationTarget, creationSegments, directoryCreated, directoryCreationPending } from '../../shared/directory-creation'

const props = defineProps<{ state: Snapshot; busy: boolean; initial?: WatchRoot }>()
const emit = defineEmits<{ save: [input: WatchInput]; back: [] }>()
const form = reactive<WatchInput>(props.initial ? JSON.parse(JSON.stringify({ ...props.initial, versionMode: props.initial.versionMode ?? 'fixed' })) : {
  path: '', title: '', work: { mediaType: 'tv', tmdbId: '', category: props.state.connection.identity?.categories?.[0]?.value ?? '' },
  sourceAccountId: props.state.connection.identity?.sourceAccount.id ?? '', seasonNumber: 1,
  versionMode: 'auto', releaseId: '', directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 30,
})
const choices = ref<Release[]>([]), loading = ref(false), error = ref(''), queried = ref(false)
const recognitionPending = ref(false), pickerGeneration = ref(0), lastRecognitionDraft = ref('')
const recognizedCategory = ref<{ value: string; label: string }>()
const draftKey = computed(() => JSON.stringify([form.work, form.title, form.seasonNumber]))
const categories = computed(() => {
  const items = props.state.connection.identity?.categories ?? []
  return recognizedCategory.value && !items.some(c => c.value === recognizedCategory.value!.value) ? [...items, recognizedCategory.value] : items
})

/** 只消费可安全回填的结果；重建作品选择器以避免旧类型监听清除新草稿。 */
function applyRecognition(result: Recognition) {
  if (props.busy || loading.value || creationDialog.value || !result.canAutoFill || !result.workTarget || !result.work) return
  applyConfirmedWork(result.work, result.parsed.seasonNumber)
}
/** 人工确认只采用选中的身份；未匹配分类和不确定季号留空，避免沿用旧作品的信息。 */
function applyConfirmedWork(work: RecognizedWork, seasonNumber: number | undefined) {
  if (props.busy || loading.value || creationDialog.value) return
  const category = work.category.status === 'matched' ? work.category.value : ''
  form.work = { mediaType: work.mediaType, tmdbId: work.tmdbId, category }; form.title = work.title
  form.seasonNumber = work.mediaType === 'tv' ? seasonNumber : undefined
  recognizedCategory.value = category ? { value: category, label: work.category.label || work.category.name || category } : undefined
  pickerGeneration.value++
  lastRecognitionDraft.value = draftKey.value
}
if (props.initial && form.versionMode === 'fixed') {
  choices.value = [{ id: form.releaseId, name: props.initial.releaseName,
    resolution: props.initial.releaseVersion?.resolution ?? '', dynamicRange: props.initial.releaseVersion?.dynamicRange ?? '', status: 'published' }]
}
const cloud = ref<DirectoryPage | null>(null), showCloud = ref(false)
const canCreate = computed(() => !!form.title.trim() && /^[1-9]\d{0,9}$/.test(form.work.tmdbId) && Number(form.work.tmdbId) <= 2147483647
  && !!categories.value.find(c => c.value === form.work.category) && !!form.sourceAccountId
  && (form.work.mediaType === 'movie' || (Number.isInteger(form.seasonNumber) && form.seasonNumber! >= 0 && form.seasonNumber! <= 10000)))
const alreadyCreated = computed(() => directoryCreated(form))
const creationPending = computed(() => directoryCreationPending(form))
const segments = computed(() => creationSegments(form, categories.value.find(c => c.value === form.work.category)?.label ?? form.work.category))
const createPreview = computed(() => alreadyCreated.value ? form.directoryPath : [form.directoryPath.replace(/\/+$/, ''), ...segments.value].join('/'))
const creationKey = () => JSON.stringify([form.sourceAccountId, form.work.mediaType, form.work.tmdbId, form.seasonNumber, form.directoryId])
const creationScope = () => JSON.stringify([props.state.connection.url, props.state.connection.identity?.id,
  form.sourceAccountId, form.work, form.title, form.seasonNumber, form.directoryId, form.directoryPath, form.directoryCreation])
const creationDialog = ref<{ input: WatchInput; categoryLabel: string; scope: string }>()
watch(creationScope, () => { creationDialog.value = undefined })
const sources = computed(() => props.state.connection.identity?.sourceAccounts ?? (props.state.connection.identity ? [props.state.connection.identity.sourceAccount] : []))
watch(() => [form.work.tmdbId, form.work.mediaType, form.work.category, form.seasonNumber, form.sourceAccountId], () => {
  choices.value = []; form.releaseId = ''; queried.value = false
})
watch(() => form.sourceAccountId, () => { delete form.directoryCreation; form.directoryId = '0'; form.directoryPath = '/'; cloud.value = null })
watch(creationKey, () => adjustCreationTarget(form))
watch(() => form.versionMode, () => {
  form.releaseId = form.versionMode === 'fixed' && choices.value.length === 1 ? choices.value[0].id : ''
})

async function perform(fn: () => Promise<void>) {
  error.value = ''; loading.value = true
  try { await fn() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' }
  finally { loading.value = false }
}
async function chooseDirectory() {
  await perform(async () => { const path = await window.plutoWatch.chooseDirectory(); if (path) form.path = path })
}
async function query() {
  await perform(async () => {
    choices.value = await window.plutoWatch.releases(JSON.parse(JSON.stringify(form)))
    queried.value = true
    if (form.versionMode === 'fixed' && choices.value.length === 1) form.releaseId = choices.value[0].id
  })
}
async function selectedWork() {
  await nextTick()
  if (form.work.category && form.sourceAccountId) await query()
}
async function browse(id = form.directoryId, cursor = '') {
  await perform(async () => {
    const page = await window.plutoWatch.directories({ sourceAccountId: form.sourceAccountId, directoryId: id, cursor })
    cloud.value = cursor && cloud.value ? { ...page, items: [...cloud.value.items, ...page.items] } : page
    showCloud.value = true
  })
}
function selectCloud() {
  if (!cloud.value) return
  if (form.directoryCreation && cloud.value.path.at(-1)!.id !== form.directoryCreation.directoryId) delete form.directoryCreation
  form.directoryId = cloud.value.path.at(-1)!.id
  form.directoryPath = '/' + cloud.value.path.slice(1).map(p => p.name).join('/')
  showCloud.value = false
}
function manualDirectory(event: Event) {
  if (form.directoryCreation && (event.target as HTMLInputElement).value !== form.directoryCreation.directoryId) delete form.directoryCreation
}
function createFolders() {
  if (!canCreate.value || alreadyCreated.value || recognitionPending.value || loading.value || props.busy) return
  creationDialog.value = { input: JSON.parse(JSON.stringify(form)), scope: creationScope(),
    categoryLabel: categories.value.find(c => c.value === form.work.category)?.label ?? form.work.category }
}
function createdFolders(input: WatchInput) {
  if (!creationDialog.value || creationDialog.value.scope !== creationScope()) return
  form.directoryId = input.directoryId; form.directoryPath = input.directoryPath; form.directoryCreation = input.directoryCreation
  creationDialog.value = undefined; showCloud.value = false
}
function submit() {
  if (recognitionPending.value || creationPending.value) return
  emit('save', JSON.parse(JSON.stringify({ ...form, seasonNumber: form.work.mediaType === 'tv' ? form.seasonNumber : undefined })))
}
</script>
<template>
  <button class="link back" :disabled="!!creationDialog" @click="emit('back')"><Icon name="back" :size="16" />返回监控目录</button>
  <div class="page-heading"><h1>{{ initial ? '编辑监控目录' : '添加监控目录' }}</h1></div>
  <p v-if="initial" class="notice">未开始发布的文件采用新配置；已开始或完成的任务继续沿用原配置。更换本地目录会停止原目录中未开始发布的任务。</p>
  <div v-if="error" role="alert" class="notice error">{{ error }}</div>
  <form @submit.prevent="submit">
    <fieldset :disabled="busy || loading || !!creationDialog">
      <section class="panel form-section">
        <div class="section-label"><span class="step">1</span><div><h2>本地目录</h2></div></div>
        <label>目录路径<div class="input-action"><input v-model="form.path" required placeholder="选择包含视频文件的目录" /><button type="button" class="button secondary" @click="chooseDirectory"><Icon name="folder" :size="17" />选择目录</button></div></label>
        <div class="form-grid"><label>文件稳定等待（秒）<input v-model.number="form.stableSeconds" type="number" min="10" max="3600" required /></label>
          <label class="checkbox"><input v-model="form.includeExisting" type="checkbox" :disabled="!!initial && form.path === initial.path" /><span>首次补传历史文件<small>{{ initial && form.path === initial.path ? '原目录的历史文件请在列表中点击“补传历史”' : '关闭后，仅处理后续新增或修改的文件' }}</small></span></label></div>
      </section>
      <section class="panel form-section">
        <h2 class="section-heading">作品与版本</h2>
        <DirectoryRecognition v-if="!initial" :path="form.path" :source-account-id="form.sourceAccountId" :connection-key="`${state.connection.url}:${state.connection.identity?.id ?? ''}`" :draft-key="draftKey" :can-replace="(!form.title && !form.work.tmdbId) || lastRecognitionDraft === draftKey" :disabled="busy || loading || !!creationDialog" @pending="recognitionPending = $event" @apply="applyRecognition" @confirm="applyConfirmedWork" />
        <div class="form-grid">
          <label>资源分类<select v-model="form.work.category" required><option value="" disabled>请选择资源分类</option><option v-for="c in categories" :key="c.value" :value="c.value">{{ c.label }}</option></select></label>
          <label>作品类型<select v-model="form.work.mediaType"><option value="tv">剧集</option><option value="movie">电影</option></select></label>
          <label v-if="form.work.mediaType === 'tv'">季号<input v-model.number="form.seasonNumber" type="number" min="0" max="10000" required /></label>
          <label>上传源账号<select v-model="form.sourceAccountId" required><option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }} · {{ s.alias }}</option></select></label>
        </div>
        <WorkPicker :key="pickerGeneration" v-model:title="form.title" v-model:tmdb-id="form.work.tmdbId" :media-type="form.work.mediaType" :source-account-id="form.sourceAccountId" @select="selectedWork" />
        <div class="version-mode"><label>版本归类<select v-model="form.versionMode" aria-label="版本归类"><option value="auto">自动归类</option><option value="fixed">固定版本</option></select></label></div>
        <template v-if="form.versionMode === 'auto'"><p class="hint">匹配已有版本，无匹配时自动新增；来源不明待确认。</p><details class="help-details"><summary>目录来源预设</summary><SourceFields v-model="form.sourcePreset" /><p class="hint">文件名优先，预设补缺。网络片源需平台；光盘来源可留空。</p></details></template>
        <div v-else class="input-action version-row"><label>固定版本<select v-model="form.releaseId" required><option value="" disabled>{{ queried ? '请选择已有版本' : '先查询作品的已有版本' }}</option><option v-for="r in choices" :key="r.id" :value="r.id">{{ r.name }}{{ r.latestEpisode !== undefined ? ` · 更新至 ${r.latestEpisode} 集` : '' }}</option></select></label>
          <button type="button" class="button secondary" :disabled="!form.work.tmdbId" @click="query">{{ loading ? '查询中…' : '查询版本' }}</button></div>
        <p v-if="queried && !choices.length && form.versionMode !== 'auto'" class="hint warning">暂无已有版本，可切换自动归类。</p>
        <details v-else class="help-details"><summary>集号识别规则</summary><p class="hint">支持 S01E02、E02、EP02、第2集；无法识别或季号不符时需手动确认。</p></details>
      </section>
      <section class="panel form-section">
        <div class="section-label"><span class="step">3</span><div><h2>网盘目标</h2></div></div>
        <div class="form-grid"><label>目标目录 ID<input v-model="form.directoryId" required pattern="0|[1-9][0-9]{0,39}" @input="manualDirectory" /></label><label>目标路径<div class="input-action"><input v-model="form.directoryPath" placeholder="/" /><button type="button" class="button secondary" @click="browse()">浏览网盘</button></div></label></div>
        <p class="hint">0 为根目录；文件平铺上传，不复制本地目录结构。</p>
        <div v-if="canCreate" class="directory-create">
          <div class="directory-preview"><span>{{ alreadyCreated ? '已创建并选为上传目录' : '默认创建路径' }}</span><p>{{ createPreview }}</p></div>
          <button type="button" class="button secondary" :disabled="alreadyCreated || recognitionPending" @click="createFolders"><Icon :name="alreadyCreated ? 'check' : 'folder'" :size="17" />{{ alreadyCreated ? '文件夹已创建' : '在网盘创建文件夹' }}</button>
          <p class="hint">{{ alreadyCreated ? '后续使用这个目录 ID，作品改名不会更改文件夹。' : '先选择上级目录，确认完整路径后创建并选为上传位置。' }}</p>
          <p v-if="creationPending" class="hint warning">请创建本季文件夹或手动选择上传目录。</p>
        </div>
        <div v-if="showCloud && cloud" class="cloud-picker">
          <div class="cloud-path"><button v-for="p in cloud.path" :key="p.id" type="button" class="link" @click="browse(p.id)">{{ p.name || '/' }} /</button></div>
          <button v-for="item in cloud.items" :key="item.id" type="button" class="folder-option" @click="browse(item.id)"><Icon name="folder" />{{ item.name }}<Icon name="arrow" :size="15" /></button>
          <p v-if="!cloud.items.length" class="hint">此目录下没有子目录</p>
          <button v-if="cloud.nextCursor" type="button" class="link" @click="browse(cloud.path.at(-1)!.id, cloud.nextCursor)">加载更多</button>
          <div class="form-footer"><button type="button" class="button secondary" @click="showCloud = false">关闭</button><button type="button" class="button primary" @click="selectCloud">选用当前目录</button></div>
        </div>
      </section>
      <div class="form-footer"><span class="hint">{{ initial ? '保存后保留目录原来的监控或暂停状态' : '自动上传 · 保留原文件' }}</span><button class="button primary" type="submit" :disabled="recognitionPending || creationPending || !form.work.tmdbId || !form.title || (form.versionMode !== 'auto' && !form.releaseId)"><Icon :name="initial ? 'check' : 'plus'" :size="18" />{{ busy ? '正在保存…' : initial ? '保存修改' : '创建并开始监控' }}</button></div>
    </fieldset>
  </form>
  <DirectoryCreateDialog v-if="creationDialog" :input="creationDialog.input" :category-label="creationDialog.categoryLabel" @close="creationDialog = undefined" @created="createdFolders" />
</template>
<style scoped>
.version-mode{margin:20px 0 10px}
.directory-create{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.directory-preview{background:var(--surface-subtle);border-radius:7px;padding:12px 14px;margin-bottom:12px;overflow-wrap:anywhere}
.directory-preview span{font-size:11px;color:var(--muted)}
.directory-preview p{font-size:13px;color:var(--text);margin-top:5px}
</style>
