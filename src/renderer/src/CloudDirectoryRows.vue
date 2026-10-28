<!-- 网盘目录单击只选中，双击或独立箭头才导航；两个上传位置入口共用。 -->
<script setup lang="ts">
import type { DirectoryPage } from '../../shared/model'
import Icon from './Icon.vue'

defineProps<{ items: DirectoryPage['items']; selectedId?: string; disabled?: boolean }>()
const emit = defineEmits<{ select: [item: DirectoryPage['items'][number]]; enter: [id: string] }>()
</script>

<template>
  <div v-for="item in items" :key="item.id" class="folder-option" :class="{ selected: selectedId === item.id }">
    <button type="button" class="folder-select" :disabled="disabled" :aria-pressed="selectedId === item.id" @click="emit('select', item)" @dblclick="emit('enter', item.id)" @keydown.right.prevent="emit('enter', item.id)">
      <Icon name="folder" /><span>{{ item.name }}</span><Icon v-if="selectedId === item.id" name="check" :size="17" />
    </button>
    <button type="button" class="folder-enter" :disabled="disabled" :aria-label="`进入“${item.name}”`" @click="emit('enter', item.id)"><Icon name="arrow" :size="17" /></button>
  </div>
</template>

<style scoped>
.folder-option{display:flex;align-items:stretch;border-top:1px solid var(--line);width:100%;padding:0}
.folder-option.selected{background:var(--surface-subtle);box-shadow:inset 3px 0 var(--accent)}
.folder-select,.folder-enter{display:flex;align-items:center;gap:10px;background:transparent;border:0;padding:11px 8px;min-height:44px;text-align:left;font:inherit;font-size:12px;color:var(--text);touch-action:manipulation}
.folder-select{flex:1;min-width:0}
.folder-select span{flex:1;min-width:0;overflow-wrap:anywhere}
.folder-select[aria-pressed="true"]{font-weight:600}
.folder-enter{flex:0 0 44px;justify-content:center}
button:disabled{opacity:.5;cursor:default}
</style>
