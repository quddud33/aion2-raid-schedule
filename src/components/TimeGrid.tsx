import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

const OVERLAP_LEAVE_MS = 140;

type OverlapPopoverState = {
  slotKey: string;
  headline: string;
  heat: number;
  who: SlotWho[];
  anchorCenterX: number;
  anchorBottom: number;
  anchorTop: number;
};

function ariaSlotLabel(key: string, heat: number): string {
  if (heat > 0) return `시간 칸 ${key}, 겹침 ${heat}명 — 자세한 목록은 포인터를 올리면 표시`;
  return `시간 칸 ${key}`;
}

type Props = {
  columns: DayColumn[];
  selected: Set<string>;
  onCellsChange: (updater: (prev: Set<string>) => Set<string>) => void;
  /** 포인터 드래그 시작 — 실행 취소를 드래그 한 번 단위로 묶음 */
  onDragUndoSessionStart?: () => void;
  /** 포인터 드래그 종료(버튼 업·캡처 해제 등) */
  onDragUndoSessionEnd?: () => void;
  heatCount?: Map<string, number>;
  /** 슬롯 키별 겹침 인원(닉·서버) — 호버 툴팁용 */
  whoBySlot?: Map<string, SlotWho[]>;
  /** 표 카드 상단(제목·설명 등) — 하단 도움말과 같은 카드 안 */
  scheduleIntro?: ReactNode;
};

export function TimeGrid({
  columns,
  selected,
  onCellsChange,
  onDragUndoSessionStart,
  onDragUndoSessionEnd,
  heatCount,
  whoBySlot,
  scheduleIntro,
}: Props) {
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const dragging = useRef(false);
  const dragSelect = useRef(true);
  const dragAnchor = useRef<CellPos | null>(null);
  const dragSnapshot = useRef<Set<string> | null>(null);
  /** Shift+클릭 구간의 시작점(직전 클릭 또는 마지막 일반 클릭 칸) */
  const shiftAnchorRef = useRef<CellPos | null>(null);
  /** 마지막 일반 클릭으로 “기준”으로 삼은 칸(Shift 직사각형 모드는 이 칸을 눌렀을 때의 선택 여부만 사용) */
  const shiftDesignatedAnchorRef = useRef<CellPos | null>(null);
  const shiftBaselineHadSlotRef = useRef(false);

  const [overlapPopover, setOverlapPopover] = useState<OverlapPopoverState | null>(null);
  const leaveOverlapTimerRef = useRef<number | null>(null);

  const cancelOverlapClose = useCallback(() => {
    if (leaveOverlapTimerRef.current != null) {
      window.clearTimeout(leaveOverlapTimerRef.current);
      leaveOverlapTimerRef.current = null;
    }
  }, []);

  const scheduleOverlapClose = useCallback(() => {
    cancelOverlapClose();
    leaveOverlapTimerRef.current = window.setTimeout(() => {
      setOverlapPopover(null);
      leaveOverlapTimerRef.current = null;
    }, OVERLAP_LEAVE_MS);
  }, [cancelOverlapClose]);

  useEffect(() => () => cancelOverlapClose(), [cancelOverlapClose]);

  useEffect(() => {
    if (!overlapPopover) return;
    const onScroll = () => setOverlapPopover(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [overlapPopover]);

  useEffect(() => {
    if (!overlapPopover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlapPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlapPopover]);

  const openOverlapPopover = useCallback(
    (rect: DOMRect, slotKey: string, headline: string, heat: number, who: SlotWho[]) => {
      cancelOverlapClose();
      setOverlapPopover({
        slotKey,
        headline,
        heat,
        who,
        anchorCenterX: rect.left + rect.width / 2,
        anchorBottom: rect.bottom,
        anchorTop: rect.top,
      });
    },
    [cancelOverlapClose],
  );

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
    onDragUndoSessionEnd?.();
  }, [onDragUndoSessionEnd]);

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
    cancelOverlapClose();
    setOverlapPopover(null);
    const pos: CellPos = { dayIdx, slotIdx };

    if (e.shiftKey) {
      const anchor = shiftAnchorRef.current;
      const cols = columnsRef.current;
      if (anchor && (anchor.dayIdx !== pos.dayIdx || anchor.slotIdx !== pos.slotIdx)) {
        const designated = shiftDesignatedAnchorRef.current;
        const sameDesignated =
          designated != null &&
          designated.dayIdx === anchor.dayIdx &&
          designated.slotIdx === anchor.slotIdx;
        const anchorKey = keyForSlot(anchor.slotIdx, cols[anchor.dayIdx]!.date);
        /** 일반 클릭으로 지정한 기준 칸이면, 그때의 선택 여부로 채움/비움. 연속 Shift만 쓴 경우는 당시 선택 기준 */
        const selectRect = sameDesignated ? !shiftBaselineHadSlotRef.current : !selected.has(anchorKey);
        dragSnapshot.current = new Set(selected);
        dragSelect.current = selectRect;
        applyRectFromSnapshot(anchor, pos, selectRect);
      }
      shiftAnchorRef.current = pos;
      return;
    }

    const key = keyForSlot(slotIdx, columnsRef.current[dayIdx]!.date);
    shiftAnchorRef.current = pos;
    shiftDesignatedAnchorRef.current = pos;
    shiftBaselineHadSlotRef.current = selected.has(key);

    onDragUndoSessionStart?.();

    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
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
      {scheduleIntro != null && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-sky-100/90 pb-3 dark:border-slate-700/90">
          {scheduleIntro}
        </div>
      )}
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
                const headline = `${col.short} · ${slotLabel(slot)}`;
                return (
                  <button
                    key={`${col.label}-${slot}`}
                    type="button"
                    aria-pressed={on}
                    aria-label={ariaSlotLabel(key, heat)}
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
                    onPointerEnter={(e) => {
                      if (heat <= 0 || dragging.current) return;
                      openOverlapPopover(
                        (e.currentTarget as HTMLButtonElement).getBoundingClientRect(),
                        key,
                        headline,
                        heat,
                        whoList ?? [],
                      );
                    }}
                    onPointerLeave={scheduleOverlapClose}
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
      {overlapPopover &&
        typeof document !== "undefined" &&
        createPortal(
          (() => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const half = 120;
            const pad = 10;
            const cx = Math.min(
              Math.max(overlapPopover.anchorCenterX, pad + half),
              vw - pad - half,
            );
            const maxPop = Math.min(224, Math.max(160, vh - 32));
            const gap = 8;
            const estBelow = overlapPopover.anchorBottom + gap + maxPop;
            const showAbove = estBelow > vh && overlapPopover.anchorTop > 96;
            const top = showAbove ? overlapPopover.anchorTop - gap : overlapPopover.anchorBottom + gap;
            const transform = showAbove ? "translate(-50%, -100%)" : "translateX(-50%)";
            return (
              <div
                role="dialog"
                aria-label={`이 시간 겹침 ${overlapPopover.heat}명`}
                className="pointer-events-auto fixed z-[300] flex w-60 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-sky-200/95 bg-white/98 shadow-xl shadow-sky-900/10 outline-none backdrop-blur-md dark:border-slate-600 dark:bg-slate-900/98 dark:shadow-black/40"
                style={{
                  left: cx,
                  top,
                  transform,
                  maxHeight: maxPop,
                }}
                onPointerEnter={cancelOverlapClose}
                onPointerLeave={scheduleOverlapClose}
              >
                <div className="shrink-0 border-b border-sky-100/80 px-3 pb-2 pt-3 dark:border-slate-700/90">
                  <p className="text-[11px] font-semibold leading-snug text-slate-800 dark:text-slate-100">
                    {overlapPopover.headline}
                  </p>
                  <p className="mt-1.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                    가능으로 표시된 인원 {overlapPopover.heat}명
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
                  {overlapPopover.who.length > 0 ? (
                    <ul className="divide-y divide-sky-100/80 dark:divide-slate-700/80">
                      {overlapPopover.who.map((p, i) => (
                        <li
                          key={`${overlapPopover.slotKey}-${i}-${p.nickname}`}
                          className="flex flex-col gap-0.5 py-2.5 first:pt-1 last:pb-1"
                        >
                          <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                            {p.nickname}
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">{p.server_name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-1 text-xs text-slate-500 dark:text-slate-400">표시할 닉네임이 없습니다.</p>
                  )}
                </div>
              </div>
            );
          })(),
          document.body,
        )}
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        <p>
          <strong>실행 취소:</strong> 표에서 칸을 바꾼 뒤 <strong>Ctrl+Z</strong>(Mac은{" "}
          <strong>⌘+Z</strong>)로 직전 변경을 되돌릴 수 있습니다. 입력란에 포커스가 있을 때는 동작하지
          않습니다. <strong>드래그</strong>로 칸을 여러 번 바꿔도, 누르기부터 떼기까지는{" "}
          <strong>한 번의 실행 취소</strong>로 통째로 되돌아갑니다.
        </p>
        <p>
          겹침이 있는 칸에 <strong>포인터를 올리면</strong> 닉네임·서버 목록이 화면 위쪽 팝업으로 표시됩니다.{" "}
          <strong>숫자</strong>는 그 30분에 가능하다고 적은 인원 수입니다.
        </p>
        <p>
          내가 선택한 칸은{" "}
          <strong className="text-blue-900 dark:text-blue-200">파란 배경 + 진한 테두리</strong>, 다른 사람만
          있으면 연한 파란 배경에 숫자만 보입니다.
        </p>
        <p>
          <strong>Shift</strong>로 다른 칸을 누르면, <strong>바로 직전 일반 클릭</strong>으로 찍은 칸부터 그
          칸까지 직사각형이 적용됩니다. 채움/비움은 그 <strong>일반 클릭 순간</strong>에 그 칸이 비어 있었는지
          여부로 정해지며, 그 사이에 다른 칸만 바뀌어도 기준은 변하지 않습니다. 연속으로 Shift만 이어 쓸 때는
          직전 칸을 기준으로 당시 선택 상태를 봅니다.
        </p>
        <p>
          Shift 없이 드래그하면 기준 칸에서 포인터를 움직이며 같은 방식으로 직사각형을 선택·해제합니다. 당일{" "}
          <strong>09:00–24:00</strong>만 표시합니다.
        </p>
      </div>
    </div>
  );
}
