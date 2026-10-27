<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { LocalRetentionSettings } from '../../shared/model'
const props = defineProps<{ settings: LocalRetentionSettings; busy: boolean }>()
const emit = defineEmits<{ save: [settings: LocalRetentionSettings] }>()
const draft = reactive({ ...props.settings })
watch([() => props.settings.enabled, () => props.settings.days], () => Object.assign(draft, props.settings))
const dirty = computed(() => draft.enabled !== props.settings.enabled || draft.days !== props.settings.days)
</script>
<template>
  <section class="panel settings-panel retention-settings">
    <h2>监控目录的本地文件</h2>
    <form @submit.prevent="emit('save', { ...draft })">
      <fieldset :disabled="busy">
        <div class="preference"><div><strong id="retention-label">自动删除本地文件</strong><p>{{ settings.enabled ? `已开启 · 上传完成满 ${settings.days} 天后清理` : '未开启 · 保留原文件' }}</p></div>
          <button type="button" class="retention-switch" role="switch" aria-labelledby="retention-label" :aria-checked="draft.enabled" @click="draft.enabled = !draft.enabled"><span /></button>
        </div>
        <label class="retention-days">上传完成后保留 <input v-model.number="draft.days" type="number" min="1" max="365" step="1" required :disabled="!draft.enabled" aria-label="保留天数" /> 天</label>
        <p class="hint">ED2K 已生成并同步后才删除。开启后也适用于已完成的监控文件。一次性上传使用创建任务时的独立设置。</p>
        <div class="form-footer"><span class="hint">{{ dirty ? '有未保存的更改' : '设置已保存' }}</span><button type="submit" class="button secondary" :disabled="busy || !dirty">保存清理设置</button></div>
      </fieldset>
    </form>
  </section>
</template>
<style scoped>
.retention-switch{width:38px;height:22px;min-height:22px;flex-shrink:0;border:1px solid var(--line);border-radius:20px;background:var(--muted);padding:2px;display:flex;align-items:center;cursor:pointer}
.retention-switch span{display:block;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.retention-switch[aria-checked=true]{background:var(--accent);border-color:var(--accent)}
.retention-switch[aria-checked=true] span{transform:translateX(15px)}
.retention-switch:disabled{opacity:.5;cursor:default}
.retention-days{display:flex;align-items:center;gap:10px;margin:20px 0 12px;flex-wrap:wrap}
.retention-days input{width:88px;margin:0;text-align:center}
.retention-settings .hint{line-height:1.7}
</style>
