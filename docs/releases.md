# GitHub Actions 自动打包与发布

`desktop` 工作流独立运行于 `xifofo/plutofish-watch`，不读取相邻 GVS 仓库。目标为 Windows x64 NSIS 和 macOS arm64/x64 DMG。

## 正式发布

1. 更新 `package.json` 的版本，可添加 `docs/release-v<版本>.md` 作为发布说明。先完成本版本源码检查、提交和推送。
2. 在发布提交上创建并推送 `v<版本>` 标签。标签必须与包版本完全一致，例如包版本 `0.1.9` 对应 `v0.1.9`。
3. Actions 使用锁定的 pnpm 版本和依赖，校验发布引擎快照，执行类型检查、离线测试及构建。测试所用 ffmpeg 只处理临时媒体，不请求真实网盘。
4. Windows 和 macOS 分别打包。全部成功且三个安装包齐全后，附加 `SHA256SUMS.txt`，上传到草稿 Release 并发布为 Latest。没有发布说明文件时由 GitHub 自动生成。

Windows 安装包名为 `PlutoFish-Watch-<版本>-windows-x64-setup.exe`；macOS 为 `PlutoFish-Watch-<版本>-macos-arm64.dmg` 和 `PlutoFish-Watch-<版本>-macos-x64.dmg`。

只需仓库自带的 `GITHUB_TOKEN`，只有发布 job 能写 Release；无需额外 PAT、PlutoFish 或 115 凭据。当前仓库为私有仓库，下载附件需要有权限的 GitHub 账号。

## 手动构建与重试

Actions → desktop → Run workflow 选择分支时，只构建并保存 Artifacts（14 天），不创建 Release。对已有 `v*` 标签执行工作流会正式发布。

失败后可重新运行；未发布草稿支持重新上传附件，已公开版本禁止覆盖，应使用新版本号和新标签。相同 ref 的工作流排队运行。

安装包仍未配置代码签名和 macOS 公证，ffprobe 仍需在客户端电脑自行安装。Watch 尚无应用内自动更新，升级时下载新包、完全退出旧客户端后安装，保留应用数据。本工作流不包含 Linux 安装包。

本地 `pack` / `pack:win:x64` 等命令仍可用于调试；正式发布交由标签触发的 Actions 完成。构建成功不代表 Windows/macOS 真机安装或真实网盘联调通过。
