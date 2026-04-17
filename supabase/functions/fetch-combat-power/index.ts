import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLAYNC_ORIGIN = "https://aion2.plaync.com";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchHtml(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
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

/** 검색·다른 페이지에서 프로필 경로만 수집 (index 제외) */
function collectProfileUrls(html: string, serverId: string): string[] {
  const esc = escapeRegexId(serverId);
  const re = new RegExp(String.raw`/ko-kr/characters/${esc}/([^"'\s<>#]+)`, "gi");
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const seg = (m[1] ?? "").trim();
    if (!seg || seg === "index") continue;
    const full = `${PLAYNC_ORIGIN}/ko-kr/characters/${serverId}/${seg}`;
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

/** 마족(race=2) → 천족(race=1) 순으로 검색 */
async function resolveProfileUrl(
  serverId: string,
  nickname: string,
): Promise<{ url: string | null; note?: string }> {
  const kw = encodeURIComponent(nickname);
  for (const race of [2, 1] as const) {
    const listUrl = `${PLAYNC_ORIGIN}/ko-kr/characters/index?race=${race}&serverId=${serverId}&keyword=${kw}`;
    const r = await fetchHtml(listUrl);
    if (!r.ok) continue;
    const urls = collectProfileUrls(r.text, serverId);
    if (urls.length === 1) return { url: urls[0]! };
    if (urls.length > 1) {
      return {
        url: null,
        note: "검색 결과가 여러 명입니다. 닉네임·서버를 공식과 동일하게 입력했는지 확인해 주세요.",
      };
    }
  }
  return {
    url: null,
    note: "플레이NC 검색에서 캐릭터를 찾지 못했습니다. 서버 ID·닉네임·종족(마족/천족)을 확인해 주세요.",
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

  const detail = await fetchHtml(profileUrl);
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
