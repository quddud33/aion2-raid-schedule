/**
 * raid_availability 를 Supabase PostgREST 로 읽어 JSON 으로 출력합니다.
 * (웹 HTML 크롤링이 아니라, 앱과 동일한 anon 키로 API 조회)
 *
 * 사용:
 *   npm run fetch:raid -- rudra
 *   npm run fetch:raid -- bagot
 *   npm run fetch:raid -- lostark
 *   npm run fetch:raid -- all
 *
 * 환경: 프로젝트 루트 .env 의 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 *       또는 동일 이름의 환경 변수
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const baseUrl = (process.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.VITE_SUPABASE_ANON_KEY ?? "";
const raidArg = (process.argv[2] ?? "rudra").toLowerCase();

if (!baseUrl || !key) {
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 필요합니다. 루트 .env 또는 환경 변수를 설정하세요.",
  );
  process.exit(1);
}

if (!["rudra", "bagot", "lostark", "all"].includes(raidArg)) {
  console.error("인자: rudra | bagot | lostark | all");
  process.exit(1);
}

let url = `${baseUrl}/rest/v1/raid_availability?select=*`;
if (raidArg !== "all") {
  url += `&raid_type=eq.${encodeURIComponent(raidArg)}`;
}

const res = await fetch(url, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  },
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
