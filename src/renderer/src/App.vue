<script setup lang="ts">
const appVersion = __APP_VERSION__
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Snapshot, WatchInput, WatchRoot, ReleaseSource } from '../../shared/model'
import Icon from './Icon.vue'
import DirectoryForm from './DirectoryForm.vue'
import JobList from './JobList.vue'
import SourceFields from './SourceFields.vue'
import RetentionSettings from './RetentionSettings.vue'
import OneTimeList from './OneTimeList.vue'
import { defaultRetention } from '../../shared/retention'
import { watchPaths } from '../../shared/watch-paths'
import watchFoldersArt from './assets/watch-folders.png'
import brandIcon from '../../../resources/icon.png'

const api = window.plutoWatch

const state = ref<Snapshot>({ connection: { url: '', hasKey: false, status: 'idle', error: '', identity: null }, watches: [], jobs: [], uploadsPaused: false, ffprobe: '', ffprobeAvailable: false, fatalError: '', retention: defaultRetention() })
const view = ref('overview'), error = ref(''), notice = ref(''), busy = ref(false), connecting = ref(false)
watch(view, async () => { notice.value = '';  await nextTick(); window.scrollTo(0, 0) })
const sourceRoot = ref<WatchRoot>(), sourceDraft = ref<ReleaseSource>({})
const editing = ref<WatchRoot>()
function edit(root: WatchRoot) {
  editing.value = JSON.parse(JSON.stringify(root)); error.value = ''
  view.value = connected.value ? 'edit' : 'settings'
}
function editSource(root: WatchRoot) { sourceRoot.value = root; sourceDraft.value = { ...root.sourcePreset } }
async function saveSource() { await run(async () => { await api.setSourcePreset({ id: sourceRoot.value!.id, source: { ...sourceDraft.value } }); sourceRoot.value = undefined }) }
const credentials = reactive({ url: '', key: '' })
let unsubscribe: (() => void) | undefined
const connected = computed(() => state.value.connection.status === 'verified')
watch(connected, ready => { if (ready && error.value.startsWith('PlutoFish 网络连接中断')) error.value = '' })
const monitored = computed(() => state.value.watches.filter(w => w.mode !== 'once'))
const batches = computed(() => state.value.watches.filter(w => w.mode === 'once'))
const active = computed(() => monitored.value.filter(w => w.enabled).reduce((count, root) => count + watchPaths(root).length, 0))
const pending = computed(() => state.value.jobs.filter(j => ['queued', 'preparing', 'processing', 'uploading', 'waiting'].includes(j.status)).length)
const attention = computed(() => state.value.jobs.filter(j => ['failed', 'review'].includes(j.status)).length)
const completed = computed(() => state.value.jobs.filter(j => j.status === 'completed').length)
const nav = [{ id: 'overview', icon: 'grid', title: '概览' }, { id: 'watches', icon: 'folder', title: '监控目录' }, { id: 'once', icon: 'upload', title: '一次性上传' }, { id: 'jobs', icon: 'list', title: '传输任务' }, { id: 'settings', icon: 'settings', title: '连接与设置' }]
async function run(fn: () => Promise<unknown>) {
  error.value = ''; busy.value = true
  try { await fn(); state.value = await api.snapshot() }
  catch (e) { error.value = e instanceof Error ? e.message : '操作失败' }
  finally { busy.value = false }
}
async function backfill(id: string) { await run(async () => { const count = await api.backfill(id); notice.value = count ? `已加入 ${count} 个历史文件` : '没有待补传的历史文件' }) }
function add() { view.value = connected.value ? 'new' : 'settings' }
function addOnce() { view.value = connected.value ? 'new-once' : 'settings' }
async function save(input: WatchInput) {
  const id = view.value === 'edit' ? editing.value?.id : undefined
  await run(async () => {
    if (id) await api.updateWatch({ id, watch: input })
    else await api.add(input)
    editing.value = undefined; view.value = input.mode === 'once' ? 'once' : 'watches'
    if (id) await nextTick().then(() => { notice.value = '目录配置已更新' })
  })
}
async function connect() {
  if (connecting.value) return
  connecting.value = true; error.value = ''
  try {
    await api.connect({ ...credentials }); credentials.key = ''
    state.value = await api.snapshot(); error.value = ''
  } catch (e) { error.value = e instanceof Error ? e.message : '连接失败' }
  finally { connecting.value = false }
}
onMounted(async () => {
  unsubscribe = api.onChange(value => { state.value = value })
  await run(async () => { state.value = await api.snapshot(); credentials.url = state.value.connection.url })
})
onUnmounted(() => unsubscribe?.())
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><img class="brand-mark" :src="brandIcon" width="48" height="48" alt="" aria-hidden="true" :draggable="false" /><div>PlutoFish<span>WATCH</span></div></div>
      <nav><button v-for="n in nav" :key="n.id" :class="{ active: view === n.id || (n.id === 'watches' && ['new', 'edit'].includes(view)) || (n.id === 'once' && view === 'new-once') }" @click="view = n.id; error = ''"><Icon :name="n.icon" :size="19" />{{ n.title }}<span v-if="n.id === 'jobs' && attention" class="nav-count">{{ attention }}</span></button></nav>
      <div class="sidebar-bottom"><div class="connection-dot" :class="{ online: connected }" /><div><strong>{{ connected ? state.connection.identity?.name : state.connection.reconnect ? '等待自动重连' : '尚未连接' }}</strong></div><button class="icon-button" aria-label="连接设置" @click="view = 'settings'"><Icon name="settings" :size="18" /></button></div>
      <div class="sidebar-version">v{{ appVersion }}</div>
    </aside>
    <main>
      <div class="topbar"><span><span class="tiny-dot" :class="{ online: active > 0 }" />{{ active ? `${active} 个目录监控中` : '目录监控' }}</span><span class="retention-note"><Icon name="check" :size="13" />{{ state.retention.enabled ? `监控文件 ${state.retention.days} 天后清理` : '监控文件保留' }}</span></div>
      <div class="content">
        <div v-if="state.fatalError" class="notice error" role="alert">{{ state.fatalError }}</div>
        <div v-if="error" class="notice error dismissible" role="alert">{{ error }}<button class="icon-button" aria-label="关闭错误" @click="error = ''"><Icon name="close" :size="16" /></button></div>
        <div v-if="notice" class="notice dismissible" role="status">{{ notice }}<button class="icon-button" aria-label="关闭提示" @click="notice = ''"><Icon name="close" :size="16" /></button></div>
        <div v-if="state.connection.reconnect" class="notice" role="status">连接中断，正在自动恢复 · {{ new Date(state.connection.reconnect.nextAt).toLocaleTimeString('zh-CN') }} 重试</div>
        <div v-if="state.connection.uploadNotice" class="notice" role="status">{{ state.connection.uploadNotice }}</div>
        <template v-if="['new', 'edit', 'new-once'].includes(view)"><DirectoryForm :key="view + (editing?.id ?? '')" :once="view === 'new-once'" :initial="view === 'edit' ? editing : undefined" :state="state" :busy="busy" @save="save" @back="view = view === 'new-once' ? 'once' : 'watches'" /></template>
        <template v-else-if="view === 'settings'">
          <div class="page-heading"><h1>连接与设置</h1></div>
          <section class="panel settings-panel"><div class="section-label"><div class="file-icon"><Icon name="cloud" /></div><div><h2>PlutoFish 服务</h2></div></div>
            <form @submit.prevent="connect"><fieldset :disabled="connecting"><label>服务地址<input v-model="credentials.url" type="url" placeholder="https://plutofish.example.com" required /></label><label>发布端凭据<input v-model="credentials.key" type="password" autocomplete="new-password" :placeholder="state.connection.hasKey ? '已保存；留空继续使用当前凭据' : '粘贴完整发布端凭据'" /></label>
              <div v-if="state.connection.error" class="notice error">{{ state.connection.error }}<p v-if="state.connection.reconnect" class="hint">{{ new Date(state.connection.reconnect.nextAt).toLocaleTimeString('zh-CN') }} 自动重连 · 第 {{ state.connection.reconnect.attempt }} 次</p></div>
              <div v-if="connected" class="identity-card"><Icon name="check" :size="19" /><div><strong>{{ state.connection.identity?.name }}</strong><p>已验证发布端 · {{ state.connection.identity?.sourceAccounts?.length ?? 1 }} 个授权源账号</p></div></div>
              <div class="form-footer"><span class="hint">凭据加密保存在本机</span><button class="button primary" type="submit">{{ connecting ? '正在连接…' : connected ? '重新验证连接' : '保存并连接' }}</button></div>
            </fieldset></form>
          </section>
          <section class="panel settings-panel"><h2>视频检测</h2><div class="tool-row probe-row"><div><span class="badge" :class="state.ffprobeAvailable ? 'completed' : 'review'">{{ state.ffprobeAvailable ? '可用' : '需要配置' }}</span><code>{{ state.ffprobe }}</code></div><button class="button secondary" :disabled="busy" @click="run(() => api.chooseProbe())">选择 ffprobe</button></div></section>
          <RetentionSettings :settings="state.retention" :busy="busy" @save="input => run(() => api.setRetention(input))" />
          <section class="panel settings-panel"><h2>运行方式</h2><div class="preference"><div><strong>关闭窗口后继续监控</strong><p>从托盘退出以停止任务</p></div><span class="badge completed">已启用</span></div></section>
        </template>
        <template v-else>
          <div class="page-heading"><h1>{{ view === 'overview' ? '概览' : view === 'watches' ? '监控目录' : view === 'once' ? '一次性上传' : '传输任务' }}</h1>
            <div class="heading-actions"><button v-if="monitored.length && view !== 'once'" class="button secondary" :disabled="busy" @click="run(() => api.scan())"><Icon name="refresh" :size="16" />补扫</button><button v-if="view === 'jobs'" class="button secondary" :disabled="busy" @click="run(() => api.pauseAll())"><Icon :name="state.uploadsPaused ? 'play' : 'pause'" :size="16" />{{ state.uploadsPaused ? '继续上传' : '暂停上传' }}</button><button v-if="view !== 'jobs'" class="button" :class="view === 'once' ? 'primary' : 'secondary'" :disabled="busy" @click="addOnce"><Icon name="upload" :size="18" />{{ view === 'once' ? '选择目录上传' : '一次性上传' }}</button><button v-if="view !== 'jobs' && view !== 'once'" class="button primary" :disabled="busy" @click="add"><Icon name="plus" :size="18" />添加目录</button></div></div>
          <div v-if="state.uploadsPaused" class="notice">上传与自动清理已暂停<button class="link" :disabled="busy" @click="run(() => api.pauseAll())">继续上传</button></div>
          <div v-if="view === 'overview'" class="stats">
            <div class="stat"><span>监控目录<Icon name="folder" :size="17" /></span><strong>{{ active.toString().padStart(2, '0') }}</strong></div>
            <div class="stat"><span>{{ state.uploadsPaused ? '传输已暂停' : '待传输' }}<Icon name="upload" :size="17" /></span><strong>{{ pending.toString().padStart(2, '0') }}</strong></div>
            <div class="stat"><span>已完成<Icon name="check" :size="17" /></span><strong>{{ completed.toString().padStart(2, '0') }}</strong></div>
            <div class="stat"><span>待处理<Icon name="alert" :size="17" /></span><strong :class="{ amber: attention }">{{ attention.toString().padStart(2, '0') }}</strong></div>
          </div>
          <OneTimeList v-if="view === 'once' || (view === 'overview' && batches.length)" :roots="batches" :jobs="state.jobs" :busy="busy" @toggle="id => run(() => api.toggleWatch(id))" @remove="id => run(() => api.removeWatch(id))" @cancel-cleanup="id => run(() => api.cancelCleanup(id))" @jobs="view = 'jobs'" />
          <template v-if="view !== 'jobs' && view !== 'once'">
            <section v-if="!monitored.length" class="panel empty-hero">
              <img class="watch-illustration" :src="watchFoldersArt" alt="" aria-hidden="true" draggable="false" />
              <div class="empty-copy"><h2>添加第一个目录</h2><p>新文件与子目录，自动上传。</p><button class="button primary" @click="add">{{ connected ? '添加目录' : '连接服务' }}<Icon name="arrow" :size="17" /></button></div>
            </section>
            <section v-if="sourceRoot" class="panel form-section"><h2>{{ sourceRoot.title }} · 来源预设</h2><SourceFields v-model="sourceDraft" :disabled="busy" /><p class="hint">文件名优先；保存后重试缺少来源的任务，已确认版本保持不变。</p><div class="form-footer"><button class="button secondary" :disabled="busy" @click="sourceRoot = undefined">取消</button><button class="button primary" :disabled="busy" @click="saveSource">保存来源预设</button></div></section>
            <section v-if="monitored.length && !sourceRoot" class="panel">
              <div class="panel-heading"><h2>监控任务 <span class="count">{{ monitored.length }}</span></h2><button v-if="view === 'overview'" class="link" @click="view = 'watches'">管理目录 <Icon name="arrow" :size="15" /></button></div>
              <article v-for="root in (view === 'overview' ? monitored.slice(0, 4) : monitored)" :key="root.id" class="watch-row"><div class="watch-folder"><Icon name="folder" :size="24" /></div><div class="watch-details"><h3>{{ root.title }} <span v-if="root.work.mediaType === 'tv'">第 {{ root.seasonNumber }} 季</span></h3><div v-for="path in watchPaths(root)" :key="path" class="path" :title="path">{{ path }}</div><div class="watch-tags"><span>{{ root.releaseName }}</span><span v-if="root.sourcePreset?.platform || root.sourcePreset?.type">预设 {{ [root.sourcePreset.platform, root.sourcePreset.type].filter(Boolean).join(' · ') }}</span><span>{{ root.binding.sourceAccount.alias }} → {{ root.directoryPath || root.directoryId }}</span></div><p v-if="root.error" class="task-error">{{ root.error }}</p><small v-else>{{ root.lastScan ? `上次扫描 ${new Date(root.lastScan).toLocaleTimeString('zh-CN')}` : '等待首次扫描' }} · 稳定等待 {{ root.stableSeconds }} 秒</small></div><div class="watch-actions"><span class="badge" :class="root.error ? 'review' : root.enabled ? 'completed' : 'paused'">{{ root.error ? '目录异常' : root.enabled ? '监控中' : '已暂停' }}</span><div><button class="link" :disabled="busy" @click="edit(root)">编辑</button><button v-if="root.versionMode === 'auto'" class="link" :disabled="busy" @click="editSource(root)">来源预设</button><button class="link" :disabled="busy || !root.enabled" @click="backfill(root.id)">补传历史</button><button class="link" :disabled="busy" @click="run(() => api.toggleWatch(root.id))">{{ root.enabled ? '暂停' : '恢复' }}</button><button class="link muted" :disabled="busy" @click="run(() => api.removeWatch(root.id))">移除</button></div></div></article>
            </section>
          </template>
          <section v-if="view === 'jobs' || (view === 'overview' && (state.watches.length || state.jobs.length))" class="panel jobs-panel"><div class="panel-heading"><h2>{{ view === 'overview' ? '最近的文件' : '文件队列' }} <span class="count">{{ state.jobs.length }}</span></h2><button v-if="view === 'overview'" class="link" @click="view = 'jobs'">查看全部 <Icon name="arrow" :size="15" /></button></div><JobList :watches="state.watches" :jobs="state.jobs" :retention="state.retention" :busy="busy" :compact="view === 'overview'" @action="input => run(() => api.job(input))" @reveal="id => run(() => api.reveal(id))" /></section>
        </template>
      </div>
    </main>
  </div>
</template>
