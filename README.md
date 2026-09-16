# LineHush

Windows 本地优先图文日记编辑器。Tauri 2 + Vue + TypeScript，正文只有纯文本和图片。

## 启动

- 开发：`pnpm tauri dev`
- 检查前端：`pnpm build`
- 构建可独立启动的程序：`pnpm tauri build --no-bundle`
- 程序位置：`src-tauri/target/release/linehush.exe`。运行需要 Windows WebView2（当前机器已安装）。

## 使用

直接输入正文，使用“保存”选择 `.linehush` 文件。随后停止输入约 650 毫秒自动保存。尚未保存为文件的内容也会保存到本机恢复草稿，下一次启动恢复。右下角区分“尚未保存”“正在保存”“已保存”“草稿已保留”和“保存失败”。关闭窗口会等待最后一次保存；保存失败时保留窗口和当前内容。

图片可以通过“插入图片”、粘贴剪贴板中的图片或拖入文件添加。支持 JPG、PNG、GIF、WebP、BMP；单张解码上限 16000 像素边长、256 MB 内存。多图同次插入形成图片组，选中图片组后插入会追加。真实空行阻止组自动合并。双击缩略图查看原图，Esc 关闭。选中组后 Delete / Backspace 删除，Ctrl+Z 撤销。

Enter / Shift+Enter 产生一个逻辑换行，没有段落间距。连续和末尾空行保留。网页粘贴只取纯文本，不解析 Markdown。Tab 插入制表符。Ctrl+Z 撤销，Ctrl+Y 或 Ctrl+Shift+Z 重做。

| 操作   | 快捷键       |
| ------ | ------------ |
| 新建   | Ctrl+N       |
| 打开   | Ctrl+O       |
| 保存   | Ctrl+S       |
| 另存为 | Ctrl+Shift+S |

“导出”支持纯文本和 HTML。TXT 使用图片文件名占位；HTML 附带当前正文引用的原图，文件与附件文件夹一起移动即可阅读。

## 文件与恢复

- `.linehush` 是 UTF-8 JSON，格式公开于 [docs/file-format.md](docs/file-format.md)。
- 原图在日记同目录的 `附件` 文件夹，缩略图在 `.linehush-cache`，可删除后自动重建。
- 整体移动日记目录时，一并移动附件。程序不自动清理原图，以保留撤销及备份引用。
- 保存前写入临时文件并同步，随后替换。每次打开文件时把打开前的内容复制到 `文件名.linehush.bak`，可从“打开”的备份筛选器打开后另存为。
- 文件只由本程序读写；打开期间被其他程序改动会在下一次自动保存时被覆盖。
- 尚未存为文件的草稿写在 `%APPDATA%\com.kandao.linehush\recovery.json`，草稿图片在同目录 `drafts` 下；已有文件的文档只记录路径，重启时按路径重新打开。日记内容不会上传服务器。
- 当前为单窗口单文档；第二个进程不会取得恢复草稿锁。

## 验证

- `pnpm test`：文档格式、换行、导出转义、保存队列。
- `pnpm test:browser`：通过本机 Edge 验证编辑与粘贴。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked`：真实临时目录中的保存、备份、故障与图片测试。
- `pnpm dev` 运行时，先 `cargo build --manifest-path src-tauri/Cargo.toml --offline --locked`，再 `node tests/native.mjs`：隔离测试数据，用真实 WebView2 检查输入、图片、原图、关闭重开和重开备份。设置 `LINEHUSH_TEST_DATA_DIR` 后数据目录改到该处，测试不访问个人日记。

自动化输入不等于真实中文输入法候选操作。交付前仍建议用自己的输入法连续写一段，测试候选确认、修改拼音、图片边界移动以及撤销的主观手感。第一版暂无全文查找、文档标签页或侧栏。
