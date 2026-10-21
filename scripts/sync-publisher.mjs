#!/usr/bin/env node
// 只同步发布引擎的完整依赖闭包；逐文件校验，不读取下载器凭据或运行数据。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor/publisher')
const lockPath = join(vendor, 'source-lock.json')
const entries = [
  'src/integrations/plutofish/publication-worker.ts',
  'src/integrations/plutofish/release-selection.ts',
  'src/lib/ed2k.ts',
]
const args = process.argv.slice(2)
const check = args.includes('--check')
const sourceIndex = args.indexOf('--source')
const source = sourceIndex >= 0 && args[sourceIndex + 1] ? realpathSync(args[sourceIndex + 1]) : undefined
if (args.some((arg, i) => arg !== '--check' && arg !== '--source' && (sourceIndex < 0 || i !== sourceIndex + 1)) ||
    (sourceIndex >= 0 && !source) || (!source && !check)) {
  throw Error('用法：node scripts/sync-publisher.mjs --check [--source /path/to/gvs-tui]，或 --source /path/to/gvs-tui')
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const safePath = path => path.startsWith('src/') && !path.split('/').some(part => part === '..' || part === '.')
const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : undefined
if (previous && (previous.schemaVersion !== 1 || !previous.files || Object.keys(previous.files).some(path => !safePath(path)))) {
  throw Error('发布引擎来源清单损坏')
}

// 任何未记录文件或本地编辑均停止，更新不能覆盖人工修改。
const list = directory => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  if (entry.isSymbolicLink()) throw Error('快照不允许符号链接')
  return entry.isDirectory() ? list(path) : [relative(vendor, path).split('\\').join('/')]
}) : []
for (const path of list(join(vendor, 'src'))) {
  if (!previous?.files[path]) throw Error(`快照有未登记文件：${path}`)
}
for (const [path, digest] of Object.entries(previous?.files ?? {})) {
  if (!existsSync(join(vendor, path)) || hash(readFileSync(join(vendor, path))) !== digest) {
    throw Error(`快照内容已被修改：${path}；请在下载器源文件修复后同步`)
  }
}
if (!source) {
  if (!previous) throw Error('缺少发布引擎快照')
  console.log(`发布引擎快照校验通过：${Object.keys(previous.files).length} 个文件`)
  process.exit(0)
}

const files = new Map()
function visit(path) {
  if (files.has(path)) return
  if (!safePath(path)) throw Error(`依赖超出源码目录：${path}`)
  const absolute = realpathSync(join(source, path))
  const fromSource = relative(source, absolute)
  if (fromSource.startsWith('..') || isAbsolute(fromSource)) throw Error(`依赖越界：${path}`)
  const bytes = readFileSync(absolute)
  files.set(path, bytes)
  const parsed = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
  function dependency(specifier) {
    if (!specifier.startsWith('.')) {
      if (!specifier.startsWith('node:') && specifier !== 'ali-oss') throw Error(`需要审查新的外部依赖：${specifier}`)
      return
    }
    const base = resolve(dirname(absolute), specifier)
    const found = [base, `${base}.ts`, join(base, 'index.ts')].find(candidate => existsSync(candidate))
    if (!found) throw Error(`无法定位依赖：${path} → ${specifier}`)
    visit(relative(source, found).split('\\').join('/'))
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependency(node.moduleSpecifier.text)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      dependency(node.argument.literal.text)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw Error(`需审查动态依赖：${path}`)
      dependency(node.arguments[0].text)
    }
    ts.forEachChild(node, walk)
  }
  walk(parsed)
}
for (const path of entries) visit(path)
const sorted = [...files].sort(([a], [b]) => a.localeCompare(b))
const digests = Object.fromEntries(sorted.map(([path, bytes]) => [path, hash(bytes)]))
if (check) {
  if (!previous || JSON.stringify(digests) !== JSON.stringify(previous.files)) throw Error('发布引擎与下载器源码不同步')
  console.log(`发布引擎与下载器源码逐字节一致：${files.size} 个文件`)
  process.exit(0)
}

const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const revision = git(['rev-parse', 'HEAD'])
const modifiedFiles = sorted.filter(([path, bytes]) => {
  try { return hash(execFileSync('git', ['-C', source, 'show', `HEAD:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] })) !== hash(bytes) }
  catch { return true }
}).map(([path]) => path)
for (const [path, bytes] of sorted) {
  mkdirSync(dirname(join(vendor, path)), { recursive: true })
  writeFileSync(join(vendor, path), bytes)
}
for (const path of Object.keys(previous?.files ?? {})) {
  if (!files.has(path)) rmSync(join(vendor, path))
}
writeFileSync(lockPath, JSON.stringify({
  schemaVersion: 1, repository: 'https://github.com/xifofo/gvs-tui', baseRevision: revision,
  includesUncommittedChanges: modifiedFiles.length > 0, modifiedFiles, entries, files: digests,
}, null, 2) + '\n')
console.log(`已同步 ${files.size} 个文件；其中 ${modifiedFiles.length} 个包含基线提交以外的改动`)
