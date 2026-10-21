<script setup lang="ts">
import type { ReleaseSource } from '../../shared/model'
defineProps<{ modelValue?: ReleaseSource; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: ReleaseSource] }>()
</script>
<template>
  <div class="source-fields">
    <label>来源平台<input :disabled="disabled" :value="modelValue?.platform ?? ''" aria-label="来源平台" placeholder="YOUKU / TX / NF" maxlength="20" @input="emit('update:modelValue', { ...modelValue, platform: ($event.target as HTMLInputElement).value })" /></label>
    <label>来源类型<select :disabled="disabled" :value="modelValue?.type ?? ''" aria-label="来源类型" @change="emit('update:modelValue', { ...modelValue, type: ($event.target as HTMLSelectElement).value })"><option value="">从文件名识别</option><option v-for="type in ['WEB-DL', 'WEBRip', 'BluRay', 'REMUX', 'HDTV', 'DVD']" :key="type" :value="type">{{ type }}</option></select></label>
  </div>
</template>
<style scoped>
.source-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;min-width:0}
.source-fields label{min-width:0}.source-fields input,.source-fields select{width:100%;min-width:0}
@media(max-width:880px){.source-fields{grid-template-columns:1fr}}
</style>
