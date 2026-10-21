# PlutoFish Watch 图标

2026-10-20 使用内置 image_gen 生成第 2 版蓝色玻璃鱼：修长弯曲的鱼身、舒展的双叶尾鳍、半透明钴蓝玻璃和珍珠白眼睛，置于白色瓷质圆角底板，底板外透明。根据用户选择的「立体精致，有材质感」方向重做。

- `icon.png`：1024 × 1024，带 alpha；侧栏 Logo、Dock、窗口和托盘共用的原图。
- `icon.icns`：由同一 PNG 导出，包含 16–1024 px 的 macOS 图标。
- `icon.ico`：由同一 PNG 导出，包含 16、24、32、48、64、128、256 px 的 Windows 图标。

Linux 打包使用 `icon.png`。侧栏保留现有 PlutoFish / WATCH 文字排版，图标底板已包含在图片内，不再叠加 CSS 背景或边框。

第 2 版高分辨率原图和完整提示词保存在仓库忽略目录 `output/branding/plutofish-watch/v2/`。各尺寸仅重采样和封装格式，未分别生成不同鱼形。
