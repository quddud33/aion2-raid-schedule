#!/usr/bin/env bash
# VM(리눅스) **안에서만** 실행: GitHub main(또는 BRANCH) tarball → discord-bot 갱신, .env 유지, npm install, systemd 재시작
# 사용: chmod +x vm-pull.sh && ./vm-pull.sh
# 다른 저장소/브랜치: GITHUB_REPO=계정/저장소 BRANCH=master ./vm-pull.sh
set -euo pipefail

REPO="${GITHUB_REPO:-quddud33/aion2-raid-schedule}"
BRANCH="${BRANCH:-main}"
ROOT="${RAID_INSTALL_ROOT:-$HOME/aion2-raid-schedule}"
UNIT="${SYSTEMD_UNIT:-raid-discord-bot.service}"
TGZ="$(mktemp /tmp/aion2-raid-src.XXXXXX.tgz)"
TMP="$(mktemp -d /tmp/aion2-raid-extract.XXXXXX)"

cleanup() { rm -f "$TGZ"; rm -rf "$TMP"; }
trap cleanup EXIT

echo "==> 설치 루트: $ROOT"
mkdir -p "$ROOT"

if [[ -f "$ROOT/discord-bot/.env" ]]; then
  cp -a "$ROOT/discord-bot/.env" /tmp/aion2-discord-dotenv.bak
  echo "==> .env 백업"
fi

URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
echo "==> 받기: $URL"
curl -fsSL "$URL" -o "$TGZ"

tar -xzf "$TGZ" -C "$TMP"
TOP="$(ls "$TMP")"
SRC="$TMP/$TOP/discord-bot"
if [[ ! -d "$SRC" ]]; then
  echo "[오류] tarball 안에 discord-bot/ 가 없습니다. REPO·BRANCH 확인." >&2
  exit 1
fi

echo "==> discord-bot/ 교체"
rm -rf "$ROOT/discord-bot"
cp -a "$SRC" "$ROOT/discord-bot"

if [[ -f /tmp/aion2-discord-dotenv.bak ]]; then
  mv /tmp/aion2-discord-dotenv.bak "$ROOT/discord-bot/.env"
  echo "==> .env 복구"
fi

echo "==> npm install"
cd "$ROOT/discord-bot"
npm install

if [[ -f "/etc/systemd/system/$UNIT" ]] || [[ -f "/lib/systemd/system/$UNIT" ]]; then
  echo "==> systemctl restart $UNIT"
  sudo systemctl restart "$UNIT"
  sudo systemctl is-active --quiet "$UNIT" && echo "==> $UNIT: active" || echo "==> 경고: systemctl status $UNIT"
else
  echo "==> (건너뜀) $UNIT 유닛 파일 없음. 수동: cd $ROOT/discord-bot && npm start"
fi

echo "==> 완료."
