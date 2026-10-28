<!-- 监控与一次性上传表单；网盘浏览位置和待确认的保存位置分别维护。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Snapshot, WatchInput, WatchRoot, Release, DirectoryPage, Recognition, RecognizedWork } from '../../shared/model'
import Icon from './Icon.vue'
import WorkPicker from './WorkPicker.vue'
import SourceFields from './SourceFields.vue'
import DirectoryRecognition from './DirectoryRecognition.vue'
import DirectoryCreateDialog from './DirectoryCreateDialog.vue'
import CloudDirectoryRows from './CloudDirectoryRows.vue'
import { adjustCreationTarget, creationSegments, directoryCreated, directoryCreationPending } from '../../shared/directory-creation'
import { watchPaths } from '../../shared/watch-paths'
import { defaultOneTimeRetention } from '../../shared/retention'

const props = defineProps<{ state: Snapshot; busy: boolean; initial?: WatchRoot; once?: boolean }>()
const emit = defineEmits<{ save: [input: WatchInput]; back: [] }>()
const form = reactive<WatchInput>(props.initial ? JSON.parse(JSON.stringify({ ...props.initial, versionMode: props.initial.versionMode ?? 'fixed' })) : {
  mode: props.once ? 'once' : 'watch', cleanup: props.once ? defaultOneTimeRetention() : undefined,
  path: '', title: '', work: { mediaType: 'tv', tmdbId: '', category: props.state.connection.identity?.categories?.[0]?.value ?? '' },
  sourceAccountId: props.state.connection.identity?.sourceAccount.id ?? '', seasonNumber: 1,
  versionMode: 'auto', releaseId: '', directoryId: '0', directoryPath: '/', includeExisting: true, stableSeconds: 30,
})
const localPaths = ref(watchPaths(form))
watch(localPaths, paths => { form.path = paths[0] ?? ''; form.additionalPaths = paths.slice(1) }, { deep: true, flush: 'sync' })
const hasNewPaths = computed(() => !props.initial || localPaths.value.some(path => !watchPaths(props.initial!).includes(path)))
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
const selectedCloud = ref<DirectoryPage['items'][number]>()
const cloudFailed = ref(false)
const cloudTarget = computed(() => cloud.value ? [...cloud.value.path, ...(selectedCloud.value ? [selectedCloud.value] : [])] : [])
const cloudTargetPath = computed(() => '/' + cloudTarget.value.slice(1).map(part => part.name).join('/'))
let cloudGeneration = 0
onBeforeUnmount(() => { cloudGeneration++ })
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
watch(() => form.sourceAccountId, () => {
  cloudGeneration++
  loading.value = false
  delete form.directoryCreation
  form.directoryId = '0'; form.directoryPath = '/'
  cloud.value = null; selectedCloud.value = undefined; showCloud.value = false
})
watch(creationKey, () => adjustCreationTarget(form))
watch(() => form.versionMode, () => {
  form.releaseId = form.versionMode === 'fixed' && choices.value.length === 1 ? choices.value[0].id : ''
})

async function perform(fn: () => Promise<void>) {
  error.value = ''; loading.value = true
  try { await fn() } catch (e) { error.value = e instanceof Error ? e.message : '操作失败' }
  finally { loading.value = false }
}
async function chooseDirectory(index: number) {
  await perform(async () => {
    const path = await window.plutoWatch.chooseDirectory()
    if (path) {
      if (form.selectedFiles && form.cleanup) form.cleanup.enabled = false
      form.selectedFiles = undefined; localPaths.value[index] = path
    }
  })
}
async function chooseFiles() {
  await perform(async () => {
    const selection = await window.plutoWatch.chooseFiles()
    if (!selection) return
    if (form.cleanup) form.cleanup.enabled = false
    form.selectedFiles = selection.files; localPaths.value = [selection.path]
  })
}
function removeFile(path: string) {
  form.selectedFiles = form.selectedFiles?.filter(file => file !== path)
  if (!form.selectedFiles?.length) {
    form.selectedFiles = undefined; localPaths.value = ['']
    if (form.cleanup) form.cleanup.enabled = false
  }
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
  if (loading.value || props.busy) return
  const generation = ++cloudGeneration
  const sourceAccountId = form.sourceAccountId
  loading.value = true; error.value = ''; cloudFailed.value = false
  if (!cursor) { cloud.value = null; selectedCloud.value = undefined }

  try {
    const page = await window.plutoWatch.directories({ sourceAccountId, directoryId: id, cursor })
    if (generation !== cloudGeneration || sourceAccountId !== form.sourceAccountId) return
    const items = new Map((cursor ? cloud.value?.items ?? [] : []).map(item => [item.id, item]))
    for (const item of page.items) items.set(item.id, item)
    cloud.value = { ...page, items: [...items.values()] }
    showCloud.value = true
  } catch (cause) {
    if (generation !== cloudGeneration) return
    error.value = cause instanceof Error ? cause.message : '读取目录失败，请重试'
    cloudFailed.value = true
  } finally {
    if (generation === cloudGeneration) loading.value = false
  }
}

function selectCloud() {
  const target = cloudTarget.value.at(-1)
  if (!target || loading.value || props.busy || cloudFailed.value) return

  if (form.directoryCreation && target.id !== form.directoryCreation.directoryId) delete form.directoryCreation
  form.directoryId = target.id
  form.directoryPath = cloudTargetPath.value
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
  <button class="link back" :disabled="!!creationDialog" @click="emit('back')"><Icon name="back" :size="16" />{{ once ? '返回一次性上传' : '返回监控目录' }}</button>
  <div class="page-heading"><h1>{{ once ? '一次性上传' : initial ? '编辑监控目录' : '添加监控目录' }}</h1></div>
  <p v-if="once" class="notice">选择文件或目录，确认作品后上传并制作 ED2K。选择文件时仅上传所选视频；选择目录时包含子目录。后续新增文件不会自动加入。</p>
  <p v-if="initial" class="notice">未开始发布的文件采用新配置；已开始或完成的任务继续沿用原配置。移除或更换本地目录会停止该目录中未开始发布的任务，保留目录继续监控。</p>
  <div v-if="error" role="alert" class="notice error">{{ error }}</div>
  <form @submit.prevent="submit">
    <fieldset :disabled="busy || loading || !!creationDialog">
      <section class="panel form-section">
        <h2 class="section-heading">{{ once ? '本地文件或目录' : '本地目录' }}</h2>
        <div v-if="once" class="file-selection-actions">
          <button type="button" class="button secondary" @click="chooseFiles"><Icon name="file" :size="17" />选择文件</button>
          <button v-if="form.selectedFiles" type="button" class="button secondary" @click="chooseDirectory(0)"><Icon name="folder" :size="17" />选择目录</button>
          <span class="hint">可多选同一目录内的视频，所有文件共用同一作品和季。</span>
        </div>
        <div v-if="form.selectedFiles" class="selected-files" aria-label="本次上传文件">
          <p class="hint">已选择 {{ form.selectedFiles.length }} 个视频</p>
          <div v-for="file in form.selectedFiles" :key="file" class="selected-file">
            <span :title="file">{{ file }}</span><button type="button" class="link muted" :aria-label="`移除文件 ${file}`" @click="removeFile(file)">移除</button>
          </div>
        </div>
        <div v-else class="local-directories">
          <div v-for="(_, index) in localPaths" :key="index" class="local-directory">
            <div class="input-action"><input :id="`local-path-${index}`" v-model="localPaths[index]" required :aria-label="`本地目录 ${index + 1}`" placeholder="选择包含视频文件的目录" /><button type="button" class="button secondary" :aria-label="`选择本地目录 ${index + 1}`" @click="chooseDirectory(index)"><Icon name="folder" :size="17" />选择目录</button><button v-if="localPaths.length > 1" type="button" class="link muted" :aria-label="`移除本地目录 ${index + 1}`" @click="localPaths.splice(index, 1)">移除</button></div>
          </div>
        </div>
        <button v-if="!once" type="button" class="link add-local-directory" @click="localPaths.push('')"><Icon name="plus" :size="15" />添加本地目录</button>
        <p v-if="localPaths.length > 1" class="hint multi-directory-hint">所有目录共用同一作品{{ form.work.mediaType === 'tv' ? '和季' : '' }}。<template v-if="!initial">按第一个目录识别。</template></p>
        <div class="form-grid"><label>文件稳定等待（秒）<input v-model.number="form.stableSeconds" type="number" min="10" max="3600" required /></label>
          <label v-if="!once" class="checkbox"><input v-model="form.includeExisting" type="checkbox" :disabled="!hasNewPaths" /><span>首次补传历史文件<small v-if="!hasNewPaths">原目录请在列表中点击“补传历史”</small><small v-else-if="initial">仅作用于新加入的目录</small></span></label></div>
      </section>
      <section class="panel form-section">
        <h2 class="section-heading">作品与版本</h2>
        <DirectoryRecognition v-if="!initial" :path="form.selectedFiles?.[0] ?? form.path" :source-account-id="form.sourceAccountId" :connection-key="`${state.connection.url}:${state.connection.identity?.id ?? ''}`" :draft-key="draftKey" :can-replace="(!form.title && !form.work.tmdbId) || lastRecognitionDraft === draftKey" :disabled="busy || loading || !!creationDialog" @pending="recognitionPending = $event" @apply="applyRecognition" @confirm="applyConfirmedWork" />
        <div class="form-grid">
          <label>资源分类<select v-model="form.work.category" required><option value="" disabled>请选择资源分类</option><option v-for="c in categories" :key="c.value" :value="c.value">{{ c.label }}</option></select></label>
          <label>作品类型<select v-model="form.work.mediaType"><option value="tv">剧集</option><option value="movie">电影</option></select></label>
          <label v-if="form.work.mediaType === 'tv'">季号<input v-model.number="form.seasonNumber" type="number" min="0" max="10000" required /></label>
          <label>上传源账号<select v-model="form.sourceAccountId" required><option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }} · {{ s.alias }}</option></select></label>
        </div>
        <WorkPicker :key="pickerGeneration" v-model:title="form.title" v-model:tmdb-id="form.work.tmdbId" :media-type="form.work.mediaType" :source-account-id="form.sourceAccountId" @select="selectedWork" />
        <div class="version-mode"><label>版本归类<select v-model="form.versionMode" aria-label="版本归类"><option value="auto">自动归类</option><option value="fixed">固定版本</option></select></label></div>
        <details v-if="form.versionMode === 'auto'" class="help-details"><summary>目录来源预设</summary><SourceFields v-model="form.sourcePreset" /><p class="hint">仅补充文件名缺失的来源；网络片源需填写平台。</p></details>
        <div v-else class="input-action version-row"><label>固定版本<select v-model="form.releaseId" required><option value="" disabled>{{ queried ? '请选择已有版本' : '先查询作品的已有版本' }}</option><option v-for="r in choices" :key="r.id" :value="r.id">{{ r.name }}{{ r.latestEpisode !== undefined ? ` · 更新至 ${r.latestEpisode} 集` : '' }}</option></select></label>
          <button type="button" class="button secondary" :disabled="!form.work.tmdbId" @click="query">{{ loading ? '查询中…' : '查询版本' }}</button></div>
        <p v-if="queried && !choices.length && form.versionMode !== 'auto'" class="hint warning">暂无已有版本，可切换自动归类。</p>
      </section>
      <section class="panel form-section">
        <h2 class="section-heading">网盘目标</h2>
        <div class="form-grid cloud-target"><label>目录 ID<input v-model="form.directoryId" required pattern="0|[1-9][0-9]{0,39}" title="0 为根目录" @input="manualDirectory" /></label><label>上传路径<div class="input-action"><input v-model="form.directoryPath" placeholder="/" /><button type="button" class="button secondary" @click="browse()">浏览网盘</button></div></label></div>
        <div v-if="canCreate" class="directory-create">
          <div class="directory-preview"><span>{{ alreadyCreated ? '上传位置' : '新建路径' }}</span><p>{{ createPreview }}</p></div>
          <button type="button" class="button secondary" :disabled="alreadyCreated || recognitionPending" @click="createFolders"><Icon :name="alreadyCreated ? 'check' : 'folder'" :size="17" />{{ alreadyCreated ? '文件夹已创建' : '在网盘创建文件夹' }}</button>
          <p v-if="creationPending" class="hint warning">请创建本季文件夹或手动选择上传目录。</p>
        </div>
        <div v-if="showCloud && cloud" class="cloud-picker">
          <div class="cloud-path"><button v-for="p in cloud.path" :key="p.id" type="button" class="link" @click="browse(p.id)">{{ p.name || '/' }} /</button></div>
          <p class="hint">单击选中，双击或点击右侧箭头进入</p>
          <CloudDirectoryRows :items="cloud.items" :selected-id="selectedCloud?.id" :disabled="loading || busy || cloudFailed" @select="selectedCloud = $event" @enter="browse" />
          <p v-if="!cloud.items.length" class="hint">此目录下没有子目录</p>
          <button v-if="cloud.nextCursor" type="button" class="link" @click="browse(cloud.path.at(-1)!.id, cloud.nextCursor)">加载更多</button>
          <p class="hint cloud-target-path">保存到：{{ cloudTargetPath }}</p>
          <div class="form-footer"><button type="button" class="button secondary" @click="showCloud = false">关闭</button><button type="button" class="button primary" :disabled="cloudFailed" @click="selectCloud">{{ selectedCloud ? '保存到选中的文件夹' : '保存到当前文件夹' }}</button></div>
        </div>
      </section>
      <section v-if="once && form.cleanup && form.work.tmdbId && form.title" class="panel form-section once-cleanup">
        <h2 class="section-heading">上传后的{{ form.selectedFiles ? '所选文件' : '本地目录' }}</h2>
        <label class="checkbox"><input v-model="form.cleanup.enabled" type="checkbox" :aria-label="form.selectedFiles ? '自动删除所选文件' : '自动删除本次目录'" /><span>完成后自动删除{{ form.selectedFiles ? '所选文件' : '这个文件夹' }}</span></label>
        <label class="cleanup-days">全部上传并同步 ED2K 后保留 <input v-model.number="form.cleanup.days" type="number" min="1" max="365" step="1" required :disabled="!form.cleanup.enabled" :aria-label="form.selectedFiles ? '文件保留天数' : '目录保留天数'" /> 天</label>
        <p class="hint">{{ form.selectedFiles ? (form.cleanup.enabled ? '到期仅删除所选视频，保留文件夹与其他文件。所选文件发生变化时会停止删除。' : '保留所选文件，不受监控目录的自动清理设置影响。') : (form.cleanup.enabled ? '到期删除整个所选文件夹，包括字幕、封面等附属文件。发现新增或修改内容时会停止删除。' : '保留本次目录，不受监控目录的自动清理设置影响。') }} 可在任务列表中取消删除；退出应用时暂停处理，下次启动后继续检查。</p>
      </section>
      <div class="form-footer submit-row"><button class="button primary" type="submit" :disabled="!form.path || recognitionPending || creationPending || !form.work.tmdbId || !form.title || (form.versionMode !== 'auto' && !form.releaseId)"><Icon :name="once ? 'upload' : initial ? 'check' : 'plus'" :size="18" />{{ busy ? '正在保存…' : once ? '开始一次性上传' : initial ? '保存修改' : '创建并开始监控' }}</button></div>
    </fieldset>
  </form>
  <DirectoryCreateDialog v-if="creationDialog" :input="creationDialog.input" :category-label="creationDialog.categoryLabel" @close="creationDialog = undefined" @created="createdFolders" />
</template>
<style scoped>
.cloud-target-path{overflow-wrap:anywhere;margin-top:12px}
.section-heading{margin-bottom:18px}
.cleanup-days{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0}
.cleanup-days input{width:80px;margin:0;text-align:center}
.file-selection-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px}
.selected-files{max-height:260px;overflow:auto;margin-bottom:16px}
.selected-file{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.selected-file span{flex:1;min-width:0;overflow-wrap:anywhere;font-size:12px}
.selected-file button{flex-shrink:0}
.local-directories{display:grid;gap:12px}
.local-directory .input-action input,.local-directory .input-action .button{margin-top:0}
.local-directory .input-action input{min-width:0}
.local-directory .input-action button{flex-shrink:0}
.add-local-directory{display:inline-flex;align-items:center;gap:6px;margin-top:14px}
.multi-directory-hint{margin-top:10px}
.cloud-target{grid-template-columns:minmax(120px,1fr) minmax(0,3fr);margin-top:0}
.submit-row{justify-content:flex-end}
@media(max-width:880px){.cloud-target{grid-template-columns:1fr}}
@media(max-width:700px){.local-directory .input-action{flex-wrap:wrap}.local-directory .input-action input{flex-basis:100%}}
.version-mode{margin:20px 0 10px}
.directory-create{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.directory-preview{background:var(--surface-subtle);border-radius:7px;padding:12px 14px;margin-bottom:12px;overflow-wrap:anywhere}
.directory-preview span{font-size:11px;color:var(--muted)}
.directory-preview p{font-size:13px;color:var(--text);margin-top:5px}
</style>
