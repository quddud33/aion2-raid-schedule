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

/** 헤더용 24시간제 (당일 18–24, 익일 0–6) */
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

type Props = {
  columns: DayColumn[];
  selected: Set<string>;
  onCellsChange: (updater: (prev: Set<string>) => Set<string>) => void;
  heatCount?: Map<string, number>;
  maxHeat?: number;
};

export function TimeGrid({ columns, selected, onCellsChange, heatCount, maxHeat }: Props) {
  const dragging = useRef(false);
  const dragSelect = useRef(true);
  const applyKey = useCallback(
    (key: string, select: boolean) => {
      onCellsChange((prev) => {
        const next = new Set(prev);
        if (select) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [onCellsChange],
  );

  const endDrag = useCallback(() => {
    dragging.current = false;
  }, []);

  const resolveSlotFromPoint = useCallback((clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const btn = el?.closest("[data-slot]");
    const key = btn?.getAttribute("data-slot");
    return key ?? null;
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const key = resolveSlotFromPoint(e.clientX, e.clientY);
      if (key) applyKey(key, dragSelect.current);
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
  }, [applyKey, endDrag, resolveSlotFromPoint]);

  const onCellPointerDown = (e: React.PointerEvent, key: string) => {
    e.preventDefault();
    (e.currentTarget as HTMLButtonElement).setPointerCapture?.(e.pointerId);
    dragging.current = true;
    const isOn = selected.has(key);
    dragSelect.current = !isOn;
    applyKey(key, dragSelect.current);
  };

  return (
    <div
      className="slot-grid overflow-x-auto rounded-2xl border border-sky-200/80 bg-white/80 p-3 shadow-sm backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/70"
      style={{ touchAction: "none" }}
    >
      <div
        className="inline-grid gap-x-0.5 gap-y-1"
        style={{
          gridTemplateColumns: `104px repeat(${SLOTS}, minmax(24px, 1fr))`,
        }}
      >
        <div className="flex items-end pb-1 text-[10px] font-medium text-sky-700 dark:text-sky-300">
          날짜 ↓ / 시간 →
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
                title={isNextDay ? `${time} (익일 00:00 기준)` : time}
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

        {columns.map((col) => (
          <Fragment key={col.label}>
            <div
              className={[
                "flex min-h-[2.25rem] flex-col justify-center border-r py-0.5 pr-2 text-xs font-semibold leading-tight",
                col.raidWeek === "next"
                  ? "border-violet-200 text-violet-800 dark:border-violet-800/60 dark:text-violet-200"
                  : "border-sky-100 text-slate-800 dark:border-slate-700 dark:text-slate-100",
              ].join(" ")}
              title={col.label}
            >
              <span>{col.short}</span>
              {col.raidWeek === "next" && (
                <span className="mt-0.5 w-fit rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-800 dark:bg-violet-900/60 dark:text-violet-200">
                  차주
                </span>
              )}
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
                  className={[
                    "relative h-9 min-w-[24px] rounded-md border transition-colors",
                    on
                      ? "border-sky-500 bg-sky-400/50 shadow-sm dark:border-sky-400 dark:bg-sky-500/35"
                      : "border-slate-200/90 bg-white/90 hover:border-sky-300 hover:bg-sky-50/80 dark:border-slate-600 dark:bg-slate-800/80 dark:hover:border-sky-600 dark:hover:bg-slate-700/80",
                  ].join(" ")}
                  onPointerDown={(e) => onCellPointerDown(e, key)}
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
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        세로는 날짜(수요일 기준 금주·차주), 가로는 24시간제 시간(18:00~익일 06:00)입니다. 셀을 누른 채
        드래그하면 연속 선택·해제됩니다.
      </p>
    </div>
  );
}
