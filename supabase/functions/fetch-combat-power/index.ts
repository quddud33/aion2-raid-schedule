import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function stripHtmlForText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCombat(t: string): { best: string | null; current: string | null } {
  let currentCombat: string | null = null;
  let bestCombat: string | null = null;
  const best = t.match(/달성\s*최고\s*전투력[\s\S]{0,80}?([\d,]+)/);
  if (best?.[1]) bestCombat = best[1];
  const cur1 = t.match(/현재\s*전투력[\s\S]{0,60}?([\d,]+)/);
  if (cur1?.[1] && /^[\d,]+$/.test(cur1[1].trim())) currentCombat = cur1[1].trim();
  if (!currentCombat) {
    const lines = t.split(/\r?\n/).map((s) => s.trim());
    const idx = lines.findIndex((l) => /현재\s*전투력/.test(l));
    if (idx >= 0) {
      for (let j = idx + 1; j < Math.min(idx + 8, lines.length); j++) {
        const m = lines[j]?.match(/^([\d,]+)$/);
        if (m?.[1]) {
          currentCombat = m[1];
          break;
        }
      }
    }
  }
  return { best: bestCombat, current: currentCombat };
}

function buildCombatDisplay(best: string | null, current: string | null): string | null {
  if (best && current) return `${current} / ${best}`.slice(0, 48);
  if (best) return best.slice(0, 48);
  if (current) return current.slice(0, 48);
  return null;
}

/** 아툴 캐릭터 HTML의 메인 전투력(#combat-power-main-value). 평문 정규식은 랭킹 % 등 오탐이 나기 쉬움 */
function extractCombatPowerMainFromHtml(html: string): string | null {
  const re = /id\s*=\s*["']combat-power-main-value["'][^>]*>\s*([^<]+?)\s*</gi;
  let pick: string | null = null;
  let pickNum = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const digits = (m[1] ?? "").replace(/\u00a0/g, " ").replace(/[^\d,]/g, "").trim();
    if (!/^[\d,]+$/.test(digits)) continue;
    const n = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 1) continue;
    if (n >= pickNum) {
      pickNum = n;
      pick = digits;
    }
  }
  return pick;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" };

  // 주의: 4xx/5xx 를 쓰면 supabase-js functions.invoke 가 "non-2xx" 로만 알려 줘서
  // 클라이언트가 본문(ok:false)을 못 읽는 경우가 있음 → 앱 레벨 오류는 항상 200 + JSON.
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

  const url = `https://aion2tool.com/char/serverid=${serverId}/${encodeURIComponent(nickname)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `아툴 요청 실패: ${e instanceof Error ? e.message : String(e)}`,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (!res.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `아툴 HTTP ${res.status}. Cloudflare 등으로 차단됐을 수 있습니다.`,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  const html = await res.text();
  const fromMainDiv = extractCombatPowerMainFromHtml(html);
  let combat_power: string | null = fromMainDiv ? fromMainDiv.slice(0, 48) : null;
  let best: string | null = null;
  let current: string | null = null;
  if (!combat_power) {
    const t = stripHtmlForText(html);
    const parsed = parseCombat(t);
    best = parsed.best;
    current = parsed.current;
    combat_power = buildCombatDisplay(best, current);
  }
  if (!combat_power) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          "HTML에서 전투력을 찾지 못했습니다. 아툴이 클라이언트만 렌더링하면 fetch로는 부족할 수 있어 npm run aion2tool:power 또는 수동 입력을 사용해 주세요.",
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (fromMainDiv) {
    const t = stripHtmlForText(html);
    const parsed = parseCombat(t);
    best = parsed.best;
    current = parsed.current;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      combat_power,
      bestCombat: best,
      currentCombat: current,
    }),
    { status: 200, headers: jsonHeaders },
  );
});
