# PlutoFish 发布引擎快照

这里保存下载器 `xifofo/gvs-tui` 中发布引擎及其完整源码依赖，文件保持逐字节一致。监控器只接入本地成品事件，不包含下载平台实现。

`source-lock.json` 记录来源基线、包含未提交改动的文件及各文件 SHA256。本次来源包含尚未提交的 PlutoFish 集成工作，不能仅凭基线提交重建快照；实际内容以本仓库文件及其校验值为准。此目录保留源代码原有声明，不新增授权条款。

日常构建无需下载器仓库。校验本仓库完整性：

```sh
pnpm publisher:check
```

公共发布逻辑应先在下载器源码修复并测试，然后显式同步：

```sh
node scripts/sync-publisher.mjs --source /absolute/path/to/gvs-tui
node scripts/sync-publisher.mjs --check --source /absolute/path/to/gvs-tui
pnpm typecheck
pnpm test
pnpm build
```

同步脚本仅复制源码依赖，不复制配置、凭据、清单、媒体、依赖或构建产物。存在手工编辑或来源清单损坏时停止；不要在此目录单独修改发布、校验或 ED2K 逻辑。
