import { useMemo } from "react";
import { formatRangeLabel, groupConsecutive } from "../lib/slots";

type Props = {
  selected: Set<string>;
};

export function SelectedSlotsSummary({ selected }: Props) {
  const groups = useMemo(() => groupConsecutive([...selected]), [selected]);
  const total = selected.size;

  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-sky-300/80 bg-sky-50/50 px-4 py-3 text-sm text-slate-600 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-400">
        아직 선택된 시간이 없습니다. 아래 표에서 칸을 누르거나 가로로 드래그해 주세요.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sky-200/90 bg-gradient-to-br from-sky-50/90 to-white px-4 py-3 shadow-sm dark:border-slate-600 dark:from-slate-800/90 dark:to-slate-900/80">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
          내가 선택한 시간 (24시간제)
        </p>
        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">총 {total}칸</span>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {groups.map((g) => (
          <li
            key={g.join("|")}
            className="rounded-lg border border-sky-200/80 bg-white/90 px-3 py-2 text-sm font-medium leading-snug text-slate-800 tabular-nums shadow-sm dark:border-slate-600 dark:bg-slate-800/90 dark:text-slate-100"
          >
            {formatRangeLabel(g)}
          </li>
        ))}
      </ul>
    </div>
  );
}
