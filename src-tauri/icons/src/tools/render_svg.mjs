// node render.mjs <projectRoot> <svg> <size> <out.png> [<svg> <size> <out.png> ...]
// Sets the SVG root width/height to size (viewBox unchanged), renders it inline at size×size,
// device scale factor 1, transparent background.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const [root, ...rest] = process.argv.slice(2);
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1100, height: 1100 } });
const page = await context.newPage();
for (let i = 0; i < rest.length; i += 3) {
  const [svgPath, sizeText, out] = rest.slice(i, i + 3);
  const n = Number(sizeText);
  const source = readFileSync(svgPath, "utf8");
  const svg = source.replace(/<svg\b[^>]*>/, (tag) =>
    tag.replace(/\swidth="[^"]*"/, ` width="${n}"`).replace(/\sheight="[^"]*"/, ` height="${n}"`));
  if (!/viewBox=/.test(svg.match(/<svg\b[^>]*>/)[0])) throw new Error("no viewBox: " + svgPath);
  await page.setViewportSize({ width: Math.max(n, 100), height: Math.max(n, 100) });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  const el = await page.$("svg");
  const box = await el.boundingBox();
  if (box.width !== n || box.height !== n) throw new Error(`box ${box.width}x${box.height} != ${n}`);
  await el.screenshot({ path: out, omitBackground: true });
  console.log("rendered", n, out);
}
await browser.close();
