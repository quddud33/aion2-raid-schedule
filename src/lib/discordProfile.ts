import type { User } from "@supabase/supabase-js";

const NICK_MAX = 80;

/** 표·DB에 넣을 Discord 표시 이름 (별명 입력 없음) */
export function discordNicknameForDb(user: User): string {
  const m = user.user_metadata ?? {};
  const identity = user.identities?.find((i) => i.provider === "discord");
  const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;

  const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const globalName = pick(m.global_name) || pick(idData.global_name);
  const fullName = pick(m.full_name) || pick(idData.full_name);
  const name = pick(m.name) || pick(idData.name);
  const preferred = pick(m.preferred_username) || pick(idData.preferred_username);
  const custom = pick(m.custom_claim);

  const raw =
    globalName ||
    fullName ||
    name ||
    preferred ||
    custom ||
    (typeof user.email === "string" ? user.email.split("@")[0] ?? "" : "") ||
    "Discord";

  return raw.length > NICK_MAX ? raw.slice(0, NICK_MAX) : raw;
}

/** Discord 프로필 이미지 URL (없으면 null — UI에서 플레이스홀더) */
export function discordAvatarUrl(user: User): string | null {
  const m = user.user_metadata ?? {};
  const identity = user.identities?.find((i) => i.provider === "discord");
  const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;

  for (const v of [m.avatar_url, m.picture, idData.avatar_url, idData.picture]) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("http")) return t;
    }
  }

  const sub =
    (typeof m.provider_id === "string" && m.provider_id) ||
    (typeof idData.sub === "string" && idData.sub) ||
    identity?.id ||
    "";

  const hashRaw = m.avatar_url ?? m.avatar ?? idData.avatar_url ?? idData.avatar;
  const hash = typeof hashRaw === "string" ? hashRaw.trim() : "";
  if (sub && hash && !hash.includes("/") && !hash.startsWith("http")) {
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${sub}/${hash}.${ext}?size=128`;
  }

  return null;
}

/** Discord OAuth provider 의 사용자 snowflake (멘션 `<@id>` 용). 없으면 null */
export function discordProviderId(user: User): string | null {
  const identity = user.identities?.find((i) => i.provider === "discord");
  const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;
  const sub = typeof idData.sub === "string" ? idData.sub.trim() : "";
  if (/^\d{5,30}$/.test(sub)) return sub;
  const meta = user.user_metadata ?? {};
  const pid = typeof meta.provider_id === "string" ? meta.provider_id.trim() : "";
  if (/^\d{5,30}$/.test(pid)) return pid;
  const id = identity?.id;
  if (typeof id === "string" && /^\d{5,30}$/.test(id.trim())) return id.trim();
  return null;
}
