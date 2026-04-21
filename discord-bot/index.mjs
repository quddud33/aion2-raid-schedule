/**
 * 일정 확정(raid_schedule_confirmation) 기준으로
 * **확정 직후**(봇이 감지한 뒤 한 번) 해당 슬롯 참가자에게 멘션하고,
 * 출발 **당일 REMIND_DAY_HOUR 시(기본 06:00)** / **30분 전**에도 디스코드 채널에 멘션 알림을 보냅니다.
 *
 * 채널: `.env` 또는 Supabase `discord_reminder_channel_config` (디스코드 `/raid_notify` 로 설정)
 *
 * 실행: npm install 후 .env 복사·채우고 → npm start
 * 한 번만 점검: npm run check
 * 채널에 테스트 글: `/raid_notify test`(실행자 멘션) 또는 npm run test-notify
 * 명령 안내: `/raid_notify help` · 관리자 알림 시각: `/raid_notify timings`
 * 내 가능 시간: `/raid_my_schedule` (금주·차주 14일만, 날짜별·연속 구간 묶음)
 * 겹침: `/raid_overlap` (레이드별 웹 전원, 멘션 없음) · 주사위: `/dice` (1~100, 채널에 멘션)
 * 슈상보: `/sugo_ping` — 짝수 시 **xx:59~정각**(06~08시 제외) 등록 채널에서 멘션
 * 파티: `/party_recruit` — 최대 8인, 버튼으로 출발·해체·가입·탈퇴
 * 알람: `/remind`(`reason` 선택) · 취소 `/remind_cancel` · 채팅 `알람 …`/`사유:`/`(메모)`/`알람 해제`/`@봇 …`
 * `@봇 구버지` / `@봇 명령어`·`도움말`: `REMIND_CHAT_ENABLED=1` 이거나 `BOT_AT_COMMANDS_ENABLED=1` 일 때 (Message Content Intent 필요)
 *
 * 부하 완화: 미래 확정 일정 없으면 레이드 틱 조기 종료 / 가능시간 DB 1회만 조회 /
 * 전송 기록 파일 주기적 정리·실제 알림 보낼 때만 state 저장 (자세한 건 로그 `[최적화]`)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.REMIND_TZ) {
  process.env.TZ = process.env.REMIND_TZ;
}

/** `npm start` cwd와 무관하게 동일 경로에 상태 저장 (systemd 등) */
const __botDir = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const STATE_PATH = process.env.SENT_STATE_PATH
  ? resolve(process.env.SENT_STATE_PATH)
  : resolve(__botDir, "sent-reminders.json");
/** `/remind` 예약 목록 (봇 재시작 시 복구) */
const ALARM_STATE_PATH = process.env.REMIND_ALARM_PATH
  ? resolve(process.env.REMIND_ALARM_PATH)
  : resolve(__botDir, "pending-alarms.json");
/** 저사양 VM: 90~120초 권장(부하·OOM 완화). 기본 60초 유지 */
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
/** 확정 직후 멘션: `updated_at` 이 이 시간(밀리초)보다 오래되면 전송 생략(봇 재시작 시 과거 확정 일괄 알림 방지). 기본 15분 */
const CONFIRM_NOTIFY_MAX_AGE_MS = Math.max(60_000, Number(process.env.CONFIRM_NOTIFY_MAX_AGE_MS ?? 900_000) || 900_000);
const REMIND_DAY_HOUR = Math.min(23, Math.max(0, Number(process.env.REMIND_DAY_HOUR ?? 6) || 6));
/** sent-reminders.json 에서 오래된 키 제거(메모리·디스크·JSON 파싱 부담 완화) */
const STATE_PRUNE_RAID_DAYS = Math.max(7, Number(process.env.STATE_PRUNE_RAID_DAYS ?? 14) || 14);
const STATE_PRUNE_SUGO_DAYS = Math.max(3, Number(process.env.STATE_PRUNE_SUGO_DAYS ?? 10) || 10);

/** `/remind` 최소·최대 지연 (남용 방지). 기본 최대 7일 */
const REMIND_MIN_MS = Math.max(1_000, Number(process.env.REMIND_MIN_MS ?? 5_000) || 5_000);
const REMIND_MAX_MS = Math.max(REMIND_MIN_MS, Number(process.env.REMIND_MAX_MS ?? 604_800_000) || 604_800_000);
const REMIND_MAX_PER_USER = Math.max(1, Math.min(50, Number(process.env.REMIND_MAX_PER_USER ?? 10) || 10));
/** 채널 전송 실패(권한·네트워크) 시 재시도 횟수·간격 */
const REMIND_SEND_MAX_RETRY = Math.max(1, Math.min(40, Number(process.env.REMIND_SEND_MAX_RETRY ?? 12) || 12));
const REMIND_SEND_RETRY_MS = Math.max(5_000, Number(process.env.REMIND_SEND_RETRY_MS ?? 15_000) || 15_000);

/** 채팅 알람: 이 문자로 시작하면 파싱 시도. `.env`에서 `REMIND_MSG_PREFIX=` 로 비우면 **봇 멘션만** 트리거 */
const REMIND_MSG_PREFIX = Object.prototype.hasOwnProperty.call(process.env, "REMIND_MSG_PREFIX")
  ? String(process.env.REMIND_MSG_PREFIX ?? "")
  : "알람";
/** 알람 사유 미입력 시 전송 본문에 쓰는 기본값 */
const DEFAULT_REMIND_REASON = "알람";

function envFlagTruthy(name) {
  const v = String(process.env[name] ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * 채팅 본문 알람에 `GuildMessages` + `MessageContent` 가 필요함.
 * `REMIND_CHAT_ENABLED=1` 인데 Portal **Bot** 탭의 **Privileged Gateway Intents** 에서
 * 메시지 본문 읽기(Intent)를 켜지 않으면 `Used disallowed intents` 로 종료되므로 기본은 끔.
 * (초대 URL의 ‘봇 권한’ 체크박스와는 다른 곳입니다.)
 */
const REMIND_CHAT_ENABLED = envFlagTruthy("REMIND_CHAT_ENABLED");
/** GuildMessages + MessageContent — 알람 채팅(`REMIND_CHAT_ENABLED`) 또는 `@봇 구버지` / `@봇 명령어` 등(`BOT_AT_COMMANDS_ENABLED=1`) */
const MESSAGE_CONTENT_INTENTS_ENABLED = REMIND_CHAT_ENABLED || envFlagTruthy("BOT_AT_COMMANDS_ENABLED");

let gAlarmState = { alarms: [] };
/** @type {Map<string, NodeJS.Timeout>} */
const gAlarmTimers = new Map();
let gAlarmClient = null;

async function loadAlarmState() {
  if (!existsSync(ALARM_STATE_PATH)) return { alarms: [] };
  try {
    const raw = await readFile(ALARM_STATE_PATH, "utf8");
    const p = JSON.parse(raw);
    const alarms = Array.isArray(p?.alarms) ? p.alarms : [];
    return { alarms: alarms.filter((a) => a?.id && a?.channelId && a?.targetUserId && Number.isFinite(a?.dueAt)) };
  } catch {
    return { alarms: [] };
  }
}

async function persistAlarmState() {
  await writeFile(ALARM_STATE_PATH, JSON.stringify(gAlarmState, null, 2), "utf8");
}

function computeRemindDelayMs(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 1) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "seconds") return n * 1000;
  if (u === "minutes") return n * 60 * 1000;
  if (u === "hours") return n * 60 * 60 * 1000;
  return null;
}

function formatRemindLabelKo(amount, unit) {
  const n = Number(amount);
  const u = String(unit || "").toLowerCase();
  if (u === "seconds") return `${n}초 뒤`;
  if (u === "minutes") return `${n}분 뒤`;
  if (u === "hours") return `${n}시간 뒤`;
  return `${n} 뒤`;
}

function msForKoUnit(n, unitKo) {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (unitKo === "초") return n * 1000;
  if (unitKo === "분") return n * 60 * 1000;
  if (unitKo === "시간") return n * 60 * 60 * 1000;
  return 0;
}

/** `1시간 10분 10초` → `1시간 10분 10초 뒤` */
function buildKoCompoundRemindLabel(parts) {
  if (parts.length === 0) return "";
  return `${parts.map(({ n, unitKo }) => `${n}${unitKo}`).join(" ")} 뒤`;
}

/**
 * 채팅 본문의 모든 `N초|분|시간` 구간을 **합산** (예: 1시간 10분 10초).
 * @returns {{ delayMs: number, labelKo: string } | null}
 */
function parseKoRemindContent(content) {
  const stripped = String(content ?? "")
    .replace(/<@!?(\d+)>/g, " ")
    .replace(/<@&(\d+)>/g, " ")
    .replace(/<#(\d+)>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  const re = /(\d{1,6})\s*(초|분|시간)/gu;
  const parts = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n === 0) continue;
    parts.push({ n, unitKo: m[2] });
  }
  if (parts.length === 0) return null;
  let delayMs = 0;
  for (const { n, unitKo } of parts) {
    delayMs += msForKoUnit(n, unitKo);
  }
  if (delayMs < 1) return null;
  return { delayMs, labelKo: buildKoCompoundRemindLabel(parts) };
}

/**
 * `사유: …` / `사유 : …` / 줄 끝 `(메모)` 를 뽑아 내고, 남은 문자열만 시간 합산에 쓴다.
 * @returns {{ textForDelay: string, reasonKo: string | null }}
 */
function extractRemindReasonAndBodyForDelay(content) {
  let text = String(content ?? "")
    .replace(/<@!?(\d+)>/g, " ")
    .replace(/<@&(\d+)>/g, " ")
    .replace(/<#(\d+)>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let reason = null;
  const colon = text.match(/사유\s*[:：]\s*(.+)$/i);
  if (colon && colon[1].trim()) {
    reason = colon[1].trim().slice(0, 500);
    text = text.replace(/사유\s*[:：]\s*.+$/i, " ").replace(/\s+/g, " ").trim();
  } else {
    const lp = text.match(/\(([^)]{1,300})\)\s*$/);
    if (lp && lp[1].trim()) {
      reason = lp[1].trim().slice(0, 500);
      text = text.replace(/\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
    }
  }

  return { textForDelay: text, reasonKo: reason };
}

/** 본문에서 멘션·채널 태그 제거한 뒤 공백 정리 */
function normalizeRemindChatBody(messageContent) {
  return String(messageContent ?? "")
    .replace(/<@!?(\d+)>/g, " ")
    .replace(/<@&(\d+)>/g, " ")
    .replace(/<#(\d+)>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 채팅 `알람 해제` / `알람 전부 해제` / `@봇 해제` 등 → `channel` | `server` | null
 * - `server`: 이 서버에서 본인이 건 예약 전부
 * - `channel`: 이 채널에서 본인이 건 예약만
 * (본문 전체가 취소 문장일 때만 인식 — `알람 10분` 등과 구분)
 */
function getRemindCancelScope(message) {
  const raw = normalizeRemindChatBody(message.content);
  if (!raw) return null;
  if (/^알람\s*(전부|모두)\s*(해제|취소)(요|해줘|해주세요)?$/.test(raw)) return "server";
  if (/^알람\s*(해제|취소)(요|해줘|해주세요)?$/.test(raw)) return "channel";
  if (/^알람\s*(해제해줘|취소해줘|해제해주세요|취소해주세요)$/.test(raw)) return "channel";
  if (/^(알람\s*)?(해제|취소)(요|해줘|해주세요)?$/.test(raw)) return "channel";
  return null;
}

function shouldHandleRemindChatMessage(message, client) {
  if (!message.guild || message.author.bot) return false;
  if (!message.channel?.isTextBased?.()) return false;
  const mentionsBot = message.mentions.users.has(client.user.id);
  const trimmed = message.content.trimStart();
  const prefixHit = REMIND_MSG_PREFIX.length > 0 && trimmed.startsWith(REMIND_MSG_PREFIX);
  if (prefixHit) return true;
  if (mentionsBot && parseKoRemindContent(message.content)) return true;
  if (mentionsBot && getRemindCancelScope(message)) return true;
  return false;
}

function resolveRemindTargetUser(message, client) {
  const botId = client.user.id;
  const others = [...message.mentions.users.values()].filter((u) => u.id !== botId);
  if (others.length >= 1) return others[0];
  return message.author;
}

/**
 * @param {object} p
 * @param {string} [p.channelId]
 * @param {string} [p.guildId]
 * @param {string} [p.createdById]
 * @param {string} [p.targetUserId]
 * @param {number} [p.amount] `/remind` 와 함께 `unit`
 * @param {string} [p.unit]
 * @param {number} [p.delayMs] 채팅 파싱 합산 시 `labelKo`와 함께 사용
 * @param {string} [p.labelKo]
 * @param {string} [p.reasonKo] 알람 사유(미지정 시 전송 시 기본 문구)
 * @returns {Promise<{ ok: true, alarm: object, whenKo: string } | { ok: false, error: string }>}
 */
async function tryScheduleRemind(p) {
  let delayMs;
  let labelKo;
  if (p.delayMs != null && typeof p.labelKo === "string" && p.labelKo.trim()) {
    delayMs = Number(p.delayMs);
    labelKo = p.labelKo.trim();
    if (!Number.isFinite(delayMs)) {
      return { ok: false, error: "시간을 인식하지 못했어요." };
    }
  } else if (p.amount != null && p.unit != null) {
    const d = computeRemindDelayMs(p.amount, p.unit);
    if (d == null) {
      return { ok: false, error: "시간 단위를 인식하지 못했어요." };
    }
    delayMs = d;
    labelKo = formatRemindLabelKo(p.amount, p.unit);
  } else {
    return { ok: false, error: "시간을 인식하지 못했어요." };
  }
  if (delayMs < REMIND_MIN_MS) {
    return { ok: false, error: `최소 ${Math.ceil(REMIND_MIN_MS / 1000)}초 이상으로 설정해 주세요.` };
  }
  if (delayMs > REMIND_MAX_MS) {
    return {
      ok: false,
      error: `최대 ${Math.floor(REMIND_MAX_MS / (24 * 60 * 60 * 1000))}일 이내로만 예약할 수 있어요.`,
    };
  }
  const activeByUser = gAlarmState.alarms.filter((a) => a.createdById === p.createdById).length;
  if (activeByUser >= REMIND_MAX_PER_USER) {
    return {
      ok: false,
      error: `한 사람당 동시에 최대 ${REMIND_MAX_PER_USER}개까지만 예약할 수 있어요.`,
    };
  }
  const dueAt = Date.now() + delayMs;
  const reasonKo =
    p.reasonKo != null && String(p.reasonKo).trim() ? String(p.reasonKo).trim().slice(0, 500) : undefined;
  const alarm = {
    id: randomUUID(),
    channelId: p.channelId,
    guildId: p.guildId,
    targetUserId: p.targetUserId,
    createdById: p.createdById,
    dueAt,
    labelKo,
    ...(reasonKo ? { reasonKo } : {}),
  };
  gAlarmState.alarms.push(alarm);
  await persistAlarmState();
  scheduleRemindTimer(alarm);
  return { ok: true, alarm, whenKo: formatKo(new Date(dueAt)) };
}

/**
 * 본인(`createdById`)이 건 예약만 제거. `channel` = 이 채널만, `server` = 이 길드 전체.
 * @returns {Promise<{ removed: number }>}
 */
async function cancelRemindAlarmsForUser({ userId, channelId, guildId, scope }) {
  const keep = [];
  let removed = 0;
  for (const a of gAlarmState.alarms) {
    if (a.createdById !== userId) {
      keep.push(a);
      continue;
    }
    if (scope === "channel") {
      if (a.channelId !== channelId) {
        keep.push(a);
        continue;
      }
    } else if (scope === "server") {
      if (a.guildId !== guildId) {
        keep.push(a);
        continue;
      }
    } else {
      keep.push(a);
      continue;
    }
    clearRemindTimer(a.id);
    removed++;
  }
  gAlarmState.alarms = keep;
  await persistAlarmState();
  return { removed };
}

function clearRemindTimer(id) {
  const t = gAlarmTimers.get(id);
  if (t) clearTimeout(t);
  gAlarmTimers.delete(id);
}

/** Discord API: allowedMentions.users 에 동일 ID 중복 시 50035 */
function uniqueMentionUserIds(...ids) {
  return [...new Set(ids.map((x) => String(x ?? "").trim()).filter((s) => /^\d{5,30}$/.test(s)))];
}

/** @returns {Promise<boolean>} */
async function sendRemindAlarmMessage(alarm) {
  if (!gAlarmClient) {
    console.error("[알람] 내부 오류: 클라이언트 없음");
    return false;
  }
  try {
    let ch = await gAlarmClient.channels.fetch(alarm.channelId, { force: true }).catch(() => null);
    if ((!ch || !ch.isTextBased?.()) && alarm.guildId) {
      const guild = await gAlarmClient.guilds.fetch(alarm.guildId).catch(() => null);
      if (guild) {
        ch = await guild.channels.fetch(alarm.channelId, { force: true }).catch(() => null);
      }
    }
    if (!ch?.isTextBased?.()) {
      console.warn(`[알람] 채널을 열 수 없음(캐시/API): ${alarm.channelId} guild=${alarm.guildId ?? "?"}`);
      return false;
    }
    const me = ch.guild?.members?.me;
    if (me && ch.permissionsFor?.(me) && !ch.permissionsFor(me).has(PermissionFlagsBits.SendMessages)) {
      console.error(
        `[알람] 이 채널에 메시지 보내기 권한 없음: ${alarm.channelId} — 서버 설정에서 봇 역할에「메시지 보내기」허용`,
      );
      return false;
    }
    const label = typeof alarm.labelKo === "string" && alarm.labelKo ? alarm.labelKo : "알람";
    const memo =
      typeof alarm.reasonKo === "string" && alarm.reasonKo.trim() ? alarm.reasonKo.trim() : DEFAULT_REMIND_REASON;
    const lines = [
      "⏰ **알람 시간이에요**",
      `<@${alarm.targetUserId}>`,
      `_(${label} · 사유: ${memo} · 등록: <@${alarm.createdById}>)_`,
    ];
    await ch.send({
      content: lines.join("\n"),
      allowedMentions: { users: uniqueMentionUserIds(alarm.targetUserId, alarm.createdById) },
    });
    console.log(`[알람 발송] 채널=${alarm.channelId} 대상=${alarm.targetUserId} (${alarm.labelKo ?? ""})`);
    return true;
  } catch (e) {
    const code = e?.code ?? e?.status;
    console.error("[알람 전송 실패]", code != null ? `code=${code}` : "", e?.message ?? e);
    return false;
  }
}

async function fireRemindAlarm(alarmId) {
  clearRemindTimer(alarmId);
  const idx = gAlarmState.alarms.findIndex((a) => a.id === alarmId);
  if (idx < 0) return;
  const alarm = gAlarmState.alarms[idx];
  const ok = await sendRemindAlarmMessage(alarm);
  if (ok) {
    gAlarmState.alarms.splice(idx, 1);
    await persistAlarmState().catch((e) => console.error("[알람 저장]", e?.message ?? e));
    return;
  }
  const n = (alarm.remindRetryCount ?? 0) + 1;
  if (n > REMIND_SEND_MAX_RETRY) {
    gAlarmState.alarms.splice(idx, 1);
    await persistAlarmState().catch((e) => console.error("[알람 저장]", e?.message ?? e));
    console.error(
      `[알람] ${REMIND_SEND_MAX_RETRY}회 전송 실패로 예약 취소 (채널 권한·봇 역할 확인) ch=${alarm.channelId}`,
    );
    return;
  }
  alarm.remindRetryCount = n;
  alarm.dueAt = Date.now() + REMIND_SEND_RETRY_MS;
  gAlarmState.alarms[idx] = alarm;
  await persistAlarmState().catch((e) => console.error("[알람 저장]", e?.message ?? e));
  scheduleRemindTimer(alarm);
  console.warn(
    `[알람] 전송 실패 → ${Math.round(REMIND_SEND_RETRY_MS / 1000)}초 후 재시도 (${n}/${REMIND_SEND_MAX_RETRY}) ch=${alarm.channelId}`,
  );
}

function scheduleRemindTimer(alarm) {
  clearRemindTimer(alarm.id);
  const delay = Math.max(0, alarm.dueAt - Date.now());
  console.log(
    `[알람 예약] ${alarm.labelKo ?? "?"} ch=${alarm.channelId} id=${alarm.id} 약 ${(delay / 1000).toFixed(1)}s 후`,
  );
  const t = setTimeout(() => {
    fireRemindAlarm(alarm.id).catch((e) => console.error("[알람 타이머]", e?.message ?? e));
  }, delay);
  gAlarmTimers.set(alarm.id, t);
}

/** setTimeout 유실·크래시 복구용: 짧은 알람도 놓치지 않도록 주기적으로 스캔 */
async function runRemindOverdueSweep() {
  if (!gAlarmClient || gAlarmState.alarms.length === 0) return;
  const now = Date.now();
  const dueIds = gAlarmState.alarms.filter((a) => a.dueAt <= now).map((a) => a.id);
  for (const id of dueIds) {
    await fireRemindAlarm(id).catch((e) => console.error("[알람 스윕]", e?.message ?? e));
  }
}

async function initRemindSystem(client) {
  gAlarmClient = client;
  gAlarmState = await loadAlarmState();
  const now = Date.now();
  const overdue = gAlarmState.alarms.filter((a) => a.dueAt <= now);
  gAlarmState.alarms = gAlarmState.alarms.filter((a) => a.dueAt > now);
  await persistAlarmState().catch((e) => console.error("[알람 초기 저장]", e?.message ?? e));
  let overdueSent = 0;
  let overdueRetry = 0;
  for (const a of overdue) {
    const ok = await sendRemindAlarmMessage(a);
    if (ok) {
      overdueSent++;
    } else {
      a.remindRetryCount = (a.remindRetryCount ?? 0) + 1;
      a.dueAt = Date.now() + REMIND_SEND_RETRY_MS;
      gAlarmState.alarms.push(a);
      await persistAlarmState().catch((e) => console.error("[알람 저장]", e?.message ?? e));
      overdueRetry++;
    }
  }
  for (const a of gAlarmState.alarms) {
    scheduleRemindTimer(a);
  }
  if (overdueSent) {
    console.log(`[알람] 재시작 후 즉시 전송 ${overdueSent}건`);
  }
  if (overdueRetry) {
    console.warn(`[알람] 재시작 시 전송 실패 ${overdueRetry}건 → ${Math.round(REMIND_SEND_RETRY_MS / 1000)}초 후 재시도 예약`);
  }
}

async function handleRemindInteraction(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있어요.", ephemeral: true });
    return;
  }
  const ch = interaction.channel;
  if (!ch?.isTextBased?.()) {
    await interaction.reply({ content: "메시지를 보낼 수 있는 채널에서만 쓸 수 있어요.", ephemeral: true });
    return;
  }

  const amount = interaction.options.getInteger("amount", true);
  const unit = interaction.options.getString("unit", true);
  const target = interaction.options.getUser("user") ?? interaction.user;
  const reasonOpt = interaction.options.getString("reason");
  const reasonKo = reasonOpt?.trim() ? reasonOpt.trim().slice(0, 200) : undefined;

  const result = await tryScheduleRemind({
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    createdById: interaction.user.id,
    targetUserId: target.id,
    amount,
    unit,
    reasonKo,
  });
  if (!result.ok) {
    await interaction.reply({ content: `⏰ ${result.error}`, ephemeral: true });
    return;
  }
  const memoLine =
    result.alarm.reasonKo != null && String(result.alarm.reasonKo).trim()
      ? `· 사유: **${String(result.alarm.reasonKo).trim()}**`
      : `· 사유: **${DEFAULT_REMIND_REASON}** (기본)`;
  await interaction.reply({
    content: [
      `⏰ 알람을 등록했어요.`,
      `· 멘션: <@${target.id}>`,
      `· 시각: **${result.whenKo}** (${result.alarm.labelKo})`,
      memoLine,
      `_이 채널(<#${interaction.channelId}>)에 올라가요._`,
    ].join("\n"),
    ephemeral: true,
    allowedMentions: { users: [target.id] },
  });
}

async function handleRemindCancelInteraction(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있어요.", ephemeral: true });
    return;
  }
  const ch = interaction.channel;
  if (!ch?.isTextBased?.()) {
    await interaction.reply({ content: "메시지를 보낼 수 있는 채널에서만 쓸 수 있어요.", ephemeral: true });
    return;
  }
  const scope = (interaction.options.getString("scope") ?? "channel") === "server" ? "server" : "channel";
  const { removed } = await cancelRemindAlarmsForUser({
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    scope,
  });
  const scopeKo = scope === "server" ? "이 서버에서" : "이 채널에서";
  await interaction.reply({
    content:
      removed === 0
        ? `⏰ ${scopeKo} 취소할 **본인 예약 알람**이 없어요.`
        : `⏰ ${scopeKo} 예약 알람 **${removed}개**를 취소했어요.`,
    ephemeral: true,
  });
}

async function handleRemindMessageCreate(message, client) {
  if (!shouldHandleRemindChatMessage(message, client)) return;

  const cancelScope = getRemindCancelScope(message);
  if (cancelScope) {
    const { removed } = await cancelRemindAlarmsForUser({
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      scope: cancelScope,
    });
    const scopeKo = cancelScope === "server" ? "이 서버에서" : "이 채널에서";
    await message
      .reply({
        content:
          removed === 0
            ? `⏰ ${scopeKo} 취소할 **본인 예약 알람**이 없어요.`
            : `⏰ ${scopeKo} 예약 알람 **${removed}개**를 취소했어요.`,
        allowedMentions: { repliedUser: false },
      })
      .catch(() => {});
    return;
  }

  const { textForDelay, reasonKo: parsedReason } = extractRemindReasonAndBodyForDelay(message.content);
  const parsed = parseKoRemindContent(textForDelay);
  if (!parsed) {
    if (REMIND_MSG_PREFIX.length > 0 && message.content.trimStart().startsWith(REMIND_MSG_PREFIX)) {
      await message
        .reply({
          content:
            "⏰ 예: `알람 1시간 10분 10초 뒤`, `알람 30분 후`, `알람 10초` 또는 봇을 멘션하고 `10분 뒤에 알려줘` 처럼 적어 주세요.\n사유(선택): `사유: 길드`, `사유 : 보스`, 줄 끝 `(메모)`\n취소: `알람 해제`(이 채널), `알람 전부 해제`(이 서버), `@봇 해제`",
          allowedMentions: { repliedUser: false },
        })
        .catch(() => {});
    }
    return;
  }
  const target = resolveRemindTargetUser(message, client);
  const result = await tryScheduleRemind({
    channelId: message.channelId,
    guildId: message.guildId,
    createdById: message.author.id,
    targetUserId: target.id,
    delayMs: parsed.delayMs,
    labelKo: parsed.labelKo,
    reasonKo: parsedReason || undefined,
  });
  if (!result.ok) {
    await message
      .reply({ content: `⏰ ${result.error}`, allowedMentions: { repliedUser: false } })
      .catch(() => {});
    return;
  }
  const memoLine =
    result.alarm.reasonKo != null && String(result.alarm.reasonKo).trim()
      ? `· 사유: **${String(result.alarm.reasonKo).trim()}**`
      : `· 사유: **${DEFAULT_REMIND_REASON}** (기본)`;
  await message
    .reply({
      content: [
        "⏰ 알람을 등록했어요.",
        `· 멘션: <@${target.id}>`,
        `· 시각: **${result.whenKo}** (${result.alarm.labelKo})`,
        memoLine,
        "_이 채널에 올라가요._",
      ].join("\n"),
      allowedMentions: { users: [target.id], repliedUser: false },
    })
    .catch(() => {});
}

function stripDiscordMentionsForAtCommands(messageContent) {
  return String(messageContent ?? "")
    .replace(/<@!?(\d+)>/g, " ")
    .replace(/<@&(\d+)>/g, " ")
    .replace(/<#(\d+)>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 일반 사용자에게만 보이는 슬래시 안내(채팅 `@봇 명령어`·`/raid_notify help` 공통) */
function buildUserSlashHelpText() {
  const atBotChatNote = MESSAGE_CONTENT_INTENTS_ENABLED
    ? "봇이 **메시지 본문**을 읽을 수 있게 되어 있을 때만 동작해요."
    : "지금은 봇이 채팅 본문을 읽지 않아요. `REMIND_CHAT_ENABLED=1` 또는 `BOT_AT_COMMANDS_ENABLED=1` 일 때 켜져요.";
  const remindChatLine = REMIND_CHAT_ENABLED
    ? [
        "· `알람` 으로 시작하는 문장, 또는 **봇 멘션 뒤에** `10분 뒤`처럼 시간만 적기 — 이 채널에서 예약 알람(멘션).",
        "· **사유(선택):** `사유: …` / `사유 : …` / 줄 끝 `(메모)` — 없으면 전송 시 **알람**.",
        "· **취소:** `알람 해제`·`알람 취소`(이 채널), `알람 전부 해제`·`알람 모두 해제`(이 서버), `@봇 해제`·`@봇 취소`(이 채널).",
      ].join("\n")
    : null;

  const lines = [
    "📌 **누구나 쓸 수 있는 슬래시 명령** (채널 입력창에 `/` 를 눌러 검색해요)",
    "",
    "**레이드 알림** `/raid_notify`",
    "· `help` — 이 봇 안내(지금 보고 있는 목록과 비슷해요).",
    "· `test` — 실제 알림이 올라갈 채널로 테스트 글을 보내고, 실행한 사람에게 멘션해요.",
    "",
    "**내 가능 시간** `/raid_my_schedule`",
    "· 웹에 저장해 둔 슬롯을 금주·차주(레이드 주 14일)만 정리해서 보여줘요. 응답은 본인만 볼 수 있어요.",
    "",
    "**공대 겹침** `/raid_overlap`",
    "· 레이드 종류를 고르면, 웹에 등록한 **전원**이 겹치는 시간만 닉네임으로 보여줘요. 멘션은 없어요.",
    "",
    "**주사위** `/dice`",
    "· 1~100 무작위. 이 채널에 실행한 사람을 멘션해요.",
    "",
    "**슈상보** `/sugo_ping`",
    "· `register` / `unregister` — 이 텍스트 채널에서 슈고 상인 보호 알림(짝수 시 정각 **1분 전**)을 켜거나 끄기(본인만 가능).",
    "",
    "**파티 구인** `/party_recruit`",
    "· `create` — 이 채널에 모집 글을 올려요(파티장=실행자, 최대 8인). 버튼으로 출발·해체·가입·탈퇴.",
    "· `kick` — 파티장이 열린 파티에서 멤버를 추방해요.",
    "",
    "**알람** `/remind`",
    "· 숫자 + `초`/`분`/`시간` + `user`(선택) + `reason`(선택) — 예약 시각에 이 채널에서 멘션. 비우면 본인에게만. 사유 없으면 전송 시 **알람**.",
    "**알람 취소** `/remind_cancel`",
    "· `scope` — 이 채널만 / 이 서버 전체(본인이 건 예약만).",
    "",
    "**채팅으로 봇 멘션 (`@` …)**",
    "_같은 줄에서 **봇을 멘션한 뒤** 아래 단어를 **이어서** 쓰면 돼요._",
    "· `구버지` — 구마유시·위닝 멘탈리티 한마디.",
    "· `명령어` 또는 `도움말` — 위에 적은 **일반 슬래시 명령**만 다시 정리해서 보여줘요.",
    remindChatLine,
    `_${atBotChatNote}_`,
  ].filter(Boolean);
  return lines.join("\n");
}

const ADMIN_SLASH_HELP_APPEND = [
  "",
  "────────────",
  "🔐 **서버 관리자 전용** (해당 슬래시를 실제로 입력했을 때만 이 블록이 함께 보여요)",
  "",
  "**알림 채널 DB** `/raid_notify`",
  "· `set` — 레이드 종류별로 알림 채널을 DB에 저장해요.",
  "· `status` — DB에 저장된 채널 ID를 요약해 보여줘요.",
  "· `clear` — DB 값을 지우고 `.env` 기본값으로 되돌려요.",
  "· `timings` — **지금 봇이 쓰는** 알림 시각·간격(당일 몇 시, 30분 전, 확정 직후, 폴링). 봇을 돌리는 PC의 `.env` 기준이에요.",
  "",
  "**슈상보** `/sugo_ping`",
  "· `list` — 이 서버에 슈상보를 등록한 사람 목록.",
].join("\n");

/** 관리자 전용: 봇 프로세스의 .env 기준 알림 시각 안내 */
function buildNotifyTimingsHelpText() {
  const tz = process.env.TZ ?? "(기본 시스템)";
  const rt = process.env.REMIND_TZ;
  const tzLine = rt ? `· **타임존:** \`TZ\`=\`${tz}\` · \`REMIND_TZ\`=\`${rt}\` (시작 시 적용)` : `· **타임존:** \`TZ\`=\`${tz}\``;
  const hh = String(REMIND_DAY_HOUR).padStart(2, "0");
  const pollSec = Math.round(POLL_MS / 1000);
  const confirmMin = Math.round(CONFIRM_NOTIFY_MAX_AGE_MS / 60_000);
  return [
    "🕐 **레이드 알림 · 지금 이 봇이 쓰는 시각**",
    "_봇을 실행한 머신의 `.env` 기준이에요. 디스코드 서버마다 다르지 않아요._",
    "",
    tzLine,
    `· **당일 알림:** 출발 **당일** 로컬 **${hh}:00** (\`REMIND_DAY_HOUR\`) — 출발 시각이 이 시각보다 **이르면** 당일 알림은 **보내지 않아요.**`,
    "· **출발 30분 전 알림:** 출발 시각 **정확히 30분 전** (코드 고정).",
    `· **웹에서 일정 확정 직후 알림:** 확정 후 **최대 약 ${pollSec}초 안**에 전송 시도, 확정 시각이 **${confirmMin}분보다 오래되면** 생략 (\`CONFIRM_NOTIFY_MAX_AGE_MS\`).`,
    `· **DB 확인(폴링):** **${pollSec}초**마다 (\`POLL_INTERVAL_MS\`=${POLL_MS}).`,
    "· **슈상보:** 짝수 시 로컬 **xx:59 ~ 정각(00초) 직전** 사이에 1회 (06·07·08시 제외, 폴링 시점에 전송).",
    "",
    "_변경 후에는 봇 프로세스를 다시 켜야 반영돼요._",
  ].join("\n");
}

function buildGubujiWinningMentalitySpeech() {
  return [
    "📘 **구마유시 × 위닝 멘탈리티** — 구버지의 한마디",
    "",
    "_바깥 소음 대신, 안쪽 나침반을 돌려 보자._ **위닝 멘탈리티**는 이기는 것만이 아니라 **다시 설 수 있는 태도**야.",
    "",
    "**다섯 가지 주제, 전부 읊어 줄게요.**",
    "",
    "**1.** 자기 객관화의 기술: 중심을 내면에 두는 법 — 거울을 바깥이 아니라 마음 안쪽에 두고, 나를 한 발 떨어져 바라보기.",
    "",
    "**2.** 실패를 성장의 발판으로 만드는 법 — 넘어진 자리에서만 보이는 디테일을 주워 담고, 다음 스텝의 발판으로 쓰기.",
    "",
    "**3.** 슬럼프 관리와 극복 전략 — 숨 고르기, 루틴, 작은 승리로 호흡을 되찾고 슬럼프를 지나가기.",
    "",
    "**4.** 목표 달성을 넘어선 삶의 가치 발견하기 — 트로피 뒤에 숨은 **왜 이 길을 걷는지**를 한 번 더 묻기.",
    "",
    "**5.** 지속 가능한 성장을 위한 루틴 만들기 — 불꽃만 쫓지 말고, 매일 돌아올 수 있는 리듬을 짜기.",
    "",
    "_구버지는 여기까지. 다음 라인에서 만나요! ✨_",
  ].join("\n");
}

/**
 * 봇 멘션 + `구버지` / `명령어` / `도움말`
 * @returns {Promise<boolean>} 처리했으면 true (알람 채팅과 중복 방지)
 */
async function handleBotAtCommands(message, client) {
  if (!message.guild || message.author.bot) return false;
  if (!message.channel?.isTextBased?.()) return false;
  if (!message.mentions.users.has(client.user.id)) return false;

  const body = stripDiscordMentionsForAtCommands(message.content);
  if (!body) return false;

  if (body.includes("구버지")) {
    await message
      .reply({ content: buildGubujiWinningMentalitySpeech(), allowedMentions: { parse: [] } })
      .catch(() => {});
    return true;
  }
  if (body.includes("명령어") || body.includes("도움말")) {
    await message
      .reply({ content: buildUserSlashHelpText(), allowedMentions: { parse: [] } })
      .catch(() => {});
    return true;
  }
  return false;
}

const RAID_TYPES = ["rudra", "bagot", "lostark"];

/** null 이면 rudra·bagot·lostark 전부. 아니면 Set 에 포함된 타입만 */
function buildRaidAllowed(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const set = new Set(
    t
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => RAID_TYPES.includes(s)),
  );
  if (set.size === 0) {
    console.warn(
      "[경고] REMINDER_RAID_TYPE 에 유효한 값(rudra, bagot, lostark)이 없어 **전체 타입**으로 동작합니다.",
    );
    return null;
  }
  return set;
}

const RAID_ALLOWED = buildRaidAllowed(process.env.REMINDER_RAID_TYPE);
const warnedBadChannelIds = new Set();

/** 슈상보: 짝수 시 **로컬 xx:59 ~ 정각(00:00) 직전** 구간에 1회 알림. 오전 6~8시(6·7·8시) 제외 → 0,2,4,10,…,22 */
const SUGO_MERCHANT_HOURS = new Set([0, 2, 4, 10, 12, 14, 16, 18, 20, 22]);

/** 짝수 시 정각 기준 전송 구간 [startMs, endMs): 23:59~24:00 또는 (h-1):59~h:00 */
function sugoMerchantWindowBoundsLocal(eventH, d) {
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day = d.getDate();
  if (eventH === 0) {
    const startMs = new Date(y, mo, day, 23, 59, 0, 0).getTime();
    const endMs = new Date(y, mo, day + 1, 0, 0, 0, 0).getTime();
    const dayOfEvent = new Date(y, mo, day + 1);
    const dk = dateKeyLocalFromDate(dayOfEvent);
    return { startMs, endMs, dk };
  }
  const startMs = new Date(y, mo, day, eventH - 1, 59, 0, 0).getTime();
  const endMs = new Date(y, mo, day, eventH, 0, 0, 0).getTime();
  const dk = dateKeyLocalFromDate(d);
  return { startMs, endMs, dk };
}

const PARTY_MAX_TOTAL = 8;
const PARTY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEnv(name, v) {
  if (!v) {
    console.error(`[오류] 환경 변수 ${name} 가 비어 있습니다. .env.example 을 참고해 .env 를 채우세요.`);
    process.exit(1);
  }
}

async function fetchReminderChannelConfig(supabase) {
  const { data, error } = await supabase
    .from("discord_reminder_channel_config")
    .select("*")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

function effectiveDefaultChannelId(cfg) {
  const db = cfg?.default_channel_id?.trim();
  return db || CHANNEL_ID;
}

/** DB(슬래시 명령) > 환경 변수 DISCORD_CHANNEL_ID_* > DB 기본 또는 .env 기본 */
function channelIdForRaidType(raidType, cfg) {
  const u = String(raidType || "").toUpperCase();
  const rt = String(raidType || "").toLowerCase();
  const dbSpecific =
    rt === "rudra"
      ? cfg?.rudra_channel_id
      : rt === "bagot"
        ? cfg?.bagot_channel_id
        : rt === "lostark"
          ? cfg?.lostark_channel_id
          : null;
  if (dbSpecific?.trim()) return dbSpecific.trim();
  const envSpecific = (process.env[`DISCORD_CHANNEL_ID_${u}`] ?? "").trim();
  if (envSpecific) return envSpecific;
  return effectiveDefaultChannelId(cfg);
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

/** 로컬 자정 기준으로 출발일과 오늘의 일 차이 (0=오늘, 1=내일, 음수=과거) */
function localCalendarDaysFromToday(date) {
  const t = new Date();
  const a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

const RAID_TYPE_LABEL_KO = {
  rudra: "루드라",
  bagot: "바고트",
  lostark: "로스트아크",
};

const RAID_TYPE_EMOJI = {
  rudra: "⚔️",
  bagot: "🛡️",
  lostark: "✨",
};

function parseSlotKeyStr(key) {
  const m = String(key).match(/^(\d{4}-\d{2}-\d{2})@(\d{4})$/);
  if (!m) return null;
  return { day: m[1], minutes: Number(m[2]) };
}

function formatMinuteLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** 웹 `slots.ts` 와 동일: 이번 레이드 주 시작 = 가장 최근 수요일 00:00(로컬) */
function startOfRaidWeekWednesday(ref) {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const offset = (dow - 3 + 7) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

function dateKeyLocalFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 금주·차주 각 7일, 총 14일 메타(표시 제목 + date 키) */
function buildRaidFortnightDayMetas(ref) {
  const start = startOfRaidWeekWednesday(ref);
  const out = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const w = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
    out.push({
      dateKey: dateKeyLocalFromDate(date),
      lineTitle: `${date.getMonth() + 1}/${date.getDate()} (${w})`,
    });
  }
  return out;
}

function allowedDateKeySetFortnight(ref) {
  return new Set(buildRaidFortnightDayMetas(ref).map((x) => x.dateKey));
}

function filterSlotKeysToFortnight(slotKeys, ref) {
  const allowed = allowedDateKeySetFortnight(ref);
  return slotKeys.filter((k) => {
    const p = parseSlotKeyStr(k);
    return p && allowed.has(p.day);
  });
}

/** 같은 날짜의 슬롯 시작 분(정렬·중복 제거 후)을 연속 30분 구간으로 병합 → [startMin, endMin) */
function mergeAdjacentHalfHourRanges(sortedUniqueMinutes) {
  if (sortedUniqueMinutes.length === 0) return [];
  const runs = [];
  let cs = sortedUniqueMinutes[0];
  let ce = cs + 30;
  for (let i = 1; i < sortedUniqueMinutes.length; i++) {
    const m = sortedUniqueMinutes[i];
    if (m === ce) {
      ce = m + 30;
    } else {
      runs.push([cs, ce]);
      cs = m;
      ce = m + 30;
    }
  }
  runs.push([cs, ce]);
  return runs;
}

/** 금주·차주만, 날짜별 헤더 + 연속 구간 줄 */
function formatFortnightSlotsGrouped(slotKeys, ref) {
  const filtered = filterSlotKeysToFortnight(slotKeys, ref);
  if (filtered.length === 0) return { lines: [], hadKeysOutside: slotKeys.length > 0 };

  const byDay = new Map();
  for (const sk of filtered) {
    const p = parseSlotKeyStr(sk);
    if (!p || !Number.isFinite(p.minutes)) continue;
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push(p.minutes);
  }

  const lines = [];
  for (const { dateKey, lineTitle } of buildRaidFortnightDayMetas(ref)) {
    if (!byDay.has(dateKey)) continue;
    const mins = [...new Set(byDay.get(dateKey))].sort((a, b) => a - b);
    const ranges = mergeAdjacentHalfHourRanges(mins);
    lines.push(`**${lineTitle}**`);
    for (const [a, b] of ranges) {
      lines.push(`· ${formatMinuteLabel(a)}–${formatMinuteLabel(b)}`);
    }
  }

  return { lines, hadKeysOutside: false };
}

/** Discord 본문 상한(여유) 기준으로 줄 단위 분할 */
function chunkLines(lines, maxLen = 1900) {
  const chunks = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const line of lines) {
    const piece = buf ? `${buf}\n${line}` : line;
    if (piece.length <= maxLen) {
      buf = piece;
    } else {
      flush();
      if (line.length <= maxLen) buf = line;
      else {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
      }
    }
  }
  flush();
  return chunks.length ? chunks : [""];
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

/** 틱당 1회 쿼리로 끝내기: (raid_type|slot_key) → discord_id[] */
function buildRaidParticipantIndex(rows) {
  const m = new Map();
  for (const row of rows ?? []) {
    const rt = row.raid_type;
    if (!rt) continue;
    const slots = row.slots;
    if (!Array.isArray(slots)) continue;
    const id = row.discord_id;
    if (!id || !/^\d{5,30}$/.test(String(id))) continue;
    const sid = String(id);
    for (const sk of slots) {
      const key = `${rt}|${sk}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(sid);
    }
  }
  return m;
}

function participantsFromIndex(index, raidType, slotKey) {
  return index.get(`${raidType}|${slotKey}`) ?? [];
}

/**
 * 알림 전송 기록이 무한히 쌓이지 않게 정리.
 * - 레이드: slot_key 날짜가 STATE_PRUNE_RAID_DAYS 일 이전이면 삭제
 * - 슈상보: sugo|…|yyyy-mm-dd|h 가 STATE_PRUNE_SUGO_DAYS 일 이전이면 삭제
 */
function pruneReminderState(state) {
  const now = Date.now();
  const raidCut = now - STATE_PRUNE_RAID_DAYS * 24 * 60 * 60 * 1000;
  const sugoCut = now - STATE_PRUNE_SUGO_DAYS * 24 * 60 * 60 * 1000;
  const out = { ...state };
  let removed = 0;
  for (const key of Object.keys(out)) {
    if (key.startsWith("sugo|")) {
      const parts = key.split("|");
      if (parts.length >= 4) {
        const day = parts[2]?.slice(0, 10);
        const t0 = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + "T12:00:00").getTime() : NaN;
        if (Number.isFinite(t0) && t0 < sugoCut) {
          delete out[key];
          removed++;
        }
      }
      continue;
    }
    if (key.startsWith("confirmSent|")) {
      const parts = key.split("|");
      if (parts.length >= 4) {
        const slotKey = parts[3];
        const dt = slotKeyToLocalDate(slotKey);
        if (dt && dt.getTime() < raidCut) {
          delete out[key];
          removed++;
        }
      }
      continue;
    }
    const lastColon = key.lastIndexOf(":");
    if (lastColon <= 0) continue;
    const kind = key.slice(lastColon + 1);
    if (kind !== "d30" && kind !== "dDay") continue;
    const base = key.slice(0, lastColon);
    const segs = base.split("|");
    if (segs.length < 3) continue;
    const slotKey = segs[2];
    const dt = slotKeyToLocalDate(slotKey);
    if (dt && dt.getTime() < raidCut) {
      delete out[key];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[상태] 오래된 전송 기록 키 ${removed}개 제거 (raid≥${STATE_PRUNE_RAID_DAYS}일, sugo≥${STATE_PRUNE_SUGO_DAYS}일)`);
  }
  return out;
}

const TARGET_CHOICES = [
  { name: "전체 기본", value: "default" },
  { name: "루드라", value: "rudra" },
  { name: "바고트", value: "bagot" },
  { name: "로스트아크", value: "lostark" },
];

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("raid_notify")
      .setDescription("출발 알림이 올라갈 디스코드 채널을 지정합니다")
      .addSubcommand((sc) =>
        sc
          .setName("set")
          .setDescription("채널 저장 (서버 관리 권한 필요)")
          .addStringOption((o) =>
            o
              .setName("target")
              .setDescription("어떤 레이드 알림에 쓸 채널인지")
              .setRequired(true)
              .addChoices(...TARGET_CHOICES),
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("텍스트 채널")
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((sc) =>
        sc
          .setName("test")
          .setDescription("알림 채널로 테스트 전송 (실행한 사람에게 멘션)")
          .addStringOption((o) =>
            o
              .setName("raid_route")
              .setDescription("어느 경로로 채널 ID를 고를지")
              .setRequired(false)
              .addChoices(
                { name: "기본 채널만(DB·env)", value: "default" },
                { name: "루드라 라우팅", value: "rudra" },
                { name: "바고트 라우팅", value: "bagot" },
                { name: "로스트아크 라우팅", value: "lostark" },
              ),
          ),
      )
      .addSubcommand((sc) =>
        sc
          .setName("status")
          .setDescription("지금 저장된 채널(DB) 보기")
          .addStringOption((o) =>
            o
              .setName("target")
              .setDescription("비우면 전체 요약")
              .setRequired(false)
              .addChoices(...TARGET_CHOICES),
          ),
      )
      .addSubcommand((sc) =>
        sc
          .setName("clear")
          .setDescription("DB에 저장된 값 지우기(.env 로 되돌림)")
          .addStringOption((o) =>
            o
              .setName("target")
              .setDescription("지울 항목")
              .setRequired(true)
              .addChoices(...TARGET_CHOICES, { name: "전부", value: "all" }),
          ),
      )
      .addSubcommand((sc) =>
        sc
          .setName("timings")
          .setDescription("알림 시각·간격 (서버 관리 전용 · 봇 실행 PC의 .env 기준)"),
      )
      .addSubcommand((sc) => sc.setName("help").setDescription("이 봇 슬래시 명령 안내 (누구나)"))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("raid_my_schedule")
      .setDescription("웹에 저장한 내 레이드 가능 시간(슬롯)을 조회합니다")
      .addStringOption((o) =>
        o
          .setName("raid_type")
          .setDescription("필터 (비우면 전체)")
          .setRequired(false)
          .addChoices(
            { name: "전체", value: "all" },
            { name: "루드라", value: "rudra" },
            { name: "바고트", value: "bagot" },
            { name: "로스트아크", value: "lostark" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("raid_overlap")
      .setDescription("웹 등록 전원 기준 겹치는 슬롯 (금주·차주, 멘션 없음)")
      .addStringOption((o) =>
        o
          .setName("raid_type")
          .setDescription("레이드 종류")
          .setRequired(true)
          .addChoices(
            { name: "루드라", value: "rudra" },
            { name: "바고트", value: "bagot" },
            { name: "로스트아크", value: "lostark" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder().setName("dice").setDescription("1~100 랜덤 주사위 (이 채널에 멘션)").toJSON(),
    new SlashCommandBuilder()
      .setName("sugo_ping")
      .setDescription("슈고 상인 보호(슈상보) 짝수 시 xx:59~정각 직전 알림")
      .addSubcommand((sc) =>
        sc.setName("register").setDescription("이 텍스트 채널에서 슈상보 알림 받기 (본인만)"),
      )
      .addSubcommand((sc) => sc.setName("unregister").setDescription("슈상보 알림 해제 (본인만)"))
      .addSubcommand((sc) =>
        sc.setName("list").setDescription("이 서버 등록자 목록 (서버 관리 전용)"),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("party_recruit")
      .setDescription("파티 구인 (최대 8인 · 실행자가 파티장)")
      .addSubcommand((sc) =>
        sc.setName("create").setDescription("이 채널에 파티 모집 메시지 올리기"),
      )
      .addSubcommand((sc) =>
        sc
          .setName("kick")
          .setDescription("파티원 추방 (파티장 전용 · 열린 파티 1개 기준)")
          .addUserOption((o) =>
            o.setName("target").setDescription("추방할 멤버").setRequired(true),
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("remind")
      .setDescription("일정 시간 뒤 이 채널에서 멘션 알림 (기본: 본인)")
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("숫자 (예: 10)").setRequired(true).setMinValue(1).setMaxValue(9999),
      )
      .addStringOption((o) =>
        o
          .setName("unit")
          .setDescription("단위")
          .setRequired(true)
          .addChoices(
            { name: "초", value: "seconds" },
            { name: "분", value: "minutes" },
            { name: "시간", value: "hours" },
          ),
      )
      .addUserOption((o) => o.setName("user").setDescription("멘션할 사람 (비우면 본인)").setRequired(false))
      .addStringOption((o) =>
        o.setName("reason").setDescription("사유 (선택 · 비우면 기본)").setRequired(false).setMaxLength(200),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("remind_cancel")
      .setDescription("본인이 건 예약 알람 취소 (이 채널 또는 이 서버)")
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("취소 범위")
          .setRequired(false)
          .addChoices(
            { name: "이 채널만", value: "channel" },
            { name: "이 서버 전체", value: "server" },
          ),
      )
      .toJSON(),
  ];
}

function intersectSlotKeyArrays(slotArrays) {
  if (slotArrays.length === 0) return [];
  let acc = new Set(slotArrays[0]);
  for (let i = 1; i < slotArrays.length; i++) {
    const next = new Set(slotArrays[i]);
    acc = new Set([...acc].filter((k) => next.has(k)));
  }
  return [...acc];
}

async function handleOverlapInteraction(supabase, interaction) {
  const raidType = interaction.options.getString("raid_type", true);

  const { data, error } = await supabase
    .from("raid_availability")
    .select("nickname, slots")
    .eq("raid_type", raidType);
  if (error) throw error;

  const rows = data ?? [];
  const nickOf = (r) => (typeof r.nickname === "string" && r.nickname.trim() ? r.nickname.trim() : "(닉 없음)");

  const withSlots = rows.filter((r) => Array.isArray(r.slots) && r.slots.length > 0);
  const emptySlots = rows.filter((r) => !Array.isArray(r.slots) || r.slots.length === 0);

  const rtLabel = RAID_TYPE_LABEL_KO[raidType] ?? raidType;
  const header = `**공대 겹치는 시간** · ${rtLabel} · 금주·차주(14일) · 웹 등록 **전원** 기준\n\n`;

  if (rows.length === 0) {
    await interaction.reply({
      content: header + "아직 이 레이드 타입으로 웹에 가능 시간을 저장한 분이 없어요.",
    });
    return;
  }

  let memberBlock = `**등록 ${rows.length}명** · 겹침 계산은 슬롯이 1개 이상인 분만 포함해요.\n`;
  memberBlock += `· 슬롯 있음 (${withSlots.length}명): ${withSlots.map(nickOf).join(", ")}\n`;
  if (emptySlots.length > 0) {
    memberBlock += `· 슬롯 없음 (${emptySlots.length}명): ${emptySlots.map(nickOf).join(", ")}\n`;
  }
  memberBlock += "\n";

  if (withSlots.length < 2) {
    const out = chunkLines([
      header + memberBlock,
      "겹침을 보려면 **슬롯을 넣은 사람이 2명 이상** 있어야 해요. 더 등록되면 다시 눌러 주세요.",
    ]);
    await interaction.reply({ content: out[0] });
    for (let i = 1; i < out.length; i++) await interaction.followUp({ content: out[i] });
    return;
  }

  const slotArrays = withSlots.map((r) => r.slots);
  const common = intersectSlotKeyArrays(slotArrays);
  const ref = new Date();
  const { lines: slotLines } = formatFortnightSlotsGrouped(common, ref);

  let body;
  if (slotLines.length === 0) {
    body =
      "이 기간에 **전원이 동시에 가능한** 30분 슬롯이 없어요…! 웹에서 가능 시간을 맞춰 볼까요? 🥺";
  } else {
    body = "**전원 겹침 시간**\n" + slotLines.join("\n");
  }

  const out = chunkLines([header + memberBlock + body]);
  await interaction.reply({ content: out[0] });
  for (let i = 1; i < out.length; i++) {
    await interaction.followUp({ content: out[i] });
  }
}

async function handleDiceInteraction(interaction) {
  const uid = interaction.user.id;
  const n = Math.floor(Math.random() * 100) + 1;
  const tails = [
    "오늘의 숫자야!",
    "행운을 빌어!",
    "이걸로 가보자~",
    "어때? 어때?",
    "두구두구…",
  ];
  const tail = tails[Math.floor(Math.random() * tails.length)];
  await interaction.reply({
    content: `🎲 ${tail} <@${uid}> 님, **${n}** (1~100) !`,
    allowedMentions: { users: [uid] },
  });
}

async function handleSugoPingInteraction(supabase, interaction) {
  const sub = interaction.options.getSubcommand(true);
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있어요.", ephemeral: true });
    return;
  }
  const gid = interaction.guildId;

  if (sub === "register") {
    const ch = interaction.channel;
    if (!ch?.isTextBased?.()) {
      await interaction.reply({ content: "메시지를 보낼 수 있는 채널(텍스트·스레드 등)에서만 등록할 수 있어요.", ephemeral: true });
      return;
    }
    const { error } = await supabase.from("discord_sugo_merchant_subscribers").upsert(
      {
        guild_id: gid,
        channel_id: interaction.channelId,
        discord_user_id: interaction.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "guild_id,discord_user_id" },
    );
    if (error) throw error;
    await interaction.reply({
      content: [
        "🛡️ **슈상보** 알림을 등록했어요. (본인만 가능)",
        `· 알림 채널: <#${interaction.channelId}>`,
        "· **짝수 시 xx:59 ~ 정각 직전**에 멘션 (로컬 **06·07·08시**는 제외)",
        "· 같은 서버에서 다시 등록하면 **지금 채널**로 바뀌어요.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (sub === "unregister") {
    const { error } = await supabase
      .from("discord_sugo_merchant_subscribers")
      .delete()
      .eq("guild_id", gid)
      .eq("discord_user_id", interaction.user.id);
    if (error) throw error;
    await interaction.reply({ content: "슈상보 알림을 해제했어요.", ephemeral: true });
    return;
  }

  if (sub === "list") {
    const canManage = interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
    if (!canManage) {
      await interaction.reply({ content: "이 서브명령은 **서버 관리(Manage Server)** 권한이 있어야 해요.", ephemeral: true });
      return;
    }
    const { data, error } = await supabase
      .from("discord_sugo_merchant_subscribers")
      .select("channel_id, discord_user_id, updated_at")
      .eq("guild_id", gid)
      .order("channel_id", { ascending: true });
    if (error) throw error;
    if (!data?.length) {
      await interaction.reply({ content: "이 서버에 슈상보를 등록한 사람이 아직 없어요.", ephemeral: true });
      return;
    }
    const byCh = new Map();
    for (const r of data) {
      const cid = String(r.channel_id ?? "");
      if (!byCh.has(cid)) byCh.set(cid, []);
      byCh.get(cid).push(r);
    }
    const lines = ["**슈상보 등록 현황** (이 서버)"];
    const allUserIds = [];
    for (const [cid, rows] of [...byCh.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push("");
      lines.push(`📍 <#${cid}>`);
      for (const r of rows) {
        allUserIds.push(String(r.discord_user_id));
        lines.push(`· <@${r.discord_user_id}> — 갱신 ${formatKo(new Date(r.updated_at))}`);
      }
    }
    const mentionUsers = [...new Set(allUserIds)].slice(0, 100);
    const chunks = chunkLines(lines);
    await interaction.reply({
      content: chunks[0],
      ephemeral: true,
      allowedMentions: { users: mentionUsers },
    });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({
        content: chunks[i],
        ephemeral: true,
        allowedMentions: { users: mentionUsers },
      });
    }
  }
}

function buildPartyEmbed(row) {
  const leader = String(row.leader_id ?? "");
  const members = Array.isArray(row.member_ids) ? row.member_ids.map(String) : [];
  const total = 1 + members.length;
  const statusLabel =
    row.status === "open"
      ? "🟢 모집 중"
      : row.status === "departed"
        ? "✅ 출발 완료 (가입·탈퇴 불가)"
        : "⛔ 파티 해체 (가입·탈퇴 불가)";
  const memberLine = members.length ? members.map((id) => `<@${id}>`).join(" ") : "_(없음)_";
  return new EmbedBuilder()
    .setTitle("🎮 파티 구인")
    .setColor(
      row.status === "open" ? 0x5865f2 : row.status === "departed" ? 0xfbbf24 : 0xed4245,
    )
    .addFields(
      { name: "파티장", value: `<@${leader}>`, inline: true },
      { name: "인원", value: `${total} / ${PARTY_MAX_TOTAL}`, inline: true },
      { name: "상태", value: statusLabel, inline: false },
      { name: "파티원", value: memberLine, inline: false },
    )
    .setFooter({ text: `파티장만 출발·해체·추방(kick) 가능 · ID ${row.id}` });
}

function buildPartyActionRow(partyId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`party:depart:${partyId}`)
      .setLabel("출발")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`party:disband:${partyId}`)
      .setLabel("파티해체")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`party:join:${partyId}`)
      .setLabel("파티가입")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`party:leave:${partyId}`)
      .setLabel("파티탈퇴")
      .setStyle(ButtonStyle.Primary),
  );
}

async function refreshPartyMessage(client, supabase, partyId) {
  const { data: row, error } = await supabase
    .from("discord_party_recruit")
    .select("*")
    .eq("id", partyId)
    .maybeSingle();
  if (error || !row) return;
  let ch;
  try {
    ch = await client.channels.fetch(row.channel_id);
  } catch {
    return;
  }
  if (!ch?.isTextBased?.()) return;
  let msg;
  try {
    msg = await ch.messages.fetch(row.message_id);
  } catch {
    return;
  }
  const embed = buildPartyEmbed(row);
  const components = row.status === "open" ? [buildPartyActionRow(row.id)] : [];
  await msg.edit({ embeds: [embed], components });
}

async function handlePartyRecruitCreate(client, supabase, interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있어요.", ephemeral: true });
    return;
  }
  const ch = interaction.channel;
  if (!ch?.isTextBased?.()) {
    await interaction.reply({ content: "메시지를 보낼 수 있는 채널에서만 올릴 수 있어요.", ephemeral: true });
    return;
  }
  const gid = interaction.guildId;
  const leaderId = interaction.user.id;

  const { data: existing, error: exErr } = await supabase
    .from("discord_party_recruit")
    .select("id")
    .eq("guild_id", gid)
    .eq("leader_id", leaderId)
    .eq("status", "open")
    .maybeSingle();
  if (exErr) throw exErr;
  if (existing) {
    await interaction.reply({
      content: "이 서버에 **이미 열린 파티**가 있어요. 먼저 **출발** 또는 **파티해체** 후 다시 만들어 주세요.",
      ephemeral: true,
    });
    return;
  }

  const partyId = randomUUID();
  const tempRow = {
    id: partyId,
    leader_id: leaderId,
    member_ids: [],
    status: "open",
  };
  await interaction.reply({
    embeds: [buildPartyEmbed(tempRow)],
    components: [buildPartyActionRow(partyId)],
  });
  const msg = await interaction.fetchReply();
  const { error } = await supabase.from("discord_party_recruit").insert({
    id: partyId,
    guild_id: gid,
    channel_id: interaction.channelId,
    message_id: msg.id,
    leader_id: leaderId,
    member_ids: [],
    status: "open",
  });
  if (error) {
    await msg.delete().catch(() => {});
    await interaction.followUp({
      content: "파티를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
      ephemeral: true,
    });
    return;
  }
}

async function handlePartyRecruitKick(client, supabase, interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있어요.", ephemeral: true });
    return;
  }
  const target = interaction.options.getUser("target", true);
  const gid = interaction.guildId;
  const leaderId = interaction.user.id;

  const { data: row, error: fe } = await supabase
    .from("discord_party_recruit")
    .select("*")
    .eq("guild_id", gid)
    .eq("leader_id", leaderId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fe) throw fe;
  if (!row) {
    await interaction.reply({
      content: "열린 파티가 없거나 파티장이 아니에요.",
      ephemeral: true,
    });
    return;
  }
  if (target.id === row.leader_id) {
    await interaction.reply({ content: "파티장은 추방할 수 없어요.", ephemeral: true });
    return;
  }
  const members = Array.isArray(row.member_ids) ? [...row.member_ids] : [];
  if (!members.includes(target.id)) {
    await interaction.reply({ content: "그 유저는 이 파티 멤버가 아니에요.", ephemeral: true });
    return;
  }
  const next = members.filter((id) => id !== target.id);
  const { error: ue } = await supabase
    .from("discord_party_recruit")
    .update({ member_ids: next, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (ue) throw ue;
  await refreshPartyMessage(client, supabase, row.id);
  await interaction.reply({
    content: `${target} 님을 파티에서 내보냈어요.`,
    ephemeral: true,
  });
}

async function handlePartyRecruitInteraction(client, supabase, interaction) {
  const sub = interaction.options.getSubcommand(true);
  if (sub === "create") {
    await handlePartyRecruitCreate(client, supabase, interaction);
    return;
  }
  if (sub === "kick") {
    await handlePartyRecruitKick(client, supabase, interaction);
    return;
  }
}

async function handlePartyButtonInteraction(client, supabase, interaction) {
  if (!interaction.isButton()) return;
  const id = interaction.customId ?? "";
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "party") return;
  const kind = parts[1];
  const partyId = parts[2];
  if (!PARTY_UUID_RE.test(partyId)) return;

  const { data: row, error } = await supabase
    .from("discord_party_recruit")
    .select("*")
    .eq("id", partyId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    await interaction.reply({ content: "파티를 찾을 수 없어요.", ephemeral: true }).catch(() => {});
    return;
  }

  const uid = interaction.user.id;
  const leaderId = String(row.leader_id ?? "");
  const open = row.status === "open";

  const ephemeralError = async (msg) => {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  };

  if (!open) {
    await ephemeralError("이미 **출발**했거나 **해체**된 파티예요.");
    return;
  }

  if (kind === "depart" || kind === "disband") {
    if (uid !== leaderId) {
      await ephemeralError("파티장만 사용할 수 있어요.");
      return;
    }
    await interaction.deferUpdate();
    const nextStatus = kind === "depart" ? "departed" : "disbanded";
    const { error: ue } = await supabase
      .from("discord_party_recruit")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", partyId)
      .eq("status", "open");
    if (ue) throw ue;
    await refreshPartyMessage(client, supabase, partyId);

    if (kind === "depart") {
      const members = Array.isArray(row.member_ids) ? row.member_ids.map(String) : [];
      const allIds = [...new Set([leaderId, ...members])].slice(0, 100);
      const ch2 = interaction.channel;
      if (ch2?.isTextBased?.()) {
        await ch2.send({
          content: `🚀 **출발합니다!** ${allIds.map((x) => `<@${x}>`).join(" ")}`,
          allowedMentions: { users: allIds },
        });
      }
    }
    return;
  }

  if (kind === "join") {
    if (uid === leaderId) {
      await ephemeralError("파티장은 **파티가입**이 필요 없어요.");
      return;
    }
    const members = Array.isArray(row.member_ids) ? [...row.member_ids].map(String) : [];
    if (members.includes(uid)) {
      await ephemeralError("이미 이 파티에 참가 중이에요.");
      return;
    }
    if (1 + members.length >= PARTY_MAX_TOTAL) {
      await ephemeralError(`파티가 가득 찼어요 (${PARTY_MAX_TOTAL}/${PARTY_MAX_TOTAL}).`);
      return;
    }
    members.push(uid);
    await interaction.deferUpdate();
    const { error: je } = await supabase
      .from("discord_party_recruit")
      .update({ member_ids: members, updated_at: new Date().toISOString() })
      .eq("id", partyId)
      .eq("status", "open");
    if (je) throw je;
    await refreshPartyMessage(client, supabase, partyId);
    return;
  }

  if (kind === "leave") {
    if (uid === leaderId) {
      await ephemeralError("파티장은 여기서 탈퇴할 수 없어요. **파티해체**를 이용해 주세요.");
      return;
    }
    const members = Array.isArray(row.member_ids) ? [...row.member_ids].map(String) : [];
    if (!members.includes(uid)) {
      await ephemeralError("이 파티에 등록되어 있지 않아요.");
      return;
    }
    const next = members.filter((x) => x !== uid);
    await interaction.deferUpdate();
    const { error: le } = await supabase
      .from("discord_party_recruit")
      .update({ member_ids: next, updated_at: new Date().toISOString() })
      .eq("id", partyId)
      .eq("status", "open");
    if (le) throw le;
    await refreshPartyMessage(client, supabase, partyId);
    return;
  }
}

async function handleMyScheduleInteraction(supabase, interaction) {
  const uid = interaction.user.id;
  const filter = (interaction.options.getString("raid_type") ?? "all").trim().toLowerCase();

  let q = supabase
    .from("raid_availability")
    .select("raid_type, nickname, slots, updated_at")
    .eq("discord_id", uid);

  if (filter && filter !== "all") {
    if (!RAID_TYPES.includes(filter)) {
      await interaction.reply({ content: "raid_type 값이 올바르지 않습니다.", ephemeral: true });
      return;
    }
    q = q.eq("raid_type", filter);
  }

  const { data, error } = await q;
  if (error) throw error;

  if (!data?.length) {
    await interaction.reply({
      content:
        "이 Discord 계정으로 저장된 **가능 시간**이 없습니다.\n웹에서 Discord로 로그인한 뒤 **가능 시간 저장**을 하면 여기에 표시됩니다. (저장 시 Discord ID가 연동되어 있어야 합니다.)",
      ephemeral: true,
    });
    return;
  }

  const ref = new Date();
  const rows = [...data].sort((a, b) => String(a.raid_type).localeCompare(String(b.raid_type)));
  const lines = [
    "**내 등록 가능 시간** · 금주·차주(수~화 기준 14일)만, 연속 30분은 한 구간으로 묶음",
    "",
  ];
  for (const row of rows) {
    const label = RAID_TYPE_LABEL_KO[row.raid_type] ?? row.raid_type;
    const slots = Array.isArray(row.slots) ? row.slots : [];
    lines.push(`**[${label}]** 닉네임: ${row.nickname ?? "(없음)"}`);
    if (slots.length === 0) {
      lines.push("· (슬롯 없음)");
    } else {
      const { lines: slotLines, hadKeysOutside } = formatFortnightSlotsGrouped(slots, ref);
      if (slotLines.length === 0) {
        lines.push(
          "· 금주·차주 안에 해당하는 슬롯이 없습니다." +
            (hadKeysOutside ? " (다른 주에만 저장된 슬롯이 있을 수 있습니다.)" : ""),
        );
      } else {
        for (const L of slotLines) lines.push(L);
      }
    }
    const updated = row.updated_at ? formatKo(new Date(row.updated_at)) : "";
    if (updated) lines.push(`_갱신: ${updated}_`);
    lines.push("");
  }

  const chunks = chunkLines(lines);
  await interaction.reply({ content: chunks[0], ephemeral: true });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], ephemeral: true });
  }
}

/** 봇이 들어가 있는 **각 디스코드 서버**에 길드 전용 슬래시 명령 등록 */
async function registerSlashCommandsOnAllGuilds(client) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const appId = client.application?.id;
  if (!appId) {
    console.warn("[Discord] application id 없음 — 슬래시 명령 등록 생략");
    return;
  }
  const body = buildSlashCommands();
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    console.warn(
      "[Discord] 참가 중인 서버가 없어 **글로벌** 슬래시로 등록합니다. (봇을 서버에 초대한 뒤 재시작하면 길드별로 다시 등록됩니다.)",
    );
    await rest.put(Routes.applicationCommands(appId), { body });
    return;
  }
  for (const g of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, g.id), { body });
      console.log(
        `[Discord] 슬래시 등록 (…·sugo_ping·party_recruit·remind): ${g.name} (${g.id})`,
      );
    } catch (e) {
      console.error(`[Discord] 슬래시 등록 실패 (${g.name} / ${g.id}):`, e?.rawError?.message ?? e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function registerSlashCommandsForGuild(client, guildId, guildName = "") {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const appId = client.application?.id;
  if (!appId) return;
  const body = buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
  console.log(
    `[Discord] 슬래시 등록 (신규 서버 · …·sugo_ping): ${guildName || guildId} (${guildId})`,
  );
}

function baseConfigRow(existing) {
  return {
    id: "default",
    default_channel_id: existing?.default_channel_id ?? null,
    rudra_channel_id: existing?.rudra_channel_id ?? null,
    bagot_channel_id: existing?.bagot_channel_id ?? null,
    lostark_channel_id: existing?.lostark_channel_id ?? null,
    updated_at: new Date().toISOString(),
  };
}

function formatCh(id) {
  if (!id?.trim()) return "(미설정 → .env 또는 상위 기본)";
  return `<#${id.trim()}>`;
}

async function handleRaidNotifyInteraction(supabase, interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "help") {
    const isAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
    let content = buildUserSlashHelpText();
    content += [
      "",
      "",
      "**채널이 정해지는 순서** (앞이 우선): DB 타입별 → `.env` 의 `DISCORD_CHANNEL_ID_RUDRA` 등 → DB 기본 → `.env` 의 `DISCORD_CHANNEL_ID`",
      "**자동 알림:** 웹에서 확정된 일정 기준, 당일·출발 30분 전 등(봇이 켜져 있을 때).",
    ].join("\n");
    if (isAdmin) content += ADMIN_SLASH_HELP_APPEND;
    const chunks = chunkLines(content.split("\n"), 1900);
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  if (sub === "test") {
    let cfg = null;
    try {
      cfg = await fetchReminderChannelConfig(supabase);
    } catch (e) {
      console.warn("[raid_notify test]", e?.message ?? e);
    }
    const route = (interaction.options.getString("raid_route") ?? "rudra").trim().toLowerCase();
    let targetCid;
    if (route === "default") {
      targetCid = effectiveDefaultChannelId(cfg);
    } else if (RAID_TYPES.includes(route)) {
      targetCid = channelIdForRaidType(route, cfg);
    } else {
      await interaction.reply({ content: "raid_route 값이 올바르지 않습니다.", ephemeral: true });
      return;
    }
    let ch;
    try {
      ch = await interaction.client.channels.fetch(targetCid);
    } catch {
      ch = null;
    }
    if (!ch?.isTextBased()) {
      await interaction.reply({
        content: `채널을 열 수 없습니다 (\`${targetCid}\`). 봇이 그 채널에 접근 가능한지·ID를 확인해 주세요.`,
        ephemeral: true,
      });
      return;
    }
    const uid = interaction.user.id;
    const content = [
      "📣 **레이드 알림 연결 테스트** (진짜 알림이 아니에요~)",
      `👤 실행: **${interaction.user.tag}**`,
      `📍 채널 라우트: \`${route}\` → <#${targetCid}>`,
      `🕐 지금(로컬): **${formatKo(new Date())}**`,
      `<@${uid}> 잘 왔지? ✨`,
    ].join("\n");
    await ch.send({ content, allowedMentions: { users: [uid] } });
    await interaction.reply({
      content: `테스트 메시지를 ${formatCh(targetCid)} 에 보냈고, <@${uid}> 님을 멘션했습니다.`,
      ephemeral: true,
      allowedMentions: { users: [uid] },
    });
    return;
  }

  const canManage = interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
  if (!canManage) {
    await interaction.reply({
      content: "이 명령은 **서버 관리(Manage Server)** 권한이 있는 사람만 쓸 수 있습니다.",
      ephemeral: true,
    });
    return;
  }

  if (sub === "timings") {
    const chunks = chunkLines(buildNotifyTimingsHelpText().split("\n"), 1900);
    await interaction.reply({ content: chunks[0], ephemeral: true });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
    return;
  }

  if (sub === "set") {
    const target = interaction.options.getString("target", true);
    const ch = interaction.options.getChannel("channel", true);
    if (!ch?.isTextBased()) {
      await interaction.reply({ content: "텍스트(또는 공지) 채널만 선택해 주세요.", ephemeral: true });
      return;
    }
    const channelId = ch.id;
    const { data: existing, error: selErr } = await supabase
      .from("discord_reminder_channel_config")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (selErr) throw selErr;
    const row = baseConfigRow(existing);
    if (target === "default") row.default_channel_id = channelId;
    if (target === "rudra") row.rudra_channel_id = channelId;
    if (target === "bagot") row.bagot_channel_id = channelId;
    if (target === "lostark") row.lostark_channel_id = channelId;
    const { error } = await supabase.from("discord_reminder_channel_config").upsert(row, { onConflict: "id" });
    if (error) throw error;
    warnedBadChannelIds.clear();
    await interaction.reply({
      content: `저장했습니다.\n**${TARGET_CHOICES.find((c) => c.value === target)?.name ?? target}** → ${formatCh(channelId)}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "status") {
    const one = interaction.options.getString("target");
    const { data: existing, error } = await supabase
      .from("discord_reminder_channel_config")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (error) throw error;
    if (!existing) {
      await interaction.reply({
        content: "DB에 저장된 값이 없습니다. `.env`의 `DISCORD_CHANNEL_ID*`만 사용 중입니다.",
        ephemeral: true,
      });
      return;
    }
    if (one === "default") {
      await interaction.reply({ content: `기본: ${formatCh(existing.default_channel_id)}`, ephemeral: true });
      return;
    }
    if (one === "rudra") {
      await interaction.reply({ content: `루드라: ${formatCh(existing.rudra_channel_id)}`, ephemeral: true });
      return;
    }
    if (one === "bagot") {
      await interaction.reply({ content: `바고트: ${formatCh(existing.bagot_channel_id)}`, ephemeral: true });
      return;
    }
    if (one === "lostark") {
      await interaction.reply({ content: `로스트아크: ${formatCh(existing.lostark_channel_id)}`, ephemeral: true });
      return;
    }
    const lines = [
      "**DB 저장값** (비어 있으면 `.env` → `DISCORD_CHANNEL_ID` 순으로 씀)",
      `· 기본: ${formatCh(existing.default_channel_id)}`,
      `· 루드라: ${formatCh(existing.rudra_channel_id)}`,
      `· 바고트: ${formatCh(existing.bagot_channel_id)}`,
      `· 로스트아크: ${formatCh(existing.lostark_channel_id)}`,
      "",
      `**.env 기본 폴백:** \`${CHANNEL_ID || "(없음)"}\``,
    ];
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  if (sub === "clear") {
    const target = interaction.options.getString("target", true);
    const { data: existing, error: selErr } = await supabase
      .from("discord_reminder_channel_config")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (selErr) throw selErr;
    const row = baseConfigRow(existing);
    if (target === "all") {
      row.default_channel_id = null;
      row.rudra_channel_id = null;
      row.bagot_channel_id = null;
      row.lostark_channel_id = null;
    } else if (target === "default") row.default_channel_id = null;
    else if (target === "rudra") row.rudra_channel_id = null;
    else if (target === "bagot") row.bagot_channel_id = null;
    else if (target === "lostark") row.lostark_channel_id = null;
    const { error } = await supabase.from("discord_reminder_channel_config").upsert(row, { onConflict: "id" });
    if (error) throw error;
    warnedBadChannelIds.clear();
    await interaction.reply({
      content: target === "all" ? "DB의 채널 설정을 모두 지웠습니다." : `**${target}** 항목을 DB에서 지웠습니다.`,
      ephemeral: true,
    });
  }
}

/** 실제 알림 없이 채널·토큰·권한만 확인 (`npm run test-notify`) */
async function runTestSend(client, supabase) {
  let cfg = null;
  try {
    cfg = await fetchReminderChannelConfig(supabase);
  } catch (e) {
    console.warn("[테스트] discord_reminder_channel_config 읽기 실패 — .env 채널만 사용:", e?.message ?? e);
  }
  const effectiveDefaultId = effectiveDefaultChannelId(cfg);
  const testRaidType = (process.env.TEST_NOTIFY_RAID_TYPE ?? "rudra").trim().toLowerCase();
  if (!RAID_TYPES.includes(testRaidType)) {
    console.error("[오류] TEST_NOTIFY_RAID_TYPE 은 rudra, bagot, lostark 중 하나여야 합니다.");
    process.exit(1);
  }
  const targetCid = channelIdForRaidType(testRaidType, cfg);
  const ch = await client.channels.fetch(targetCid);
  if (!ch?.isTextBased()) {
    console.error(`[오류] 채널을 열 수 없거나 텍스트 채널이 아닙니다. id=${targetCid}`);
    process.exit(1);
  }
  const mention = (process.env.TEST_NOTIFY_DISCORD_ID ?? "").trim();
  const lines = [
    "🧪 **레이드 알림 · 터미널 테스트** (평소 자동 알림이랑 같은 채널로 가요)",
    `raid_type: \`${testRaidType}\` → 채널 \`${targetCid}\``,
    `기본 폴백: \`${effectiveDefaultId}\` · 로컬 시각 **${formatKo(new Date())}**`,
  ];
  if (mention && /^\d{5,30}$/.test(mention)) {
    lines.push(`멘션 테스트: <@${mention}>`);
    await ch.send({
      content: lines.join("\n"),
      allowedMentions: { users: [mention] },
    });
  } else {
    lines.push(
      "(멘션 없음) 디스코드에서 **`/raid_notify test`** 를 쓰면 실행한 사람에게 멘션됩니다. 터미널 테스트만 쓸 때는 `.env`의 `TEST_NOTIFY_DISCORD_ID=숫자`",
    );
    await ch.send({ content: lines.join("\n") });
  }
  console.log(`[테스트] 전송 완료 → 채널 ${targetCid}`);
}

function weekKeyFromConfirmation(conf) {
  return String(conf.raid_week_start ?? "").slice(0, 10);
}

/** DB `updated_at` 문자열 표기(Z/+00:00 등)와 무관하게 동일 여부를 맞추기 위해 ms 로 키를 씀 */
function confirmNotifyStateKeyCanonical(conf, updatedAtMs) {
  return `confirmSent|${conf.raid_type}|${weekKeyFromConfirmation(conf)}|${conf.slot_key}|${updatedAtMs}`;
}

/** 재시작 후에도 동일 확정이면 스킵 — 구버전 키(접미 ISO 문자열)와 호환 */
function isConfirmNotifyAlreadySent(state, conf, updatedAtMs) {
  const canonical = confirmNotifyStateKeyCanonical(conf, updatedAtMs);
  if (state[canonical]) return true;
  const weekKey = weekKeyFromConfirmation(conf);
  const prefix = `confirmSent|${conf.raid_type}|${weekKey}|${conf.slot_key}|`;
  for (const k of Object.keys(state)) {
    if (!k.startsWith(prefix)) continue;
    const suffix = k.slice(prefix.length);
    if (suffix === String(updatedAtMs)) return true;
    const legacyMs = new Date(suffix).getTime();
    if (Number.isFinite(legacyMs) && legacyMs === updatedAtMs) return true;
  }
  return false;
}

function clearConfirmNotifyStateVariantsForRow(state, conf) {
  const weekKey = weekKeyFromConfirmation(conf);
  const prefix = `confirmSent|${conf.raid_type}|${weekKey}|${conf.slot_key}|`;
  for (const k of Object.keys(state)) {
    if (k.startsWith(prefix)) delete state[k];
  }
}

/** `discord_raid_confirm_notify_state` 한 번에 읽어 (raid_type|weekKey) → last_notified_updated_at_ms */
async function fetchConfirmNotifyDbMap(supabase) {
  try {
    const { data: notifyRows, error: nErr } = await supabase
      .from("discord_raid_confirm_notify_state")
      .select("raid_type, raid_week_start, last_notified_updated_at_ms");
    if (nErr) throw nErr;
    const m = new Map();
    for (const r of notifyRows ?? []) {
      const wk =
        typeof r.raid_week_start === "string"
          ? r.raid_week_start.slice(0, 10)
          : String(r.raid_week_start).slice(0, 10);
      m.set(`${r.raid_type}|${wk}`, Number(r.last_notified_updated_at_ms));
    }
    return m;
  } catch (e) {
    console.warn("[확정 알림] DB 중복 방지 테이블 읽기 실패 — 파일 상태만 사용:", e?.message ?? e);
    return null;
  }
}

function isConfirmNotifyRecordedInDbMap(dbMap, conf, updatedAtMs) {
  if (!dbMap) return false;
  const weekKey = weekKeyFromConfirmation(conf);
  const k = `${conf.raid_type}|${weekKey}`;
  const stored = dbMap.get(k);
  if (stored === undefined) return false;
  return Number(stored) === updatedAtMs;
}

async function recordConfirmNotifyInDb(supabase, conf, updatedAtMs) {
  const weekKey = weekKeyFromConfirmation(conf);
  try {
    const { error } = await supabase.from("discord_raid_confirm_notify_state").upsert(
      {
        raid_type: conf.raid_type,
        raid_week_start: weekKey,
        last_notified_updated_at_ms: updatedAtMs,
      },
      { onConflict: "raid_type,raid_week_start" },
    );
    if (error) throw error;
  } catch (e) {
    console.warn("[확정 알림] DB 기록 실패:", e?.message ?? e);
  }
}

/**
 * 웹에서 일정 확정(upsert) 직후, 해당 슬롯에 가능 시간을 넣은 사람들에게 디스코드 멘션을 한 번 보냅니다.
 * `sent-reminders.json` 과 DB `discord_raid_confirm_notify_state` 로 중복 전송을 막고, `updated_at` 이 너무 오래된 건 무시합니다.
 */
async function runScheduleConfirmNotifyTick(client, supabase, state) {
  const { data: confs, error } = await supabase.from("raid_schedule_confirmation").select("*");
  if (error) throw error;
  if (!confs?.length) return state;

  const { data: avRows, error: avErr } = await supabase
    .from("raid_availability")
    .select("raid_type, discord_id, slots");
  if (avErr) throw avErr;
  const partIndex = buildRaidParticipantIndex(avRows);

  let cfg = null;
  try {
    cfg = await fetchReminderChannelConfig(supabase);
  } catch (e) {
    console.error("[경고] discord_reminder_channel_config 읽기 실패 — .env 채널만 사용:", e?.message ?? e);
  }

  const effectiveDefaultId = effectiveDefaultChannelId(cfg);
  const channelCache = new Map();
  async function textChannelById(id) {
    if (channelCache.has(id)) return channelCache.get(id);
    try {
      const ch = await client.channels.fetch(id);
      const ok = ch?.isTextBased() ? ch : null;
      channelCache.set(id, ok);
      return ok;
    } catch {
      channelCache.set(id, null);
      return null;
    }
  }

  const defaultCh = await textChannelById(effectiveDefaultId);
  if (!defaultCh) {
    console.error(
      "[오류] 기본 알림 채널을 열 수 없습니다. `/raid_notify set` 또는 `DISCORD_CHANNEL_ID` 확인. (확정 직후 멘션 생략)",
    );
    return state;
  }

  const now = Date.now();
  const dbNotifyMap = await fetchConfirmNotifyDbMap(supabase);
  let nextState = { ...state };
  let mutated = false;

  for (const conf of confs) {
    if (RAID_ALLOWED && !RAID_ALLOWED.has(conf.raid_type)) continue;
    const weekKey = weekKeyFromConfirmation(conf);
    const updatedAtMs = conf.updated_at ? new Date(conf.updated_at).getTime() : NaN;
    if (!Number.isFinite(updatedAtMs)) continue;

    const age = now - updatedAtMs;
    if (age < 0) continue;
    if (age > CONFIRM_NOTIFY_MAX_AGE_MS) continue;

    if (isConfirmNotifyRecordedInDbMap(dbNotifyMap, conf, updatedAtMs)) continue;
    if (isConfirmNotifyAlreadySent(nextState, conf, updatedAtMs)) continue;

    const rawParticipants = participantsFromIndex(partIndex, conf.raid_type, conf.slot_key);
    const participants = [...new Set(rawParticipants)];

    const targetCid = channelIdForRaidType(conf.raid_type, cfg);
    const resolvedCh = await textChannelById(targetCid);
    if (!resolvedCh && targetCid !== effectiveDefaultId && !warnedBadChannelIds.has(targetCid)) {
      warnedBadChannelIds.add(targetCid);
      console.error(
        `[오류] raid_type=${conf.raid_type} 채널 ${targetCid} 를 열 수 없어 기본 채널로 보냅니다. (이 메시지는 채널당 1회)`,
      );
    }
    const channel = resolvedCh ?? defaultCh;

    const slotStart = slotKeyToLocalDate(conf.slot_key);
    const em = RAID_TYPE_EMOJI[conf.raid_type] ?? "📌";
    const raidLabel = RAID_TYPE_LABEL_KO[conf.raid_type] ?? conf.raid_type;

    const dayOffset = slotStart ? localCalendarDaysFromToday(slotStart) : null;
    let relativeTag = "";
    if (slotStart && dayOffset != null) {
      if (dayOffset < 0) relativeTag = " _(지난 일정이면 웹·캘린더만 확인해 주세요)_";
      else if (dayOffset === 0) relativeTag = " **(오늘)**";
      else if (dayOffset === 1) relativeTag = " **(내일)**";
      else if (dayOffset === 2) relativeTag = " **(모레)**";
      else relativeTag = ` **(${dayOffset}일 뒤)**`;
    }

    const isToday = dayOffset === 0;
    const mentionLine =
      participants.length > 0
        ? isToday
          ? `💌 오늘 함께하는 분들 불러올게요~ ${participants.map((id) => `<@${id}>`).join(" ")}`
          : `💌 이번에 확정된 시간 함께인 분들 멘션이에요~ ${participants.map((id) => `<@${id}>`).join(" ")}`
        : "🥺 _(아직 불러올 디스코드 친구가 없어요… 웹에서 「가능 시간 저장」 한 번만 더 해주면 다음엔 꼭 꼬옥 멘션해 드릴게요!)_";

    const calendarHint = isToday
      ? "캘린더에 하트 도장 쾅! 💕"
      : "아직 멀었다면 일정표에만 넣어 두고, 당일·알림 때 다시 볼게요 📌";

    const timeLine = slotStart
      ? `⏰ **출발 시각:** **${formatKo(slotStart)}**${relativeTag}\n_${calendarHint}_`
      : `⏰ 슬롯: **${conf.slot_key}** · 시간 깜빡하면 안 돼요~`;

    const headerLine = `🎀 **${raidLabel}** 레이드 시간이 웹에서 **확정**됐어요! ${em}`;
    const closingLine = isToday
      ? "_다들 늦지 말고 쪽~ 모여요. 파이팅이에요! (๑˃ᴗ˂)ﻭ✧_"
      : "_오늘이 아니어도 괜찮아요. **그날** 시간 맞춰 모여요. 파이팅! ✨_";

    const text = [headerLine, timeLine, mentionLine, "", closingLine].join("\n");

    try {
      await channel.send({
        content: text,
        allowedMentions: participants.length > 0 ? { users: participants.slice(0, 100) } : undefined,
      });
      clearConfirmNotifyStateVariantsForRow(nextState, conf);
      nextState[confirmNotifyStateKeyCanonical(conf, updatedAtMs)] = new Date().toISOString();
      await recordConfirmNotifyInDb(supabase, conf, updatedAtMs);
      mutated = true;
      console.log(`[확정 알림] ${conf.raid_type} ${weekKey} ${conf.slot_key}`);
    } catch (e) {
      console.error(`[확정 알림 실패] ${conf.raid_type} ${weekKey}`, e?.message ?? e);
    }
  }

  if (mutated) await saveState(nextState);
  return mutated ? nextState : state;
}

async function runTick(client, supabase, state) {
  const { data: confs, error } = await supabase.from("raid_schedule_confirmation").select("*");
  if (error) throw error;

  const now = Date.now();
  const relevant = [];
  for (const conf of confs ?? []) {
    if (RAID_ALLOWED && !RAID_ALLOWED.has(conf.raid_type)) continue;
    const slotStart = slotKeyToLocalDate(conf.slot_key);
    if (!slotStart || slotStart.getTime() <= now) continue;
    relevant.push({ conf, slotStart });
  }

  if (relevant.length === 0) {
    return state;
  }

  const { data: avRows, error: avErr } = await supabase
    .from("raid_availability")
    .select("raid_type, discord_id, slots");
  if (avErr) throw avErr;
  const partIndex = buildRaidParticipantIndex(avRows);

  let cfg = null;
  try {
    cfg = await fetchReminderChannelConfig(supabase);
  } catch (e) {
    console.error("[경고] discord_reminder_channel_config 읽기 실패 — .env 채널만 사용:", e?.message ?? e);
  }

  const effectiveDefaultId = effectiveDefaultChannelId(cfg);

  const channelCache = new Map();
  async function textChannelById(id) {
    if (channelCache.has(id)) return channelCache.get(id);
    try {
      const ch = await client.channels.fetch(id);
      const ok = ch?.isTextBased() ? ch : null;
      channelCache.set(id, ok);
      return ok;
    } catch {
      channelCache.set(id, null);
      return null;
    }
  }

  const defaultCh = await textChannelById(effectiveDefaultId);
  if (!defaultCh) {
    console.error(
      "[오류] 기본 알림 채널을 열 수 없습니다. `/raid_notify set` 또는 `DISCORD_CHANNEL_ID` 확인.",
    );
    return state;
  }

  let nextState = { ...state };
  let mutated = false;

  for (const { conf, slotStart } of relevant) {
    const t30 = slotStart.getTime() - 30 * 60 * 1000;
    const weekKey = String(conf.raid_week_start ?? "").slice(0, 10);
    const keyBase = `${conf.raid_type}|${weekKey}|${conf.slot_key}`;

    /** 출발 당일 REMIND_DAY_HOUR:00 (로컬). 출발이 그보다 이르면 당일 알림은 생략 */
    const dayRemindMs = new Date(
      slotStart.getFullYear(),
      slotStart.getMonth(),
      slotStart.getDate(),
      REMIND_DAY_HOUR,
      0,
      0,
      0,
    ).getTime();

    const targetCid = channelIdForRaidType(conf.raid_type, cfg);
    const resolvedCh = await textChannelById(targetCid);
    if (!resolvedCh && targetCid !== effectiveDefaultId && !warnedBadChannelIds.has(targetCid)) {
      warnedBadChannelIds.add(targetCid);
      console.error(
        `[오류] raid_type=${conf.raid_type} 채널 ${targetCid} 를 열 수 없어 기본 채널로 보냅니다. (이 메시지는 채널당 1회)`,
      );
    }
    const channel = resolvedCh ?? defaultCh;

    const participants = participantsFromIndex(partIndex, conf.raid_type, conf.slot_key);
    const em = RAID_TYPE_EMOJI[conf.raid_type] ?? "📌";
    const raidLabel = RAID_TYPE_LABEL_KO[conf.raid_type] ?? conf.raid_type;
    const mentionLine =
      participants.length > 0
        ? `👥 ${participants.map((id) => `<@${id}>`).join(" ")}`
        : "💤 _(아직 멘션할 분이 없어요… 웹에서 「가능 시간 저장」해 주면 다음부터 불러올게요!)_";

    const sendIf = async (kind, targetMs) => {
      const flagKey = `${keyBase}:${kind}`;
      if (nextState[flagKey]) return;
      if (Math.abs(now - targetMs) > 90_000) return;
      const text =
        kind === "d30"
          ? [
              `${em} **${raidLabel}** 레이드 곧 출발이에요! 앞으로 **30분** ⏰`,
              `🗓️ 출발 시각: **${formatKo(slotStart)}**`,
              mentionLine,
              "",
              "_다들 준비됐지? 파이팅! ✨_",
            ].join("\n")
          : kind === "dDay"
            ? [
                `${em} **${raidLabel}** 오늘 레이드 당일이야! (당일 알림 ${String(REMIND_DAY_HOUR).padStart(2, "0")}:00 기준)`,
                `🎯 출발 예정: **${formatKo(slotStart)}**`,
                mentionLine,
                "",
                "_늦지 말고 모여요~ 💕_",
              ].join("\n")
            : [
                `${em} **${raidLabel}** 알림`,
                `출발: **${formatKo(slotStart)}**`,
                mentionLine,
              ].join("\n");
      const allowedMentions =
        participants.length > 0 ? { users: participants.slice(0, 100) } : undefined;
      await channel.send({ content: text, allowedMentions });
      nextState[flagKey] = new Date().toISOString();
      mutated = true;
      console.log(`[전송] ${flagKey}`);
    };

    if (dayRemindMs < slotStart.getTime()) {
      await sendIf("dDay", dayRemindMs);
    }
    await sendIf("d30", t30);
  }

  if (mutated) await saveState(nextState);
  return nextState;
}

async function runSugoMerchantTick(client, supabase, state) {
  const now = Date.now();
  const d = new Date();

  /** 짝수 시 정각 기준 — 로컬 **xx:59:00 이상 ~ 정각(00:00) 미만**에만 전송. 0시는 전날 23:59~24:00 → 달력 키는 해당 0시가 속한 날 */
  let resolved = null;
  for (const eventH of SUGO_MERCHANT_HOURS) {
    const { startMs, endMs, dk } = sugoMerchantWindowBoundsLocal(eventH, d);
    if (now >= startMs && now < endMs) {
      resolved = { eventHour: eventH, dk };
      break;
    }
  }
  if (!resolved) return state;

  const h = resolved.eventHour;
  const dk = resolved.dk;
  const { data, error } = await supabase.from("discord_sugo_merchant_subscribers").select("channel_id, discord_user_id");
  if (error) throw error;

  const byChannel = new Map();
  for (const row of data ?? []) {
    const cid = String(row.channel_id ?? "").trim();
    if (!/^\d{5,30}$/.test(cid)) continue;
    const uid = String(row.discord_user_id ?? "").trim();
    if (!/^\d{5,30}$/.test(uid)) continue;
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid).push(uid);
  }

  let nextState = { ...state };
  let any = false;

  for (const [channelId, userIds] of byChannel) {
    const unique = [...new Set(userIds)].slice(0, 100);
    if (unique.length === 0) continue;

    const flagKey = `sugo|${channelId}|${dk}|${h}`;
    if (nextState[flagKey]) continue;

    let ch;
    try {
      ch = await client.channels.fetch(channelId);
    } catch {
      continue;
    }
    if (!ch?.isTextBased?.()) continue;

    const mentionLine = unique.map((id) => `<@${id}>`).join(" ");
    const text = [
      "🛡️ **슈고 상인 보호(슈상보)** 짝수 시 **정각 직전** 알림이야! (오전 6~8시 제외)",
      `⏰ **${String(h).padStart(2, "0")}:00** 정각이 곧이에요`,
      mentionLine,
      "_상인님 조심히 다녀오세요~ ✨_",
    ].join("\n");

    await ch.send({
      content: text,
      allowedMentions: { users: unique },
    });
    nextState[flagKey] = new Date().toISOString();
    any = true;
    console.log(`[슈상보 전송] ${flagKey}`);
  }

  if (any) await saveState(nextState);
  return any ? nextState : state;
}

async function main() {
  requireEnv("DISCORD_BOT_TOKEN", TOKEN);
  requireEnv("DISCORD_CHANNEL_ID", CHANNEL_ID);
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

  const raidDesc = RAID_ALLOWED ? [...RAID_ALLOWED].sort().join(", ") : "rudra + bagot + lostark (전체)";
  console.log(
    `[설정] TZ=${process.env.TZ ?? "(기본)"} STATE=${STATE_PATH} ALARM_STATE=${ALARM_STATE_PATH} POLL=${POLL_MS}ms 당일=${REMIND_DAY_HOUR}시 알림대상=${raidDesc} .env기본채널=${CHANNEL_ID}`,
  );
  console.log(
    `[최적화] 레이드 알림=가능시간 1회 조회·인덱스 / 상태정리 raid≥${STATE_PRUNE_RAID_DAYS}일 sugo≥${STATE_PRUNE_SUGO_DAYS}일 / 전송 시에만 state 저장`,
  );
  console.log(
    `[확정 직후 멘션] 최근 ${Math.round(CONFIRM_NOTIFY_MAX_AGE_MS / 60_000)}분 이내 확정만 전송 · CONFIRM_NOTIFY_MAX_AGE_MS 로 조정`,
  );
  console.log(
    `[슈상보] 짝수 시 xx:59~정각 직전 멘션(06·07·08시 제외) — 대상 시각: ${[...SUGO_MERCHANT_HOURS].sort((a, b) => a - b).join(", ")}`,
  );
  if (MESSAGE_CONTENT_INTENTS_ENABLED) {
    console.log(
      `[메시지 본문] 켜짐 — 알람 채팅${REMIND_CHAT_ENABLED ? ` · 접두 "${REMIND_MSG_PREFIX || "(없음·봇멘션만)"}"` : ""}${envFlagTruthy("BOT_AT_COMMANDS_ENABLED") && !REMIND_CHAT_ENABLED ? " · @봇 구버지/명령어" : ""} · Portal→Bot→Privileged Gateway Intents→MESSAGE CONTENT ON 필수`,
    );
  } else {
    console.log(
      `[메시지 본문] 끔 — 채팅 알람·@봇 명령 비활성. 슬래시 /remind·레이드 알림은 동일. 켜려면 REMIND_CHAT_ENABLED=1 또는 BOT_AT_COMMANDS_ENABLED=1`,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const gatewayIntents = [GatewayIntentBits.Guilds];
  if (MESSAGE_CONTENT_INTENTS_ENABLED) {
    gatewayIntents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  const client = new Client({ intents: gatewayIntents });
  await client.login(TOKEN);
  console.log(`[Discord] 로그인: ${client.user?.tag}`);

  const once = process.argv.includes("--once");
  const testSend = process.argv.includes("--test-send");

  if (testSend) {
    await runTestSend(client, supabase);
    await client.destroy();
    process.exit(0);
  }

  if (!once) {
    await initRemindSystem(client);
    await registerSlashCommandsOnAllGuilds(client);
    client.on(Events.GuildCreate, async (guild) => {
      try {
        await registerSlashCommandsForGuild(client, guild.id, guild.name);
      } catch (e) {
        console.error("[Discord] GuildCreate 슬래시 등록 실패:", e?.message ?? e);
      }
    });
    if (MESSAGE_CONTENT_INTENTS_ENABLED) {
      client.on(Events.MessageCreate, async (message) => {
        try {
          if (await handleBotAtCommands(message, client)) return;
          if (REMIND_CHAT_ENABLED) await handleRemindMessageCreate(message, client);
        } catch (e) {
          console.error("[message]", e?.message ?? e);
        }
      });
    }
    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isButton() && interaction.customId?.startsWith("party:")) {
          await handlePartyButtonInteraction(client, supabase, interaction);
          return;
        }
        if (!interaction.isChatInputCommand()) return;
        const cn = interaction.commandName;
        if (
          ![
            "raid_notify",
            "raid_my_schedule",
            "raid_overlap",
            "dice",
            "sugo_ping",
            "party_recruit",
            "remind",
            "remind_cancel",
          ].includes(cn)
        )
          return;
        if (cn === "raid_notify") {
          await handleRaidNotifyInteraction(supabase, interaction);
        } else if (cn === "raid_my_schedule") {
          await handleMyScheduleInteraction(supabase, interaction);
        } else if (cn === "raid_overlap") {
          await handleOverlapInteraction(supabase, interaction);
        } else if (cn === "dice") {
          await handleDiceInteraction(interaction);
        } else if (cn === "sugo_ping") {
          await handleSugoPingInteraction(supabase, interaction);
        } else if (cn === "remind") {
          await handleRemindInteraction(interaction);
        } else if (cn === "remind_cancel") {
          await handleRemindCancelInteraction(interaction);
        } else {
          await handlePartyRecruitInteraction(client, supabase, interaction);
        }
      } catch (e) {
        console.error("[interaction]", e?.message ?? e);
        const msg =
          "처리 중 오류가 났습니다. 봇 로그·Supabase 마이그레이션(파티 구인 테이블 등)을 확인해 주세요.";
        if (interaction.isRepliable()) {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
          } else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
          }
        }
      }
    });
  }

  let state = await loadState();

  const tick = async () => {
    try {
      const nBefore = Object.keys(state).length;
      state = pruneReminderState(state);
      if (Object.keys(state).length !== nBefore) {
        await saveState(state);
      }
      state = await runScheduleConfirmNotifyTick(client, supabase, state);
      state = await runTick(client, supabase, state);
      state = await runSugoMerchantTick(client, supabase, state);
      await runRemindOverdueSweep().catch((e) => console.error("[알람 스윕]", e?.message ?? e));
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
  if (!once) {
    setInterval(() => {
      void runRemindOverdueSweep();
    }, 5_000);
  }
  console.log("[동작 중] 종료하려면 Ctrl+C");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
