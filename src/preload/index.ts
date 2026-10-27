/** 只暴露固定操作，不开放通用 IPC、文件读取或任意网络调用。 */
import { contextBridge, ipcRenderer } from 'electron'
import type { WatchAPI, Snapshot } from '../shared/model'

const invoke = async (action: string, payload?: unknown) => {
  const result = await ipcRenderer.invoke('watch:command', action, payload)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const api: WatchAPI = {
  snapshot: () => invoke('snapshot'),
  connect: input => invoke('connect', input),
  chooseDirectory: () => invoke('chooseDirectory'),
  chooseFiles: () => invoke('chooseFiles'),
  chooseProbe: () => invoke('chooseProbe'),
  searchWorks: input => invoke('searchWorks', input),
  recognitionSample: path => invoke('recognitionSample', path),
  recognizeFile: input => invoke('recognizeFile', input),
  releases: input => invoke('releases', input),
  directories: input => invoke('directories', input),
  createDirectories: input => invoke('createDirectories', input),
  add: input => invoke('add', input),
  updateWatch: input => invoke('updateWatch', input),
  setSourcePreset: input => invoke('setSourcePreset', input),
  setRetention: input => invoke('setRetention', input),
  cancelCleanup: id => invoke('cancelCleanup', id),
  toggleWatch: id => invoke('toggleWatch', id),
  removeWatch: id => invoke('removeWatch', id),
  scan: () => invoke('scan'),
  backfill: id => invoke('backfill', id),
  pauseAll: () => invoke('pauseAll'),
  job: input => invoke('job', input),
  reveal: id => invoke('reveal', id),
  onChange: callback => {
    const listener = (_: unknown, state: Snapshot) => callback(state)
    ipcRenderer.on('watch:state', listener)
    return () => ipcRenderer.removeListener('watch:state', listener)
  },
}
contextBridge.exposeInMainWorld('plutoWatch', api)
