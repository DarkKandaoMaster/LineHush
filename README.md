# LineHush

LineHush 是一个只有纯文本和图片的文本编辑器~  
不支持 md 语法~  
每个 .hush 文件是一个 SQLite，所以是单文件，图片不需要以附件形式存储~  
像 Win11 记事本一样有标签页和多窗口：Ctrl+N 新标签页、Ctrl+Shift+N 新窗口、Ctrl+W 关标签页、Ctrl+Tab 切换~  
设置里可以改字体、字号，选双击打开文件时开新标签页还是新窗口，以及启动时打开新窗口还是恢复上一会话~  

验证：`pnpm build`、`pnpm test`、`cargo test --manifest-path src-tauri/Cargo.toml`；桌面回归先 `pnpm tauri build --debug --no-bundle`，再 `node tests/native.mjs`（`--release` 测 release 版，`--only <用例名>` 只跑一项）~
