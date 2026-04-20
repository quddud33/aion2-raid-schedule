import { useEffect, useMemo, useState } from "react";
import { type DayColumn, type RaidWeekPhase, filterSlotsByRaidPhase, slotKeyLabel } from "../lib/slots";

export type WeekConfirmation = { slot_key: string; updated_at: string };

type Props = {
  columns: DayColumn[];
  scheduleLabel: string;
  /** 금주·차주 수요일(레이드 주 시작) YYYY-MM-DD */
  raidWeekStartCurrent: string;
  raidWeekStartNext: string;
  intersectionKeys: string[];
  confirmByWeek: Map<string, WeekConfirmation>;
  canConfirm: boolean;
  busy: boolean;
  onConfirm: (raidWeekStart: string, slotKey: string) => Promise<void>;
  onClear: (raidWeekStart: string) => Promise<void>;
};

const card =
  "rounded-2xl border border-emerald-200/90 bg-white/90 p-5 shadow-md backdrop-blur-sm dark:border-emerald-900/40 dark:bg-slate-900/80";

function keysForPhase(keys: string[], columns: DayColumn[], phase: RaidWeekPhase): string[] {
  return filterSlotsByRaidPhase(keys, columns, phase);
}

export function ScheduleConfirmPanel({
  columns,
  scheduleLabel,
  raidWeekStartCurrent,
  raidWeekStartNext,
  intersectionKeys,
  confirmByWeek,
  canConfirm,
  busy,
  onConfirm,
  onClear,
}: Props) {
  const currentKeys = useMemo(
    () => keysForPhase(intersectionKeys, columns, "current"),
    [intersectionKeys, columns],
  );
  const nextKeys = useMemo(
    () => keysForPhase(intersectionKeys, columns, "next"),
    [intersectionKeys, columns],
  );

  const [pickCurrent, setPickCurrent] = useState("");
  const [pickNext, setPickNext] = useState("");

  useEffect(() => {
    setPickCurrent((p) => (p && currentKeys.includes(p) ? p : currentKeys[0] ?? ""));
  }, [currentKeys]);

  useEffect(() => {
    setPickNext((p) => (p && nextKeys.includes(p) ? p : nextKeys[0] ?? ""));
  }, [nextKeys]);

  const confCur = confirmByWeek.get(raidWeekStartCurrent) ?? null;
  const confNext = confirmByWeek.get(raidWeekStartNext) ?? null;

  const block = (
    phaseLabel: string,
    phaseClass: string,
    raidWeekStart: string,
    keys: string[],
    pick: string,
    setPick: (v: string) => void,
    confirmed: WeekConfirmation | null,
  ) => {
    const validPick = pick && keys.includes(pick) ? pick : keys[0] ?? "";
    return (
      <div
        className={`rounded-xl border p-4 ${
          phaseClass === "current"
            ? "border-sky-200/90 bg-sky-50/40 dark:border-sky-800/50 dark:bg-sky-950/20"
            : "border-violet-200/90 bg-violet-50/40 dark:border-violet-800/50 dark:bg-violet-950/20"
        }`}
      >
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{phaseLabel}</h3>
        {confirmed ? (
          <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-200">
            <span className="font-semibold">확정</span>{" "}
            <span className="text-slate-800 dark:text-slate-100">{slotKeyLabel(confirmed.slot_key, columns)}</span>
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              갱신 {new Date(confirmed.updated_at).toLocaleString("ko-KR")}
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">아직 확정된 일정이 없습니다.</p>
        )}

        {canConfirm ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              교집합에서 선택
              <select
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                value={validPick}
                onChange={(e) => setPick(e.target.value)}
                disabled={busy || keys.length === 0}
              >
                {keys.length === 0 ? <option value="">(겹치는 시간 없음)</option> : null}
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {slotKeyLabel(k, columns)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || keys.length === 0 || !validPick}
              onClick={() => void onConfirm(raidWeekStart, validPick)}
              className="min-h-[40px] rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
            >
              이 시간으로 확정
            </button>
            {confirmed ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void onClear(raidWeekStart)}
                className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                확정 취소
              </button>
            ) : null}
          </div>
        ) : null}

        {!canConfirm && keys.length > 0 ? (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            확정은 DB에 등록된 관리자 Discord 핸들만 가능합니다. 겹치는 후보만 목록에 나옵니다.
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section className={card}>
      <h2 className="text-lg font-semibold text-emerald-900 dark:text-emerald-200">일정 확정</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {scheduleLabel} · 금주·차주 각각 한 구간만 확정할 수 있습니다. 확정 시각은 전원 교집합에서만 고를 수
        있습니다.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {block("금주", "current", raidWeekStartCurrent, currentKeys, pickCurrent, setPickCurrent, confCur)}
        {block("차주", "next", raidWeekStartNext, nextKeys, pickNext, setPickNext, confNext)}
      </div>
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Discord 출발 알림 봇을 쓰려면 참가자가「가능 시간 저장」할 때 DB에 Discord ID가 함께 저장되어야 멘션
        <code className="mx-0.5 rounded bg-slate-200 px-1 dark:bg-slate-700">&lt;@id&gt;</code>이 가능합니다. 자세한
        것은 저장소의 <code className="rounded bg-slate-200 px-1 dark:bg-slate-700">discord-bot/README.md</code>를
        참고하세요.
      </p>
    </section>
  );
}
