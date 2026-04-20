import {
  formatRangeLabel,
  groupConsecutive,
  intersectSlots,
  filterSlotsByRaidPhase,
  slotKeyLabel,
} from "../lib/slots";
import type { DayColumn } from "../lib/slots";

type Participant = {
  nickname: string;
  slots: string[];
};

type Props = {
  participants: Participant[];
  columns: DayColumn[];
};

const card =
  "rounded-2xl border border-sky-200/90 bg-white/85 p-5 shadow-md backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/80 dark:shadow-lg";

function overlapChips(keys: string[], week: "current" | "next", chipListClass = "mt-2") {
  const chip =
    week === "next"
      ? "rounded-full border border-violet-300/80 bg-violet-100/90 px-3 py-1 text-sm font-medium text-violet-900 shadow-sm dark:border-violet-600/50 dark:bg-violet-950/60 dark:text-violet-100"
      : "rounded-full border border-sky-300/80 bg-sky-100/90 px-3 py-1 text-sm font-medium text-sky-900 shadow-sm dark:border-sky-600/50 dark:bg-sky-950/60 dark:text-sky-100";
  const groups = groupConsecutive(keys);
  return (
    <ul className={`${chipListClass} flex flex-wrap gap-2`}>
      {groups.map((g) => (
        <li key={g.join("|")} className={chip}>
          {formatRangeLabel(g)}
        </li>
      ))}
    </ul>
  );
}

export function MatchSummary({ participants, columns }: Props) {
  const withSlots = participants.filter((p) => p.slots.length > 0);
  const intersection =
    withSlots.length === 0 ? [] : intersectSlots(withSlots.map((p) => p.slots));
  const currentKeys = filterSlotsByRaidPhase(intersection, columns, "current");
  const nextKeys = filterSlotsByRaidPhase(intersection, columns, "next");

  if (withSlots.length === 0) {
    return (
      <section className={`${card} flex min-h-0 flex-col md:h-full md:flex-1 md:overflow-hidden`}>
        <h2 className="text-lg font-semibold text-sky-800 dark:text-sky-200">전원 겹치는 시간</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          아직 가능 시간을 적은 인원이 없습니다. 아래 표에서 본인 일정을 채운 뒤 저장해 주세요.
        </p>
      </section>
    );
  }

  const legend = (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      기준: 가능 시간을 1칸 이상 적은 인원 {withSlots.length}명의 교집합(최대 8명 파티를 가정해 시간만
      조율) · 24시간제 · 금주·차주는 표 상단과 동일
    </p>
  );

  return (
    <section className={`${card} flex min-h-0 flex-col md:h-full md:flex-1 md:overflow-hidden`}>
      <div className="shrink-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-sky-800 dark:text-sky-200">전원 겹치는 시간</h2>
          {legend}
        </div>

        {intersection.length === 0 ? (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">
            전체 기간에 전원이 겹치는 30분 구간이 없습니다. 시간대를 조정해 보세요.
          </p>
        ) : null}
      </div>

      {intersection.length === 0 ? null : (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-y-contain border-t border-sky-100/90 pt-4 dark:border-slate-700/90 md:min-h-0">
          <div className="shrink-0">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">금주</h3>
            {currentKeys.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                금주 구간에는 전원이 겹치는 30분이 없습니다.
              </p>
            ) : (
              overlapChips(currentKeys, "current")
            )}
          </div>

          <div className="shrink-0 border-t border-sky-100/90 pt-4 dark:border-slate-700/90">
            <h3 className="text-sm font-semibold text-violet-800 dark:text-violet-200">
              전원 겹치는 시간 (차주)
            </h3>
            {nextKeys.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                차주 구간에는 전원이 겹치는 30분이 없습니다.
              </p>
            ) : (
              <>
                {overlapChips(nextKeys, "next")}
                <details className="mt-3 rounded-xl border border-violet-200/90 bg-violet-50/40 dark:border-violet-800/50 dark:bg-violet-950/25">
                  <summary className="cursor-pointer list-none px-3 py-2.5 text-sm outline-none ring-violet-400/40 marker:content-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
                    <span className="font-semibold text-violet-900 dark:text-violet-100">
                      30분 단위 전체 목록
                    </span>
                    <span className="mt-0.5 block text-xs font-normal text-violet-800/90 dark:text-violet-200/90">
                      {nextKeys.length}칸 · 연속 구간 {groupConsecutive(nextKeys).length}개 — 탭하여 펼치기
                    </span>
                  </summary>
                  <div className="border-t border-violet-200/60 px-3 pb-3 pt-2 dark:border-violet-800/50">
                    <ul className="max-h-[min(50vh,18rem)] overflow-y-auto overscroll-y-contain rounded-lg border border-violet-200/70 bg-white/90 py-1 text-xs text-slate-700 dark:border-violet-800/60 dark:bg-slate-900/60 dark:text-slate-200 sm:max-h-[min(55vh,22rem)]">
                      {nextKeys.map((k) => (
                        <li
                          key={k}
                          className="border-b border-violet-100/80 px-3 py-1.5 last:border-b-0 dark:border-violet-900/40"
                        >
                          {slotKeyLabel(k, columns)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
