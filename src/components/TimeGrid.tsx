import { Fragment, useCallback, useEffect, useRef } from "react";
import type { DayColumn } from "../lib/slots";
import { slotKey } from "../lib/slots";

const SLOTS = 24; // 18:00~익일 06:00, 30분 간격

function keyForSlot(slot: number, columnDate: Date): string {
  const D = new Date(columnDate);
  D.setHours(0, 0, 0, 0);
  if (slot < 12) {
    const d = new Date(D);
    d.setHours(18, 0, 0, 0);
    d.setMinutes(d.getMinutes() + slot * 30);
    const mins = d.getHours() * 60 + d.getMinutes();
    return slotKey(d, mins);
  }
  const d = new Date(D);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  d.setMinutes((slot - 12) * 30);
  const mins = d.getHours() * 60 + d.getMinutes();
  return slotKey(d, mins);
}

function keysForDay(columns: DayColumn[], dayIdx: number): string[] {
  const col = columns[dayIdx];
  if (!col) return [];
  return Array.from({ length: SLOTS }, (_, s) => keyForSlot(s, col.date));
}

function slotLabel(slot: number): string {
  if (slot < 12) {
    const total = 18 * 60 + slot * 30;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const total = (slot - 12) * 30;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function keysInRectangle(
  columns: DayColumn[],
  d0: number,
  d1: number,
  s0: number,
  s1: number,
): string[] {
  const da = Math.min(d0, d1);
  const db = Math.max(d0, d1);
  const sa = Math.min(s0, s1);
  const sb = Math.max(s0, s1);
  const keys: string[] = [];
  for (let d = da; d <= db; d++) {
    const col = columns[d];
    if (!col) continue;
    for (let s = sa; s <= sb; s++) {
      keys.push(keyForSlot(s, col.date));
    }
  }
  return keys;
}

type CellPos = { dayIdx: number; slotIdx: number };

type Props = {
  columns: DayColumn[];
  selected: Set<string>;
  onCellsChange: (updater: (prev: Set<string>) => Set<string>) => void;
  heatCount?: Map<string, number>;
  maxHeat?: number;
};

export function TimeGrid({ columns, selected, onCellsChange, heatCount, maxHeat }: Props) {
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const dragging = useRef(false);
  const dragSelect = useRef(true);
  const dragAnchor = useRef<CellPos | null>(null);
  const dragSnapshot = useRef<Set<string> | null>(null);

  const applyRectFromSnapshot = useCallback((anchor: CellPos, current: CellPos, select: boolean) => {
    const cols = columnsRef.current;
    const keys = keysInRectangle(cols, anchor.dayIdx, current.dayIdx, anchor.slotIdx, current.slotIdx);
    const base = dragSnapshot.current ?? new Set<string>();
    onCellsChange(() => {
      const next = new Set(base);
      for (const k of keys) {
        if (select) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, [onCellsChange]);

  const endDrag = useCallback(() => {
    dragging.current = false;
    dragAnchor.current = null;
    dragSnapshot.current = null;
  }, []);

  const resolveCellFromPoint = useCallback((clientX: number, clientY: number): CellPos | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const btn = el?.closest("[data-slot]");
    if (!btn) return null;
    const day = btn.getAttribute("data-day-index");
    const slot = btn.getAttribute("data-slot-index");
    if (day == null || slot == null) return null;
    const dayIdx = Number(day);
    const slotIdx = Number(slot);
    if (Number.isNaN(dayIdx) || Number.isNaN(slotIdx)) return null;
    return { dayIdx, slotIdx };
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current || !dragAnchor.current) return;
      const cur = resolveCellFromPoint(e.clientX, e.clientY);
      if (!cur) return;
      applyRectFromSnapshot(dragAnchor.current, cur, dragSelect.current);
    };
    const onPointerUp = () => endDrag();
    const onLostCapture = () => endDrag();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onPointerUp);
    window.addEventListener("lostpointercapture", onLostCapture);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onPointerUp);
      window.removeEventListener("lostpointercapture", onLostCapture);
    };
  }, [applyRectFromSnapshot, endDrag, resolveCellFromPoint]);

  const onCellPointerDown = (e: React.PointerEvent, dayIdx: number, slotIdx: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
    const key = keyForSlot(slotIdx, columnsRef.current[dayIdx]!.date);
    dragSnapshot.current = new Set(selected);
    dragAnchor.current = { dayIdx, slotIdx };
    dragging.current = true;
    dragSelect.current = !selected.has(key);
    applyRectFromSnapshot(dragAnchor.current, { dayIdx, slotIdx }, dragSelect.current);
  };

  const toggleDayAll = (e: React.MouseEvent, dayIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const keys = keysForDay(columnsRef.current, dayIdx);
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
    onCellsChange((prev) => {
      const next = new Set(prev);
      if (allOn) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });
  };

  return (
    <div
      className="slot-grid overflow-x-auto rounded-2xl border border-sky-200/80 bg-white/80 p-3 shadow-sm backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/70"
      style={{ touchAction: "none" }}
    >
      <div
        className="inline-grid gap-x-0.5 gap-y-1"
        style={{
          gridTemplateColumns: `148px repeat(${SLOTS}, minmax(24px, 1fr))`,
        }}
      >
        {/* 그룹 헤더: 12:00–24:00(당일 저녁) | 00:00–12:00(익일 새벽) */}
        <div className="text-[9px] font-medium text-slate-500 dark:text-slate-400">시간 구간</div>
        <div
          className="flex flex-col items-center justify-center rounded-md bg-slate-100/90 px-1 py-1 text-center dark:bg-slate-800/80"
          style={{ gridColumn: "2 / span 12" }}
        >
          <span className="text-[10px] font-bold text-slate-700 dark:text-slate-200">12:00–24:00</span>
          <span className="text-[8px] leading-tight text-slate-500 dark:text-slate-400">당일 18:00–24:00 (30분 단위)</span>
        </div>
        <div
          className="flex flex-col items-center justify-center rounded-md bg-violet-50/90 px-1 py-1 text-center dark:bg-violet-950/40"
          style={{ gridColumn: "14 / span 12" }}
        >
          <span className="text-[10px] font-bold text-violet-800 dark:text-violet-200">00:00–12:00</span>
          <span className="text-[8px] leading-tight text-violet-600 dark:text-violet-300">익일 00:00–06:00 (30분 단위)</span>
        </div>

        <div className="flex items-end pb-1 text-[10px] font-medium text-sky-700 dark:text-sky-300">
          날짜 / 전체
        </div>
        {Array.from({ length: SLOTS }, (_, slot) => {
          const time = slotLabel(slot);
          const isNextDay = slot >= 12;
          return (
            <div
              key={`h-${slot}`}
              className="flex h-12 min-w-[24px] flex-col items-center justify-end gap-0 pb-0.5 text-center"
            >
              <span
                className={[
                  "whitespace-nowrap text-[9px] font-semibold tabular-nums leading-none",
                  isNextDay ? "text-violet-600 dark:text-violet-300" : "text-slate-600 dark:text-slate-400",
                ].join(" ")}
                title={isNextDay ? `${time} (익일)` : time}
              >
                {time}
              </span>
              {isNextDay && (
                <span className="text-[8px] font-medium leading-none text-violet-500 dark:text-violet-400">
                  익일
                </span>
              )}
            </div>
          );
        })}

        {columns.map((col, dayIdx) => {
          const dayKeys = keysForDay(columns, dayIdx);
          const allOn = dayKeys.length > 0 && dayKeys.every((k) => selected.has(k));
          return (
            <Fragment key={col.label}>
              <div
                className={[
                  "flex min-h-[2.25rem] items-stretch gap-1 border-r py-0.5 pr-1 text-xs font-semibold leading-tight",
                  col.raidWeek === "next"
                    ? "border-violet-200 text-violet-800 dark:border-violet-800/60 dark:text-violet-200"
                    : "border-sky-100 text-slate-800 dark:border-slate-700 dark:text-slate-100",
                ].join(" ")}
                title={col.label}
              >
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="truncate">{col.short}</span>
                  {col.raidWeek === "next" && (
                    <span className="mt-0.5 w-fit rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-800 dark:bg-violet-900/60 dark:text-violet-200">
                      차주
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className={[
                    "shrink-0 self-center rounded-md border px-1.5 py-1 text-[10px] font-bold leading-none transition",
                    allOn
                      ? "border-sky-500 bg-sky-500 text-white dark:border-sky-400 dark:bg-sky-600"
                      : "border-sky-200 bg-white text-sky-700 hover:bg-sky-50 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-300 dark:hover:bg-slate-700",
                  ].join(" ")}
                  onClick={(e) => toggleDayAll(e, dayIdx)}
                  title={allOn ? "이 날짜 전체 해제" : "이 날짜 전체 선택"}
                >
                  전체
                  <br />
                  {allOn ? "✓" : "□"}
                </button>
              </div>
              {Array.from({ length: SLOTS }, (_, slot) => {
                const key = keyForSlot(slot, col.date);
                const on = selected.has(key);
                const heat = heatCount?.get(key) ?? 0;
                const mh = Math.max(1, maxHeat ?? 1);
                const heatRatio = heat / mh;
                return (
                  <button
                    key={`${col.label}-${slot}`}
                    type="button"
                    aria-pressed={on}
                    data-slot={key}
                    data-day-index={dayIdx}
                    data-slot-index={slot}
                    className={[
                      "relative h-9 min-w-[24px] rounded-md border transition-colors",
                      on
                        ? "border-sky-500 bg-sky-400/50 shadow-sm dark:border-sky-400 dark:bg-sky-500/35"
                        : "border-slate-200/90 bg-white/90 hover:border-sky-300 hover:bg-sky-50/80 dark:border-slate-600 dark:bg-slate-800/80 dark:hover:border-sky-600 dark:hover:bg-slate-700/80",
                    ].join(" ")}
                    onPointerDown={(e) => onCellPointerDown(e, dayIdx, slot)}
                    title={key}
                  >
                    {heatCount && heat > 0 && (
                      <span
                        className="pointer-events-none absolute inset-0 rounded-md"
                        style={{
                          background: `rgba(14, 165, 233, ${0.12 + heatRatio * 0.35})`,
                        }}
                      />
                    )}
                    <span
                      className={[
                        "relative z-10 flex h-full w-full items-center justify-center text-[10px]",
                        on ? "font-semibold text-sky-950 dark:text-sky-50" : "text-slate-400 dark:text-slate-500",
                      ].join(" ")}
                    >
                      {on ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        가로는 24시간제(12–24시 당일 저녁, 0–12시 익일 새벽), 세로는 날짜입니다. 셀에서 드래그하면{" "}
        <strong className="text-slate-700 dark:text-slate-300">시작 칸–끝 칸 직사각형 전체</strong>가 한 번에
        선택/해제됩니다. 날짜 오른쪽 <strong>전체</strong>는 해당 날 18:00~익일 06:00 전 구간을 토글합니다.
      </p>
    </div>
  );
}
