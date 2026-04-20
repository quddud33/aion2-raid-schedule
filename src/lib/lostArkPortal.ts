/**
 * 로스트아크 전용 입장(아이온2 탭 없이 로스트아크만)은 아래 둘 중 하나(또는 둘 다)로 판별합니다.
 * - VITE_LOSTARK_ENTRY_PATH: Vite base 뒤 첫 경로 세그먼트 (예: `lostark` → `/repo/lostark`)
 * - VITE_LOSTARK_ENTRY_HASH: location.hash 와 정확히 일치 (예: `#/lostark`)
 *
 * GitHub Pages 에서 경로 입장을 쓰려면 빌드 후 `dist/404.html` 이 필요합니다 (`npm run build` 가 복사함).
 */

function pathSegmentAfterBase(): string {
  if (typeof window === "undefined") return "";
  const rawBase = import.meta.env.BASE_URL || "/";
  const base = rawBase.replace(/\/+$/, "") || "";
  let path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (!base || base === "/") {
    if (path === "/" || path === "") return "";
    return path.replace(/^\//, "").split("/")[0] ?? "";
  }
  if (path === base) return "";
  const prefix = `${base}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length).split("/")[0] ?? "";
  return path.replace(/^\//, "").split("/")[0] ?? "";
}

function normalizePathSecret(s: string): string {
  return s.trim().replace(/^\/+|\/+$/g, "");
}

/** 라우트 변경 시 App 에서 state 로 갱신해 주세요(hash/popstate). */
export function isLostArkPortal(): boolean {
  if (typeof window === "undefined") return false;
  const pathSecret = normalizePathSecret(import.meta.env.VITE_LOSTARK_ENTRY_PATH ?? "");
  const hashSecret = (import.meta.env.VITE_LOSTARK_ENTRY_HASH ?? "").trim();
  if (!pathSecret && !hashSecret) return false;
  const pathOk = pathSecret !== "" && pathSegmentAfterBase() === pathSecret;
  const hashOk = hashSecret !== "" && window.location.hash === hashSecret;
  if (pathSecret && hashSecret) return pathOk || hashOk;
  if (pathSecret) return pathOk;
  return hashOk;
}
