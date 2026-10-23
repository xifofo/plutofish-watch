<script setup lang="ts">
/** 仅添加目录时读取样本并识别；代次与草稿快照一起保护切换目录和手动输入。 */
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Recognition } from '../../shared/model'

const props = defineProps<{ path: string; sourceAccountId: string; connectionKey: string; draftKey: string; canReplace: boolean; disabled: boolean }>()
const emit = defineEmits<{ apply: [result: Recognition]; pending: [value: boolean] }>()
const fileName = ref(''), directoryName = ref(''), pending = ref(false), message = ref(''), error = ref('')
const result = ref<Recognition | null>(null), applied = ref(false)
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined

function invalidate() {
  generation++; clearTimeout(timer); pending.value = false; emit('pending', false)
  result.value = null; applied.value = false; error.value = ''; message.value = ''
}

async function recognize(current = ++generation) {
  if (!fileName.value.trim() || !props.sourceAccountId || props.disabled) return
  const draft = props.draftKey, canReplace = props.canReplace
  pending.value = true; emit('pending', true); result.value = null; applied.value = false; error.value = ''
  message.value = fileName.value === directoryName.value ? '正在识别目录名…' : '正在识别文件名…'
  try {
    const response = await window.plutoWatch.recognizeFile({ sourceAccountId: props.sourceAccountId, fileName: fileName.value.trim() })
    if (current !== generation) return
    result.value = response
    if (response.canAutoFill && canReplace && draft === props.draftKey) {
      emit('apply', response); applied.value = true
      message.value = '已填入作品与分类，请确认目录内文件属于同一作品和季。'
    } else if (response.canAutoFill) message.value = '识别完成。当前已有填写内容，可确认后替换。'
    else if (response.status === 'not_identified') message.value = '未识别到作品，可换一个目录名或文件名，或使用下方搜索和手动填写。'
    else if (response.reasons.some(reason => reason.startsWith('category_'))) message.value = '已识别作品，但分类未匹配到可用字典项，请检查分类规则或手动填写。'
    else message.value = '识别结果需要确认，请参考候选并使用下方搜索或手动填写。'
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
      message.value = '没有可用的目录名或视频文件名。可以输入名称识别，或手动填写。'
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
    message.value = '已填入作品与分类，请确认目录内文件属于同一作品和季。'
  }
}
</script>

<template>
  <div class="recognition">
    <label for="recognition-file">目录名 / 文件名识别</label>
    <div class="input-action">
      <input id="recognition-file" v-model="fileName" maxlength="1000" placeholder="例如：作品名.2024.S01 或 作品名.S01E02.mkv" :disabled="disabled" @input="invalidate" @keydown.enter.prevent="recognize()" />
      <button type="button" class="button secondary" :disabled="disabled || pending || !fileName.trim() || !sourceAccountId" @click="recognize()">{{ pending ? '识别中…' : '识别并填入' }}</button>
    </div>
    <p class="hint">选择目录后优先用视频文件名识别，没有可用视频时使用目录名。只在添加时回填，不改变后续目录绑定。</p>
    <button v-if="directoryName && fileName !== directoryName" type="button" class="link" :disabled="disabled || pending" @click="recognizeDirectory">使用目录名识别</button>
    <p v-if="message" role="status" class="hint">{{ message }}</p>
    <p v-if="error" role="alert" class="hint warning">{{ error }}</p>
    <div v-if="result?.work" class="recognition-result">
      <strong>{{ result.work.title }}</strong><span>{{ result.work.year || '年份未知' }} · {{ result.work.mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ result.work.tmdbId }} · {{ result.work.category.label || result.work.category.name || '分类待选择' }}</span>
      <button v-if="result.canAutoFill && !applied" type="button" class="link" :disabled="disabled" @click="apply">替换当前作品信息</button>
    </div>
    <details v-if="result && !result.canAutoFill && result.candidates.length" class="help-details">
      <summary>识别候选（{{ result.candidates.length }}）</summary>
      <p v-for="candidate in result.candidates" :key="`${candidate.work.mediaType}:${candidate.work.tmdbId}`" class="hint">{{ candidate.work.title }} · {{ candidate.work.year || '年份未知' }} · {{ candidate.work.mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ candidate.work.tmdbId }}</p>
    </details>
  </div>
</template>

<style scoped>
.recognition{margin-top:20px}.recognition-result{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px;background:var(--accent-soft);border-radius:9px;overflow-wrap:anywhere}.recognition-result span{font-size:11px;color:var(--muted)}
</style>
