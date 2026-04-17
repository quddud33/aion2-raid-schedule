/** 플레이NC 아이온2 캐릭터 정보실 (공식) */

export const PLAYNC_CHAR_INDEX = "https://aion2.plaync.com/ko-kr/characters/index";

/** 천족 1 · 마족 2 — 검색 URL */
export function buildPlayncSearchUrl(serverId: string, nickname: string, race: 1 | 2): string {
  const kw = encodeURIComponent(nickname.trim());
  return `${PLAYNC_CHAR_INDEX}?race=${race}&serverId=${encodeURIComponent(serverId)}&keyword=${kw}`;
}
