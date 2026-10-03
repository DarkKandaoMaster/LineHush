# LineHush

Windows 本地优先图文日记编辑器。Tauri 2 + React + TypeScript，正文只有纯文本和图片。

## 启动

- 开发：`pnpm tauri dev`
- 检查前端：`pnpm build`
- 构建可独立启动的程序：`pnpm tauri build --no-bundle`；`pnpm tauri build` 只生成 NSIS 安装包（`bundle.targets = ["nsis"]`）。
- 程序位置：`src-tauri/target/release/linehush.exe`。运行需要 Windows WebView2（当前机器已安装）。
- Rust 依赖 `rusqlite`（`bundled`，自带 SQLite，无需系统安装）与 `sha2`（图片 id）。
- 构建不需要手动把 `rc.exe` 加入 PATH：Tauri 的构建脚本（`tauri-winres` → `embed-resource`）会通过注册表 / Visual Studio 安装信息自动找到 Windows SDK 的 `rc.exe`。2026-10-03 在未进入 VS 开发者环境、PATH 中没有 `rc.exe` 的 PowerShell 和 Git Bash 中强制重跑构建脚本均通过。若某个环境报 “RC.EXE” 相关错误，再临时把 `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64` 加入 PATH。

## 使用

直接输入正文，按 Ctrl+S 或“保存”写入 `.hush` 文件；未命名文档会先弹出另存为。日记文件只在保存或另存为时改变。停止输入约 650 毫秒后，未保存的修改会暂存到本机工作副本（不改动日记文件）；程序意外退出后再次启动，会恢复这些修改、标记为未保存并提示“已恢复未保存的修改。”（保存成功后提示消失）；若上次打开的文件已被移走、改名或无法打开，暂存的修改作为未命名文档恢复，并提示原文件无法打开及原因。右下角显示“尚未保存”“已保存”“保存失败”或“暂存失败”，标题栏和工具栏的“● ”表示有未保存的修改。有未保存的修改时关闭窗口、新建或打开，会询问“保存 / 不保存 / 取消”（Esc 等于取消）；选“不保存”丢弃修改，文件保持上次保存的样子；保存失败时保留窗口和当前内容。

图片可以通过“插入图片”、粘贴剪贴板中的图片或拖入文件添加。支持 JPG、PNG、GIF、WebP、BMP（由 Cargo `image` 启用的格式决定，其他格式或损坏、超限文件统一提示“无法读取此图片”）；单张解码上限 16000 像素边长、256 MB 内存。多图同次插入形成图片组，选中图片组后插入会追加。真实空行阻止组自动合并。双击缩略图查看原图，预览中“保存原图”把文件中的原图按原字节写出，Esc 关闭。选中组后 Delete / Backspace 删除，Ctrl+Z 撤销。

Enter / Shift+Enter 产生一个逻辑换行，没有段落间距。连续和末尾空行保留。网页粘贴只取纯文本，不解析 Markdown。Tab 插入制表符。Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做。

| 操作   | 快捷键       |
| ------ | ------------ |
| 新建   | Ctrl+N       |
| 打开   | Ctrl+O       |
| 保存   | Ctrl+S       |
| 另存为 | Ctrl+Shift+S |

“导出”支持纯文本和 HTML。TXT 使用图片文件名占位；HTML 把正文引用的原图写到同目录 `附件` 文件夹（`<id 前 12 位>-<原文件名>`），与 HTML 一起移动即可阅读。

## 文件与恢复

- `.hush` 是单个 SQLite 文件，正文和原图都在其中，格式公开于 [docs/file-format.md](docs/file-format.md)。移动或备份日记只需这一个文件。打开文件时只对正文做结构反序列化（拒绝未知字段和节点）。
- 原图按字节原样保存，以 SHA-256 为 id，同一张图只存一份。缩略图在打开时现场生成，只缓存在内存，不写入文件。
- 保存在一个事务里写入正文和自上次保存以来新导入的图片，不重写已有图片。正文删除的图片在会话内仍可撤销找回；关闭窗口或切换文档时按已保存的正文删除未引用的图片并回收空间。
- 另存为先写出临时文件再替换目标，原文件不变。不再生成 `.bak` 备份。
- 文件只由本程序读写；打开期间被其他程序改动会在下一次保存时被覆盖。
- 未保存的修改和新导入的图片暂存在 `%APPDATA%\com.kandao.linehush\working.hush`（工作副本，与文档同格式，不是用户文档），保存、关闭或切换文档后清空；未命名文档的工作副本就是草稿。同目录 `recovery.json` 只记录上次打开的文件路径，重启时按路径重新打开，并恢复工作副本中暂存的修改；该文件打不开时，有暂存则保留工作副本作为未命名草稿（只在原文件中的图片显示“无法显示此图片”），没有暂存则新建草稿。日记内容不会上传服务器。
- 当前为单窗口单文档；第二个进程不会取得数据目录锁。

## 验证

- `pnpm test`（21 项）：Node 24 直接运行 `tests/*.test.mjs`，导入 `src/core/*.ts`（类型剥离，无构建步骤）；覆盖文档格式、换行、导出转义与附件命名、暂存队列、会话订阅，以及保存 / 未命名另存为 / 恢复标记与提示（含原文件丢失）和关闭、新建、打开前的“保存 / 不保存 / 取消”询问。
- `pnpm test:browser`（12 项，`tests/browser/*.spec.ts`，自动启动或复用 `pnpm dev`）：通过本机 Edge 验证编辑与粘贴、初始化、只暂存不写文件与 Ctrl+S 保存后的光标及撤销、暂存失败提示、文件切换、保存故障与重试、关闭询问（取消 / Esc / 不保存 / 保存）、导出，以及按 id 读取图片和保存原图。会话集成测试替换原生 IPC 边界，编辑器与暂存队列使用真实实现。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked`（17 项）：真实临时目录中的 `.hush` 文件结构与空行往返、只在保存时改文件、崩溃后恢复暂存（含原文件被移走后作为未命名草稿恢复）、原图逐字节与去重、草稿恢复与另存为（含另存为当前文件、带上未保存图片）、关闭与切换时丢弃修改并清理、读入结构检查、打开失败、导出与缩略图、并发缩略图只解码一次。
- `pnpm dev` 运行时，先 `cargo build --manifest-path src-tauri/Cargo.toml --offline --locked`，再 `node tests/native.mjs`：隔离测试数据，用真实 WebView2 检查 15 项：草稿崩溃恢复、中文换行、未命名保存走另存为、只在保存时写文件（暂存后用户文件字节与修改时间不变）、保存写入正文与新图片、撤销重做、多图原图（`images` 表与 `export_image` / HTML 导出均与源图逐字节相等）、另存为当前文件、关闭弹窗（Esc / 取消保留窗口且焦点回到编辑区、弹窗期间 Ctrl+S 无效、不保存后文件保持原样）、关闭清理（未引用图片关闭后不在 `images` 表中）、文件结构（SQLite 文件头、PRAGMA、无 `-journal` / `-wal` / `.tmp` 残留，数据目录只有 `recovery.json`、`session.lock`、`working.hush`）、关闭时保存、崩溃恢复（`taskkill /F` 后重启恢复暂存正文与图片、标记未保存，用户文件不变；Ctrl+S 后恢复提示消失）、保存重开和原文件丢失恢复（暂存后强杀、移走用户文件再重启：出现提示、正文为暂存内容、未保存、标题为“● 未命名”，原文件中的图片显示占位，`recovery.json` 的 path 为 null）。脚本用 Node 内置 `node:sqlite` 只读检查文件；系统“保存日记”对话框通过 Win32 消息填写文件名并确认（PowerShell 内联 C#），只写入 `test-results/`；这会更新 Windows 为 `linehush.exe` 记住的上次保存目录。`src-tauri/capabilities/default.json` 中的 `core:window:allow-close` 只为该脚本模拟关闭窗口所需。设置 `LINEHUSH_TEST_DATA_DIR` 后数据目录改到该处，测试不访问个人日记。
- `pnpm tauri build --no-bundle` 后运行 `node tests/native.mjs --release`：对独立 Release 程序执行同样的桌面回归，不需要开发服务器。
- 测试记录都放在 `test-results/`：`native-*`（桌面回归）、`playwright/`（Playwright 输出，每次运行前只清空这个子目录）。

自动化输入不等于真实中文输入法候选操作。交付前仍建议用自己的输入法连续写一段，测试候选确认、修改拼音、图片边界移动以及撤销的主观手感。第一版暂无全文查找、文档标签页或侧栏。
