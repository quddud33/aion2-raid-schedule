/**
 * 일정 확정(raid_schedule_confirmation) 기준으로
 * 출발 **당일 REMIND_DAY_HOUR 시(기본 06:00)** / **30분 전**에 디스코드 채널에 멘션 알림을 보냅니다.
 *
 * 채널: `.env` 또는 Supabase `discord_reminder_channel_config` (디스코드 `/raid_notify` 로 설정)
 *
 * 실행: npm install 후 .env 복사·채우고 → npm start
 * 한 번만 점검: npm run check
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  ChannelType,
  Client,
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
const DISCORD_GUILD_ID = (process.env.DISCORD_GUILD_ID ?? "").trim();
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
      .toJSON(),
  ];
}

async function registerSlashCommands(client) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const appId = client.application?.id;
  if (!appId) {
    console.warn("[Discord] application id 없음 — 슬래시 명령 등록 생략");
    return;
  }
  const body = buildSlashCommands();
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, DISCORD_GUILD_ID), { body });
    console.log(`[Discord] 슬래시 /raid_notify 등록됨 (길드 ${DISCORD_GUILD_ID})`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log("[Discord] 슬래시 /raid_notify 글로벌 등록 (반영까지 최대 수십 분 걸릴 수 있음)");
  }
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
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
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

  const sub = interaction.options.getSubcommand();

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
    const mentionLine =
      participants.length > 0
        ? participants.map((id) => `<@${id}>`).join(" ")
        : "(멘션할 Discord ID가 없습니다. 웹에서 「가능 시간 저장」을 해 주세요.)";

    const sendIf = async (kind, targetMs) => {
      const flagKey = `${keyBase}:${kind}`;
      if (nextState[flagKey]) return;
      if (Math.abs(now - targetMs) > 90_000) return;
      const label =
        kind === "d30"
          ? "30분 전"
          : kind === "dDay"
            ? `당일 ${String(REMIND_DAY_HOUR).padStart(2, "0")}:00`
            : kind;
      const text = [
        `**[레이드 알림 · ${label}]**`,
        `raid_type: \`${conf.raid_type}\``,
        `출발 시각(로컬): **${formatKo(slotStart)}**`,
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

async function main() {
  requireEnv("DISCORD_BOT_TOKEN", TOKEN);
  requireEnv("DISCORD_CHANNEL_ID", CHANNEL_ID);
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

  const raidDesc = RAID_ALLOWED ? [...RAID_ALLOWED].sort().join(", ") : "rudra + bagot + lostark (전체)";
  console.log(
    `[설정] TZ=${process.env.TZ ?? "(기본)"} STATE=${STATE_PATH} POLL=${POLL_MS}ms 당일=${REMIND_DAY_HOUR}시 알림대상=${raidDesc} .env기본채널=${CHANNEL_ID}${DISCORD_GUILD_ID ? ` GUILD=${DISCORD_GUILD_ID}` : ""}`,
  );

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(TOKEN);
  console.log(`[Discord] 로그인: ${client.user?.tag}`);

  const once = process.argv.includes("--once");

  if (!once) {
    await registerSlashCommands(client);
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== "raid_notify") return;
      try {
        await handleRaidNotifyInteraction(supabase, interaction);
      } catch (e) {
        console.error("[raid_notify]", e?.message ?? e);
        const msg = "저장/조회 중 오류가 났습니다. 봇 로그·Supabase 마이그레이션을 확인해 주세요.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    });
  }

  let state = await loadState();

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
