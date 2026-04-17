import { Fragment, useCallback, useEffect, useRef } from "react";
import type { DayColumn } from "../lib/slots";
import { slotKey } from "../lib/slots";

/** 당일 09:00–24:00 (30분 단위, 마지막 23:30) */
const SLOT_START_MIN = 9 * 60;
const SLOTS = (24 * 60 - SLOT_START_MIN) / 30;

function keyForSlot(slot: number, columnDate: Date): string {
  const D = new Date(columnDate);
  D.setHours(0, 0, 0, 0);
  const mins = SLOT_START_MIN + slot * 30;
  return slotKey(D, mins);
}

function keysForDay(columns: DayColumn[], dayIdx: number): string[] {
  const col = columns[dayIdx];
  if (!col) return [];
  return Array.from({ length: SLOTS }, (_, s) => keyForSlot(s, col.date));
}

function slotLabel(slot: number): string {
  const mins = SLOT_START_MIN + slot * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
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

export type SlotWho = {
  nickname: string;
  server_name: string;
};

function slotHoverTitle(key: string, heat: number, whoList: SlotWho[] | undefined): string {
  if (whoList && whoList.length > 0) {
    const lines = whoList.map((p) => `${p.nickname} (${p.server_name})`);
    return [`슬롯 ${key}`, `겹침 ${whoList.length}명`, ...lines].join("\n");
  }
  return heat > 0 ? `${key} · ${heat}명` : key;
}

type Props = {
  columns: DayColumn[];
  selected: Set<string>;
  onCellsChange: (updater: (prev: Set<string>) => Set<string>) => void;
  heatCount?: Map<string, number>;
  /** 슬롯 키별 겹침 인원(닉·서버) — 호버 툴팁용 */
  whoBySlot?: Map<string, SlotWho[]>;
};

export function TimeGrid({ columns, selected, onCellsChange, heatCount, whoBySlot }: Props) {
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const dragging = useRef(false);
  const dragSelect = useRef(true);
  const dragAnchor = useRef<CellPos | null>(null);
  const dragSnapshot = useRef<Set<string> | null>(null);
  /** Shift+클릭 구간의 시작점(직전 클릭 또는 마지막 일반 클릭 칸) */
  const shiftAnchorRef = useRef<CellPos | null>(null);

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
      if (e.shiftKey) return;
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
    const pos: CellPos = { dayIdx, slotIdx };

    if (e.shiftKey) {
      const anchor = shiftAnchorRef.current;
      const cols = columnsRef.current;
      if (anchor && (anchor.dayIdx !== pos.dayIdx || anchor.slotIdx !== pos.slotIdx)) {
        const keys = keysInRectangle(cols, anchor.dayIdx, pos.dayIdx, anchor.slotIdx, pos.slotIdx);
        onCellsChange((prev) => {
          const anchorKey = keyForSlot(anchor.slotIdx, cols[anchor.dayIdx]!.date);
          /** 기준 칸이 채워져 있으면 직사각형 전부 지우기, 비어 있으면 전부 채우기 */
          const anchorFilled = prev.has(anchorKey);
          const next = new Set(prev);
          for (const k of keys) {
            if (anchorFilled) next.delete(k);
            else next.add(k);
          }
          return next;
        });
      }
      shiftAnchorRef.current = pos;
      return;
    }

    shiftAnchorRef.current = pos;

    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
    const key = keyForSlot(slotIdx, columnsRef.current[dayIdx]!.date);
    dragSnapshot.current = new Set(selected);
    dragAnchor.current = pos;
    dragging.current = true;
    dragSelect.current = !selected.has(key);
    applyRectFromSnapshot(dragAnchor.current, pos, dragSelect.current);
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

  const morningSlots = 6;
  const afternoonSlots = SLOTS - morningSlots;

  return (
    <div
      className="slot-grid overflow-x-auto rounded-2xl border border-sky-200/80 bg-white/80 p-3 shadow-sm backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/70"
      style={{ touchAction: "none" }}
    >
      <div
        className="inline-grid gap-x-0.5 gap-y-1"
        style={{
          gridTemplateColumns: `148px repeat(${SLOTS}, minmax(20px, 1fr))`,
        }}
      >
        <div className="text-[9px] font-medium text-slate-500 dark:text-slate-400">시간 구간</div>
        <div
          className="flex flex-col items-center justify-center rounded-md bg-sky-100/90 px-1 py-1 text-center dark:bg-slate-800/80"
          style={{ gridColumn: `2 / span ${morningSlots}` }}
        >
          <span className="text-[10px] font-bold text-blue-800 dark:text-blue-200">09:00–12:00</span>
          <span className="text-[8px] leading-tight text-slate-600 dark:text-slate-400">24시 · 전반</span>
        </div>
        <div
          className="flex flex-col items-center justify-center rounded-md bg-blue-50/90 px-1 py-1 text-center dark:bg-blue-950/30"
          style={{ gridColumn: `${2 + morningSlots} / span ${afternoonSlots}` }}
        >
          <span className="text-[10px] font-bold text-blue-900 dark:text-blue-100">12:00–24:00</span>
          <span className="text-[8px] leading-tight text-blue-800/80 dark:text-blue-300/90">24시 · 후반</span>
        </div>

        <div className="flex items-end pb-1 text-[10px] font-medium text-sky-700 dark:text-sky-300">
          날짜 / 전체
        </div>
        {Array.from({ length: SLOTS }, (_, slot) => (
          <div
            key={`h-${slot}`}
            className="flex h-11 min-w-[20px] flex-col items-center justify-end pb-0.5 text-center"
          >
            <span className="whitespace-nowrap text-[9px] font-semibold tabular-nums leading-none text-slate-600 dark:text-slate-400">
              {slotLabel(slot)}
            </span>
          </div>
        ))}

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
                      ? "border-blue-700 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-600"
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
                const showCount = heat > 0;
                const whoList = whoBySlot?.get(key);
                return (
                  <button
                    key={`${col.label}-${slot}`}
                    type="button"
                    aria-pressed={on}
                    data-slot={key}
                    data-day-index={dayIdx}
                    data-slot-index={slot}
                    className={[
                      "relative h-10 min-w-[20px] rounded-md transition-colors",
                      on
                        ? "z-[1] border-[3px] border-blue-800 bg-blue-500/40 shadow-sm dark:border-blue-300 dark:bg-blue-500/45"
                        : showCount
                          ? "border border-blue-200/90 bg-blue-50/90 dark:border-blue-900/50 dark:bg-blue-950/40"
                          : "border border-slate-200/90 bg-white/90 hover:border-blue-200 hover:bg-blue-50/50 dark:border-slate-600 dark:bg-slate-800/80 dark:hover:border-blue-900",
                    ].join(" ")}
                    onPointerDown={(e) => onCellPointerDown(e, dayIdx, slot)}
                    title={slotHoverTitle(key, heat, whoList)}
                  >
                    <span
                      className={[
                        "relative z-10 flex h-full w-full flex-col items-center justify-center gap-0 leading-none",
                        showCount
                          ? "text-[11px] font-bold tabular-nums text-blue-900 dark:text-blue-100"
                          : "text-[10px] text-slate-300 dark:text-slate-600",
                      ].join(" ")}
                    >
                      {showCount ? heat : ""}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          );
        })}
      </div>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        <p>
          <strong>실행 취소:</strong> 표에서 칸을 바꾼 뒤 <strong>Ctrl+Z</strong>(Mac은{" "}
          <strong>⌘+Z</strong>)로 직전 변경을 되돌릴 수 있습니다. 입력란에 포커스가 있을 때는 동작하지
          않습니다.
        </p>
        <p>
          겹침이 있는 칸에 <strong>마우스를 올리면</strong> 닉네임·서버가 툴팁으로 표시됩니다.{" "}
          <strong>숫자</strong>는 그 30분에 가능하다고 적은 인원 수입니다.
        </p>
        <p>
          내가 선택한 칸은{" "}
          <strong className="text-blue-900 dark:text-blue-200">파란 배경 + 진한 테두리</strong>, 다른 사람만
          있으면 연한 파란 배경에 숫자만 보입니다.
        </p>
        <p>
          <strong>Shift</strong>로 두 칸을 찍으면 직사각형이 한 번에 바뀝니다.{" "}
          <strong>기준 칸이 채워진 상태</strong>면 그 범위를 지우고, <strong>빈 칸이 기준</strong>이면 그
          범위를 채웁니다.
          <br />
          (기준은 직전에 누른 칸 — Shift 없이 한 번 누른 뒤 Shift로 두 번째 클릭.)
        </p>
        <p>
          Shift 없이 드래그하면 직사각형으로 선택·해제합니다. 당일 <strong>09:00–24:00</strong>만
          표시합니다.
        </p>
      </div>
    </div>
  );
}
