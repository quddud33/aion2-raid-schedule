/** 플레이NC 아이온2 캐릭터 정보실 (공식) */

export const PLAYNC_ORIGIN = "https://aion2.plaync.com";

export const PLAYNC_CHAR_INDEX = `${PLAYNC_ORIGIN}/ko-kr/characters/index`;

/** 천족 1 · 마족 2 — 웹 검색(정보실 페이지) URL */
export function buildPlayncSearchUrl(serverId: string, nickname: string, race: 1 | 2): string {
  const kw = encodeURIComponent(nickname.trim());
  return `${PLAYNC_CHAR_INDEX}?race=${race}&serverId=${encodeURIComponent(serverId)}&keyword=${kw}`;
}

/** Edge `fetch-combat-power`와 동일한 공식 검색 JSON API (characterId 등) */
export function buildPlayncCharacterSearchApiUrl(
  serverId: string,
  nickname: string,
  race?: 1 | 2,
): string {
  const q = new URLSearchParams({
    keyword: nickname.trim(),
    serverId,
    page: "1",
    size: "30",
  });
  if (race !== undefined) q.set("race", String(race));
  return `${PLAYNC_ORIGIN}/ko-kr/api/search/aion2/search/v2/character?${q.toString()}`;
}
