import {
  formatRangeLabel,
  groupConsecutive,
  intersectSlots,
  filterSlotsByRaidPhase,
} from "../lib/slots";
import type { DayColumn } from "../lib/slots";

type Participant = {
  nickname: string;
  server_name: string;
  slots: string[];
};

type Props = {
  participants: Participant[];
  columns: DayColumn[];
};

const card =
  "rounded-2xl border border-sky-200/90 bg-white/85 p-5 shadow-md backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/80 dark:shadow-lg";

function overlapChips(keys: string[], week: "current" | "next") {
  const chip =
    week === "next"
      ? "rounded-full border border-violet-300/80 bg-violet-100/90 px-3 py-1 text-sm font-medium text-violet-900 shadow-sm dark:border-violet-600/50 dark:bg-violet-950/60 dark:text-violet-100"
      : "rounded-full border border-sky-300/80 bg-sky-100/90 px-3 py-1 text-sm font-medium text-sky-900 shadow-sm dark:border-sky-600/50 dark:bg-sky-950/60 dark:text-sky-100";
  const groups = groupConsecutive(keys);
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
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
      <section className={card}>
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
    <section className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-sky-800 dark:text-sky-200">전원 겹치는 시간</h2>
        {legend}
      </div>

      {intersection.length === 0 ? (
        <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">
          전체 기간에 전원이 겹치는 30분 구간이 없습니다. 시간대를 조정해 보세요.
        </p>
      ) : (
        <>
          <div className="mt-4 border-t border-sky-100/90 pt-4 dark:border-slate-700/90">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">금주</h3>
            {currentKeys.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                금주 구간에는 전원이 겹치는 30분이 없습니다.
              </p>
            ) : (
              overlapChips(currentKeys, "current")
            )}
          </div>

          <div className="mt-6 border-t border-sky-100/90 pt-4 dark:border-slate-700/90">
            <h3 className="text-sm font-semibold text-violet-800 dark:text-violet-200">
              전원 겹치는 시간 (차주)
            </h3>
            {nextKeys.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                차주 구간에는 전원이 겹치는 30분이 없습니다.
              </p>
            ) : (
              overlapChips(nextKeys, "next")
            )}
          </div>
        </>
      )}
    </section>
  );
}
