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

直接输入正文，使用“保存”选择 `.hush` 文件。随后停止输入约 650 毫秒自动保存。尚未保存为文件的内容也会保存到本机恢复草稿，下一次启动恢复。右下角区分“尚未保存”“正在保存”“已保存”“草稿已保留”和“保存失败”。关闭窗口会等待最后一次保存；保存失败时保留窗口和当前内容。

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
- 自动保存只更新正文，不重写图片。正文删除的图片在会话内仍可撤销找回；关闭窗口或切换文档时删除未引用的图片并回收空间。
- 另存为先写出临时文件再替换目标，原文件不变。不再生成 `.bak` 备份。
- 文件只由本程序读写；打开期间被其他程序改动会在下一次自动保存时被覆盖。
- 尚未存为文件的草稿是 `%APPDATA%\com.kandao.linehush\draft.hush`（与文档同格式）；同目录 `recovery.json` 只记录上次打开的文件路径，重启时按路径重新打开。日记内容不会上传服务器。
- 当前为单窗口单文档；第二个进程不会取得恢复草稿锁。

## 验证

- `pnpm test`（9 项）：Node 24 直接运行 `tests/*.test.mjs`，导入 `src/core/*.ts`（类型剥离，无构建步骤）；覆盖文档格式、换行、导出转义与附件命名、保存队列及会话订阅。
- `pnpm test:browser`（8 项，`tests/browser/*.spec.ts`，自动启动或复用 `pnpm dev`）：通过本机 Edge 验证编辑与粘贴、初始化、自动保存后的光标及撤销、文件切换、保存故障、关闭保护、导出，以及按 id 读取图片和保存原图。会话集成测试替换原生 IPC 边界，编辑器与保存队列使用真实实现。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked`（13 项）：真实临时目录中的 `.hush` 文件结构与空行往返、只改正文、原图逐字节与去重、草稿恢复与另存为、关闭清理、读入结构检查、打开失败、导出与缩略图、并发缩略图只解码一次。
- `pnpm dev` 运行时，先 `cargo build --manifest-path src-tauri/Cargo.toml --offline --locked`，再 `node tests/native.mjs`：隔离测试数据，用真实 WebView2 检查中文换行、草稿恢复、保存重开、多图原图（`images` 表与 `export_image` / HTML 导出均与源图逐字节相等）、撤销重做、关闭保护、关闭清理（删掉的图片关闭后不在 `images` 表中）和文件结构（SQLite 文件头、PRAGMA、无 `-journal` / `-wal` / `.tmp` 残留）。脚本用 Node 内置 `node:sqlite` 只读检查文件。`src-tauri/capabilities/default.json` 中的 `core:window:allow-close` 只为该脚本模拟关闭窗口所需。设置 `LINEHUSH_TEST_DATA_DIR` 后数据目录改到该处，测试不访问个人日记。
- `pnpm tauri build --no-bundle` 后运行 `node tests/native.mjs --release`：对独立 Release 程序执行同样的桌面回归，不需要开发服务器。
- 测试记录都放在 `test-results/`：`native-*`（桌面回归）、`playwright/`（Playwright 输出，每次运行前只清空这个子目录）。

自动化输入不等于真实中文输入法候选操作。交付前仍建议用自己的输入法连续写一段，测试候选确认、修改拼音、图片边界移动以及撤销的主观手感。第一版暂无全文查找、文档标签页或侧栏。
