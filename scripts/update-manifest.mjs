/** 发布工作流生成 latest.json：客户端据此提示新版本，并按大小与 SHA256 校验下载的安装包。 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [directory, tag, repository, notesFile] = process.argv.slice(2)
if (!directory || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
  console.error('用法：node scripts/update-manifest.mjs <附件目录> <v版本> <owner/仓库> [发布说明]')
  process.exit(1)
}
const version = tag.slice(1)
const installers = [
  ['win32', 'x64', `PlutoFish-Watch-${version}-windows-x64-setup.exe`],
  ['darwin', 'arm64', `PlutoFish-Watch-${version}-macos-arm64.dmg`],
  ['darwin', 'x64', `PlutoFish-Watch-${version}-macos-x64.dmg`],
]
const files = []
for (const [platform, arch, name] of installers) {
  const path = join(directory, name), hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  files.push({ platform, arch, name, url: `https://github.com/${repository}/releases/download/${tag}/${name}`, size: statSync(path).size, sha256: hash.digest('hex') })
}
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : ''
const manifest = { version, publishedAt: new Date().toISOString(), page: `https://github.com/${repository}/releases/tag/${tag}`, notes, files }
writeFileSync(join(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`latest.json：${version}，${files.length} 个安装包`)
