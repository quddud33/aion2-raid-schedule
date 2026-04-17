/**
 * https://aion2tool.com/ 캐릭터 검색 폼(.character-search-form)으로 서버·닉 검색 후 전투력 텍스트를 읽습니다.
 * (SPA + Cloudflare 대응을 위해 Playwright 사용)
 *
 * 최초 1회: npx playwright install chromium
 *
 * 사용:
 *   npm run aion2tool:power -- 무닌 반갑꼬리
 *   npm run aion2tool:power -- "무 닌" 반갑꼬리
 */

import { chromium } from "playwright";

const BASE = "https://aion2tool.com";

function norm(s) {
  return String(s).replace(/\s+/g, "").toLowerCase();
}

function parseArgs() {
  const rest = process.argv.slice(2).filter(Boolean);
  if (rest.length < 2) {
    console.error("사용법: npm run aion2tool:power -- <서버명> <닉네임>");
    console.error("예: npm run aion2tool:power -- 무닌 반갑꼬리");
    process.exit(1);
  }
  const nickname = rest.pop();
  const server = rest.join(" ");
  return { server: server.trim(), nickname: nickname.trim() };
}

async function waitForCombatNumbers(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await page.evaluate(() => {
      const t = document.body?.innerText ?? "";
      const { currentCombat, bestCombat } = (() => {
        let currentCombat = null;
        let bestCombat = null;
        const best = t.match(/달성\s*최고\s*전투력[\s\S]{0,80}?([\d,]+)/);
        if (best) bestCombat = best[1];
        const cur1 = t.match(/현재\s*전투력[\s\S]{0,60}?([\d,]+)/);
        if (cur1 && /^[\d,]+$/.test(cur1[1].trim())) currentCombat = cur1[1].trim();
        if (!currentCombat) {
          const lines = t.split(/\r?\n/).map((s) => s.trim());
          const idx = lines.findIndex((l) => /현재\s*전투력/.test(l));
          if (idx >= 0) {
            for (let j = idx + 1; j < Math.min(idx + 8, lines.length); j++) {
              const m = lines[j].match(/^([\d,]+)$/);
              if (m) {
                currentCombat = m[1];
                break;
              }
            }
          }
        }
        if (!currentCombat) {
          for (const el of document.querySelectorAll("div, span, dt, p, td")) {
            const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (/^현재\s*전투력$/.test(raw) || raw === "현재 전투력") {
              const block = el.parentElement?.innerText ?? el.innerText ?? "";
              const m = block.match(/현재\s*전투력[\s\S]{0,120}?([\d,]+)/);
              if (m && /^[\d,]+$/.test(m[1].trim())) {
                currentCombat = m[1].trim();
                break;
              }
            }
          }
        }
        return { currentCombat, bestCombat };
      })();
      return {
        currentCombat,
        bestCombat,
        title: document.title,
        hasLoading: /로딩\s*중|검색\s*중/.test(t),
        url: location.href,
      };
    });
    if ((out.currentCombat || out.bestCombat) && !out.hasLoading) {
      return out;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const last = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    snippet: (document.body?.innerText ?? "").slice(0, 800),
  }));
  throw new Error(`전투력 숫자를 제한 시간 안에 찾지 못했습니다.\nURL: ${last.url}\n제목: ${last.title}`);
}

async function main() {
  const { server, nickname } = parseArgs();

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });

    const form = page.locator(".character-search-form").first();
    await form.waitFor({ state: "visible", timeout: 120_000 });

    const select = form.locator("select").first();
    await select.waitFor({ state: "visible", timeout: 60_000 });

    const options = await select.evaluate((el) =>
      [...el.options].map((o) => ({ text: (o.textContent ?? "").trim(), value: o.value })),
    );
    const ns = norm(server);
    const hit = options.find(
      (o) => norm(o.text).includes(ns) || o.text.includes(server.trim()) || norm(o.text) === ns,
    );
    if (!hit) {
      console.error(`서버 "${server}" 에 맞는 옵션을 찾지 못했습니다.`);
      console.error("일부 옵션:", options.slice(0, 25).map((o) => o.text).join(" | "));
      process.exit(1);
    }
    await select.selectOption({ value: hit.value });

    const textInput = form.locator('input[type="text"], input:not([type]), input[type="search"]').first();
    await textInput.fill(nickname);

    await Promise.all([
      page.waitForURL(/\/char\/serverid=\d+\//, { timeout: 120_000 }),
      form.getByRole("button", { name: "검색" }).click(),
    ]);

    const data = await waitForCombatNumbers(page, 90_000);

    const title = await page.title();
    console.log(
      JSON.stringify(
        {
          serverQuery: server,
          serverOption: hit.text,
          serverId: hit.value,
          nickname,
          url: data.url,
          title,
          currentCombatPower: data.currentCombat,
          bestCombatPower: data.bestCombat,
          note:
            data.currentCombat == null
              ? "현재 전투력은 페이지 구조에 따라 비어 있을 수 있습니다. 달성 최고 전투력은 아툴 DB 기준 값입니다."
              : undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

await main();
