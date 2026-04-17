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

/** 표시용: 30분 단위 라벨 */
export function formatMinuteLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export type DayColumn = {
  date: Date;
  label: string;
  short: string;
};

export function buildWeekColumns(start: Date, dayCount: number): DayColumn[] {
  const out: DayColumn[] = [];
  const base = new Date(start);
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()]!;
    out.push({
      date: d,
      label: `${d.getMonth() + 1}/${d.getDate()} (${w})`,
      short: `${d.getMonth() + 1}/${d.getDate()}`,
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

export function formatRangeLabel(keys: string[]): string {
  if (keys.length === 0) return "";
  const first = parseSlotKey(keys[0]!);
  const last = parseSlotKey(keys[keys.length - 1]!);
  if (!first || !last) return keys.join(", ");
  const start = formatMinuteLabel(first.minutes);
  const endMin = last.minutes + 30;
  const end = formatMinuteLabel(endMin);
  return `${first.day} ${start}–${end}`;
}
