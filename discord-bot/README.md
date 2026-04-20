# 출발 알림 Discord 봇 — 처음부터 설정하기

웹앱은 **일정 확정**과 참가자 `discord_id` 저장까지만 합니다. **레이드 24시간 전·30분 전**에 디스코드 채널로 멘션을 내려면, 아래처럼 **별도로 이 봇 프로그램**을 한 대의 PC·서버에서 계속 실행해야 합니다.

> **중요:** `SUPABASE_SERVICE_ROLE_KEY`와 `DISCORD_BOT_TOKEN`은 **절대** GitHub에 올리거나 웹(React) 코드에 넣지 마세요. 봇만 아는 환경 변수(`.env`)로만 씁니다.

---

## 0. 미리 준비된 것

1. **디스코드 서버** — 알림을 받을 길드(서버)가 있어야 합니다.  
2. **Supabase 프로젝트** — 웹 일정 앱과 같은 프로젝트.  
3. **DB 마이그레이션** — `raid_schedule_confirmation`, `discord_id` 등이 들어간 `20260218150000_raid_schedule_confirmation.sql` 이 이미 적용된 상태여야 합니다.  
4. **PC에 Node.js 18+** — [https://nodejs.org](https://nodejs.org) LTS 설치.

---

## 1. Discord에서 봇 만들기

1. 브라우저에서 [Discord Developer Portal](https://discord.com/developers/applications) 접속 후 로그인합니다.  
2. **New Application** → 이름 입력 → **Create**.  
3. 왼쪽 **Bot** 메뉴 → **Add Bot** (이미 있으면 생략).  
4. 같은 Bot 화면에서 **Reset Token** → 토큰이 나오면 **한 번만** 복사해 둡니다. (다시는 전체가 안 보이므로 잃어버리면 Reset)  
   - 이 값이 나중에 `.env`의 `DISCORD_BOT_TOKEN`입니다.  
5. (선택) **Public Bot** 은 소규모 길드면 꺼도 됩니다.  
6. **Privileged Gateway Intents** — 이 예제는 채널에만 글을 쓰므로 **Presence / Server Members Intent 는 꺼도 됩니다.** (켜도 동작에는 큰 문제 없음)

---

## 2. 봇을 서버에 초대하기

1. Developer Portal에서 해당 앱 → 왼쪽 **OAuth2** → **URL Generator**.  
2. **SCOPES:** `bot` 체크.  
3. **BOT PERMISSIONS:** 최소한  
   - **Send Messages**  
   - **Embed Links** (선택)  
   - 멘션을 확실히 하려면 **Mention Everyone** 는 필요 없습니다. `<@userid>` 멘션만 씁니다.  
4. 아래에 생성된 **URL**을 복사해 브라우저 주소창에 붙여 넣고, 알림을 받을 **디스코드 서버**를 선택해 초대합니다.

---

## 3. 채널 ID 복사하기

1. Discord **설정** → **고급** → **개발자 모드** 켜기.  
2. 알림을 보내고 싶은 **텍스트 채널**에서 우클릭 → **채널 ID 복사**.  
3. 숫자만 복사된 값이 `DISCORD_CHANNEL_ID` 입니다.

---

## 4. Supabase Service Role 키

1. [Supabase 대시보드](https://supabase.com/dashboard) → 해당 프로젝트.  
2. **Project Settings** (톱니바퀴) → **API**.  
3. **Project URL** → `SUPABASE_URL`  
4. **`service_role` `secret`** — **anon key 가 아닙니다.** `service_role` 을 복사합니다.  
   - 이 키는 **DB 전 권한**과 비슷하므로, Git에 넣지 말고 봇이 도는 기기에만 두세요.

---

## 5. 이 폴더에서 봇 설치·실행 (Windows 기준)

1. 터미널( PowerShell )을 엽니다.  
2. 저장소의 `discord-bot` 폴더로 이동합니다.

   ```powershell
   cd C:\경로\aion2-raid-schedule\discord-bot
   ```

3. 의존성 설치:

   ```powershell
   npm install
   ```

4. 환경 변수 파일 만들기:

   ```powershell
   copy .env.example .env
   ```

5. 메모장 등으로 `.env` 를 열고 다음을 채웁니다.

   - `DISCORD_BOT_TOKEN` — 1절에서 복사한 봇 토큰  
   - `DISCORD_CHANNEL_ID` — 3절 채널 ID  
   - `SUPABASE_URL` — Supabase Project URL  
   - `SUPABASE_SERVICE_ROLE_KEY` — service_role secret  
   - `REMIND_TZ=Asia/Seoul` — 한국에서 쓰면 그대로 두면 됩니다.

6. (선택) 로스트아크 일정만 알리려면 한 줄 추가:

   ```env
   REMINDER_RAID_TYPE=lostark
   ```

7. **한 번만 테스트** (지금 시각에 맞는 알림이 없어도 오류 없이 끝나면 성공에 가깝습니다):

   ```powershell
   npm run check
   ```

8. **상시 실행:**

   ```powershell
   npm start
   ```

   - 창을 닫으면 봇도 멈춥니다. **24시간 돌리려면** 집 PC를 켜 두거나, Railway / Fly.io / Oracle Cloud 무료 티어 등에 같은 방식으로 올리면 됩니다.

---

## 6. 동작 방식 (이 예제 `index.mjs`)

1. **1분마다** Supabase에서 `raid_schedule_confirmation` 전체를 읽습니다.  
2. 각 행의 `slot_key`를 **한국(또는 `REMIND_TZ`) 로컬 날짜·시각**으로 바꿉니다.  
3. 그 시각 기준 **정확히 24시간 전**·**정확히 30분 전**에 들어오는 **약 90초 창** 안에 들어오면, 지정 채널에 메시지를 보냅니다.  
4. 같은 알림을 두 번 보내지 않도록 `sent-reminders.json` 에 플래그를 저장합니다. (파일 삭제 시 다시 보낼 수 있으니 주의)  
5. 멘션 대상: 같은 `raid_type`의 `raid_availability` 중, `slots` 배열에 **확정된 `slot_key`가 포함**된 행의 `discord_id`.  
   - `discord_id`가 비어 있으면 웹에서 **「가능 시간 저장」**을 한 번 더 해서 채워야 멘션이 됩니다.

---

## 7. 자주 나는 문제

| 증상 | 확인할 것 |
|------|------------|
| `Used disallowed intents` | Portal에서 불필요한 Privileged Intent 를 켰다면 끄거나, 봇 코드와 맞춥니다. 이 예제는 `Guilds` 만 사용합니다. |
| 채널에 메시지가 안 감 | 봇이 그 **서버·채널**에 초대됐는지, `DISCORD_CHANNEL_ID`가 텍스트 채널인지 확인합니다. |
| 멘션이 안 됨 | 해당 유저가 `discord_id` 없이 저장됐을 수 있습니다. 웹에서 저장 다시. |
| 시간이 9시간 어긋남 | `.env`에 `REMIND_TZ=Asia/Seoul` 이 있는지, 봇을 돌리는 PC/OS 타임존을 확인합니다. |
| Supabase 오류 | 마이그레이션 적용 여부, `service_role` 키 오타, URL 오타. |

---

## 8. 보안 체크리스트

- [ ] `.env` 는 **Git에 커밋하지 않음** (`discord-bot/.gitignore` 에 포함됨)  
- [ ] `service_role` 을 **GitHub Actions / Pages / 프론트**에 넣지 않음  
- [ ] 봇 토큰이 유출되면 Portal에서 **Reset Token** 후 `.env` 갱신  

---

## 9. 다음 단계 (원할 때)

- 여러 채널·레이드 타입별 채널: `index.mjs`를 수정해 `raid_type`에 따라 `CHANNEL_ID`를 매핑합니다.  
- 알림 문구·역할 멘션(`<@&roleid>`): 메시지 문자열만 바꾸면 됩니다.  
- GitHub Actions `schedule` 만으로는 **매 분 정확한 알림**이 어려울 수 있어, 상시 프로세스를 권장합니다.

이상으로 **처음부터** 봇을 붙일 수 있는 최소 경로입니다. 막히는 단계가 있으면 그때의 **오류 메시지 전문**을 알려 주시면 됩니다.
