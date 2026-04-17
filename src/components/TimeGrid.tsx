import { useCallback, useEffect, useRef } from "react";
import type { DayColumn } from "../lib/slots";
import { slotKey } from "../lib/slots";

const ROWS = 24; // 18:00~익일 06:00, 30분 간격

function keyForRow(row: number, columnDate: Date): string {
  const D = new Date(columnDate);
  D.setHours(0, 0, 0, 0);
  if (row < 12) {
    const d = new Date(D);
    d.setHours(18, 0, 0, 0);
    d.setMinutes(d.getMinutes() + row * 30);
    const mins = d.getHours() * 60 + d.getMinutes();
    return slotKey(d, mins);
  }
  const d = new Date(D);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  d.setMinutes((row - 12) * 30);
  const mins = d.getHours() * 60 + d.getMinutes();
  return slotKey(d, mins);
}

function rowLabel(row: number): string {
  if (row < 12) {
    const total = 18 * 60 + row * 30;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const total = (row - 12) * 30;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} (+1)`;
}

type Props = {
  columns: DayColumn[];
  selected: Set<string>;
  onCellsChange: (updater: (prev: Set<string>) => Set<string>) => void;
  /** 슬롯별 가능 인원 수(본인 제외 표시용 등 자유) */
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

  useEffect(() => {
    const up = () => endDrag();
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
    };
  }, [endDrag]);

  const onCellDown = (key: string) => {
    dragging.current = true;
    const isOn = selected.has(key);
    dragSelect.current = !isOn;
    applyKey(key, dragSelect.current);
  };

  const onCellEnter = (key: string) => {
    if (!dragging.current) return;
    applyKey(key, dragSelect.current);
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40 p-3 slot-grid">
      <div
        className="inline-grid gap-1"
        style={{
          gridTemplateColumns: `88px repeat(${columns.length}, minmax(52px, 1fr))`,
        }}
      >
        <div className="text-xs text-slate-500">시간 \\ 날짜</div>
        {columns.map((c) => (
          <div
            key={c.label}
            className="text-center text-xs font-medium text-slate-200"
            title={c.label}
          >
            {c.short}
          </div>
        ))}

        {Array.from({ length: ROWS }, (_, row) => (
          <div key={row} className="contents">
            <div className="flex items-center justify-end pr-2 text-[11px] tabular-nums text-slate-500">
              {rowLabel(row)}
            </div>
            {columns.map((col) => {
              const key = keyForRow(row, col.date);
              const on = selected.has(key);
              const heat = heatCount?.get(key) ?? 0;
              const mh = Math.max(1, maxHeat ?? 1);
              const heatRatio = heat / mh;
              return (
                <button
                  key={`${col.label}-${row}`}
                  type="button"
                  aria-pressed={on}
                  data-slot={key}
                  className={[
                    "relative h-7 w-full rounded border transition-colors",
                    on
                      ? "border-amber-400/70 bg-amber-400/35"
                      : "border-slate-800 bg-slate-950/60 hover:border-slate-600",
                  ].join(" ")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onCellDown(key);
                  }}
                  onMouseEnter={() => onCellEnter(key)}
                  title={key}
                >
                  {heatCount && heat > 0 && (
                    <span
                      className="pointer-events-none absolute inset-0 rounded"
                      style={{
                        background: `rgba(56, 189, 248, ${0.08 + heatRatio * 0.45})`,
                      }}
                    />
                  )}
                  <span
                    className={[
                      "relative z-10 flex h-full w-full items-center justify-center text-[10px]",
                      on ? "text-amber-50" : "text-slate-600",
                    ].join(" ")}
                  >
                    {on ? "✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        드래그로 연속 선택·해제할 수 있습니다. (30분 단위, 저녁 18:00 ~ 익일 06:00)
      </p>
    </div>
  );
}
