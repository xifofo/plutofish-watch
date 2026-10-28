declare module '*?nodeWorker' {
  import { Worker, type WorkerOptions } from 'node:worker_threads'
  export default function createWorker(options: WorkerOptions): Worker
}

// 共享源码的 CLI 代理重启入口使用 Bun；Watch 不调用它，构建时会将该入口裁掉。
declare const Bun: {
  spawn(args: string[], options: { env: Record<string, string>; stdio: string[] }): { exited: Promise<number> }
}
