/**
 * 플레이NC 캐릭터 검색·프로필은 초기 HTML에 목록/전투력이 없고(CSR), 서버 fetch만으로는 실패하는 것이 일반적입니다.
 * 프론트 앱은 목록 갱신 시 이 함수를 호출하지 않습니다. 수동 입력·별도 자동화(브라우저)를 권장합니다.
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

function escapeRegexId(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 검색 HTML·번들 JSON 등에서 프로필 URL 후보 수집 (index 제외) */
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

function listSearchUrl(serverId: string, nickname: string, race?: number): string {
  const q = new URLSearchParams();
  if (race !== undefined) q.set("race", String(race));
  q.set("serverId", serverId);
  q.set("keyword", nickname);
  return `${PLAYNC_ORIGIN}/ko-kr/characters/index?${q.toString()}`;
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

/** 검색(race=2 → race=1 → race 생략) 후 URL 후보; 복수면 실제 프로필 HTML에 전투력 블록 있는 쪽만 시도 */
async function resolveProfileUrl(
  serverId: string,
  nickname: string,
): Promise<{ url: string | null; note?: string }> {
  const indexRef = `${PLAYNC_ORIGIN}/ko-kr/characters/index`;
  const searchOrders = [2, 1, undefined] as const;

  for (const race of searchOrders) {
    const listUrl = listSearchUrl(serverId, nickname, race);
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
    // 링크는 여럿인데 SSR에 전투력이 없으면 다음 검색(race 생략 등)으로 이어감
  }
  return {
    url: null,
    note:
      "플레이NC 검색 HTML에서 프로필 링크를 찾지 못했습니다. (공식이 클라이언트만 렌더링하면 서버 fetch로는 목록이 비어 있을 수 있습니다.) 서버·닉네임·종족을 확인하거나 수동 입력을 사용해 주세요.",
  };
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
          "전투력·아이템 레벨을 HTML에서 찾지 못했습니다. 공식 페이지가 클라이언트만 렌더링하면 수동 입력을 사용해 주세요.",
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
