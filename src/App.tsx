import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchSummary } from "./components/MatchSummary";
import { TimeGrid } from "./components/TimeGrid";
import { isLostArkPortal } from "./lib/lostArkPortal";
import { buildRaidWeekColumns } from "./lib/slots";
import { supabase, supabaseConfigured } from "./lib/supabase";

type AionRaidType = "rudra" | "bagot";
type DbRaidType = AionRaidType | "lostark";
type Universe = "aion" | "lostark";

type AvailabilityRow = {
  id: string;
  user_id: string;
  raid_type: DbRaidType;
  nickname: string;
  slots: string[];
  updated_at: string;
};

const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

function readInitialDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("aion2-theme") === "dark";
}

const MAX_SLOT_UNDO = 50;

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

const fmt24 = (d: Date) =>
  d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function discordDisplayName(user: { user_metadata?: Record<string, unknown>; email?: string | null }): string {
  const m = user.user_metadata ?? {};
  const globalName = typeof m.global_name === "string" ? m.global_name.trim() : "";
  const fullName = typeof m.full_name === "string" ? m.full_name.trim() : "";
  const name = typeof m.name === "string" ? m.name.trim() : "";
  const custom = typeof m.custom_claim === "string" ? m.custom_claim.trim() : "";
  return globalName || fullName || name || custom || user.email?.split("@")[0] || "Discord";
}

export function App() {
  const [routeTick, setRouteTick] = useState(0);
  useEffect(() => {
    const bump = () => setRouteTick((t) => t + 1);
    window.addEventListener("hashchange", bump);
    window.addEventListener("popstate", bump);
    return () => {
      window.removeEventListener("hashchange", bump);
      window.removeEventListener("popstate", bump);
    };
  }, []);

  const lostArkGate = useMemo(() => {
    void routeTick;
    return isLostArkPortal();
  }, [routeTick]);

  const [universe, setUniverse] = useState<Universe>("aion");
  useEffect(() => {
    if (!lostArkGate && universe === "lostark") setUniverse("aion");
  }, [lostArkGate, universe]);

  const [aionRaidType, setAionRaidType] = useState<AionRaidType>("rudra");
  const dbRaidType: DbRaidType = universe === "lostark" ? "lostark" : aionRaidType;

  const [nickname, setNickname] = useState("");
  const [mySlots, setMySlots] = useState<Set<string>>(() => new Set());
  const slotUndoStack = useRef<Set<string>[]>([]);
  const slotUndoCoalesceRef = useRef(false);
  const slotUndoDragPushedRef = useRef(false);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<{ id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null>(null);
  const [darkMode, setDarkMode] = useState(readInitialDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    window.localStorage.setItem("aion2-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const columns = useMemo(() => buildRaidWeekColumns(new Date()), []);

  const heatCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      for (const s of r.slots) {
        m.set(s, (m.get(s) ?? 0) + 1);
      }
    }
    return m;
  }, [rows]);

  const whoBySlot = useMemo(() => {
    const m = new Map<string, { nickname: string }[]>();
    for (const r of rows) {
      for (const s of r.slots) {
        if (!m.has(s)) m.set(s, []);
        m.get(s)!.push({ nickname: r.nickname });
      }
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.nickname.localeCompare(b.nickname, "ko"));
    }
    return m;
  }, [rows]);

  const fetchRowsFromDb = useCallback(async (): Promise<
    { ok: true; rows: AvailabilityRow[] } | { ok: false; message: string }
  > => {
    if (!supabase) return { ok: false, message: "Supabase가 설정되지 않았습니다." };
    const { data, error: e } = await supabase
      .from("raid_availability")
      .select("*")
      .eq("raid_type", dbRaidType)
      .order("updated_at", { ascending: false });
    if (e) return { ok: false, message: e.message };
    return { ok: true, rows: (data ?? []) as AvailabilityRow[] };
  }, [dbRaidType]);

  const loadRows = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const r = await fetchRowsFromDb();
    setLoading(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setRows(r.rows);
  }, [fetchRowsFromDb]);

  const onRefreshParticipants = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const first = await fetchRowsFromDb();
    setLoading(false);
    if (!first.ok) {
      setError(first.message);
      return;
    }
    setRows(first.rows);
  }, [fetchRowsFromDb]);

  const beginSlotUndoDragSession = useCallback(() => {
    slotUndoCoalesceRef.current = true;
    slotUndoDragPushedRef.current = false;
  }, []);

  const endSlotUndoDragSession = useCallback(() => {
    slotUndoCoalesceRef.current = false;
    slotUndoDragPushedRef.current = false;
  }, []);

  const applyMySlots = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setMySlots((prev) => {
      const next = updater(prev);
      if (setsEqual(prev, next)) return prev;
      if (slotUndoCoalesceRef.current) {
        if (!slotUndoDragPushedRef.current) {
          slotUndoStack.current.push(new Set(prev));
          slotUndoDragPushedRef.current = true;
          if (slotUndoStack.current.length > MAX_SLOT_UNDO) slotUndoStack.current.shift();
        }
      } else {
        slotUndoStack.current.push(new Set(prev));
        if (slotUndoStack.current.length > MAX_SLOT_UNDO) slotUndoStack.current.shift();
      }
      return next;
    });
  }, []);

  const undoMySlots = useCallback(() => {
    const prev = slotUndoStack.current.pop();
    if (!prev) return;
    setMySlots(new Set(prev));
  }, []);

  useEffect(() => {
    slotUndoStack.current = [];
  }, [dbRaidType]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (slotUndoStack.current.length === 0) return;
      e.preventDefault();
      undoMySlots();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [undoMySlots]);

  useEffect(() => {
    if (!supabase) {
      setSessionUser(null);
      return;
    }
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionUser(session?.user ?? null);
    });
    void supabase.auth.getSession().then(({ data }) => {
      setSessionUser(data.session?.user ?? null);
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !sessionUser) return;
    void loadRows();
  }, [sessionUser, loadRows]);

  useEffect(() => {
    if (!supabase || !sessionUser) return;
    const client = supabase;
    const channel = client
      .channel(`raid_availability:${dbRaidType}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "raid_availability",
          filter: `raid_type=eq.${dbRaidType}`,
        },
        () => {
          void loadRows();
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [sessionUser, dbRaidType, loadRows]);

  useEffect(() => {
    if (!supabase || !sessionUser) return;
    void (async () => {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) return;
      const mine = rows.find((r) => r.user_id === uid);
      setMySlots(new Set(mine?.slots ?? []));
    })();
  }, [rows, sessionUser, dbRaidType]);

  const signInWithDiscord = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/?$/, "/")}`.replace(
      /([^:]\/)\/+/g,
      "$1",
    );
    const { error: oerr } = await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: window.location.href || redirectTo },
    });
    if (oerr) setError(oerr.message);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setRows([]);
    setMySlots(new Set());
  }, []);

  const onSave = async () => {
    if (!supabase) return;
    const nn = nickname.trim();
    if (nn.length < 1 || nn.length > 24) {
      setError("닉네임은 1~24자로 입력해 주세요.");
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
      raid_type: dbRaidType,
      nickname: nn,
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
    slotUndoStack.current = [];
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
      .eq("raid_type", dbRaidType);
    setSaving(false);
    if (de) {
      setError(de.message);
      return;
    }
    slotUndoStack.current = [];
    setMySlots(new Set());
    await loadRows();
  };

  const scheduleLabel =
    universe === "lostark" ? "로스트아크 (공용)" : aionRaidType === "rudra" ? "루드라" : "바고트";

  const pageTitle = universe === "lostark" ? "로스트아크 · 레이드 일정" : "아이온2 성역 일정";
  const pageBadge =
    universe === "lostark" ? "Lost Ark · 공용" : "Aion 2 · 성역(레이드)";
  const pageIntro =
    universe === "lostark"
      ? "공용 레이드 일정 맞추기입니다. 달력 규칙(수요일 기준 금주·차주)은 아이온2 성역과 같습니다."
      : "루드라 / 바고트 레이드별로 가능한 시간을 표시합니다. 달력은 수요일 초기화 기준 금주·차주(각 7일)입니다.";

  if (!supabaseConfigured) {
    return (
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-6">
        <header className="flex gap-3">
          <img
            src={logoUrl}
            alt=""
            className="mt-0.5 h-11 w-11 shrink-0 rounded-full border border-sky-200 bg-white object-cover shadow-sm dark:border-slate-600"
            width={44}
            height={44}
          />
          <div>
            <h1 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">일정 맞추기</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Supabase 환경 변수가 없습니다. 루트에{" "}
              <code className="rounded bg-sky-100 px-1 text-sky-900 dark:bg-slate-800 dark:text-sky-200">
                .env
              </code>{" "}
              를 만들고{" "}
              <code className="rounded bg-sky-100 px-1 text-sky-900 dark:bg-slate-800 dark:text-sky-200">
                VITE_SUPABASE_URL
              </code>
              ,{" "}
              <code className="rounded bg-sky-100 px-1 text-sky-900 dark:bg-slate-800 dark:text-sky-200">
                VITE_SUPABASE_ANON_KEY
              </code>
              를 설정한 뒤{" "}
              <code className="rounded bg-sky-100 px-1 text-sky-900 dark:bg-slate-800 dark:text-sky-200">
                npm run dev
              </code>
              를 다시 실행하세요.
            </p>
          </div>
        </header>
      </div>
    );
  }

  if (!sessionUser) {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 p-6">
        <header className="text-center">
          <h1 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">일정 맞추기</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Supabase에서 Discord 로그인을 켠 뒤, 아래 버튼으로 로그인해 주세요.
          </p>
        </header>
        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100">
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={() => void signInWithDiscord()}
          className="min-h-[48px] rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
        >
          Discord로 계속하기
        </button>
        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
          인증은 Supabase OAuth로 처리됩니다. 대시보드 Authentication → Providers → Discord 에 Client ID·Secret을
          넣고, Redirect URL에 이 사이트 주소를 등록해야 합니다.
        </p>
      </div>
    );
  }

  const card =
    "rounded-2xl border border-sky-200/90 bg-white/90 p-5 shadow-md backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/80";

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6 px-3 py-4 pb-16 sm:px-8 sm:py-8">
      <header className="flex flex-col gap-4 border-b border-sky-200/90 pb-6 dark:border-slate-700 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <img
            src={logoUrl}
            alt=""
            className="mt-1 h-11 w-11 shrink-0 rounded-full border border-sky-200 bg-white object-cover shadow-sm dark:border-slate-600"
            width={44}
            height={44}
          />
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-sky-600 dark:text-sky-400">
              {pageBadge}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-800 dark:text-slate-50 sm:text-3xl">
              {pageTitle}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">{pageIntro}</p>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="max-w-[14rem] truncate text-right text-xs text-slate-600 dark:text-slate-400">
              {discordDisplayName(sessionUser)}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="min-h-[36px] shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              로그아웃
            </button>
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              className="min-h-[36px] rounded-lg border border-sky-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-sky-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              aria-pressed={darkMode}
            >
              {darkMode ? "라이트" : "다크"}
            </button>
          </div>
          {lostArkGate ? (
            <div className="flex w-full max-w-md gap-1 rounded-xl border border-sky-200 bg-white/90 p-1 shadow-sm dark:border-slate-600 dark:bg-slate-800/90">
              <button
                type="button"
                className={[
                  "min-h-[40px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                  universe === "aion"
                    ? "bg-sky-500 text-white shadow-sm dark:bg-sky-600"
                    : "text-slate-600 hover:bg-sky-50 dark:text-slate-300 dark:hover:bg-slate-700",
                ].join(" ")}
                onClick={() => setUniverse("aion")}
              >
                아이온2
              </button>
              <button
                type="button"
                className={[
                  "min-h-[40px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                  universe === "lostark"
                    ? "bg-violet-600 text-white shadow-sm dark:bg-violet-500"
                    : "text-slate-600 hover:bg-violet-50 dark:text-slate-300 dark:hover:bg-slate-700",
                ].join(" ")}
                onClick={() => setUniverse("lostark")}
              >
                로스트아크
              </button>
            </div>
          ) : null}
          {universe === "aion" ? (
            <div className="flex w-full max-w-md gap-1 rounded-xl border border-sky-200 bg-white/90 p-1 shadow-sm dark:border-slate-600 dark:bg-slate-800/90 sm:gap-2">
              <button
                type="button"
                className={[
                  "min-h-[40px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition sm:flex-none sm:px-4",
                  aionRaidType === "rudra"
                    ? "bg-sky-500 text-white shadow-sm dark:bg-sky-600"
                    : "text-slate-600 hover:bg-sky-50 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white",
                ].join(" ")}
                onClick={() => setAionRaidType("rudra")}
              >
                루드라
              </button>
              <button
                type="button"
                className={[
                  "min-h-[40px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition sm:flex-none sm:px-4",
                  aionRaidType === "bagot"
                    ? "bg-sky-500 text-white shadow-sm dark:bg-sky-600"
                    : "text-slate-600 hover:bg-sky-50 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white",
                ].join(" ")}
                onClick={() => setAionRaidType("bagot")}
              >
                바고트
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 shadow-sm dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-8 md:flex-row md:items-stretch md:gap-8">
        <div className="min-w-0 flex-1 md:flex md:h-full md:min-h-0 md:flex-col">
          <MatchSummary
            columns={columns}
            participants={rows.map((r) => ({
              nickname: r.nickname,
              slots: r.slots,
            }))}
          />
        </div>

        <aside className={`flex w-full shrink-0 flex-col space-y-4 md:max-w-sm ${card}`}>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">내 정보</h2>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            표시 이름
            <input
              className="mt-1 box-border min-h-[44px] w-full max-w-full rounded-lg border border-sky-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-sky-500 dark:focus:ring-sky-900 sm:min-h-0 sm:py-2 sm:text-sm"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="예: 캐릭터명 또는 별칭"
              maxLength={24}
            />
          </label>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            표에 올라갈 이름입니다. Discord 닉네임과 다르게 적어도 됩니다.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={saving || !sessionUser}
              onClick={() => void onSave()}
              className="min-h-[44px] flex-1 rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500 sm:py-2.5"
            >
              {saving ? "저장 중…" : "가능 시간 저장"}
            </button>
            <button
              type="button"
              disabled={saving || !sessionUser}
              onClick={() => void onClearMine()}
              className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 hover:border-sky-300 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 sm:py-2.5"
            >
              내 행 삭제
            </button>
          </div>
        </aside>
      </div>

      <section>
        <TimeGrid
          columns={columns}
          selected={mySlots}
          onCellsChange={applyMySlots}
          onDragUndoSessionStart={beginSlotUndoDragSession}
          onDragUndoSessionEnd={endSlotUndoDragSession}
          heatCount={heatCount}
          whoBySlot={whoBySlot}
          scheduleIntro={
            <>
              <div>
                <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                  내 가능 시간 <span className="font-medium text-slate-500 dark:text-slate-400">({scheduleLabel})</span>
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  표는 위에서부터 금주(수~화) 7일, 이어서{" "}
                  <span className="font-medium text-violet-700 dark:text-violet-300">차주</span> 7일입니다.
                  시간은 24시간제입니다.
                </p>
              </div>
              {loading && (
                <span className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">불러오는 중…</span>
              )}
            </>
          }
        />
      </section>

      <section className={`${card} pb-5`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">등록된 인원</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-slate-600 dark:text-slate-400">
            <button
              type="button"
              disabled={loading || !sessionUser}
              title="DB에서 참가자 목록을 다시 불러옵니다."
              onClick={() => void onRefreshParticipants()}
              className="min-h-[36px] rounded-lg border border-sky-200 bg-white px-3 py-1.5 font-medium text-slate-700 shadow-sm hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {loading ? "갱신 중…" : "목록 갱신"}
            </button>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">{rows.length}명</span>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-sky-100 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <th className="py-2 pr-3 font-medium">이름</th>
                <th className="py-2 pr-3 font-medium">가능 칸</th>
                <th className="py-2 font-medium normal-case">
                  <span className="block">일정 갱신</span>
                  <span className="block text-[10px] font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">
                    (24h)
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-sky-100/90 text-slate-800 dark:border-slate-700 dark:text-slate-200"
                >
                  <td className="py-2 pr-3 font-medium">{r.nickname}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.slots.length}</td>
                  <td className="py-2 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {fmt24(new Date(r.updated_at))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-slate-500 dark:text-slate-400">
                    아직 등록된 일정이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          표의 숫자는 해당 30분에 가능하다고 표시한 인원 수입니다. 상단 배지는 가능 시간을 적은 모든 인원의
          교집합입니다. (표는 당일 09:00–24:00만 다루며, 그 밖에 저장된 슬롯은 목록·교집합에는 그대로 나올 수
          있습니다.)
        </p>
      </section>
    </div>
  );
}
