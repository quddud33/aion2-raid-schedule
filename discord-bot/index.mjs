/**
 * 일정 확정(raid_schedule_confirmation) 기준으로
 * 출발 24시간 전 / 30분 전에 디스코드 채널에 멘션 알림을 보냅니다.
 *
 * 실행: npm install 후 .env 복사·채우고 → npm start
 * 한 번만 점검: npm run check
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Client, GatewayIntentBits } from "discord.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (process.env.REMIND_TZ) {
  process.env.TZ = process.env.REMIND_TZ;
}

const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RAID_FILTER = (process.env.REMINDER_RAID_TYPE ?? "").trim();
const STATE_PATH = resolve(process.env.SENT_STATE_PATH ?? "./sent-reminders.json");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

function requireEnv(name, v) {
  if (!v) {
    console.error(`[오류] 환경 변수 ${name} 가 비어 있습니다. .env.example 을 참고해 .env 를 채우세요.`);
    process.exit(1);
  }
}

/** slot_key: YYYY-MM-DD@MMMM — MMMM = 자정부터의 분(4자리 패딩) */
function slotKeyToLocalDate(slotKey) {
  const m = String(slotKey).match(/^(\d{4})-(\d{2})-(\d{2})@(\d{4})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const mins = Number(m[4]);
  if (!Number.isFinite(y) || !Number.isFinite(mins)) return null;
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  return new Date(y, mo - 1, d, h, min, 0, 0);
}

function formatKo(dt) {
  return dt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

async function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(obj) {
  await writeFile(STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

async function fetchParticipants(supabase, raidType, slotKey) {
  const { data, error } = await supabase
    .from("raid_availability")
    .select("nickname, discord_id, slots")
    .eq("raid_type", raidType);
  if (error) throw error;
  const ids = new Set();
  for (const row of data ?? []) {
    const slots = row.slots ?? [];
    if (!Array.isArray(slots) || !slots.includes(slotKey)) continue;
    const id = row.discord_id;
    if (id && /^\d{5,30}$/.test(String(id))) ids.add(String(id));
  }
  return [...ids];
}

async function runTick(client, supabase, state) {
  const { data: confs, error } = await supabase.from("raid_schedule_confirmation").select("*");
  if (error) throw error;

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    console.error("[오류] 채널을 찾을 수 없거나 텍스트 채널이 아닙니다. 봇을 서버에 초대했는지·CHANNEL_ID 확인.");
    return state;
  }

  const now = Date.now();
  let nextState = { ...state };

  for (const conf of confs ?? []) {
    if (RAID_FILTER && conf.raid_type !== RAID_FILTER) continue;

    const slotStart = slotKeyToLocalDate(conf.slot_key);
    if (!slotStart || slotStart.getTime() <= now) continue;

    const t24 = slotStart.getTime() - 24 * 60 * 60 * 1000;
    const t30 = slotStart.getTime() - 30 * 60 * 1000;
    const weekKey = String(conf.raid_week_start ?? "").slice(0, 10);
    const keyBase = `${conf.raid_type}|${weekKey}|${conf.slot_key}`;

    const participants = await fetchParticipants(supabase, conf.raid_type, conf.slot_key);
    const mentionLine =
      participants.length > 0
        ? participants.map((id) => `<@${id}>`).join(" ")
        : "(멘션할 Discord ID가 없습니다. 웹에서 「가능 시간 저장」을 해 주세요.)";

    const sendIf = async (kind, targetMs) => {
      const flagKey = `${keyBase}:${kind}`;
      if (nextState[flagKey]) return;
      if (Math.abs(now - targetMs) > 90_000) return;
      const label = kind === "d24" ? "24시간 전" : "30분 전";
      const text = [
        `**[레이드 알림 · ${label}]**`,
        `raid_type: \`${conf.raid_type}\``,
        `출발 시각(로컬): **${formatKo(slotStart)}**`,
        mentionLine,
      ].join("\n");
      await channel.send({ content: text });
      nextState[flagKey] = new Date().toISOString();
      console.log(`[전송] ${flagKey}`);
    };

    await sendIf("d24", t24);
    await sendIf("d30", t30);
  }

  await saveState(nextState);
  return nextState;
}

async function main() {
  requireEnv("DISCORD_BOT_TOKEN", TOKEN);
  requireEnv("DISCORD_CHANNEL_ID", CHANNEL_ID);
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

  console.log(`[설정] TZ=${process.env.TZ ?? "(기본)"} STATE=${STATE_PATH} POLL=${POLL_MS}ms`);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(TOKEN);
  console.log(`[Discord] 로그인: ${client.user?.tag}`);

  let state = await loadState();
  const once = process.argv.includes("--once");

  const tick = async () => {
    try {
      state = await runTick(client, supabase, state);
    } catch (e) {
      console.error("[틱 오류]", e?.message ?? e);
    }
  };

  await tick();
  if (once) {
    await client.destroy();
    process.exit(0);
  }

  setInterval(tick, POLL_MS);
  console.log("[동작 중] 종료하려면 Ctrl+C");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
