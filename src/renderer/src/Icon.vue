<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z',
  file: 'M14 2H5v20h14V7l-5-5z M14 2v6h5',
  list: 'M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M4 16l2 3a8 8 0 0 0 13-3',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4l14 8-14 8V4z',
  check: 'M5 12l4 4L19 6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5',
  close: 'M5 5l14 14 M19 5L5 19',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  cloud: 'M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 3 4 4 0 0 1-1 8H7',
  alert: 'M12 3L2 21h20L12 3z M12 9v5 M12 17h.01',
}
</script>
<template><svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.folder" /></svg></template>
