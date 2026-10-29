// 生成自动更新用的 latest.json（src-tauri/src/update.rs 读它，见
// docs/design/auto-update-2026-10-29.md）：先 `pnpm tauri build`，把
// src-tauri/target/release/bundle/nsis/ 下的 setup.exe 上传到 GitHub 上以 LineHush_v<版本>
// 为标签的正式 Release，再 `pnpm release:json [--notes "更新说明"]`，生成仓库根目录的
// latest.json，提交并 push 到 main（程序从 raw.githubusercontent.com 读它）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/DarkKandaoMaster/LineHush";

/** `--notes "…"` 或 `--notes=…`；没有为空串。 */
function notesArgument(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--notes") return args[i + 1] ?? "";
    if (args[i].startsWith("--notes=")) return args[i].slice("--notes=".length);
  }
  return "";
}

const config = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = config.version;
const installer = `LineHush_${version}_x64-setup.exe`;
const built = join(root, "src-tauri", "target", "release", "bundle", "nsis", installer);
if (!existsSync(built)) {
  console.error(`找不到 ${built}。\n先运行 pnpm tauri build 打出 ${version} 的安装包。`);
  process.exit(1);
}
const latest = {
  version,
  notes: notesArgument(process.argv.slice(2)),
  // RFC 3339（UTC，去掉毫秒）。
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  url: `${REPO}/releases/download/LineHush_v${version}/${installer}`,
};
const target = join(root, "latest.json");
writeFileSync(target, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`已生成 ${target}`);
