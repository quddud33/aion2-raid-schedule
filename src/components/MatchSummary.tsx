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

export function MatchSummary({ participants }: Props) {
  const withSlots = participants.filter((p) => p.slots.length > 0);
  const intersection =
    withSlots.length === 0 ? [] : intersectSlots(withSlots.map((p) => p.slots));
  const groups = groupConsecutive(intersection);

  if (withSlots.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg">
        <h2 className="text-lg font-semibold text-amber-200/90">전원 겹치는 시간</h2>
        <p className="mt-2 text-sm text-slate-400">
          아직 가능 시간을 적은 인원이 없습니다. 아래 표에서 본인 일정을 채운 뒤 저장해 주세요.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-200/90">전원 겹치는 시간</h2>
        <p className="text-xs text-slate-500">
          기준: 가능 시간을 1칸 이상 적은 인원 {withSlots.length}명의 교집합(최대 8명 파티를 가정해
          시간만 조율)
        </p>
      </div>

      {intersection.length === 0 ? (
        <p className="mt-3 text-sm text-rose-300/90">
          현재 모든 인원이 겹치는 30분 구간이 없습니다. 시간대를 조정해 보세요.
        </p>
      ) : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {groups.map((g) => (
            <li
              key={g.join("|")}
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm text-amber-100"
            >
              {formatRangeLabel(g)}
            </li>
          ))}
        </ul>
      )}

      <details className="mt-4 text-sm text-slate-400">
        <summary className="cursor-pointer select-none text-slate-300 hover:text-slate-200">
          30분 단위 전체 목록
        </summary>
        <ul className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-2 font-mono text-xs text-slate-300">
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
