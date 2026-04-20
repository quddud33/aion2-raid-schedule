/**
 * GitHub Pages 등에서 `/base/secret` 경로로 SPA에 진입할 때 404.html 이 index 와 같아야 합니다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const index = path.join(root, "index.html");
const dest = path.join(root, "404.html");
if (!fs.existsSync(index)) {
  console.warn("spa-404: dist/index.html 없음 — vite build 후 실행되는지 확인하세요.");
  process.exit(0);
}
fs.copyFileSync(index, dest);
console.log("spa-404: dist/404.html ← index.html 복사 완료");
