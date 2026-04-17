/**
 * 임의 URL 의 HTML 을 가져와 메타만 출력합니다. (브라우저 없이 fetch 만 사용)
 *
 * 사용:
 *   npm run crawl -- https://example.com/news
 *
 * 제한: 클라이언트에서 그려지는 내용(SPA·hydration)은 비어 있을 수 있습니다.
 *       그런 경우 Playwright/Puppeteer 등이 필요합니다.
 *
 * robots.txt·이용약관·과도한 요청은 각 사이트 정책을 따르세요.
 */

const url = process.argv[2];
if (!url) {
  console.error("사용법: npm run crawl -- <https://...>");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("올바른 URL 이 아닙니다.");
  process.exit(1);
}

if (!["http:", "https:"].includes(parsed.protocol)) {
  console.error("http(s) URL 만 허용합니다.");
  process.exit(1);
}

const res = await fetch(url, {
  redirect: "follow",
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; aion2-raid-schedule/1.0; +https://github.com) personal-fetch",
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko,en;q=0.9",
  },
});

const buf = await res.arrayBuffer();
const ct = res.headers.get("content-type") ?? "";
const charsetMatch = ct.match(/charset=([^;]+)/i);
const charset = charsetMatch ? charsetMatch[1].trim().replace(/"/g, "") : "utf-8";
let text;
try {
  text = new TextDecoder(charset.toLowerCase() === "utf-8" ? "utf-8" : charset).decode(buf);
} catch {
  text = new TextDecoder("utf-8").decode(buf);
}

const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;

const out = {
  ok: res.ok,
  status: res.status,
  finalUrl: res.url,
  contentType: ct,
  byteLength: buf.byteLength,
  title,
  /** 본문 앞부분만 (터미널용). 전체는 파일로 리다이렉트: npm run crawl -- URL > out.html */
  bodyPreview: text.slice(0, 4000),
};

console.log(JSON.stringify(out, null, 2));
