# 출발 알림 Discord 봇 — 처음부터 설정하기

웹앱은 **일정 확정**과 참가자 `discord_id` 저장까지만 합니다. **확정 슬롯 당일 06:00(로컬)·출발 30분 전**에 디스코드 채널로 멘션을 내려면, 아래처럼 **별도로 이 봇 프로그램**을 한 대의 PC·서버에서 계속 실행해야 합니다. (당일 시각은 `.env`의 `REMIND_DAY_HOUR`로 바꿀 수 있습니다.)

> **중요:** `SUPABASE_SERVICE_ROLE_KEY`와 `DISCORD_BOT_TOKEN`은 **절대** GitHub에 올리거나 웹(React) 코드에 넣지 마세요. 봇만 아는 환경 변수(`.env`)로만 씁니다.

### Q. GitHub Pages에 웹이랑 같이 봇도 돌릴 수 있나요?

**아니요.** GitHub Pages는 **HTML·JS·CSS 같은 정적 파일만** 올려서 브라우저가 받아 쓰는 서비스라, **항상 켜져 있는 Node 프로세스**(디스코드 봇)는 돌릴 수 없습니다.

- **같은 GitHub 저장소**는 그대로 쓰면 됩니다. 웹은 Pages로 배포하고, 봇 코드(`discord-bot/`)는 repo에만 두고 **실행은 다른 곳**에서 하면 됩니다. (예: 집 PC, Railway·Fly.io·Render 등 소액/무료 티어, VPS)  
- **GitHub Actions**의 `on: schedule`으로 주기적으로 `node index.mjs --once`를 돌리는 방법도 있지만, 무료 플랜은 **최소 간격·지연**이 있어 “정확히 30분 전” 알림에는 부적합한 경우가 많습니다. 알림 봇은 **상시 실행**이 맞습니다.

---

## 0. 미리 준비된 것

1. **디스코드 서버** — 알림을 받을 길드(서버)가 있어야 합니다.  
2. **Supabase 프로젝트** — 웹 일정 앱과 같은 프로젝트.  
3. **DB 마이그레이션** — `raid_schedule_confirmation`, `discord_id` 등(`20260218150000_…`)과, 디스코드에서 채널을 고르려면 **`20260420180000_discord_reminder_channel_config.sql`** 까지 적용된 상태여야 합니다.  
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
2. **SCOPES:** **`bot`** 과 **`applications.commands`** 를 둘 다 체크합니다. (`applications.commands` 가 없으면 `/raid_notify` 슬래시 명령이 서버에 안 보일 수 있습니다.)  
3. **BOT PERMISSIONS:** 최소한  
   - **Send Messages**  
   - **Embed Links** (선택)  
   - 멘션을 확실히 하려면 **Mention Everyone** 는 필요 없습니다. `<@userid>` 멘션만 씁니다.  
4. 아래에 생성된 **URL**을 복사해 브라우저 주소창에 붙여 넣고, 알림을 받을 **디스코드 서버**를 선택해 초대합니다. (이미 초대했다면 **같은 SCOPES로 URL을 다시 만들어** 한 번 더 초대해도 됩니다.)

---

## 3. 채널 ID 복사하기

1. Discord **설정** → **고급** → **개발자 모드** 켜기.  
2. 알림을 보내고 싶은 **텍스트 채널**에서 우클릭 → **채널 ID 복사**.  
3. 숫자만 복사된 값이 `.env`의 **`DISCORD_CHANNEL_ID`** 입니다.  
   - **어느 채널에 쓰이나요?** 기본은 **이 ID 한 곳**에만 메시지가 갑니다 (`rudra` / `bagot` / `lostark` 모두 동일 채널).  
   - 레이드마다 나누려면 `.env`에 **`DISCORD_CHANNEL_ID_RUDRA`**, **`DISCORD_CHANNEL_ID_BAGOT`**, **`DISCORD_CHANNEL_ID_LOSTARK`** 를 각각 넣으면, 해당 타입만 그 채널로 갑니다. (엔트리가 없는 타입은 여전히 `DISCORD_CHANNEL_ID` 사용.)
   - **디스코드만으로 바꾸고 싶다면** 아래 **§2A** 의 `/raid_notify` 를 쓰면 됩니다. (DB에 저장되며, **저장된 값이 `.env`보다 우선**합니다.)

---

## 2A. 디스코드에서 알림 채널 지정 (`/raid_notify`)

Supabase에 테이블 `discord_reminder_channel_config` 가 있어야 합니다(SQL Editor에 `supabase/migrations/20260420180000_discord_reminder_channel_config.sql` 실행 또는 CLI 마이그레이션).

1. 봇을 **§2**처럼 `applications.commands` 포함해 서버에 넣습니다.  
2. 봇을 **켜면(`npm start`)** 봇이 들어가 있는 **서버마다** `/raid_notify` 가 **길드 명령**으로 등록됩니다. (`.env`의 서버 ID는 필요 없습니다.) 나중에 **다른 서버에 초대**하면 그 서버에도 자동으로 등록됩니다.  
3. 서버에서:

   - **`/raid_notify help`** — 이 봇이 제공하는 슬래시 하위 명령 설명 (서버 관리 권한 **불필요**).  
   - **`/raid_notify test`** — 알림으로 쓰는 **채널에 테스트 글** + **명령을 친 사람 멘션** (서버 관리 권한 **불필요**). `raid_route`로 기본/루드라/바고트/로아 라우팅 선택.  
   - **`/raid_notify set` / `status` / `clear`** — **서버 관리(Manage Server)** 권한 필요. `set`은 `target` + 텍스트 `channel`, `status`는 DB 요약, `clear`는 DB 삭제.

**우선순위(높은 것 먼저):** DB 타입별 채널 → `.env`의 `DISCORD_CHANNEL_ID_*` → DB 기본 → `.env`의 `DISCORD_CHANNEL_ID`.

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
   - `DISCORD_CHANNEL_ID` — 3절 **기본** 채널 ID (루드라·바고트·로아 공통, 또는 타입별 ID를 안 넣을 때)  
   - (선택) `DISCORD_CHANNEL_ID_RUDRA` / `DISCORD_CHANNEL_ID_BAGOT` / `DISCORD_CHANNEL_ID_LOSTARK` — 타입별 채널  
   - `SUPABASE_URL` — Supabase Project URL  
   - `SUPABASE_SERVICE_ROLE_KEY` — service_role secret  
   - `REMIND_TZ=Asia/Seoul` — 한국에서 쓰면 그대로 두면 됩니다.  
   - (선택) `REMIND_DAY_HOUR=6` — 출발 **당일** 아침 알림 시각(0~23). 생략 시 `6`(06:00).

6. (선택) 알릴 **레이드 종류** 제한:

   ```env
   # 비우면 rudra · bagot · lostark 확정 일정이 모두 알림 대상
   REMINDER_RAID_TYPE=lostark
   # 아이온 루드라+바고트만 (로아 제외)
   REMINDER_RAID_TYPE=rudra,bagot
   ```

7. **한 번만 테스트** (지금 시각에 맞는 알림이 없어도 오류 없이 끝나면 성공에 가깝습니다):

   ```powershell
   npm run check
   ```

   **채널에 테스트 글을 실제로 올려보기**

   - **디스코드(권장):** `/raid_notify test` — **명령을 친 사람**에게 멘션이 갑니다. `raid_route`로 기본/루드라/바고트/로아 라우팅을 골라 채널을 맞출 수 있습니다.  
   - **터미널:** `npm run test-notify` — 채널로만 테스트. 본인 멘션까지 보려면 `.env`에 `TEST_NOTIFY_DISCORD_ID` 를 넣습니다.

8. **상시 실행:**

   ```powershell
   npm start
   ```

   - 창을 닫으면 봇도 멈춥니다. **24시간 돌리려면** 집 PC를 켜 두거나, Railway / Fly.io / Oracle Cloud 무료 티어 등에 같은 방식으로 올리면 됩니다.

---

## 5A. Oracle VM을 쓸 때 — **어디서** 무엇을 하나요?

지금처럼 OCI **홈**에서 **Compute → Create a VM instance** 로 들어가 마법사를 진행 중이면, 아래만 순서대로 맞추면 됩니다. (리전은 스크린샷 기준 **South Korea North (Chuncheon)** 도 OK입니다.)

### 로컬 PC (Windows PowerShell) — **VM 만들기 전에** 또는 **지금 바로**

| 단계 | 할 일 |
|------|--------|
| 1 | **SSH 키**가 없으면 생성합니다. ([`oracle-cloud-free-vm.md`](oracle-cloud-free-vm.md) 2절 — PowerShell에서 `-N ""` 오류 나면 **`--% -N ""`** 또는 `cmd /c` 예제 사용) |
| 2 | **`*.pub` 파일 내용 전체**를 메모장으로 열어 복사해 둡니다. VM 만들기 화면의 **SSH keys** 칸에 붙여 넣습니다. |
| 3 | (나중에) **비밀키 파일**(확장자 없는 쪽) 경로를 기억합니다. 접속할 때 `ssh -i ...` 에 씁니다. |
| 4 | (나중에) 메모장으로 **`.env` 초안**을 만들어 둘 수 있습니다. 값은 README §1~4·`discord-bot/.env.example` 참고. **이 파일은 Git에 넣지 마세요.** |

### Oracle 브라우저 콘솔 — **Create compute instance** 마법사 안

지금 보이는 **Security (2)** 단계는 **Shielded instance OFF**, 보안 속성 비어 있음 → **디스코드 봇만 쓸 때는 그대로 두고 다음 단계로** 가도 됩니다.

**반드시 같은 마법사 안에서** 확인할 것(다른 단계 이름은 `Basic information`, `Networking` 등일 수 있음):

| 화면/단계 | 할 일 |
|-----------|--------|
| **Image** | **Oracle Linux 9** (또는 8) 선택. |
| **Shape** | **Always Free eligible** 표시가 있는 **Ampere A1** (`VM.Standard.A1.Flex` 등). OCPU **1**, 메모리 **6 GB** 정도로 시작. (무료가 아닌 Shape면 과금될 수 있음) |
| **Networking** | 인스턴스가 **인터넷에서 SSH로 접속** 가능해야 하므로, **퍼블릭 서브넷** + **퍼블릭 IPv4 할당(Yes)** 을 선택했는지 확인합니다. |
| **SSH keys** | 로컬에서 만든 **공개키(.pub) 전체**를 **Paste SSH keys** 에 붙여 넣습니다. |
| **Security (2)** | 기본값 유지해도 됨(위 스크린샷 상태). |
| 마지막 | **Create** 로 인스턴스 생성. 몇 분 후 상태가 **RUNNING** 이 될 때까지 콘솔에서 대기합니다. |

**SSH가 거절될 때만** OCI 콘솔에서 추가로:

| 어디 | 할 일 |
|------|--------|
| **Networking → Virtual cloud networks** → 해당 VCN → **Security Lists** | **Ingress Rules**에 **TCP 목적지 포트 22** 허용(소스는 가능하면 집 공인 IP/32). |

### Oracle 브라우저 콘솔 — **인스턴스가 RUNNING 된 뒤**

| 메뉴 | 할 일 |
|------|--------|
| **Compute → Instances** | 방금 만든 인스턴스 클릭 → **Public IP address** 를 메모합니다. |

### 로컬 PC — **SSH 접속 후 (터미널은 이제 VM 안)**

이 단계부터 입력하는 터미널은 **Oracle Linux 안**입니다. 상세 명령은 **[oracle-cloud-free-vm.md](oracle-cloud-free-vm.md)** 5절 이후와 동일합니다.

| 단계 | 할 일 |
|------|--------|
| 1 | PowerShell에서 `ssh -i 비밀키경로 opc@공인IP` 로 접속 (`opc` 는 이미지 기본 사용자, 다르면 인스턴스 상세의 Connection 가이드 참고). |
| 2 | VM 안에서 **Node.js 20** 설치, `git clone` 또는 `scp` 로 **`discord-bot` 폴더** 준비, `npm install`. |
| 3 | VM 안에서 `nano .env` 로 **README §5와 동일한 항목** 채우기(`chmod 600 .env` 권장). |
| 4 | `npm run check` → `npm start` 로 테스트. 상시 실행은 **systemd** (`oracle-cloud-free-vm.md` 10절). |

**한 줄 요약:** **키 만들기·복사·SSH 접속·코드·`.env`** = 로컬(또는 VM 셸). **VM 사양·네트워크·방화벽·공인 IP 확인** = Oracle **브라우저 콘솔**.

---

## 6. 동작 방식 (이 예제 `index.mjs`)

1. **1분마다** Supabase에서 `raid_schedule_confirmation` 전체를 읽고, 알림 채널은 `discord_reminder_channel_config`(있으면)과 `.env`를 합쳐 결정합니다.  
2. 각 행의 `slot_key`를 **한국(또는 `REMIND_TZ`) 로컬 날짜·시각**으로 바꿉니다.  
3. **출발 당일** `REMIND_DAY_HOUR` 시(기본 6 → 06:00, `REMIND_TZ` 로컬)와 **출발 30분 전** 시각에 들어오는 **약 90초 창** 안이면, 지정 채널에 메시지를 보냅니다. 출발이 그날 `REMIND_DAY_HOUR`보다 이르면(예: 새벽 레이드) 당일 알림은 생략되고 **30분 전**만 갑니다.  
4. 같은 알림을 두 번 보내지 않도록 `sent-reminders.json` 에 플래그를 저장합니다. (`:dDay`, `:d30` 키. 예전 `:d24` 는 더 이상 쓰이지 않습니다. 파일 삭제 시 다시 보낼 수 있으니 주의)  
5. 멘션 대상: 같은 `raid_type`의 `raid_availability` 중, `slots` 배열에 **확정된 `slot_key`가 포함**된 행의 `discord_id`.  
   - `discord_id`가 비어 있으면 웹에서 **「가능 시간 저장」**을 한 번 더 해서 채워야 멘션이 됩니다.

---

## 6-1. 무료·저비용으로 돌릴만한 곳은?

**완전 무료 + 설정 쉬움** 조합은 많지 않고, 각 서비스 **정책은 자주 바뀌므로** 가입 전에 공식 사이트를 한 번 확인하는 것이 좋습니다.

| 방식 | 특징 |
|------|------|
| **집 PC / 남는 노트북** | 비용 0. `npm start`만 켜 두면 됨. 잠자기·재부팅 시 멈추니 전원·절전만 조절. |
| **Oracle Cloud Infrastructure (Always Free)** | 소규모 VM이 **장기 무료**로 쓰이는 경우가 많음. **단계별 설정:** [oracle-cloud-free-vm.md](oracle-cloud-free-vm.md) |
| **Fly.io / Render / Railway 등** | 무료 크레딧·무료 티어가 있기도 하나, **유휴 시 슬립**이면 디스코드 봇처럼 **항상 붙어 있어야 하는 프로세스**에는 맞지 않을 수 있음. 소액 유료면 안정적인 경우가 많음. |
| **학생·크레딧** | Azure/GitHub Student Pack 등으로 소액 VM을 쓰는 방법도 있음(자격 조건 확인). |

이 봇(`index.mjs`)은 **짧게만 실행되는 서버리스**보다, **한 프로세스가 계속 도는 환경**(VM, 상시 컨테이너, 안 꺼지는 PC)에 두는 것이 맞습니다.

---

## 7. 자주 나는 문제

| 증상 | 확인할 것 |
|------|------------|
| `Used disallowed intents` | Portal에서 불필요한 Privileged Intent 를 켰다면 끄거나, 봇 코드와 맞춥니다. 이 예제는 `Guilds` 만 사용합니다. |
| 채널에 메시지가 안 감 | 봇이 그 **서버·채널**에 초대됐는지, `DISCORD_CHANNEL_ID`가 텍스트 채널인지 확인합니다. |
| 멘션이 안 됨 | 해당 유저가 `discord_id` 없이 저장됐을 수 있습니다. 웹에서 저장 다시. |
| 시간이 9시간 어긋남 | `.env`에 `REMIND_TZ=Asia/Seoul` 이 있는지, 봇을 돌리는 PC/OS 타임존을 확인합니다. |
| Supabase 오류 | 마이그레이션 적용 여부, `service_role` 키 오타, URL 오타. |
| `/raid_notify` 가 안 보임 | 초대 URL에 **`applications.commands`** 포함, 봇 **재시작** 후 잠시 대기, 마이그레이션 `20260420180000` 적용 여부. (서버에 봇이 실제로 들어가 있어야 길드 등록이 됩니다.) |

---

## 8. 보안 체크리스트

- [ ] `.env` 는 **Git에 커밋하지 않음** (`discord-bot/.gitignore` 에 포함됨)  
- [ ] `service_role` 을 **GitHub Actions / Pages / 프론트**에 넣지 않음  
- [ ] 봇 토큰이 유출되면 Portal에서 **Reset Token** 후 `.env` 갱신  

---

## 9. 다음 단계 (원할 때)

- 여러 채널: **§2A `/raid_notify`** 또는 `.env`의 `DISCORD_CHANNEL_ID_RUDRA` 등(§3·`.env.example`).  
- 알림 문구·역할 멘션(`<@&roleid>`): 메시지 문자열만 바꾸면 됩니다.  
- GitHub Actions `schedule` 만으로는 **매 분 정확한 알림**이 어려울 수 있어, 상시 프로세스를 권장합니다.

이상으로 **처음부터** 봇을 붙일 수 있는 최소 경로입니다. 막히는 단계가 있으면 그때의 **오류 메시지 전문**을 알려 주시면 됩니다.
