// 生成自动更新用的 latest.json（tauri-plugin-updater 的静态 JSON，见
// docs/design/auto-update-2026-10-29.md）：先带签名环境变量 `pnpm tauri build`，再
// `pnpm release:json [--notes "更新说明"]`，把同目录的 setup.exe、.sig 与 latest.json
// 一起上传到 GitHub 上以 LineHush_v<版本> 为标签的正式 Release。
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
const dir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `LineHush_${version}_x64-setup.exe`;
const sigFile = join(dir, `${installer}.sig`);
if (!existsSync(sigFile)) {
  console.error(
    `找不到 ${sigFile}。\n先设好 TAURI_SIGNING_PRIVATE_KEY（私钥路径）再运行 pnpm tauri build。`,
  );
  process.exit(1);
}
const latest = {
  version,
  notes: notesArgument(process.argv.slice(2)),
  // RFC 3339（UTC，去掉毫秒）。
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigFile, "utf8").trim(),
      url: `${REPO}/releases/download/LineHush_v${version}/${installer}`,
    },
  },
};
const target = join(dir, "latest.json");
writeFileSync(target, `${JSON.stringify(latest, null, 2)}\n`);
console.log(`已生成 ${target}`);
