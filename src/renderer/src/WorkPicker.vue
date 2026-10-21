<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Work, WorkOption, WorkPage } from '../../shared/model'

const props = defineProps<{ mediaType: Work['mediaType']; sourceAccountId: string }>()
const title = defineModel<string>('title', { required: true })
const tmdbId = defineModel<string>('tmdbId', { required: true })
const emit = defineEmits<{ select: [] }>()
const query = ref(''), loading = ref(false), error = ref('')
const page = ref<WorkPage | null>(null), selected = ref<WorkOption | null>(null), manual = ref(false)
let generation = 0

function resetResults() {
  generation++; loading.value = false; error.value = ''; page.value = null
}
function clear() {
  resetResults(); selected.value = null; title.value = ''; tmdbId.value = ''
}
watch(() => props.mediaType, clear)
watch(() => props.sourceAccountId, resetResults)
onBeforeUnmount(resetResults)

async function search(number = 1) {
  if (!query.value.trim() || loading.value) return
  const current = ++generation
  loading.value = true; error.value = ''; page.value = null
  try {
    const result = await window.plutoWatch.searchWorks({
      query: query.value.trim(), mediaType: props.mediaType, sourceAccountId: props.sourceAccountId, page: number,
    })
    if (current === generation) page.value = result
  } catch (e) {
    if (current === generation) error.value = e instanceof Error ? e.message : '作品搜索失败'
  } finally {
    if (current === generation) loading.value = false
  }
}
function select(item: WorkOption) {
  resetResults(); selected.value = item; title.value = item.title; tmdbId.value = item.tmdbId
  emit('select')
}
function toggleManual() {
  clear(); manual.value = !manual.value
}
</script>
<template>
  <div class="work-picker">
    <template v-if="selected">
      <div class="selected-work">
        <div><strong>{{ selected.title }}</strong><small>{{ selected.year ?? '年份未知' }} · {{ mediaType === 'tv' ? '剧集' : '电影' }} · TMDB {{ selected.tmdbId }}</small></div>
        <button type="button" class="link" @click="clear">重新选择</button>
      </div>
    </template>
    <template v-else>
      <div v-if="!manual">
        <label for="work-query">搜索作品</label>
        <div class="input-action">
          <input id="work-query" v-model="query" type="search" maxlength="100" autocomplete="off" placeholder="输入片名搜索 TMDB" @input="resetResults" @keydown.enter.prevent="search()" />
          <button type="button" class="button secondary" :disabled="loading || !query.trim()" @click="search()">{{ loading ? '搜索中…' : '搜索' }}</button>
        </div>
        <p v-if="error" role="alert" class="hint warning">{{ error }}</p>
        <div v-if="page" class="work-results" aria-label="作品搜索结果" aria-live="polite">
          <p v-if="!page.items.length" class="hint">没有找到作品，试试其他片名或切换电影／剧集。</p>
          <button v-for="item in page.items" :key="item.tmdbId" type="button" class="work-option" @click="select(item)">
            <span><strong>{{ item.title }}</strong><small v-if="item.originalTitle && item.originalTitle !== item.title">{{ item.originalTitle }}</small></span>
            <span class="work-identity"><strong>{{ item.year ?? '年份未知' }}</strong><small>TMDB {{ item.tmdbId }}</small></span>
          </button>
          <div v-if="page.totalPages > 1" class="work-pages">
            <button type="button" class="link" :disabled="page.page <= 1" @click="search(page.page - 1)">上一页</button>
            <span>{{ page.page }} / {{ page.totalPages }}</span>
            <button type="button" class="link" :disabled="page.page >= page.totalPages" @click="search(page.page + 1)">下一页</button>
          </div>
        </div>
      </div>
      <div v-else class="manual-work">
        <label>作品名称<input v-model="title" required maxlength="200" placeholder="作品名称" /></label>
        <label>TMDB ID<input v-model="tmdbId" required inputmode="numeric" pattern="[1-9][0-9]*" placeholder="填写 TMDB ID" /></label>
      </div>
      <button type="button" class="link manual-toggle" @click="toggleManual">{{ manual ? '返回片名搜索' : '直接填写 TMDB ID' }}</button>
    </template>
  </div>
</template>
<style scoped>
.work-picker{margin-top:20px}
.work-results{margin-top:12px;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.work-results>p{padding:0 14px}
.work-option{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;background:transparent;border:0;border-bottom:1px solid var(--line);padding:12px 14px;text-align:left;color:inherit}
.work-option:hover,.work-option:focus-visible{background:var(--accent-soft)}
.work-option>span{min-width:0}
.work-option strong,.selected-work strong{display:block;font-size:12px;font-weight:550;overflow-wrap:anywhere}
.work-option small,.selected-work small{display:block;font-size:10px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.work-identity{text-align:right;flex-shrink:0}
.work-pages{display:flex;justify-content:space-between;align-items:center;font-size:10px;padding:12px 14px;color:var(--muted)}
.selected-work{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px;background:var(--accent-soft);border-radius:9px}
.selected-work>div{min-width:0}.selected-work .link{flex-shrink:0}
.manual-toggle{margin-top:12px;font-size:10px}
.manual-work{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:900px){.manual-work{grid-template-columns:1fr}}
</style>
