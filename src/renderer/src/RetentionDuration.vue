<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { retentionParts, retentionRange, retentionUnits } from '../../shared/retention'
const props = defineProps<{ modelValue: number; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [minutes: number] }>()
const initial = retentionParts(props.modelValue)
const amount = ref<number | string>(initial.amount), unit = ref<number>(initial.unit)
const range = computed(() => retentionRange(unit.value))
const minutes = computed(() => Number(amount.value) * unit.value)
// 外部写入（保存、还原）才重新拆分，避免把正在输入的 120 分钟改写成 2 小时。
watch(() => props.modelValue, value => {
  if (value !== minutes.value) ({ amount: amount.value, unit: unit.value } = retentionParts(value))
})
// 切换单位保留数字并收进新单位的范围，7 天切到分钟时直接得到最短的 30 分钟。
watch(unit, () => {
  if (amount.value !== '') amount.value = Math.min(range.value.max, Math.max(range.value.min, Number(amount.value)))
})
watch(minutes, value => emit('update:modelValue', value))
</script>
<template>
  <span class="retention-duration">
    <input v-model.number="amount" type="number" :min="range.min" :max="range.max" step="1" required :disabled="disabled" :aria-label="label" />
    <select v-model="unit" :disabled="disabled" :aria-label="`${label}单位`"><option v-for="item in retentionUnits" :key="item.minutes" :value="item.minutes">{{ item.label }}</option></select>
  </span>
</template>
<style scoped>
.retention-duration{display:inline-flex;align-items:center;gap:8px}
.retention-duration input{width:88px;margin:0;text-align:center}
.retention-duration select{width:80px;margin:0}
</style>
