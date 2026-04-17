/**
 * 캐릭터 검색: 플레이NC 공식 JSON API (`/ko-kr/api/search/aion2/search/v2/character`)로 characterId 확보.
 * 전투력·템렙: 프로필 HTML에 SSR로 내려오는 경우에만 파싱 가능(없으면 수동 입력 안내).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLAYNC_ORIGIN = "https://aion2.plaync.com";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchHtml(url: string, referer?: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchJson(url: string, referer?: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ko-KR,ko;q=0.9",
    };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: e instanceof Error ? e.message : String(e),
    };
  }
}

function escapeRegexId(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 검색 HTML·번들 JSON 등에서 프로필 URL 후보 수집 (index 제외) — API 실패 시 보조 */
function collectProfileUrls(html: string, serverId: string): string[] {
  const normalized = html.replace(/\\\//g, "/");
  const esc = escapeRegexId(serverId);
  const seen = new Set<string>();
  const out: string[] = [];

  const addSeg = (raw: string) => {
    let seg = (raw ?? "").trim();
    seg = seg.split(/["'?#]/)[0] ?? "";
    seg = seg.replace(/\\/g, "").trim();
    if (!seg || seg === "index") return;
    const full = `${PLAYNC_ORIGIN}/ko-kr/characters/${serverId}/${seg}`;
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  };

  const res: RegExp[] = [
    new RegExp(String.raw`https://aion2\.plaync\.com/ko-kr/characters/${esc}/([^"'\s<>]+)`, "gi"),
    new RegExp(String.raw`/ko-kr/characters/${esc}/([^"'\s<>]+)`, "gi"),
    new RegExp(String.raw`to=["']/ko-kr/characters/${esc}/([^"']+)`, "gi"),
    new RegExp(String.raw`to=\{[^}]*['"]/ko-kr/characters/${esc}/([^'"]+)`, "gi"),
    new RegExp(String.raw`["']/ko-kr/characters/${esc}/([^"']+)`, "gi"),
  ];

  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      addSeg(m[1] ?? "");
    }
  }
  return out;
}

function listSearchPageUrl(serverId: string, nickname: string, race?: number): string {
  const q = new URLSearchParams();
  if (race !== undefined) q.set("race", String(race));
  q.set("serverId", serverId);
  q.set("keyword", nickname);
  return `${PLAYNC_ORIGIN}/ko-kr/characters/index?${q.toString()}`;
}

function characterSearchApiUrl(serverId: string, nickname: string, race?: number): string {
  const q = new URLSearchParams({
    keyword: nickname.trim(),
    serverId,
    page: "1",
    size: "30",
  });
  if (race !== undefined) q.set("race", String(race));
  return `${PLAYNC_ORIGIN}/ko-kr/api/search/aion2/search/v2/character?${q.toString()}`;
}

type SearchRow = {
  characterId?: string;
  name?: string;
  serverId?: number;
};

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/** API가 %3D 등으로 줄 수 있어, 한 번 decode 후 encode 하면 경로가 올바름 */
function encodeCharacterPathSegment(characterId: string): string {
  const t = characterId.trim();
  if (!t) return t;
  try {
    return encodeURIComponent(decodeURIComponent(t));
  } catch {
    return encodeURIComponent(t);
  }
}

/** 검색 API list 에서 serverId·닉네임(HTML 제거)이 일치하는 캐릭터의 characterId */
function pickCharacterIdFromSearchList(
  list: SearchRow[],
  serverId: string,
  nickname: string,
): string | null {
  const want = nickname.trim();
  const sid = String(serverId);
  const rows = list.filter((x) => x.characterId && String(x.serverId ?? "") === sid);
  if (rows.length === 0) return null;
  const exact = rows.filter((x) => stripHtmlTags(x.name ?? "") === want);
  if (exact.length >= 1) return String(exact[0]!.characterId).trim();
  return null;
}

async function resolveProfileUrlFromSearchApi(
  serverId: string,
  nickname: string,
): Promise<{ url: string | null; note?: string }> {
  const indexRef = `${PLAYNC_ORIGIN}/ko-kr/characters/index`;
  const searchOrders = [2, 1, undefined] as const;

  for (const race of searchOrders) {
    const apiUrl = characterSearchApiUrl(serverId, nickname, race);
    const r = await fetchJson(apiUrl, indexRef);
    if (!r.ok) continue;
    let data: { list?: SearchRow[] } = {};
    try {
      data = JSON.parse(r.text) as { list?: SearchRow[] };
    } catch {
      continue;
    }
    const list = Array.isArray(data.list) ? data.list : [];
    const id = pickCharacterIdFromSearchList(list, serverId, nickname);
    if (id) {
      const seg = encodeCharacterPathSegment(id).replace(/^\/+|\/+$/g, "");
      if (!seg || seg === "index") continue;
      return { url: `${PLAYNC_ORIGIN}/ko-kr/characters/${serverId}/${seg}` };
    }
  }

  return {
    url: null,
    note:
      "플레이NC 검색 API에서 일치하는 캐릭터를 찾지 못했습니다. 닉네임·서버(플레이NC serverId 매핑)·종족(마족/천족)을 확인하거나 수동 입력을 사용해 주세요.",
  };
}

/** HTML에서 링크만 수집 (API 실패 시) */
async function resolveProfileUrlFromHtml(
  serverId: string,
  nickname: string,
): Promise<{ url: string | null; note?: string }> {
  const indexRef = `${PLAYNC_ORIGIN}/ko-kr/characters/index`;
  const searchOrders = [2, 1, undefined] as const;

  for (const race of searchOrders) {
    const listUrl = listSearchPageUrl(serverId, nickname, race);
    const r = await fetchHtml(listUrl, indexRef);
    if (!r.ok) continue;
    const urls = collectProfileUrls(r.text, serverId);
    if (urls.length === 0) continue;
    if (urls.length === 1) return { url: urls[0]! };
    for (const candidate of urls.slice(0, 10)) {
      const d = await fetchHtml(candidate, listUrl);
      if (!d.ok) continue;
      const { power, item } = extractPowerAndItem(d.text);
      if (power || item) return { url: candidate };
    }
  }
  return {
    url: null,
    note: "검색 HTML에서 프로필 링크를 찾지 못했습니다.",
  };
}

async function resolveProfileUrl(
  serverId: string,
  nickname: string,
): Promise<{ url: string | null; note?: string }> {
  const api = await resolveProfileUrlFromSearchApi(serverId, nickname);
  if (api.url) return api;
  const html = await resolveProfileUrlFromHtml(serverId, nickname);
  if (html.url) return html;
  return {
    url: null,
    note: [api.note, html.note].filter(Boolean).join(" "),
  };
}

function extractPowerAndItem(html: string): { power: string | null; item: string | null } {
  const powerRe = /profile__info-power-level[^>]*>\s*<span>([^<]*)<\/span>/i;
  const itemRe = /profile__info-item-level[^>]*>\s*<span>([^<]*)<\/span>/i;
  const pm = html.match(powerRe);
  const im = html.match(itemRe);
  const power = pm?.[1]?.replace(/\u00a0/g, " ").trim() || null;
  const item = im?.[1]?.replace(/\u00a0/g, " ").trim() || null;
  return { power, item };
}

function buildCombatLine(power: string | null, item: string | null): string | null {
  if (power && item) return `${power} / ${item}`.slice(0, 48);
  if (power) return power.slice(0, 48);
  if (item) return item.slice(0, 48);
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ ok: false, error: "Authorization 헤더가 없습니다. 로그인(익명) 후 다시 시도해 주세요." }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `세션 확인 실패: ${userErr?.message ?? "user 없음"}. 페이지를 새로고침한 뒤 다시 시도해 주세요.`,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  let body: { serverId?: string; nickname?: string };
  try {
    body = (await req.json()) as { serverId?: string; nickname?: string };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "JSON 본문이 필요합니다." }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const serverId = String(body.serverId ?? "").trim();
  const nickname = String(body.nickname ?? "").trim();
  if (!/^\d+$/.test(serverId)) {
    return new Response(JSON.stringify({ ok: false, error: "serverId가 올바르지 않습니다." }), {
      status: 200,
      headers: jsonHeaders,
    });
  }
  if (nickname.length < 1 || nickname.length > 24) {
    return new Response(JSON.stringify({ ok: false, error: "닉네임은 1~24자여야 합니다." }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const { url: profileUrl, note: searchNote } = await resolveProfileUrl(serverId, nickname);
  if (!profileUrl) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: searchNote ?? "캐릭터 URL을 찾지 못했습니다.",
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  const detail = await fetchHtml(profileUrl, `${PLAYNC_ORIGIN}/ko-kr/characters/index`);
  if (!detail.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `플레이NC 캐릭터 페이지 요청 실패 (HTTP ${detail.status}).`,
        plaync_profile_url: profileUrl,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  const { power, item } = extractPowerAndItem(detail.text);
  const combat_power = buildCombatLine(power, item);
  if (!combat_power) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "캐릭터는 검색 API로 찾았으나, 전투력·템렙이 초기 HTML에 없습니다(공식이 브라우저에서만 그리는 경우).「전투력 반영」으로 수동 입력해 주세요.",
        plaync_profile_url: profileUrl,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      combat_power,
      plaync_profile_url: profileUrl,
      power_level: power,
      item_level: item,
    }),
    { status: 200, headers: jsonHeaders },
  );
});
