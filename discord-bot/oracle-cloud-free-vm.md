# Oracle Cloud 무료 VM — 처음부터 (디스코드 봇용)

OCI **Always Free**로 소형 VM을 만들고, SSH로 접속한 뒤 이 저장소의 `discord-bot`을 돌리는 흐름입니다.  
(화면 이름은 콘솔 업데이트로 조금 다를 수 있습니다.)

> **과금 주의:** 인스턴스 만들 때 **Shape**가 “Always Free eligible”인지 꼭 확인하세요. 무료 한도를 넘기면 요금이 나갈 수 있습니다.

---

## 1. 가입

1. [https://www.oracle.com/cloud/free/](https://www.oracle.com/cloud/free/) 에서 **Start for free** 등으로 진행합니다.  
2. **신용카드 등록**이 요구되는 경우가 많습니다. (본인 확인·남용 방지용이며, Always Free 범위만 쓰면 청구 0원인 경우가 대부분이지만, **정책은 Oracle 쪽 최신 안내**를 따릅니다.)  
3. 가입이 끝나면 **OCI 콘솔**에 로그인합니다. 리전(Region)은 **도쿄·오사카 등 가까운 곳**을 고르는 것이 지연에 유리합니다.

---

## 2. SSH 키 만들기 (Windows PowerShell)

로컬 PC에서 **한 번만** 만듭니다.

PowerShell은 `-N ""` 처럼 **빈 암호**를 넘길 때 인자가 비는 경우가 많아, 아래 **둘 중 하나**를 쓰면 됩니다.

**방법 A (권장):** `--%` 로 이후 인자를 PowerShell이 해석하지 않게 합니다.

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t rsa -b 4096 -f "$env:USERPROFILE\.ssh\oci_raid_bot" --% -N ""
```

**방법 B:** **Git Bash** 또는 WSL 터미널이 있으면 bash와 동일하게 됩니다.

```bash
mkdir -p ~/.ssh
ssh-keygen -t rsa -b 4096 -f ~/.ssh/oci_raid_bot -N ""
```

**방법 C:** 암호를 **직접 입력**해도 됩니다 (`-N` 없이 실행 후 프롬프트에 두 번 입력).

```powershell
ssh-keygen -t rsa -b 4096 -f "$env:USERPROFILE\.ssh\oci_raid_bot"
```

- `oci_raid_bot` / `oci_raid_bot.pub` 두 파일이 생깁니다.  
- **`.pub`는 Oracle에 붙여 넣고**, **확장자 없는 쪽은 비밀키** — 절대 GitHub에 올리지 마세요.

`notepad "$env:USERPROFILE\.ssh\oci_raid_bot.pub"` 로 열어 **전체 한 줄**을 복사해 둡니다.

---

## 3. 네트워크(VCN) — 처음이면 마법사 추천

1. 콘솔 왼쪽 햄버거 메뉴 → **Networking** → **Virtual cloud networks**.  
2. 인스턴스를 만들 때 **Create new VCN** 같은 옵션이 있으면, **새 VCN + 퍼블릭 서브넷 + 인터넷 게이트웨이**를 한 번에 만드는 **시작용 마법사**를 쓰는 것이 쉽습니다.  
3. 나중에 수동으로 만든다면 최소한 다음이 필요합니다.  
   - VCN  
   - 퍼블릭 서브넷  
   - 인터넷 게이트웨이 + 라우트(0.0.0.0/0 → IGW)  
   - **보안 목록(Security List)** 인바운드에 **TCP 22**(SSH) 허용

**SSH만 본인 IP로 제한**하려면 인바운드 규칙 소스를 `0.0.0.0/0` 대신 집 공인 IP/32 로 좁힙니다. (IP가 바뀌면 다시 열어야 할 수 있음.)

---

## 3-1. Create compute instance 화면에서 **Networking · 2 Errors** 일 때

스크린샷처럼 **Virtual cloud network**·**Subnet** 드롭다운이 비어 있고 빨간 **Required** / **2 Errors** 가 나오는 경우입니다. **집 PC에서 SSH로 접속**하려면 **퍼블릭 서브넷 + 공인 IPv4**가 필요합니다.

### A. 같은 마법사 안에서 새 VCN 만들기 (있으면 가장 빠름)

1. **Networking** 섹션을 펼칩니다.  
2. **Create new virtual cloud network** / **Create new VCN** / **Start VCN wizard** 류의 링크·라디오가 있으면 선택해, **인터넷 접근 가능한 VCN + 퍼블릭 서브넷**이 한 번에 만들어지게 합니다. (이름은 기본값도 됨.)  
3. 만들어진 뒤 **VCN** 드롭다운에서 그 VCN을 고르고, **Subnet**에서 이름에 **public** 이 들어간 서브넷을 고릅니다.  
4. **Public IPv4 address assignment** 를 **예(할당)** 로 켭니다. (퍼블릭 서브넷을 고르면 활성화됩니다.)  
5. 오류 배지가 사라졌는지 확인합니다.

### B. 마법사에 “새 VCN”이 없으면 — 브라우저에서 먼저 VCN만 만들기

1. (인스턴스 만들기는 **Cancel** 해도 됩니다.) 왼쪽 햄버거 → **Networking** → **Virtual cloud networks** → **Start VCN Wizard** (또는 **Create VCN**).  
2. **VCN with Internet Connectivity** 같은 프리셋을 고르면 퍼블릭 서브넷·게이트웨이가 같이 만들어지는 경우가 많습니다.  
3. 끝난 뒤 다시 **Compute → Instances → Create instance** 로 들어와, **Networking**에서  
   - **Select existing virtual cloud network** → 방금 만든 VCN  
   - **Subnet** → **Public Subnet-xxx** 에 가까운 이름  
   - **Assign public IPv4 address** 켜기  

### C. SSH 공개키(이미 하신 부분)

- **Paste public key** 칸에 `oci_raid_bot.pub` **한 줄 전체**가 들어가 있으면 그대로 두면 됩니다.

### D. Storage · Review

- **Storage:** 보통 기본 부트 볼륨(약 50GB) 그대로 두어도 됩니다. (Always Free 한도 안인지 콘솔 안내 확인.)  
- **Review** → 내용 확인 후 **Create**.

### E. Basic information 의 Shape 참고

- **VM.Standard.E2.1.Micro** (1 OCPU, 1GB) — Always Free면 디스코드 봇에는 **충분할 수 있음**.  
- 여유를 두려면 **Ampere A1 Flex** (`VM.Standard.A1.Flex`)로 바꾸는 것도 가능(같은 마법사 **Edit** / Basic에서 Shape 변경).

---

## 4. 컴퓨트 인스턴스 만들기

1. **Compute** → **Instances** → **Create instance**.  
2. **Name:** 아무 이름 (예: `raid-reminder-bot`).  
3. **Placement:** 기본 리전·가용 영역(Availability Domain) 유지.  
4. **Image:** **Oracle Linux 9** (또는 8) 권장.  
5. **Shape:**  
   - **Ampere A1 Flex** (`VM.Standard.A1.Flex`) — Always Free에 자주 쓰이는 ARM.  
   - **OCPU 1**, **Memory 6 GB** 정도로 시작(무료 한도 안에서 조정).  
   - 화면에 **“Always Free-eligible”** 표시가 있는지 확인합니다.  
6. **Networking:** 위에서 만든 VCN·퍼블릭 서브넷 선택.  
7. **Public IPv4 address:** **예(Yes)** — 외부에서 SSH 하려면 필요합니다.  
8. **Add SSH keys:** **Paste SSH keys** 선택 후, 2절에서 복사한 **`.pub` 내용 전체**를 붙여 넣습니다.  
9. **Create** — 몇 분 기다리면 상태가 **RUNNING** 이 되고 **Public IP**가 보입니다.

---

## 5. SSH 접속

PowerShell에서 (경로는 본인 PC에 맞게):

```powershell
ssh -i "$env:USERPROFILE\.ssh\oci_raid_bot" opc@공인IP주소
```

- 첫 연결 시 `yes` 입력.  
- 기본 사용자는 이미지에 따라 **`opc`** 가 많습니다. (다르면 콘솔 인스턴스 상세의 **Connection information** 참고.)

---

## 5-1. `Connection timed out` (22번으로 접속이 안 될 때)

`ssh: connect to host ... port 22: Connection timed out` 은 보통 **OCI 방화벽(보안 목록/NSG)** 또는 **집·회사 인터넷이 22번 발신을 막는 경우**입니다. 아래를 **위에서부터** 확인합니다.

### 1) 인스턴스 상태 (브라우저 OCI 콘솔)

**Compute → Instances** → 해당 인스턴스가 **RUNNING** 인지 확인합니다. **Stopped** 이면 **Start** 합니다.

### 2) 보안 목록(Security List)에 SSH 허용 (가장 흔한 원인)

1. **Networking → Virtual cloud networks** → 인스턴스가 쓰는 **VCN** 클릭.  
2. 왼쪽 **Security Lists** → 보통 **Default Security List for …** 클릭.  
3. **Add Ingress Rules** (인바운드 규칙 추가):  
   - **Source CIDR:** 테스트용으로는 `0.0.0.0/0` (나중에 집 공인 IP/32 로 좁혀도 됨)  
   - **IP Protocol:** TCP  
   - **Destination Port Range:** `22`  
   - **Stateless:** **아니요(No)** — SSH는 **Stateful**(무상태 아님)이 일반적입니다. (이미 **아니오** 로 되어 있으면 그대로 두면 됩니다. **예(무상태)** 만 피하세요.)  
   - 설명에 `SSH from home` 등 저장.  
4. 저장 후 **1~2분** 기다린 뒤 다시 `ssh` 시도.

> VCN 마법사로 만든 네트워크에도 **기본으로 22가 없을 수** 있습니다. 위 규칙이 없으면 반드시 추가하세요.

### 3) 네트워크 보안 그룹(NSG)을 VNIC에 붙인 경우

인스턴스 상세 → **Attached VNICs** → 해당 VNIC → **Network Security Groups** 에 NSG가 있으면, 그 NSG에도 **TCP 22 인바운드** 규칙을 넣어야 합니다.

### 4) 퍼블릭 서브넷·라우팅

인스턴스가 **퍼블릭 서브넷**에 있고, 서브넷 라우트에 **0.0.0.0/0 → Internet Gateway** 가 있어야 공인 IP로 들어옵니다. (VCN 마법사 “Internet Connectivity” 로 만들었다면 보통 맞습니다.)

### 5) 집/회사망에서 22번 차단 여부

같은 PC에서 **휴대폰 테더링(핫스팟)** 으로 바꾼 뒤 `ssh` 를 다시 시도해 보세요. 테더링에서는 되고 회사 Wi-Fi에서는 안 되면 **사내 방화벽** 때문일 수 있습니다.

### 6) 그래도 안 되면

OCI 콘솔 상단 **Cloud Shell** 을 열고, 거기서 `ssh opc@공인IP` 를 시도해 보세요(Cloud Shell은 Oracle 쪽 네트워크라, 로컬 ISP 문제를 가릴 수 있음). Cloud Shell에서는 키를 Cloud Shell에 따로 등록해야 할 수 있습니다.

---

## 5-2. 보안 목록·Stateful 은 맞는데 **여전히** 접속이 안 될 때

### A. “수정한 보안 목록”이 인스턴스 서브넷에 실제로 붙어 있는지

**Default Security List** 만 고치고, 인스턴스는 **다른 서브넷**(다른 보안 목록)에 있을 수 있습니다.

1. **Compute → Instances** → 인스턴스 클릭.  
2. **Attached VNICs** → 기본 VNIC → **Subnet** 링크로 들어갑니다.  
3. 그 서브넷의 **Security Lists** 탭에, **TCP 22** 규칙이 있는 보안 목록이 붙어 있는지 확인합니다.  
4. 없으면 **해당 서브넷에** SSH 인그레스가 있는 보안 목록을 추가로 연결하거나, 그 보안 목록에 22번 규칙을 넣습니다.

### B. 로컬 PC에서 22번이 “닿는지”만 먼저 확인 (PowerShell)

```powershell
Test-NetConnection -ComputerName 168.137.28.238 -Port 22
```

- **`TcpTestSucceeded : False`** 이면: OCI 쪽(서브넷·SL·NSG·라우팅) 또는 **집/회사망이 22 발신 차단** 가능성이 큽니다.  
- **`True`** 인데 `ssh` 만 실패하면: 사용자명(`opc` vs 이미지 안내)·키 경로·`ssh -vvv` 로 메시지 확인.

### C. 공인 IP가 바뀌지 않았는지

인스턴스를 **Stop / Start** 하면 **임시 공인 IP(Ephemeral)** 는 바뀌는 경우가 많습니다. 콘솔 **Instances** 목록에 찍힌 **지금** Public IP로 다시 접속합니다.

### D. NSG(네트워크 보안 그룹) 재확인

VNIC에 NSG가 **1개라도** 붙어 있으면, **보안 목록과 AND 조건**으로 모두 통과해야 합니다. NSG에 **TCP 22 인바운드**가 없으면 타임아웃이 납니다.

### E. 라우트 테이블(서브넷)

서브넷의 **Route Tables**에 **0.0.0.0/0 → Internet Gateway** 가 없으면 공인 IP로 들어오는 트래픽이 밖으로 나가지 않습니다. VCN 마법사로 만든 **퍼블릭 서브넷**인지 이름·라우트를 확인합니다.

### F. `ssh` 상세 로그 (로컬 PC)

```powershell
ssh -vvv -i "$env:USERPROFILE\.ssh\oci_raid_bot" opc@공인IP
```

맨 아래 근처의 `Connection timed out` / `Permission denied` 등으로 원인을 좁힐 수 있습니다. (`Permission denied` 까지 가면 네트워크는 통한 것입니다.)

### G. 사용자명

**Oracle Linux** 이미지는 보통 **`opc`** 입니다. 인스턴스 상세의 **Access information** / **Connection** 에 적힌 사용자를 그대로 씁니다.

### H. Windows 방화벽·백신

드물게 **밖으로 나가는 SSH(22)** 를 막는 경우가 있습니다. 잠시 끄고 테스트하거나 예외를 둡니다.

---

## 6. VM 안에서 Node.js 설치

봇은 **Node 18+** 가 필요합니다. Oracle Linux 9에서 **20 LTS**를 쓰려면 NodeSource 예시가 무난합니다.

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v
npm -v
```

이미 `sudo dnf install nodejs` 로 깔려 있고 버전이 18 이상이면 그대로 써도 됩니다.

---

## 7. 봇 코드 올리기

**방법 A — Git clone (저장소가 public이거나 VM에 토큰 설정 시)**

```bash
cd ~
git clone https://github.com/본인계정/aion2-raid-schedule.git
cd aion2-raid-schedule/discord-bot
npm install
```

**방법 B — 로컬에서 복사 (scp)**

로컬 PowerShell에서:

```powershell
scp -i $env:USERPROFILE\.ssh\oci_raid_bot -r C:\경로\aion2-raid-schedule\discord-bot opc@공인IP:/home/opc/
```

VM에서:

```bash
cd ~/discord-bot
npm install
```

---

## 8. `.env` 만들기 (VM 안에서)

```bash
cd ~/aion2-raid-schedule/discord-bot   # 또는 scp 한 경로
nano .env
```

`discord-bot/.env.example` 과 동일 항목을 채웁니다. 저장: `Ctrl+O`, 종료: `Ctrl+X`.

권한을 조금 좁혀도 좋습니다:

```bash
chmod 600 .env
```

---

## 9. 동작 확인

```bash
npm run check
npm start
```

잘 되면 `Ctrl+C` 로 끄고, 다음 절에서 **부팅 시 자동 실행**을 붙입니다.

---

## 10. systemd로 상시 실행 (권장)

1. Node 전체 경로 확인:

   ```bash
   which node
   ```

   예: `/usr/bin/node`

2. 서비스 파일 작성:

   ```bash
   sudo nano /etc/systemd/system/raid-discord-bot.service
   ```

   아래에서 **WorkingDirectory**·**ExecStart**·**User** 를 본인 경로에 맞게 수정합니다.

   ```ini
   [Unit]
   Description=Raid schedule Discord reminder bot
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=opc
   WorkingDirectory=/home/opc/aion2-raid-schedule/discord-bot
   EnvironmentFile=/home/opc/aion2-raid-schedule/discord-bot/.env
   ExecStart=/usr/bin/node /home/opc/aion2-raid-schedule/discord-bot/index.mjs
   Restart=always
   RestartSec=15

   [Install]
   WantedBy=multi-user.target
   ```

3. 적용 및 시작:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now raid-discord-bot.service
   sudo systemctl status raid-discord-bot.service
   ```

4. 로그 보기:

   ```bash
   journalctl -u raid-discord-bot.service -f
   ```

코드를 바꾼 뒤에는 `sudo systemctl restart raid-discord-bot.service` 입니다.

---

## 11. 보안·운영 팁

- **`.env`·비밀키**는 Git에 넣지 않습니다. VM 디스크만 두거나, 나중에 OCI **Vault**를 써도 됩니다.  
- SSH는 가능하면 **키만** 쓰고, 패스워드 로그인은 끕니다.  
- VM을 안 쓸 때는 **인스턴스 중지(Stop)** 로 비용·리소스 정책을 확인하세요(Always Free 정책은 Oracle 문서 기준).  
- **Outbound:** Discord·Supabase HTTPS는 기본적으로 나갑니다. 방화벽을 건드렸다면 아웃바운드도 확인합니다.

---

## 12. 막힐 때

- **인스턴스는 있는데 SSH 타임아웃** → 보안 목록·서브넷·퍼블릭 IP.  
- **`npm: command not found`** → Node 설치 경로·PATH.  
- **봇은 도는데 알림 없음** → `discord-bot/README.md` 의 동작 조건·`REMIND_TZ`·확정 일정·`discord_id` 확인.

이 문서는 경로 예시가 `/home/opc/aion2-raid-schedule` 입니다. clone 위치에 맞춰 바꾸면 됩니다.
