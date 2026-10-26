<script setup lang="ts">
/** 仅添加目录时读取样本并识别；代次与草稿快照一起保护切换目录和手动输入。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Recognition, RecognizedWork } from '../../shared/model'

const props = defineProps<{ path: string; sourceAccountId: string; connectionKey: string; draftKey: string; canReplace: boolean; disabled: boolean }>()
const emit = defineEmits<{ apply: [result: Recognition]; confirm: [work: RecognizedWork, seasonNumber: number | undefined]; pending: [value: boolean] }>()
const fileName = ref(''), directoryName = ref(''), pending = ref(false), message = ref(''), error = ref('')
const result = ref<Recognition | null>(null), applied = ref(false)
const selectedIndex = ref<number | null>(null)
const selectedCandidate = computed(() => selectedIndex.value === null ? null : result.value?.candidates[selectedIndex.value])
const selectedSeason = computed(() => {
  const parsed = result.value?.parsed
  return selectedCandidate.value?.work.mediaType === 'tv' && parsed?.seasonNumber !== undefined
    && parsed.seasonNumber <= 10000 && (parsed.seasonEnd === undefined || parsed.seasonEnd === parsed.seasonNumber)
    ? parsed.seasonNumber : undefined
})
const missingFields = computed(() => {
  const work = selectedCandidate.value?.work
  if (!work) return []
  return [work.category.status !== 'matched' ? '资源分类' : '', work.mediaType === 'tv' && selectedSeason.value === undefined ? '季号' : ''].filter(Boolean)
})
const conflictLabels: Record<string, string> = { title: '片名', year: '年份', media_type: '作品类型', tmdb_id: 'TMDB ID', release_title: '发行片名' }
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined

function invalidate() {
  generation++; clearTimeout(timer); pending.value = false; emit('pending', false)
  result.value = null; selectedIndex.value = null; applied.value = false; error.value = ''; message.value = ''
}

async function recognize(current = ++generation) {
  if (!fileName.value.trim() || !props.sourceAccountId || props.disabled) return
  const draft = props.draftKey, canReplace = props.canReplace
  pending.value = true; emit('pending', true); result.value = null; selectedIndex.value = null; applied.value = false; error.value = ''
  message.value = fileName.value === directoryName.value ? '正在识别目录名…' : '正在识别文件名…'
  try {
    const response = await window.plutoWatch.recognizeFile({ sourceAccountId: props.sourceAccountId, fileName: fileName.value.trim() })
    if (current !== generation) return
    result.value = response
    if (response.canAutoFill && canReplace && draft === props.draftKey) {
      emit('apply', response); applied.value = true
      message.value = '已填入作品与分类'
    } else if (response.canAutoFill) message.value = '当前已有填写内容，可确认后替换。'
    else if (response.status === 'not_identified') message.value = '未识别到作品，请修改名称或搜索片名。'
    else if (response.candidates.length) message.value = '识别结果需要确认'
    else message.value = '识别结果需要确认，请搜索片名或手动填写。'
  } catch (e) {
    if (current === generation) { message.value = ''; error.value = e instanceof Error ? e.message : '识别失败，可继续手动填写' }
  } finally {
    if (current === generation) { pending.value = false; emit('pending', false) }
  }
}

async function sample(current: number) {
  if (!props.path.trim() || !props.sourceAccountId || props.disabled) {
    pending.value = false; emit('pending', false)
    return
  }
  pending.value = true; emit('pending', true); message.value = '正在查找目录中的视频文件…'
  try {
    const sample = await window.plutoWatch.recognitionSample(props.path)
    if (current !== generation) return
    directoryName.value = sample.directoryName
    fileName.value = sample.fileName || sample.directoryName
    if (!fileName.value) {
      message.value = '未找到可识别的名称，请输入名称或搜索片名。'
      return
    }
    await recognize(current)
  } catch (e) {
    if (current === generation) { message.value = ''; error.value = e instanceof Error ? e.message : '无法读取目录，可输入文件名识别' }
  } finally {
    if (current === generation) { pending.value = false; emit('pending', false) }
  }
}

watch(() => [props.path, props.sourceAccountId, props.connectionKey], () => {
  invalidate(); fileName.value = ''; directoryName.value = ''
  const current = generation
  if (props.path.trim()) {
    pending.value = true; emit('pending', true)
    timer = setTimeout(() => void sample(current), 400)
  }
}, { immediate: true })
onBeforeUnmount(invalidate)

function recognizeDirectory() {
  if (props.disabled || pending.value || !directoryName.value) return
  invalidate(); fileName.value = directoryName.value
  void recognize()
}

function apply() {
  if (!props.disabled && result.value?.canAutoFill) {
    emit('apply', result.value); applied.value = true
    message.value = '已填入作品与分类'
  }
}

function selectCandidate(index: number) {
  if (props.disabled || pending.value) return
  selectedIndex.value = index; applied.value = false
}

function confirmCandidate() {
  if (props.disabled || pending.value || applied.value || !selectedCandidate.value) return
  const work = selectedCandidate.value.work
  emit('confirm', work, selectedSeason.value); applied.value = true
  message.value = missingFields.value.length ? `请在下方补充${missingFields.value.join('和')}。` : '已填入作品与分类'
}
</script>

<template>
  <div class="recognition">
    <label for="recognition-file">目录名 / 文件名识别</label>
    <div class="input-action">
      <input id="recognition-file" v-model="fileName" maxlength="1000" placeholder="例如：作品名.2024.S01 或 作品名.S01E02.mkv" :disabled="disabled" @input="invalidate" @keydown.enter.prevent="recognize()" />
      <button type="button" class="button secondary" :disabled="disabled || pending || !fileName.trim() || !sourceAccountId" @click="recognize()">{{ pending ? '识别中…' : '识别并填入' }}</button>
    </div>
    <button v-if="directoryName && fileName !== directoryName" type="button" class="link" :disabled="disabled || pending" @click="recognizeDirectory">使用目录名识别</button>
    <p v-if="message" role="status" class="hint" :class="{ 'recognition-status-only': applied && !missingFields.length }">{{ message }}</p>
    <p v-if="error" role="alert" class="hint warning">{{ error }}</p>
    <div v-if="result?.work && !applied && (result.canAutoFill || !result.candidates.length)" class="recognition-result">
      <strong>{{ result.work.title }}</strong><span>{{ result.work.year || '年份未知' }} · {{ result.work.mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ result.work.tmdbId }} · {{ result.work.category.label || result.work.category.name || '分类待选择' }}</span>
      <button v-if="result.canAutoFill && !applied" type="button" class="link" :disabled="disabled" @click="apply">替换当前作品信息</button>
    </div>
    <details v-if="result && !result.canAutoFill && result.candidates.length" class="help-details" open>
      <summary>识别候选（{{ result.candidates.length }}）</summary>
      <p v-if="result.truncated" class="hint">当前仅展示部分候选；没有正确作品时，可使用下方搜索。</p>
      <div class="recognition-candidates" role="group" aria-label="识别候选">
        <button v-for="(candidate, index) in result.candidates" :key="`${candidate.work.mediaType}:${candidate.work.tmdbId}`" type="button" class="recognition-candidate" :aria-pressed="selectedIndex === index" :disabled="disabled || pending" @click="selectCandidate(index)">
          <span><strong>{{ candidate.work.title }}</strong><small v-if="candidate.work.originalTitle && candidate.work.originalTitle !== candidate.work.title">{{ candidate.work.originalTitle }}</small><small>{{ candidate.work.year || '年份未知' }} · {{ candidate.work.mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ candidate.work.tmdbId }}</small></span>
          <span class="candidate-action">{{ selectedIndex === index ? (applied ? '已确认' : '已选中') : '选择' }}</span>
        </button>
      </div>
      <div v-if="selectedCandidate" class="candidate-confirmation" aria-live="polite">
        <strong>{{ selectedCandidate.work.title }}</strong>
        <p class="hint">{{ selectedCandidate.work.year || '年份未知' }} · {{ selectedCandidate.work.mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ selectedCandidate.work.tmdbId }}</p>
        <p class="hint">分类：{{ selectedCandidate.work.category.status === 'matched' ? (selectedCandidate.work.category.label || selectedCandidate.work.category.name) : '待选择' }}<template v-if="selectedCandidate.work.mediaType === 'tv'"> · 季号：{{ selectedSeason ?? '待填写' }}</template></p>
        <p v-for="(conflict, index) in selectedCandidate.conflicts" :key="index" class="hint warning">{{ conflictLabels[conflict.field] || '识别信息' }}不一致：文件名为「{{ conflict.expected || '未知' }}」，候选为「{{ conflict.actual || '未知' }}」。</p>
        <p v-if="missingFields.length" class="hint warning">确认后请在下方补充{{ missingFields.join('和') }}。</p>
        <button type="button" class="button primary small" :disabled="disabled || pending || applied" @click="confirmCandidate">{{ applied ? '已确认并填入' : '确认并填入' }}</button>
      </div>
    </details>
  </div>
</template>

<style scoped>
.recognition{margin-bottom:24px}.recognition>.link,.recognition>.hint{margin-top:10px}.recognition-result{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px;margin-top:12px;background:var(--accent-soft);border-radius:9px;overflow-wrap:anywhere}.recognition-result span{font-size:11px;color:var(--muted)}
.recognition-status-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.recognition-candidates{margin-top:12px;border:1px solid var(--line);border-radius:9px;max-height:300px;overflow:auto}
.recognition-candidate{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;background:transparent;border:0;border-bottom:1px solid var(--line);padding:12px 14px;text-align:left;color:var(--text)}
.recognition-candidate:last-child{border-bottom:0}.recognition-candidate:hover,.recognition-candidate[aria-pressed=true]{background:var(--accent-soft)}
.recognition-candidate:focus-visible{outline-offset:-3px}.recognition-candidate>span:first-child{min-width:0}
.recognition-candidate strong,.candidate-confirmation>strong{display:block;font-size:12px;font-weight:550;overflow-wrap:anywhere}
.recognition-candidate small{display:block;font-size:10px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.candidate-action{flex-shrink:0;font-size:11px;color:var(--accent)}
.candidate-confirmation{margin-top:12px;padding:14px;background:var(--surface-subtle);border-radius:9px;overflow-wrap:anywhere}.candidate-confirmation .button{margin-top:12px}
</style>
