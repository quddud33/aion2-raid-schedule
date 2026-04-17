/** 아툴 홈 검색 폼의 서버 select 옵션을 JSON 으로 출력 (src/data 반영용) */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "src", "data", "aion2tool-servers.json");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://aion2tool.com/", { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.locator(".character-search-form select").first().waitFor({ timeout: 120_000 });
const options = await page.locator(".character-search-form select").first().evaluate((el) =>
  [...el.options]
    .filter((o) => o.value)
    .map((o) => ({
      value: o.value,
      label: (o.textContent ?? "").trim(),
    })),
);
await browser.close();

const byLabel = {};
for (const o of options) {
  byLabel[o.label] = o.value;
}
writeFileSync(outPath, JSON.stringify({ options, byLabel }, null, 2), "utf8");
console.log("Wrote", outPath, "count", options.length);
