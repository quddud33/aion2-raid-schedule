import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MatchSummary } from "./components/MatchSummary";
import { TimeGrid } from "./components/TimeGrid";
import { resolveAion2toolServerId } from "./lib/aion2toolCharUrl";
import { buildPlayncSearchUrl, PLAYNC_CHAR_INDEX } from "./lib/playncCharUrl";
import { buildRaidWeekColumns } from "./lib/slots";
import { supabase, supabaseConfigured } from "./lib/supabase";

type RaidType = "rudra" | "bagot";

type AvailabilityRow = {
  id: string;
  user_id: string;
  raid_type: RaidType;
  nickname: string;
  server_name: string;
  slots: string[];
  combat_power: string | null;
  combat_power_updated_at: string | null;
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

/** Edge Function invoke 실패 시 사용자에게 보여 줄 안내 */
function formatCombatInvokeFailure(message: string): string {
  const m = message.trim() || "알 수 없는 오류";
  if (/non-2xx/i.test(m)) {
    return [
      `전투력 자동 갱신에 실패했습니다. (${m})`,
      "",
      "함수가 대시보드에 있어도, 예전 배포본이 HTTP 401·400 등을 쓰면 브라우저 라이브러리가 본문 대신 이 메시지만 보여 줄 수 있습니다.",
      "→ 저장소를 최신으로 받은 뒤 다시 배포: npm run deploy:functions",
      "→ 대시보드 → Edge Functions → fetch-combat-power → Logs 에서 실제 응답을 확인할 수 있습니다.",
      "",
      "목록은 이미 갱신된 상태입니다. 수동 입력·「전투력 반영」도 그대로 사용할 수 있습니다.",
    ].join("\n");
  }
  const lines = [
    `전투력 자동 갱신에 실패했습니다. (${m})`,
    "",
    "가장 흔한 원인: Supabase에 `fetch-combat-power` 함수를 아직 배포하지 않은 경우입니다.",
    "1) PC 터미널에서 이 저장소 루트로 이동합니다.",
    "2) npx supabase@latest login",
    "3) npx supabase@latest link --project-ref <값>",
    "   ※ Project Reference ID: Supabase 대시보드 → Project Settings → General",
    "4) npx supabase@latest functions deploy fetch-combat-power",
    "5) 대시보드 → Edge Functions 메뉴에 `fetch-combat-power`가 나타나는지 확인합니다.",
    "",
    "그 외: 브라우저 광고 차단·회사망이 *.supabase.co 요청을 막는지 확인합니다.",
    "당분간은 표의 수동 입력 후「전투력 반영」을 사용할 수 있습니다.",
  ];
  return lines.join("\n");
}

/** 번들 이슈로 instanceof FunctionsHttpError 가 실패할 수 있어 이름·context 로 판별 */
function isLikeFunctionsHttpError(err: unknown): err is { name: string; context: Response } {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.name === "FunctionsHttpError" && e.context instanceof Response;
}

async function readCombatInvokeHttpErrorBody(err: unknown): Promise<{ text: string; status: number } | null> {
  if (!isLikeFunctionsHttpError(err)) return null;
  const res = err.context;
  const status = res.status;
  try {
    const text = (await res.clone().text()).trim();
    if (text.startsWith("{")) {
      try {
        const body = JSON.parse(text) as { error?: string; message?: string };
        const msg =
          (typeof body.error === "string" && body.error.length > 0 && body.error) ||
          (typeof body.message === "string" && body.message.length > 0 && body.message) ||
          text;
        return { text: msg, status };
      } catch {
        return text ? { text, status } : null;
      }
    }
    return text ? { text: text.slice(0, 800), status } : null;
  } catch {
    return null;
  }
}

export function App() {
  const [raidType, setRaidType] = useState<RaidType>("rudra");
  const [nickname, setNickname] = useState("");
  const [server, setServer] = useState("");
  const [mySlots, setMySlots] = useState<Set<string>>(() => new Set());
  const slotUndoStack = useRef<Set<string>[]>([]);
  /** true: 포인터 드래그 중 — 스택은 첫 실제 변경 직전 상태만 한 번 push */
  const slotUndoCoalesceRef = useRef(false);
  const slotUndoDragPushedRef = useRef(false);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [darkMode, setDarkMode] = useState(readInitialDark);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myCombatDraft, setMyCombatDraft] = useState("");
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const serverCombatSyncedRef = useRef<string | null>(null);

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
    const m = new Map<string, { nickname: string; server_name: string }[]>();
    for (const r of rows) {
      for (const s of r.slots) {
        if (!m.has(s)) m.set(s, []);
        m.get(s)!.push({ nickname: r.nickname, server_name: r.server_name });
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
      .eq("raid_type", raidType)
      .order("updated_at", { ascending: false });
    if (e) return { ok: false, message: e.message };
    const rows = (data ?? []).map((r) => {
      const row = r as AvailabilityRow;
      return {
        ...row,
        combat_power: row.combat_power ?? null,
        combat_power_updated_at: row.combat_power_updated_at ?? null,
      };
    });
    return { ok: true, rows };
  }, [raidType]);

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
    setRefreshNote(null);
    const first = await fetchRowsFromDb();
    if (!first.ok) {
      setError(first.message);
      setLoading(false);
      return;
    }
    setRows(first.rows);

    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id;
    if (uid) {
      const mine = first.rows.find((r) => r.user_id === uid);
      if (mine) {
        const sid = resolveAion2toolServerId(mine.server_name);
        if (sid) {
          const { data: sessWrap } = await supabase.auth.getSession();
          const access = sessWrap.session?.access_token;
          if (!access) {
            setRefreshNote(
              "로그인 세션 토큰이 없어 전투력 자동 갱신을 건너뜁니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
            );
          } else {
            const { data: fnData, error: fnErr } = await supabase.functions.invoke("fetch-combat-power", {
              body: { serverId: sid, nickname: mine.nickname },
              headers: { Authorization: `Bearer ${access}` },
            });
            if (fnErr) {
              const parsed = await readCombatInvokeHttpErrorBody(fnErr);
              const baseMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
              if (parsed) {
                setRefreshNote(
                  `${parsed.text}\n\n(Edge Function HTTP ${parsed.status}. 위 내용은 응답 본문에서 읽었습니다. GitHub Pages는 저장소 푸시로 프론트도 최신 배포해 주세요.)`,
                );
              } else {
                setRefreshNote(formatCombatInvokeFailure(baseMsg));
              }
            } else if (fnData && typeof fnData === "object") {
            const fd = fnData as { ok?: boolean; error?: string; combat_power?: string };
            if (fd.ok === true && typeof fd.combat_power === "string" && fd.combat_power.length > 0) {
              const { error: upErr } = await supabase.from("raid_availability").upsert(
                {
                  user_id: uid,
                  raid_type: raidType,
                  nickname: mine.nickname,
                  server_name: mine.server_name,
                  slots: mine.slots,
                  combat_power: fd.combat_power.slice(0, 48),
                  combat_power_updated_at: new Date().toISOString(),
                  updated_at: mine.updated_at,
                },
                { onConflict: "user_id,raid_type" },
              );
              if (upErr) setRefreshNote(`DB 반영 실패: ${upErr.message}`);
              else {
                const second = await fetchRowsFromDb();
                if (second.ok) setRows(second.rows);
                setRefreshNote("전투력·템렙을 플레이NC 공식에서 가져와 반영했습니다.");
              }
            } else {
              setRefreshNote(fd.error ?? "전투력을 페이지에서 찾지 못했습니다.");
            }
            }
          }
        } else {
          setRefreshNote(
            "서버명이 내부 서버 ID 목록과 맞지 않아 전투력 자동 갱신을 건너뜁니다. (플레이NC 검색에 쓰는 serverId)",
          );
        }
      }
    }
    setLoading(false);
  }, [fetchRowsFromDb, raidType]);

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
  }, [raidType]);

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
    if (!supabase || !authReady) {
      setMyUserId(null);
      return;
    }
    let cancelled = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setMyUserId(data.user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  useEffect(() => {
    if (!myUserId) {
      setMyCombatDraft("");
      serverCombatSyncedRef.current = null;
      return;
    }
    const mine = rows.find((r) => r.user_id === myUserId);
    const cp = mine?.combat_power ?? "";
    if (serverCombatSyncedRef.current !== cp) {
      serverCombatSyncedRef.current = cp;
      setMyCombatDraft(cp);
    }
  }, [rows, myUserId]);

  useEffect(() => {
    if (!supabase || !authReady) return;
    void loadRows();
  }, [authReady, loadRows]);

  useEffect(() => {
    if (!supabase || !authReady) return;
    const client = supabase;
    const channel = client
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
      void client.removeChannel(channel);
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
    const mine = rows.find((r) => r.user_id === u.user.id);
    const payload = {
      user_id: u.user.id,
      raid_type: raidType,
      nickname: nn,
      server_name: sv,
      slots: [...mySlots],
      combat_power: mine?.combat_power ?? null,
      combat_power_updated_at: mine?.combat_power_updated_at ?? null,
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

  const saveMyCombat = async () => {
    if (!supabase) return;
    const { data: u, error: ue } = await supabase.auth.getUser();
    if (ue || !u.user) {
      setError(ue?.message ?? "세션을 찾을 수 없습니다.");
      return;
    }
    const mine = rows.find((r) => r.user_id === u.user.id);
    if (!mine) {
      setError("먼저 닉네임·서버·가능 시간을 저장한 뒤 전투력을 반영할 수 있습니다.");
      return;
    }
    const raw = myCombatDraft.trim();
    if (raw.length > 48) {
      setError("전투력은 48자 이내로 입력해 주세요.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      user_id: u.user.id,
      raid_type: raidType,
      nickname: mine.nickname,
      server_name: mine.server_name,
      slots: mine.slots,
      combat_power: raw.length ? raw : null,
      combat_power_updated_at: raw.length ? new Date().toISOString() : null,
      updated_at: mine.updated_at,
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
    slotUndoStack.current = [];
    setMySlots(new Set());
    await loadRows();
  };

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
            <h1 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">아이온2 성역 일정</h1>
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
              </code>{" "}
              를 설정한 뒤{" "}
              <code className="rounded bg-sky-100 px-1 text-sky-900 dark:bg-slate-800 dark:text-sky-200">
                npm run dev
              </code>{" "}
              를 다시 실행하세요.
            </p>
          </div>
        </header>
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
              Aion 2 · 성역(레이드)
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-800 dark:text-slate-50 sm:text-3xl">
              일정 맞추기
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
              루드라 / 바고트 레이드별로 가능한 시간을 표시합니다. 달력은{" "}
              <strong className="text-slate-800 dark:text-slate-200">수요일 초기화</strong> 기준 금주·차주
              (각 7일)입니다. 데이터는 Supabase에 저장되며, 익명 세션과 닉네임·서버만으로 참여합니다.
            </p>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            className="min-h-[44px] rounded-xl border border-sky-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-sky-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            aria-pressed={darkMode}
          >
            {darkMode ? "라이트 모드" : "다크 모드"}
          </button>
          <div className="flex min-w-0 gap-1 rounded-xl border border-sky-200 bg-white/90 p-1 shadow-sm dark:border-slate-600 dark:bg-slate-800/90 sm:gap-2">
            <button
              type="button"
              className={[
                "min-h-[44px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition sm:flex-none sm:px-4",
                raidType === "rudra"
                  ? "bg-sky-500 text-white shadow-sm dark:bg-sky-600"
                  : "text-slate-600 hover:bg-sky-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white",
              ].join(" ")}
              onClick={() => setRaidType("rudra")}
            >
              루드라
            </button>
            <button
              type="button"
              className={[
                "min-h-[44px] flex-1 rounded-lg px-3 py-2 text-sm font-medium transition sm:flex-none sm:px-4",
                raidType === "bagot"
                  ? "bg-sky-500 text-white shadow-sm dark:bg-sky-600"
                  : "text-slate-600 hover:bg-sky-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white",
              ].join(" ")}
              onClick={() => setRaidType("bagot")}
            >
              바고트
            </button>
          </div>
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
              server_name: r.server_name,
              slots: r.slots,
            }))}
          />
        </div>

        <aside className={`flex w-full shrink-0 flex-col space-y-4 md:max-w-sm ${card}`}>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">내 정보</h2>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
          캐릭터 닉네임
          <input
            className="mt-1 box-border min-h-[44px] w-full max-w-full rounded-lg border border-sky-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-sky-500 dark:focus:ring-sky-900 sm:min-h-0 sm:py-2 sm:text-sm"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="예: 반갑꼬리"
            maxLength={24}
          />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
          서버
          <input
            className="mt-1 box-border min-h-[44px] w-full max-w-full rounded-lg border border-sky-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-sky-500 dark:focus:ring-sky-900 sm:min-h-0 sm:py-2 sm:text-sm"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="예: 무닌"
            maxLength={24}
          />
        </label>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          브라우저에 익명 로그인 세션이 저장됩니다. 다른 기기에서는 다시 입력하면 새 줄로 올라갑니다.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={saving || !authReady}
            onClick={() => void onSave()}
            className="min-h-[44px] flex-1 rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-600 dark:hover:bg-sky-500 sm:py-2.5"
          >
            {saving ? "저장 중…" : "가능 시간 저장"}
          </button>
          <button
            type="button"
            disabled={saving || !authReady}
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
                  내 가능 시간{" "}
                  <span className="font-medium text-slate-500 dark:text-slate-400">
                    ({raidType === "rudra" ? "루드라" : "바고트"})
                  </span>
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
              disabled={loading || !authReady}
              title="등록 목록을 불러오고, 본인 행이 있으면 플레이NC 공식(캐릭터 정보실)에서 전투력·템렙을 조회해 반영합니다."
              onClick={() => void onRefreshParticipants()}
              className="min-h-[36px] rounded-lg border border-sky-200 bg-white px-3 py-1.5 font-medium text-slate-700 shadow-sm hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {loading ? "갱신 중…" : "목록·전투력 갱신"}
            </button>
            <span className="hidden text-slate-300 sm:inline dark:text-slate-600" aria-hidden>
              |
            </span>
            <span className="max-w-md leading-relaxed">
              「목록·전투력 갱신」은 DB 목록을 다시 불러오고, 본인이 등록돼 있으면{" "}
              <a
                href={PLAYNC_CHAR_INDEX}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
              >
                플레이NC 캐릭터 정보실
              </a>
              에서 전투력·템렙을 자동 조회해 저장합니다(Supabase Edge Function 배포 필요). 검색은 마족(race=2) 후
              천족(race=1) 순입니다. 실패 시 본인 행에서 수동 입력·「전투력 반영」을 쓰면 됩니다. 행의「공식」은
              마족 기준 검색 링크입니다(천족은 링크에서 race=1로 바꿔 보세요).
            </span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">{rows.length}명</span>
          </div>
        </div>
        {refreshNote && (
          <p className="mt-2 whitespace-pre-line rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs leading-relaxed text-slate-700 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {refreshNote}
          </p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-sky-100 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <th className="py-2 pr-3 font-medium">닉네임</th>
                <th className="py-2 pr-3 font-medium">서버</th>
                <th className="py-2 pr-3 font-medium">가능 칸</th>
                <th className="py-2 pr-3 font-medium normal-case">전투력</th>
                <th className="py-2 font-medium normal-case">
                  <span className="block">일정 갱신</span>
                  <span className="block text-[10px] font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">
                    (24h)
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sidRow = resolveAion2toolServerId(r.server_name);
                const charUrl = sidRow ? buildPlayncSearchUrl(sidRow, r.nickname, 2) : null;
                const isMine = myUserId !== null && r.user_id === myUserId;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-sky-100/90 text-slate-800 dark:border-slate-700 dark:text-slate-200"
                  >
                    <td className="py-2 pr-3">{r.nickname}</td>
                    <td className="py-2 pr-3 text-slate-600 dark:text-slate-400">{r.server_name}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.slots.length}</td>
                    <td className="max-w-[14rem] py-2 pr-3 align-top text-xs">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium tabular-nums text-slate-800 dark:text-slate-100">
                            {r.combat_power?.trim() ? r.combat_power : "—"}
                          </span>
                          <a
                            href={charUrl ?? PLAYNC_CHAR_INDEX}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="플레이NC 검색(기본 마족 race=2). 천족은 URL의 race=1로 변경"
                            className="shrink-0 font-medium text-sky-600 underline-offset-2 hover:underline dark:text-sky-400"
                          >
                            공식
                          </a>
                        </div>
                        {r.combat_power_updated_at && (
                          <span className="text-[10px] leading-tight text-slate-400 dark:text-slate-500">
                            전투력 반영: {fmt24(new Date(r.combat_power_updated_at))}
                          </span>
                        )}
                        {isMine && (
                          <div className="flex flex-col gap-1.5 pt-0.5 sm:flex-row sm:items-center">
                            <input
                              className="box-border min-h-[40px] w-full min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2 py-2 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-sky-500 dark:focus:ring-sky-900 sm:min-h-0 sm:py-1.5"
                              value={myCombatDraft}
                              onChange={(e) => setMyCombatDraft(e.target.value)}
                              placeholder="예: 523.9K / 4,144 (전투력 / 템렙)"
                              maxLength={48}
                              disabled={saving}
                              aria-label="내 전투력 입력"
                            />
                            <button
                              type="button"
                              disabled={saving || !authReady}
                              onClick={() => void saveMyCombat()}
                              className="min-h-[40px] shrink-0 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-700 dark:bg-sky-950/50 dark:text-sky-200 dark:hover:bg-sky-900/60 sm:min-h-0 sm:py-1.5"
                            >
                              {saving ? "저장 중…" : "전투력 반영"}
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                      {fmt24(new Date(r.updated_at))}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500 dark:text-slate-400">
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
