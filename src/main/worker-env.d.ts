declare module '*?nodeWorker' {
  import { Worker, type WorkerOptions } from 'node:worker_threads'
  export default function createWorker(options: WorkerOptions): Worker
}

// 共享源码的 CLI 代理重启入口使用 Bun；Watch 不调用它，构建时会将该入口裁掉。
declare const Bun: {
  spawn(args: string[], options: { env: Record<string, string>; stdio: string[] }): { exited: Promise<number> }
}

/** 构建时写入的包版本；测试直接加载入口时 app.getVersion() 可能返回 Electron 版本。 */
declare const __APP_VERSION__: string
