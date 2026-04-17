import {
  formatRangeLabel,
  groupConsecutive,
  intersectSlots,
  parseSlotKey,
  formatMinuteLabel,
} from "../lib/slots";

type Participant = {
  nickname: string;
  server_name: string;
  slots: string[];
};

type Props = {
  participants: Participant[];
};

const card =
  "rounded-2xl border border-sky-200/90 bg-white/85 p-5 shadow-md backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/80 dark:shadow-lg";

export function MatchSummary({ participants }: Props) {
  const withSlots = participants.filter((p) => p.slots.length > 0);
  const intersection =
    withSlots.length === 0 ? [] : intersectSlots(withSlots.map((p) => p.slots));
  const groups = groupConsecutive(intersection);

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

  return (
    <section className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-sky-800 dark:text-sky-200">전원 겹치는 시간</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          기준: 가능 시간을 1칸 이상 적은 인원 {withSlots.length}명의 교집합(최대 8명 파티를 가정해
          시간만 조율) · 24시간제
        </p>
      </div>

      {intersection.length === 0 ? (
        <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">
          현재 모든 인원이 겹치는 30분 구간이 없습니다. 시간대를 조정해 보세요.
        </p>
      ) : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {groups.map((g) => (
            <li
              key={g.join("|")}
              className="rounded-full border border-sky-300/80 bg-sky-100/90 px-3 py-1 text-sm font-medium text-sky-900 shadow-sm dark:border-sky-600/50 dark:bg-sky-950/60 dark:text-sky-100"
            >
              {formatRangeLabel(g)}
            </li>
          ))}
        </ul>
      )}

      <details className="mt-4 text-sm text-slate-600 dark:text-slate-400">
        <summary className="cursor-pointer select-none font-medium text-slate-700 hover:text-sky-800 dark:text-slate-300 dark:hover:text-sky-300">
          30분 단위 전체 목록 (24시간제)
        </summary>
        <ul className="mt-2 max-h-40 overflow-auto rounded-lg border border-sky-100 bg-sky-50/80 p-2 font-mono text-xs text-slate-700 dark:border-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
          {intersection.map((k) => {
            const p = parseSlotKey(k);
            const label = p ? `${p.day} ${formatMinuteLabel(p.minutes)}` : k;
            return <li key={k}>{label}</li>;
          })}
        </ul>
      </details>
    </section>
  );
}
