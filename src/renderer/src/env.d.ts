/// <reference types="vite/client" />
import type { WatchAPI } from '../../shared/model'
declare global { interface Window { plutoWatch: WatchAPI } }
export {}
