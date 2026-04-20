import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

type CellPos = { dayIdx: number; slotIdx: number };

/** 드래그·Shift 직사각형 중 날짜/시간 축 하이라이트용 */
type BrushRect = { dayMin: number; dayMax: number; slotMin: number; slotMax: number };

function brushFromCells(a: CellPos, b: CellPos): BrushRect {
  return {
    dayMin: Math.min(a.dayIdx, b.dayIdx),
    dayMax: Math.max(a.dayIdx, b.dayIdx),
    slotMin: Math.min(a.slotIdx, b.slotIdx),
    slotMax: Math.max(a.slotIdx, b.slotIdx),
  };
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

export type SlotWho = {
  nickname: string;
  /** Discord 등 프로필 URL — 없으면 이니셜만 */
  avatar_url?: string | null;
};

const OVERLAP_LEAVE_MS = 140;

const MOBILE_MQ = "(max-width: 767px)";
const VERTICAL_MODE_STORAGE_KEY = "aion2-timegrid-vertical-day";

function readVerticalModePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(VERTICAL_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeVerticalModePreference(on: boolean) {
  try {
    if (on) window.sessionStorage.setItem(VERTICAL_MODE_STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(VERTICAL_MODE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** md 미만에서만 true — 세로 편집·날짜 칩 등 */
function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** 가로 스크롤 시 첫 열(날짜·축 라벨) 고정 — 옆으로 번지는 box-shadow는 PC에서 얼룩처럼 보일 수 있어 테두리만 사용 */
const scrollStickyCorner =
  "sticky left-0 z-20 border-r border-slate-200/95 bg-white/98 dark:border-slate-600 dark:bg-slate-900/98";
const scrollStickyTimeAxis =
  "sticky left-0 z-[15] border-r border-slate-200/95 bg-white/98 dark:border-slate-600 dark:bg-slate-900/98";
const scrollStickyDayAxis =
  "sticky left-0 z-10 border-r border-slate-200/95 bg-white/98 dark:border-slate-600 dark:bg-slate-900/98";

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
  /** 슬롯 키별 겹침 인원(닉네임) — 호버 툴팁용 */
  whoBySlot?: Map<string, SlotWho[]>;
  /** 표 카드 상단(제목·설명 등) — 하단 도움말과 같은 카드 안 */
  scheduleIntro?: ReactNode;
  /** 제목 옆·아래에 붙는 저장 등 액션(가능 시간 저장 버튼 등) */
  scheduleToolbar?: ReactNode;
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
  scheduleToolbar,
}: Props) {
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const dragging = useRef(false);
  const dragSelect = useRef(true);
  const dragAnchor = useRef<CellPos | null>(null);
  const dragSnapshot = useRef<Set<string> | null>(null);
  /** Shift 없이 마지막으로 누른 칸(직사각형 한쪽·체인 끝) */
  const shiftAnchorRef = useRef<CellPos | null>(null);
  /** 마지막 일반 클릭으로 지정한 기준 칸(Shift 채움/비움 판별) */
  const shiftDesignatedAnchorRef = useRef<CellPos | null>(null);
  const shiftBaselineHadSlotRef = useRef(false);
  /** Shift 키를 누른 세션에서 직사각형 고정 꼭짓점(첫 Shift+클릭 직전의 shiftAnchor) — Shift를 떼면 해제 */
  const shiftRectOriginRef = useRef<CellPos | null>(null);

  const [overlapPopover, setOverlapPopover] = useState<OverlapPopoverState | null>(null);
  const [brushRect, setBrushRect] = useState<BrushRect | null>(null);
  const leaveOverlapTimerRef = useRef<number | null>(null);

  const gridScrollRef = useRef<HTMLDivElement>(null);
  const dayRowLabelRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** 모바일: 가로 스크롤 가능 여부 + 끝 도달 (버튼·가장자리 힌트용) */
  const [hScroll, setHScroll] = useState({ overflow: false, canLeft: false, canRight: false });
  const narrowLayout = useNarrowLayout();
  const [mobileVerticalDay, setMobileVerticalDay] = useState(readVerticalModePreference);
  const [verticalDayIdx, setVerticalDayIdx] = useState(0);

  useEffect(() => {
    if (!narrowLayout && mobileVerticalDay) {
      setMobileVerticalDay(false);
      writeVerticalModePreference(false);
    }
  }, [narrowLayout, mobileVerticalDay]);

  useEffect(() => {
    if (verticalDayIdx >= columns.length) setVerticalDayIdx(0);
  }, [columns.length, verticalDayIdx]);

  const updateHScroll = useCallback(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 2) {
      setHScroll({ overflow: false, canLeft: false, canRight: false });
      return;
    }
    setHScroll({
      overflow: true,
      canLeft: el.scrollLeft > 2,
      canRight: el.scrollLeft < max - 2,
    });
  }, []);

  useLayoutEffect(() => {
    updateHScroll();
    const el = gridScrollRef.current;
    if (!el) return;
    const onScroll = () => updateHScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateHScroll()) : null;
    ro?.observe(el);
    window.addEventListener("resize", updateHScroll);
    const t = window.setTimeout(updateHScroll, 0);
    return () => {
      window.clearTimeout(t);
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      window.removeEventListener("resize", updateHScroll);
    };
  }, [updateHScroll, columns]);

  const scrollGridPage = useCallback((dir: -1 | 1) => {
    const el = gridScrollRef.current;
    if (!el) return;
    const step = Math.max(176, Math.min(Math.floor(el.clientWidth * 0.78), 360));
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  }, []);

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
    const onShiftKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      shiftRectOriginRef.current = null;
    };
    window.addEventListener("keyup", onShiftKeyUp);
    return () => window.removeEventListener("keyup", onShiftKeyUp);
  }, []);

  useEffect(() => {
    if (!overlapPopover) return;
    const onScroll = () => setOverlapPopover(null);
    window.addEventListener("scroll", onScroll, true);
    const gridEl = gridScrollRef.current;
    gridEl?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      gridEl?.removeEventListener("scroll", onScroll);
    };
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
    setBrushRect(null);
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
      setBrushRect(brushFromCells(dragAnchor.current, cur));
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
    setBrushRect(null);
    const pos: CellPos = { dayIdx, slotIdx };

    if (e.shiftKey) {
      const anchor = shiftAnchorRef.current;
      const cols = columnsRef.current;
      if (anchor && (anchor.dayIdx !== pos.dayIdx || anchor.slotIdx !== pos.slotIdx)) {
        if (shiftRectOriginRef.current == null) {
          shiftRectOriginRef.current = anchor;
        }
        const origin = shiftRectOriginRef.current;
        if (origin) {
          const designated = shiftDesignatedAnchorRef.current;
          /** 직사각형 꼭짓점은 origin(Shift 세션 첫 기준), 채움/비움은 직전 칸 anchor 기준 — 예전 로직 */
          const sameDesignated =
            designated != null &&
            designated.dayIdx === anchor.dayIdx &&
            designated.slotIdx === anchor.slotIdx;
          const anchorKey = keyForSlot(anchor.slotIdx, cols[anchor.dayIdx]!.date);
          const selectRect = sameDesignated ? !shiftBaselineHadSlotRef.current : !selected.has(anchorKey);
          dragSnapshot.current = new Set(selected);
          dragSelect.current = selectRect;
          applyRectFromSnapshot(origin, pos, selectRect);
          setBrushRect(brushFromCells(origin, pos));
        }
      }
      shiftAnchorRef.current = pos;
      return;
    }

    shiftRectOriginRef.current = null;

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
    setBrushRect(brushFromCells(pos, pos));
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

  const inBrushDay = (d: number) => brushRect != null && d >= brushRect.dayMin && d <= brushRect.dayMax;
  const inBrushSlot = (s: number) => brushRect != null && s >= brushRect.slotMin && s <= brushRect.slotMax;
  const brushHitsMorning =
    brushRect != null && brushRect.slotMin < morningSlots && brushRect.slotMax >= 0;
  const brushHitsAfternoon =
    brushRect != null && brushRect.slotMax >= morningSlots && brushRect.slotMin <= SLOTS - 1;

  const slotHeaderGlow =
    "font-semibold text-sky-700 drop-shadow-[0_0_10px_rgba(56,189,248,0.65)] dark:text-sky-100 dark:drop-shadow-[0_0_14px_rgba(125,211,252,0.5)]";
  const slotHeaderIdle =
    "font-semibold text-slate-600 dark:text-slate-400 md:text-[9px]";

  return (
    <div className="slot-grid max-w-full rounded-2xl border border-sky-200/80 bg-white/80 p-5 shadow-sm backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/70">
      {(scheduleIntro != null || scheduleToolbar != null) && (
        <div className="mb-3 border-b border-sky-100/90 pb-3 dark:border-slate-700/90">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            {scheduleIntro != null ? <div className="min-w-0 flex-1">{scheduleIntro}</div> : null}
            {scheduleToolbar != null ? (
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:max-w-md sm:flex-row sm:justify-end">
                {scheduleToolbar}
              </div>
            ) : null}
          </div>
          {scheduleIntro != null ? (
            <p className="mt-2 w-full text-[11px] leading-snug text-slate-500 dark:text-slate-400 md:hidden">
              <strong className="text-slate-600 dark:text-slate-300">세로 편집</strong>으로 하루만 크게
              펼쳐 입력하거나, 날짜 칩으로 해당 줄로 이동할 수 있습니다. 표 모드에서는{" "}
              <strong className="text-slate-600 dark:text-slate-300">가로 스크롤</strong>·이전·다음 시간
              버튼을 쓰면 됩니다.
            </p>
          ) : null}
        </div>
      )}

      {narrowLayout ? (
        <div className="mb-3 flex flex-col gap-2 md:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !mobileVerticalDay;
                setMobileVerticalDay(next);
                writeVerticalModePreference(next);
              }}
              className={[
                "min-h-11 shrink-0 rounded-xl border px-3 text-sm font-semibold shadow-sm transition active:scale-[0.98]",
                mobileVerticalDay
                  ? "border-violet-400 bg-violet-600 text-white dark:border-violet-500 dark:bg-violet-600"
                  : "border-sky-300/90 bg-white text-sky-900 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-100",
              ].join(" ")}
            >
              {mobileVerticalDay ? "표로 보기" : "세로 편집 (하루)"}
            </button>
            <span className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
              {mobileVerticalDay
                ? "시간만 위아래로 훑으면 됩니다."
                : "날짜 칩을 누르면 그날 행으로 스크롤됩니다."}
            </span>
          </div>
          {!mobileVerticalDay ? (
            <div
              className="-mx-1 flex gap-1.5 overflow-x-auto overscroll-x-contain px-1 py-0.5 [scrollbar-width:thin]"
              role="tablist"
              aria-label="날짜로 이동"
            >
              {columns.map((col, i) => (
                <button
                  key={`jump-${col.label}`}
                  type="button"
                  role="tab"
                  onClick={() => {
                    setVerticalDayIdx(i);
                    dayRowLabelRefs.current[i]?.scrollIntoView({
                      behavior: "smooth",
                      block: "center",
                    });
                  }}
                  className={[
                    "flex min-h-10 min-w-0 shrink-0 flex-col items-center justify-center rounded-xl border px-2.5 py-1.5 text-center transition active:scale-[0.98]",
                    col.raidWeek === "next"
                      ? "border-violet-300/90 bg-violet-50/90 text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100"
                      : "border-sky-200/90 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
                  ].join(" ")}
                >
                  <span className="max-w-[5.25rem] truncate text-[11px] font-bold leading-tight">{col.short}</span>
                  {col.raidWeek === "next" ? (
                    <span className="mt-0.5 text-[9px] font-bold text-violet-700 dark:text-violet-300">차주</span>
                  ) : (
                    <span className="mt-0.5 text-[9px] font-medium text-slate-500 dark:text-slate-400">금주</span>
                  )}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {hScroll.overflow && !mobileVerticalDay ? (
        <div className="mb-2 grid grid-cols-2 gap-2 md:hidden">
          <button
            type="button"
            disabled={!hScroll.canLeft}
            onClick={() => scrollGridPage(-1)}
            className="min-h-11 rounded-xl border border-sky-300/90 bg-white px-2 text-sm font-semibold text-sky-900 shadow-sm transition enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-100 dark:disabled:opacity-35"
          >
            ◀ 이전 시간
          </button>
          <button
            type="button"
            disabled={!hScroll.canRight}
            onClick={() => scrollGridPage(1)}
            className="min-h-11 rounded-xl border border-sky-300/90 bg-white px-2 text-sm font-semibold text-sky-900 shadow-sm transition enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-100 dark:disabled:opacity-35"
          >
            다음 시간 ▶
          </button>
        </div>
      ) : null}

      {narrowLayout && mobileVerticalDay ? (
        <div className="md:hidden">
          <div
            className="-mx-0.5 flex gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 pb-2 [scrollbar-width:thin]"
            role="tablist"
            aria-label="편집할 날짜"
          >
            {columns.map((col, i) => (
              <button
                key={`vd-${col.label}`}
                type="button"
                role="tab"
                aria-selected={i === verticalDayIdx}
                onClick={() => setVerticalDayIdx(i)}
                className={[
                  "flex min-h-11 min-w-0 shrink-0 flex-col items-center justify-center rounded-xl border px-2.5 py-2 text-center transition active:scale-[0.98]",
                  i === verticalDayIdx
                    ? "border-violet-500 bg-violet-600 text-white shadow-md dark:border-violet-400 dark:bg-violet-600"
                    : col.raidWeek === "next"
                      ? "border-violet-300/90 bg-violet-50/90 text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100"
                      : "border-sky-200/90 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
                ].join(" ")}
              >
                <span className="max-w-[5.5rem] truncate text-[11px] font-bold leading-tight">{col.short}</span>
                {col.raidWeek === "next" ? (
                  <span
                    className={[
                      "mt-0.5 text-[9px] font-bold",
                      i === verticalDayIdx ? "text-violet-100" : "text-violet-700 dark:text-violet-300",
                    ].join(" ")}
                  >
                    차주
                  </span>
                ) : (
                  <span
                    className={[
                      "mt-0.5 text-[9px] font-medium",
                      i === verticalDayIdx ? "text-violet-100/90" : "text-slate-500 dark:text-slate-400",
                    ].join(" ")}
                  >
                    금주
                  </span>
                )}
              </button>
            ))}
          </div>
          {(() => {
            const col = columns[verticalDayIdx] ?? columns[0];
            if (!col) return null;
            const dIdx = verticalDayIdx < columns.length ? verticalDayIdx : 0;
            const dayKeys = keysForDay(columns, dIdx);
            const allOn = dayKeys.length > 0 && dayKeys.every((k) => selected.has(k));
            return (
              <div className="rounded-xl border border-violet-200/70 bg-white/90 p-3 shadow-sm dark:border-violet-900/40 dark:bg-slate-900/80">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-violet-100/80 pb-3 dark:border-violet-900/40">
                  <div>
                    <p
                      className={[
                        "text-xs font-semibold transition-[color,filter] duration-150",
                        inBrushDay(dIdx)
                          ? "text-sky-800 drop-shadow-[0_0_10px_rgba(14,165,233,0.45)] dark:text-sky-100 dark:drop-shadow-[0_0_12px_rgba(125,211,252,0.4)]"
                          : "text-slate-700 dark:text-slate-200",
                      ].join(" ")}
                    >
                      {col.label}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">30분 단위 · 드래그로 연속 선택</p>
                  </div>
                  <button
                    type="button"
                    className={[
                      "min-h-11 shrink-0 rounded-xl border px-3 text-xs font-bold transition active:scale-[0.98]",
                      allOn
                        ? "border-blue-700 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-600"
                        : "border-sky-200 bg-white text-sky-800 hover:bg-sky-50 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-200 dark:hover:bg-slate-700",
                    ].join(" ")}
                    onClick={(e) => toggleDayAll(e, dIdx)}
                  >
                    이 날 전체 {allOn ? "해제" : "선택"}
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {Array.from({ length: SLOTS }, (_, slot) => {
                    const key = keyForSlot(slot, col.date);
                    const on = selected.has(key);
                    const heat = heatCount?.get(key) ?? 0;
                    const showCount = heat > 0;
                    const whoList = whoBySlot?.get(key);
                    const headline = `${col.short} · ${slotLabel(slot)}`;
                    return (
                      <button
                        key={`vslot-${key}`}
                        type="button"
                        aria-pressed={on}
                        aria-label={ariaSlotLabel(key, heat)}
                        data-slot={key}
                        data-day-index={dIdx}
                        data-slot-index={slot}
                        className={[
                          "flex min-h-[52px] w-full touch-manipulation items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors active:scale-[0.99]",
                          on
                            ? "border-blue-800 bg-blue-500/35 shadow-sm dark:border-blue-300 dark:bg-blue-500/40"
                            : showCount
                              ? "border-blue-200/90 bg-blue-50/90 dark:border-blue-900/50 dark:bg-blue-950/35"
                              : "border-slate-200/90 bg-white dark:border-slate-600 dark:bg-slate-800/90",
                        ].join(" ")}
                        onPointerDown={(e) => onCellPointerDown(e, dIdx, slot)}
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
                            "text-sm font-bold tabular-nums transition-[color,filter] duration-150",
                            inBrushSlot(slot) && inBrushDay(dIdx)
                              ? "text-sky-700 drop-shadow-[0_0_10px_rgba(56,189,248,0.55)] dark:text-sky-100 dark:drop-shadow-[0_0_12px_rgba(125,211,252,0.45)]"
                              : "text-slate-800 dark:text-slate-100",
                          ].join(" ")}
                        >
                          {slotLabel(slot)}
                        </span>
                        <span
                          className={[
                            "flex h-9 min-w-9 items-center justify-center rounded-lg text-xs font-bold tabular-nums",
                            showCount
                              ? "bg-blue-600/15 text-blue-900 dark:bg-blue-500/20 dark:text-blue-100"
                              : "text-slate-300 dark:text-slate-600",
                          ].join(" ")}
                        >
                          {showCount ? `${heat}명` : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      ) : (
      <div className="relative max-md:rounded-lg">
        {hScroll.overflow && !mobileVerticalDay ? (
          <>
            <div
              className={[
                "pointer-events-none absolute bottom-0 left-0 top-0 z-[1] w-6 bg-gradient-to-r from-white via-white/90 to-transparent dark:from-slate-900 dark:via-slate-900/90 md:hidden",
                hScroll.canLeft ? "opacity-100" : "opacity-0",
              ].join(" ")}
              aria-hidden
            />
            <div
              className={[
                "pointer-events-none absolute bottom-0 right-0 top-0 z-[1] w-6 bg-gradient-to-l from-white via-white/90 to-transparent dark:from-slate-900 dark:via-slate-900/90 md:hidden",
                hScroll.canRight ? "opacity-100" : "opacity-0",
              ].join(" ")}
              aria-hidden
            />
          </>
        ) : null}
        <div
          ref={gridScrollRef}
          className="slot-grid-scroll max-w-full overflow-x-auto overscroll-x-contain pb-1"
        >
          <div
            className={[
              "inline-grid w-max gap-1",
              "max-md:[grid-template-columns:minmax(5.5rem,6.75rem)_repeat(30,minmax(2.75rem,2.75rem))]",
              "md:[grid-template-columns:9.25rem_repeat(30,minmax(1.15rem,1fr))]",
            ].join(" ")}
          >
        <div
          className={[
            "text-[9px] font-medium transition-[color,filter] duration-150",
            scrollStickyCorner,
            brushRect != null
              ? "text-sky-800 drop-shadow-[0_0_6px_rgba(56,189,248,0.4)] dark:text-sky-100 dark:drop-shadow-[0_0_8px_rgba(125,211,252,0.35)]"
              : "text-slate-500 dark:text-slate-400",
          ].join(" ")}
        >
          시간 구간
        </div>
        <div
          className={[
            "flex flex-col items-center justify-center rounded-md px-1 py-1 text-center transition-[background-color,box-shadow,color] duration-150",
            brushHitsMorning
              ? "bg-sky-200/95 ring-2 ring-sky-400/70 dark:bg-sky-800/70 dark:ring-sky-400/45"
              : "bg-sky-100/90 dark:bg-slate-800/80",
          ].join(" ")}
          style={{ gridColumn: `2 / span ${morningSlots}` }}
        >
          <span
            className={[
              "text-[10px] font-bold transition-[color,filter] duration-150",
              brushHitsMorning
                ? "text-blue-900 drop-shadow-[0_0_8px_rgba(37,99,235,0.45)] dark:text-sky-100 dark:drop-shadow-[0_0_12px_rgba(125,211,252,0.45)]"
                : "text-blue-800 dark:text-blue-200",
            ].join(" ")}
          >
            09:00–12:00
          </span>
          <span
            className={[
              "text-[8px] leading-tight transition-colors duration-150",
              brushHitsMorning ? "text-slate-800 dark:text-sky-200" : "text-slate-600 dark:text-slate-400",
            ].join(" ")}
          >
            24시 · 전반
          </span>
        </div>
        <div
          className={[
            "flex flex-col items-center justify-center rounded-md px-1 py-1 text-center transition-[background-color,box-shadow,color] duration-150",
            brushHitsAfternoon
              ? "bg-indigo-100/95 ring-2 ring-indigo-400/60 dark:bg-indigo-950/50 dark:ring-indigo-400/40"
              : "bg-blue-50/90 dark:bg-blue-950/30",
          ].join(" ")}
          style={{ gridColumn: `${2 + morningSlots} / span ${afternoonSlots}` }}
        >
          <span
            className={[
              "text-[10px] font-bold transition-[color,filter] duration-150",
              brushHitsAfternoon
                ? "text-indigo-950 drop-shadow-[0_0_8px_rgba(79,70,229,0.4)] dark:text-indigo-100 dark:drop-shadow-[0_0_12px_rgba(165,180,252,0.45)]"
                : "text-blue-900 dark:text-blue-100",
            ].join(" ")}
          >
            12:00–24:00
          </span>
          <span
            className={[
              "text-[8px] leading-tight transition-colors duration-150",
              brushHitsAfternoon ? "text-indigo-900 dark:text-indigo-200" : "text-blue-800/80 dark:text-blue-300/90",
            ].join(" ")}
          >
            24시 · 후반
          </span>
        </div>

        <div
          className={[
            "flex items-end pb-1 text-[10px] font-medium transition-[color,filter] duration-150",
            scrollStickyTimeAxis,
            brushRect != null
              ? "text-sky-900 drop-shadow-[0_0_8px_rgba(14,165,233,0.45)] dark:text-sky-50 dark:drop-shadow-[0_0_10px_rgba(125,211,252,0.4)]"
              : "text-sky-700 dark:text-sky-300",
          ].join(" ")}
        >
          날짜 / 전체
        </div>
        {Array.from({ length: SLOTS }, (_, slot) => (
          <div
            key={`h-${slot}`}
            className={[
              "flex h-11 w-full min-w-[2.75rem] flex-col items-center justify-end px-0.5 pb-0.5 text-center transition-[background-color] duration-150 md:min-w-0",
              inBrushSlot(slot) ? "rounded-md bg-sky-100/70 dark:bg-sky-900/40" : "",
            ].join(" ")}
          >
            <span
              className={[
                "whitespace-nowrap text-[10px] tabular-nums leading-none transition-[color,filter] duration-150",
                inBrushSlot(slot) ? slotHeaderGlow : slotHeaderIdle,
              ].join(" ")}
            >
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
                ref={(el) => {
                  dayRowLabelRefs.current[dayIdx] = el;
                }}
                className={[
                  "flex min-h-[2.25rem] items-stretch gap-1 border-r py-0.5 pr-1 text-xs font-semibold leading-tight transition-[color,background-color,box-shadow] duration-150",
                  scrollStickyDayAxis,
                  inBrushDay(dayIdx)
                    ? col.raidWeek === "next"
                      ? "rounded-md bg-violet-200/85 ring-1 ring-violet-400/75 text-violet-950 drop-shadow-[0_0_10px_rgba(139,92,246,0.45)] dark:bg-violet-950/55 dark:text-violet-50 dark:ring-violet-400/45 dark:drop-shadow-[0_0_12px_rgba(196,181,253,0.4)]"
                      : "rounded-md bg-sky-100/95 ring-1 ring-sky-400/70 text-sky-950 drop-shadow-[0_0_10px_rgba(14,165,233,0.4)] dark:bg-sky-900/50 dark:text-sky-50 dark:ring-sky-400/45 dark:drop-shadow-[0_0_12px_rgba(125,211,252,0.38)]"
                    : col.raidWeek === "next"
                      ? "border-violet-200 text-violet-800 dark:border-violet-800/60 dark:text-violet-200"
                      : "border-sky-100 text-slate-800 dark:border-slate-700 dark:text-slate-100",
                ].join(" ")}
                title={col.label}
              >
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <span
                    className={[
                      "truncate transition-[color,filter] duration-150",
                      inBrushDay(dayIdx)
                        ? col.raidWeek === "next"
                          ? "font-bold text-violet-950 dark:text-violet-50"
                          : "font-bold text-sky-950 dark:text-sky-50"
                        : "",
                    ].join(" ")}
                  >
                    {col.short}
                  </span>
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
                      "relative h-11 w-full min-w-[2.75rem] touch-none rounded-md transition-colors md:h-10 md:min-w-0",
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
        </div>
      </div>
      )}
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
                          className="flex items-center gap-2 py-2.5 first:pt-1 last:pb-1"
                        >
                          {p.avatar_url ? (
                            <img
                              src={p.avatar_url}
                              alt=""
                              className="h-7 w-7 shrink-0 rounded-full border border-sky-200/80 object-cover dark:border-slate-600"
                              width={28}
                              height={28}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200/80 bg-sky-100 text-[10px] font-bold text-sky-800 dark:border-slate-600 dark:bg-slate-700 dark:text-sky-200">
                              {p.nickname.slice(0, 1)}
                            </span>
                          )}
                          <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                            {p.nickname}
                          </span>
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
          겹침이 있는 칸에 <strong>포인터를 올리면</strong> 닉네임 목록이 화면 위쪽 팝업으로 표시됩니다.{" "}
          <strong>숫자</strong>는 그 30분에 가능하다고 적은 인원 수입니다.
        </p>
        <p>
          내가 선택한 칸은{" "}
          <strong className="text-blue-900 dark:text-blue-200">파란 배경 + 진한 테두리</strong>, 다른 사람만
          있으면 연한 파란 배경에 숫자만 보입니다.
        </p>
        <p>
          <strong>Shift+클릭</strong>으로 다른 칸을 누르면 <strong>직사각형</strong>이 적용됩니다.{" "}
          <strong>Shift 키를 누른 채 처음 다른 칸을 누를 때</strong>의 칸이 한쪽 꼭짓점으로 고정되고, Shift를
          떼기 전에 같은 방식으로 또 누르면 <strong>그 고정 칸부터 새로 누른 칸까지</strong> 직사각형이 다시
          그려집니다. 채움/비움은 마지막 <strong>일반 클릭</strong>으로 찍은 칸이 직전 칸과 같을 때 그때의
          비움/채움 기준을 쓰고, 아니면 <strong>직전 칸</strong>(연속 Shift면 바로 이전에 누른 칸)의 선택
          여부를 봅니다. <strong>Shift 키를 떼면</strong> 고정 꼭짓점이 풀리고 다음부터 새 세션입니다.
        </p>
        <p>
          Shift 없이 드래그하면 기준 칸에서 포인터를 움직이며 같은 방식으로 직사각형을 선택·해제합니다. 당일{" "}
          <strong>09:00–24:00</strong>만 표시합니다.
        </p>
        <p className="md:hidden">
          <strong>모바일:</strong> <strong>세로 편집(하루)</strong>이 가장 편합니다. 표 모드에서는 날짜 열이
          가로 스크롤에 고정되고, <strong>날짜 칩</strong>으로 그날 행으로 이동할 수 있습니다. 시간대는{" "}
          <strong>이전·다음 시간</strong> 버튼·가로 스크롤로 옮긴 뒤 탭·드래그하면 됩니다.
        </p>
      </div>
    </div>
  );
}
