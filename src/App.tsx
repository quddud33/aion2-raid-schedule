import { useCallback, useEffect, useMemo, useState } from "react";
import { MatchSummary } from "./components/MatchSummary";
import { TimeGrid } from "./components/TimeGrid";
import { buildWeekColumns } from "./lib/slots";
import { supabase, supabaseConfigured } from "./lib/supabase";

type RaidType = "rudra" | "bagot";

type AvailabilityRow = {
  id: string;
  user_id: string;
  raid_type: RaidType;
  nickname: string;
  server_name: string;
  slots: string[];
  updated_at: string;
};

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function App() {
  const [raidType, setRaidType] = useState<RaidType>("rudra");
  const [nickname, setNickname] = useState("");
  const [server, setServer] = useState("");
  const [mySlots, setMySlots] = useState<Set<string>>(() => new Set());
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const columns = useMemo(() => buildWeekColumns(startOfToday(), 7), []);

  const heatCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      for (const s of r.slots) {
        m.set(s, (m.get(s) ?? 0) + 1);
      }
    }
    return m;
  }, [rows]);

  const maxHeat = useMemo(() => {
    let x = 0;
    for (const v of heatCount.values()) x = Math.max(x, v);
    return x;
  }, [heatCount]);

  const loadRows = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const { data, error: e } = await supabase
      .from("raid_availability")
      .select("*")
      .eq("raid_type", raidType)
      .order("updated_at", { ascending: false });
    setLoading(false);
    if (e) {
      setError(e.message);
      return;
    }
    setRows((data ?? []) as AvailabilityRow[]);
  }, [raidType]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const { error: anonErr } = await supabase.auth.signInAnonymously();
        if (anonErr) {
          if (!cancelled) {
            setError(anonErr.message);
            setAuthReady(false);
          }
          return;
        }
      }
      if (!cancelled) setAuthReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!supabase || !authReady) return;
    void loadRows();
  }, [authReady, loadRows]);

  useEffect(() => {
    if (!supabase || !authReady) return;
    const channel = supabase
      .channel(`raid_availability:${raidType}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "raid_availability",
          filter: `raid_type=eq.${raidType}`,
        },
        () => {
          void loadRows();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [authReady, raidType, loadRows]);

  useEffect(() => {
    if (!supabase || !authReady) return;
    void (async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) return;
      const mine = rows.find((r) => r.user_id === uid);
      setMySlots(new Set(mine?.slots ?? []));
    })();
  }, [rows, authReady, raidType]);

  const onSave = async () => {
    if (!supabase) return;
    const nn = nickname.trim();
    const sv = server.trim();
    if (nn.length < 1 || nn.length > 24) {
      setError("닉네임은 1~24자로 입력해 주세요.");
      return;
    }
    if (sv.length < 1 || sv.length > 24) {
      setError("서버명은 1~24자로 입력해 주세요.");
      return;
    }
    setSaving(true);
    setError(null);
    const { data: u, error: ue } = await supabase.auth.getUser();
    if (ue || !u.user) {
      setSaving(false);
      setError(ue?.message ?? "세션을 찾을 수 없습니다.");
      return;
    }
    const payload = {
      user_id: u.user.id,
      raid_type: raidType,
      nickname: nn,
      server_name: sv,
      slots: [...mySlots],
      updated_at: new Date().toISOString(),
    };
    const { error: ie } = await supabase.from("raid_availability").upsert(payload, {
      onConflict: "user_id,raid_type",
    });
    setSaving(false);
    if (ie) {
      setError(ie.message);
      return;
    }
    await loadRows();
  };

  const onClearMine = async () => {
    if (!supabase) return;
    const { data: u, error: ue } = await supabase.auth.getUser();
    if (ue || !u.user) {
      setError(ue?.message ?? "세션을 찾을 수 없습니다.");
      return;
    }
    setSaving(true);
    setError(null);
    const { error: de } = await supabase
      .from("raid_availability")
      .delete()
      .eq("user_id", u.user.id)
      .eq("raid_type", raidType);
    setSaving(false);
    if (de) {
      setError(de.message);
      return;
    }
    setMySlots(new Set());
    await loadRows();
  };

  if (!supabaseConfigured) {
    return (
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-100">아이온2 성역 일정</h1>
          <p className="mt-2 text-sm text-slate-400">
            Supabase 환경 변수가 없습니다. 루트에 <code className="text-amber-200">.env</code> 를 만들고{" "}
            <code className="text-amber-200">VITE_SUPABASE_URL</code>,{" "}
            <code className="text-amber-200">VITE_SUPABASE_ANON_KEY</code> 를 설정한 뒤{" "}
            <code className="text-amber-200">npm run dev</code> 를 다시 실행하세요.
          </p>
        </header>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-6 p-4 pb-16 sm:p-8">
      <header className="flex flex-col gap-3 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-amber-400/80">
            Aion 2 · 성역(레이드)
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-50">일정 맞추기</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            루드라 / 바고트 레이드별로 가능한 시간을 표시합니다. 정적 사이트이므로 데이터는 Supabase에
            저장되며, 별도 회원가입 없이 익명 세션과 닉네임·서버만으로 참여합니다.
          </p>
        </div>
        <div className="flex gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-1">
          <button
            type="button"
            className={[
              "rounded-lg px-4 py-2 text-sm font-medium transition",
              raidType === "rudra"
                ? "bg-amber-500/20 text-amber-100"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
            onClick={() => setRaidType("rudra")}
          >
            루드라
          </button>
          <button
            type="button"
            className={[
              "rounded-lg px-4 py-2 text-sm font-medium transition",
              raidType === "bagot"
                ? "bg-amber-500/20 text-amber-100"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
            onClick={() => setRaidType("bagot")}
          >
            바고트
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      <MatchSummary
        participants={rows.map((r) => ({
          nickname: r.nickname,
          server_name: r.server_name,
          slots: r.slots,
        }))}
      />

      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-100">내 가능 시간</h2>
            {loading && <span className="text-xs text-slate-500">불러오는 중…</span>}
          </div>
          <TimeGrid
            columns={columns}
            selected={mySlots}
            onCellsChange={(updater) => setMySlots((prev) => updater(prev))}
            heatCount={heatCount}
            maxHeat={maxHeat}
          />
        </div>

        <aside className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <h2 className="text-base font-semibold text-slate-100">내 정보</h2>
          <label className="block text-xs text-slate-500">
            캐릭터 닉네임
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-amber-500/0 focus:ring-2"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="예: 가을바람"
              maxLength={24}
            />
          </label>
          <label className="block text-xs text-slate-500">
            서버
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-amber-500/0 focus:ring-2"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="예: 지켈"
              maxLength={24}
            />
          </label>
          <p className="text-xs leading-relaxed text-slate-500">
            브라우저에 익명 로그인 세션이 저장됩니다. 다른 기기에서는 다시 입력하면 새 줄로
            올라갑니다.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={saving || !authReady}
              onClick={() => void onSave()}
              className="flex-1 rounded-xl bg-amber-500/90 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "저장 중…" : "가능 시간 저장"}
            </button>
            <button
              type="button"
              disabled={saving || !authReady}
              onClick={() => void onClearMine()}
              className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              내 행 삭제
            </button>
          </div>
        </aside>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-100">등록된 인원</h2>
          <span className="text-xs text-slate-500">{rows.length}명</span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">닉네임</th>
                <th className="py-2 pr-3 font-medium">서버</th>
                <th className="py-2 pr-3 font-medium">가능 칸</th>
                <th className="py-2 font-medium">갱신</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-800/80 text-slate-200">
                  <td className="py-2 pr-3">{r.nickname}</td>
                  <td className="py-2 pr-3 text-slate-400">{r.server_name}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.slots.length}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {new Date(r.updated_at).toLocaleString("ko-KR")}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    아직 등록된 일정이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          파란 농도는 해당 30분에 가능하다고 표시한 인원 수입니다(그래프 느낌). 상단 노란 배지는
          &quot;가능 시간을 적은 모든 인원&quot;의 교집합입니다.
        </p>
      </section>
    </div>
  );
}
