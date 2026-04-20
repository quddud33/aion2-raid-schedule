/**
 * 일정 확정(raid_schedule_confirmation) 기준으로
 * 출발 **당일 REMIND_DAY_HOUR 시(기본 06:00)** / **30분 전**에 디스코드 채널에 멘션 알림을 보냅니다.
 *
 * 채널: `.env` 또는 Supabase `discord_reminder_channel_config` (디스코드 `/raid_notify` 로 설정)
 *
 * 실행: npm install 후 .env 복사·채우고 → npm start
 * 한 번만 점검: npm run check
 * 채널에 테스트 글: `/raid_notify test`(실행자 멘션) 또는 npm run test-notify
 * 명령 안내: `/raid_notify help`
 * 내 가능 시간: `/raid_my_schedule` (금주·차주 14일만, 날짜별·연속 구간 묶음)
 * 겹침: `/raid_overlap` (레이드별 웹 전원, 멘션 없음) · 주사위: `/dice` (1~100, 채널에 멘션)
 * 슈상보: `/sugo_ping` — 짝수 시 정각(06~08시 제외) 등록 채널에서 멘션
 * 파티: `/party_recruit` — 최대 8인, 버튼으로 출발·해체·가입·탈퇴
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
import { resolve } from "node:path";

if (process.env.REMIND_TZ) {
  process.env.TZ = process.env.REMIND_TZ;
}

const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const STATE_PATH = resolve(process.env.SENT_STATE_PATH ?? "./sent-reminders.json");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const REMIND_DAY_HOUR = Math.min(23, Math.max(0, Number(process.env.REMIND_DAY_HOUR ?? 6) || 6));

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

/** 슈상보: 짝수 시 정각 알림. 오전 6~8시(6·7·8시) 제외 → 0,2,4,10,…,22 */
const SUGO_MERCHANT_HOURS = new Set([0, 2, 4, 10, 12, 14, 16, 18, 20, 22]);

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

const TARGET_CHOICES = [
  { name: "전체 기본", value: "default" },
  { name: "루드라", value: "rudra" },
  { name: "바고트", value: "bagot" },
  { name: "로스트아크", value: "lostark" },
];

const SLASH_HELP_KO = [
  "**출발 알림 봇 — `/raid_notify` 명령**",
  "",
  "• `help` — 이 안내 (누구나)",
  "• `test` — 알림으로 쓰는 **채널에 테스트 글** + **명령 실행자 멘션** (누구나). 옵션 `raid_route`: 기본 / 루드라 / 바고트 / 로아 라우팅",
  "• `set` — **서버 관리** 권한 필요. DB에 채널 저장 (`target` + `channel`)",
  "• `status` — **서버 관리** 권한. DB에 저장된 채널 요약",
  "• `clear` — **서버 관리** 권한. DB 값 삭제 → 다시 `.env` 의 `DISCORD_CHANNEL_ID*` 기준",
  "",
  "**채널이 정해지는 순서** (앞이 우선): DB 타입별 → `.env` 의 `DISCORD_CHANNEL_ID_RUDRA` 등 → DB 기본 → `.env` 의 `DISCORD_CHANNEL_ID`",
  "",
  "**자동 알림:** 웹에서 확정된 일정 기준, 당일 지정 시각·출발 30분 전에 위 채널로 전송 (봇 프로세스가 켜져 있을 때).",
  "",
  "**내 가능 시간:** `/raid_my_schedule` — 금주·차주(레이드 주 14일)만, 날짜별·연속 구간 묶어 표시 (본인만 보임).",
  "**공대 겹침:** `/raid_overlap` — 해당 레이드 **웹 등록 전원** 기준, 금주·차주에서 **전원 겹치는** 슬롯 (닉네임만, 멘션 없음).",
  "**주사위:** `/dice` — 1~100 무작위, 이 채널에 실행자 멘션.",
  "**슈상보:** `/sugo_ping` — `register`/`unregister` 본인만, `list`는 서버 관리. 짝수 시 정각(06~08시 제외) 등록 채널에서 한 번에 멘션.",
  "**파티 구인:** `/party_recruit` — `create`로 모집 글(파티장=실행자, 최대 8인), `kick`으로 추방. 버튼: 출발·해체(빨강), 가입·탈퇴(파랑).",
].join("\n");

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
      .setDescription("슈고 상인 보호(슈상보) 짝수 시 정각 알림")
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
        "· **짝수 시 정각**에 멘션 (로컬 **06·07·08시**는 제외)",
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
        `[Discord] 슬래시 등록 (…·sugo_ping·party_recruit): ${g.name} (${g.id})`,
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
    await interaction.reply({ content: SLASH_HELP_KO, ephemeral: true });
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

async function runTick(client, supabase, state) {
  const { data: confs, error } = await supabase.from("raid_schedule_confirmation").select("*");
  if (error) throw error;

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

  const now = Date.now();
  let nextState = { ...state };

  for (const conf of confs ?? []) {
    if (RAID_ALLOWED && !RAID_ALLOWED.has(conf.raid_type)) continue;

    const slotStart = slotKeyToLocalDate(conf.slot_key);
    if (!slotStart || slotStart.getTime() <= now) continue;

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

    const participants = await fetchParticipants(supabase, conf.raid_type, conf.slot_key);
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
      console.log(`[전송] ${flagKey}`);
    };

    if (dayRemindMs < slotStart.getTime()) {
      await sendIf("dDay", dayRemindMs);
    }
    await sendIf("d30", t30);
  }

  await saveState(nextState);
  return nextState;
}

async function runSugoMerchantTick(client, supabase, state) {
  const now = Date.now();
  const d = new Date();
  const hourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0).getTime();
  if (Math.abs(now - hourStart) > 90_000) return state;

  const h = d.getHours();
  if (!SUGO_MERCHANT_HOURS.has(h)) return state;

  const dk = dateKeyLocalFromDate(d);
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
      "🛡️ **슈고 상인 보호(슈상보)** 짝수 시 정각 알림이야! (오전 6~8시 제외)",
      `⏰ ${String(h).padStart(2, "0")}:00`,
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
    `[설정] TZ=${process.env.TZ ?? "(기본)"} STATE=${STATE_PATH} POLL=${POLL_MS}ms 당일=${REMIND_DAY_HOUR}시 알림대상=${raidDesc} .env기본채널=${CHANNEL_ID}`,
  );
  console.log(
    `[슈상보] 짝수 시 정각 멘션(06·07·08시 제외) — 시각: ${[...SUGO_MERCHANT_HOURS].sort((a, b) => a - b).join(", ")}`,
  );

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
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
    await registerSlashCommandsOnAllGuilds(client);
    client.on(Events.GuildCreate, async (guild) => {
      try {
        await registerSlashCommandsForGuild(client, guild.id, guild.name);
      } catch (e) {
        console.error("[Discord] GuildCreate 슬래시 등록 실패:", e?.message ?? e);
      }
    });
    client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isButton() && interaction.customId?.startsWith("party:")) {
          await handlePartyButtonInteraction(client, supabase, interaction);
          return;
        }
        if (!interaction.isChatInputCommand()) return;
        const cn = interaction.commandName;
        if (
          !["raid_notify", "raid_my_schedule", "raid_overlap", "dice", "sugo_ping", "party_recruit"].includes(
            cn,
          )
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
      state = await runTick(client, supabase, state);
      state = await runSugoMerchantTick(client, supabase, state);
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
