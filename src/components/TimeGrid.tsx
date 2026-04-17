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
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} (+1)`;
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
      className="slot-grid overflow-x-auto rounded-2xl border border-sky-200/80 bg-white/80 p-3 shadow-sm backdrop-blur-sm"
      style={{ touchAction: "none" }}
    >
      <div
        className="inline-grid gap-x-0.5 gap-y-1"
        style={{
          gridTemplateColumns: `92px repeat(${SLOTS}, minmax(22px, 1fr))`,
        }}
      >
        <div className="flex items-end pb-1 text-[10px] font-medium text-sky-700/90">
          날짜 / 시간 →
        </div>
        {Array.from({ length: SLOTS }, (_, slot) => {
          const full = slotLabel(slot);
          const isNext = full.includes("(+1)");
          const time = full.replace(" (+1)", "");
          return (
            <div
              key={`h-${slot}`}
              className="flex h-12 min-w-[22px] flex-col items-center justify-end gap-0 pb-0.5 text-center"
            >
              <span
                className={[
                  "whitespace-nowrap text-[9px] font-semibold tabular-nums leading-none",
                  isNext ? "text-sky-600" : "text-slate-600",
                ].join(" ")}
                title={full}
              >
                {time}
              </span>
              {isNext && (
                <span className="text-[8px] font-medium leading-none text-sky-500">익일</span>
              )}
            </div>
          );
        })}

        {columns.map((col) => (
          <Fragment key={col.label}>
            <div
              className="flex min-h-[2rem] items-center border-r border-sky-100 pr-2 text-xs font-semibold text-slate-700"
              title={col.label}
            >
              {col.short}
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
                    "relative h-9 min-w-[22px] rounded-md border transition-colors",
                    on
                      ? "border-sky-400 bg-sky-400/45 shadow-sm"
                      : "border-slate-200/90 bg-white/90 hover:border-sky-300 hover:bg-sky-50/80",
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
                      on ? "font-semibold text-sky-950" : "text-slate-400",
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
      <p className="mt-2 text-xs text-slate-500">
        가로가 시간(30분 단위, 18:00 ~ 익일 06:00), 세로가 요일입니다. 셀을 누른 채 좌우로 드래그하면
        연속으로 선택·해제됩니다.
      </p>
    </div>
  );
}
