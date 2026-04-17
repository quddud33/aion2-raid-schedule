import serversJson from "../data/aion2tool-servers.json";

type ServerOption = { value: string; label: string };

function parseLabelParts(label: string): { longName: string; shortTag: string } | null {
  const m = label.match(/^(.+?)\s*-\s*\[([^\]]+)\]\s*$/);
  if (!m?.[1] || !m[2]) return null;
  return { longName: m[1].trim(), shortTag: m[2].trim() };
}

/** 서버명(또는 아툴 셀렉트 라벨)으로 aion2tool serverId를 해석합니다. 애매하면 null. */
export function resolveAion2toolServerId(serverName: string): string | null {
  const q = serverName.trim().normalize("NFC");
  if (!q) return null;

  const byLabel = serversJson.byLabel as Record<string, string>;
  const mapped = byLabel[q];
  if (mapped && mapped !== "all") return mapped;

  const exact: string[] = [];
  for (const opt of serversJson.options as ServerOption[]) {
    if (opt.value === "all") continue;
    const p = parseLabelParts(opt.label);
    if (!p) continue;
    if (q === p.longName || q === p.shortTag) exact.push(opt.value);
  }
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) return null;

  let found: string | null = null;
  for (const opt of serversJson.options as ServerOption[]) {
    if (opt.value === "all") continue;
    const p = parseLabelParts(opt.label);
    if (!p) continue;
    if (q.length < 2) continue;
    if (p.longName.includes(q) || p.shortTag.includes(q)) {
      if (found && found !== opt.value) return null;
      found = opt.value;
    }
  }
  return found;
}

export const AION2TOOL_HOME = "https://aion2tool.com/";

export function buildAion2toolCharUrl(serverName: string, nickname: string): string | null {
  const sid = resolveAion2toolServerId(serverName);
  const nick = nickname.trim();
  if (!sid || !nick) return null;
  return `${AION2TOOL_HOME}char/serverid=${sid}/${encodeURIComponent(nick)}`;
}
