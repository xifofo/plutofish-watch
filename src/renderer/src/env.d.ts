/// <reference types="vite/client" />
import type { WatchAPI } from '../../shared/model'
declare global {
  const __APP_VERSION__: string
  interface Window { plutoWatch: WatchAPI }
}
export {}
