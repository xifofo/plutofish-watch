/** ED2K 在工作线程计算，避免大文件 MD4 占用上传与 Electron 主线程。 */
import { parentPort, workerData } from 'node:worker_threads'
import { ed2kFile } from '../../vendor/publisher/src/lib/ed2k'

const { path } = workerData as { path: string }
void ed2kFile(path, (done, total) => parentPort?.postMessage({ type: 'progress', done, total }))
  .then(result => parentPort?.postMessage({ type: 'done', ...result }))
  .catch(error => parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'ED2K 计算失败' }))
