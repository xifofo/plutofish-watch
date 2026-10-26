import type { WatchInput, WatchRoot } from './model'

type LocalPaths = Pick<WatchInput, 'path' | 'additionalPaths'>

export const watchPaths = (root: LocalPaths): string[] => [root.path, ...(root.additionalPaths ?? [])]

export function validateWatchPaths(input: LocalPaths): string[] {
  if (!input || (input.additionalPaths !== undefined && !Array.isArray(input.additionalPaths))) {
    throw new Error('请填写有效的本地目录列表')
  }
  const paths = watchPaths(input)
  if (paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0'))) {
    throw new Error('请填写有效的本地目录路径')
  }
  return paths
}

export const initializedWatchPaths = (root: WatchRoot): string[] =>
  root.initializedPaths ?? (root.initialized ? watchPaths(root) : [])
