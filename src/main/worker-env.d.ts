declare module '*?nodeWorker' {
  import { Worker, type WorkerOptions } from 'node:worker_threads'
  export default function createWorker(options: WorkerOptions): Worker
}
