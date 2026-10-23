# 图标源文件

这里是 `icon.ico` 中 16 / 20 / 24 / 32 帧的手绘源（`s16.svg`、`s20.svg`、`s24.svg`、`s32.svg`，按整像素绘制，原尺寸渲染）与生成脚本（`tools/`）。主稿是上级目录的 `icon.svg`（viewBox 48），用于 40 / 48 / 64 / 256 帧和 `icon-source.png`。

## 重做流程

以下命令在项目根目录执行。

1. 渲染各帧：

   ```
   node src-tauri/icons/src/tools/render_svg.mjs <项目根> <svg> <尺寸> <out.png> [<svg> <尺寸> <out.png> …]
   ```

   脚本经项目的 `@playwright/test` 启动 Edge（`channel: "msedge"`），先把 SVG 根元素的 width / height 改成目标尺寸（viewBox 不变）再内联渲染，设备缩放 1，透明背景。SVG 根元素必须带 width、height 与 viewBox。不要用 `<img>` 显示 width=48 的 SVG 再放大，滤镜会按 48 px 栅格化而发糊。

   - 16 / 20 / 24 / 32 帧：`s16.svg` 等按各自尺寸渲染。
   - 40 / 48 / 64 / 256 帧：`../icon.svg` 按目标尺寸渲染。
   - `icon-source.png`：`../icon.svg` 按 1024 渲染。

2. 合成 ico（需要 Pillow）：

   ```
   python src-tauri/icons/src/tools/make_ico.py src-tauri/icons/icon.ico 16=a.png 20=b.png 24=c.png 32=d.png 40=e.png 48=f.png 64=g.png 256=h.png
   ```

   每帧必须已是目标尺寸，脚本不缩放；256 帧存 PNG，其余存 32 位 BMP + AND 掩码（`--png-from` 可改阈值）。写完读回逐帧与源图逐像素比对，不一致即返回非 0。

3. 其余 png / icns 等：`pnpm tauri icon src-tauri/icons/icon-source.png` 生成，然后用第 2 步的 `icon.ico` 覆盖它生成的那份；多出的 android / ios / `64x64.png` 不需要。

4. 换 ico 后先 `touch src-tauri/tauri.conf.json` 再 build（Tauri 构建脚本只监视 tauri.conf.json 与 capabilities，否则 exe 仍嵌旧图标）。
