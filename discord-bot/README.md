# 출발 알림 Discord 봇 (개요)

웹앱은 **일정 확정**과 참가자 `discord_id` 저장까지만 담당합니다. **1일 전·30분 전 자동 멘션**은 이 저장소 밖에서 동작하는 봇(또는 워커)이 필요합니다.

## 가능 여부

**가능합니다.** 전제는 다음과 같습니다.

1. **Discord 봇 계정** — [Discord Developer Portal](https://discord.com/developers/applications)에서 앱·봇을 만들고, 알림을 보낼 **서버에 초대**합니다. 채널에 메시지를 쓰고 멘션할 권한이 있어야 합니다.
2. **항상 도는 스케줄러** — 예: 소규모 VPS·Railway·Fly.io·집 PC에서 `node` 프로세스 + `setInterval` / `node-cron`, 또는 Supabase **Edge Function + pg_cron**(플랜·설정에 따름), GitHub Actions `schedule`(분 단위 정밀도는 부적합할 수 있음) 등.
3. **Supabase 읽기** — 봇은 **Service Role 키**로 REST/RPC를 호출해 읽기만 하는 편이 단순합니다. (Service Role은 절대 브라우저·GitHub Pages에 넣지 마세요.)
4. **멘션 대상** — `raid_schedule_confirmation`에서 `raid_type`·`raid_week_start`·`slot_key`를 읽고, 같은 `raid_type`의 `raid_availability` 행 중 `slots` 배열에 그 `slot_key`가 포함된 사용자의 `discord_id`를 모읍니다. 값이 있으면 메시지에 `<@discord_id>` 형태로 넣으면 해당 사용자에게 멘션 알림이 갑니다. `discord_id`가 비어 있으면 과거에 저장만 하고 ID 동기화 전인 행일 수 있으니, 참가자에게 한 번 「가능 시간 저장」을 다시 하게 하면 됩니다.

## 슬롯 시각과 리마인드 시각

`slot_key` 형식은 `YYYY-MM-DD@MMMM` (자정부터 분 단위, 30분 칸 시작 시각). 이걸 로컬(또는 팀이 합의한 타임존) `Date`로 바꾼 뒤, 그 시각의 **24시간 전**·**30분 전**에 각각 한 번씩 메시지를 내면 됩니다. 이미 보냈는지는 봇 쪽 DB·파일·Redis 등에 플래그를 두면 중복을 막을 수 있습니다.

## 이 폴더의 코드

현재는 **실행 가능한 완성 봇이 아니라** 위 흐름을 구현할 때 참고할 체크리스트용 README입니다. 원하시면 `discord.js`로 최소 예제를 이 디렉터리에 추가할 수 있습니다.

## 환경 변수 예시 (봇 전용, 서버에만 보관)

- `DISCORD_BOT_TOKEN` — 봇 토큰  
- `DISCORD_CHANNEL_ID` — 알림을 쓸 채널  
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`  
- (선택) `REMIND_TZ` — 타임존(예: `Asia/Seoul`)
