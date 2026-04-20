/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** 예: `lostark` → `${BASE}lostark` 로 들어왔을 때만 로스트아크 탭 노출 (404.html 필요) */
  readonly VITE_LOSTARK_ENTRY_PATH?: string;
  /** 예: `#/lostark` — hash 가 일치할 때만 로스트아크 탭 노출 */
  readonly VITE_LOSTARK_ENTRY_HASH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
