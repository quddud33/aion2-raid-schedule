/** YYYY-MM-DD + 분 단위 오프셋(자정 기준) → 고정 키 */
export function slotKey(date: Date, minutesFromMidnight: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const mm = String(minutesFromMidnight).padStart(4, "0");
  return `${y}-${m}-${d}@${mm}`;
}

export function parseSlotKey(key: string): { day: string; minutes: number } | null {
  const m = key.match(/^(\d{4}-\d{2}-\d{2})@(\d{4})$/);
  if (!m) return null;
  return { day: m[1]!, minutes: Number(m[2]) };
}

/** 표시용: 30분 단위, 24시간제 (예: 18:30, 익일 01:00 → 01:00) */
export function formatMinuteLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export type RaidWeekPhase = "current" | "next";

export type DayColumn = {
  date: Date;
  label: string;
  short: string;
  /** 레이드 주(수~화) 기준: 금주 7일 + 차주 7일 */
  raidWeek: RaidWeekPhase;
};

/**
 * 이번 레이드 주의 시작일 = 가장 최근 수요일 00:00(로컬).
 * 수~화가 한 주이며, 수요일에 초기화된다고 가정.
 */
export function startOfRaidWeekWednesday(ref: Date): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const offset = (dow - 3 + 7) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

/** 금주·차주 각 7일(수~화), 총 14칸 */
export function buildRaidWeekColumns(ref: Date): DayColumn[] {
  const start = startOfRaidWeekWednesday(ref);
  const out: DayColumn[] = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const w = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()]!;
    const raidWeek: RaidWeekPhase = i < 7 ? "current" : "next";
    out.push({
      date,
      label: `${date.getMonth() + 1}/${date.getDate()} (${w})`,
      short: `${date.getMonth() + 1}/${date.getDate()} ${w}`,
      raidWeek,
    });
  }
  return out;
}

/** 교집합: 모든 참가자가 가능한 슬롯 */
export function intersectSlots(participantSlots: string[][]): string[] {
  if (participantSlots.length === 0) return [];
  let acc = new Set(participantSlots[0]);
  for (let i = 1; i < participantSlots.length; i++) {
    const next = new Set(participantSlots[i]);
    acc = new Set([...acc].filter((s) => next.has(s)));
  }
  return [...acc].sort();
}

export function groupConsecutive(sortedKeys: string[]): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  const toMin = (k: string) => {
    const p = parseSlotKey(k);
    if (!p) return null;
    const [yy, mo, dd] = p.day.split("-").map(Number);
    if (!yy || !mo || !dd) return null;
    return new Date(yy, mo - 1, dd).getTime() + p.minutes * 60_000;
  };
  const sorted = [...sortedKeys].sort((a, b) => (toMin(a) ?? 0) - (toMin(b) ?? 0));
  for (const k of sorted) {
    const t = toMin(k);
    if (t == null) continue;
    if (cur.length === 0) {
      cur.push(k);
      continue;
    }
    const prev = toMin(cur[cur.length - 1]!);
    if (prev != null && t - prev === 30 * 60_000) {
      cur.push(k);
    } else {
      groups.push(cur);
      cur = [k];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** 연속 구간을 24시간제 한 줄로 (날짜 넘어가면 양쪽 날짜 표기) */
export function formatRangeLabel(keys: string[]): string {
  if (keys.length === 0) return "";
  const first = parseSlotKey(keys[0]!);
  const last = parseSlotKey(keys[keys.length - 1]!);
  if (!first || !last) return keys.join(", ");
  const start = formatMinuteLabel(first.minutes);
  const endMin = last.minutes + 30;
  const end = formatMinuteLabel(endMin);
  if (first.day === last.day) {
    return `${first.day} ${start}–${end}`;
  }
  return `${first.day} ${start} – ${last.day} ${end}`;
}
