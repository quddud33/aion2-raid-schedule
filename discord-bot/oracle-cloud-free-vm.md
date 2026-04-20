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

## 3-2. Always Free에서 RAM을 늘리는 방법 (자세히)

**전제:** `VM.Standard.E2.1.Micro` 는 **RAM 1GB 고정**입니다. 무료여도 메모리는 늘지 않습니다.  
RAM을 늘리려면 **(1) 다른 무료 Shape 쓰기**, **(2) 같은 1GB에 스왑 추가**, **(3) `dnf` 대신 tarball** 중에서 고르면 됩니다.

### A. Ampere A1 Flex로 새 VM 만들기 (무료 한도 안에서 RAM 4~6GB)

Oracle **Always Free**에는 **Ampere A1 Compute** 할당이 따로 있습니다. `VM.Standard.A1.Flex` 는 **OCPU 개수와 메모리(GB)를 슬라이더로** 정합니다.  
**E2.1 Micro(x86, 1GB)** 와 **CPU 아키텍처가 다릅니다** → **새 인스턴스**를 만들고 **ARM64(aarch64)** 이미지를 고릅니다. (기존 VM에서 “Shape만 변경”으로 바꾸는 것은 **거의 불가**입니다.)

#### A-0. 시작 전에

1. **[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)** 에서 **Ampere A1** 무료 한도(월 OCPU·GB 시간, 홈 리전 등)를 한 번 확인합니다.  
2. **E2 VM에만 있는 것**을 백업합니다. (로컬 PC에서 예시)

   ```powershell
   scp -i $env:USERPROFILE\.ssh\oci_raid_bot opc@예전E2공인IP:/home/opc/aion2-raid-schedule/discord-bot/.env C:\backup\discord-bot.env
   ```

   또는 VM 안에서 `cat` 해서 메모장에 복사해 둡니다. **`.env`는 Git에 올리지 마세요.**

3. 새 VM이 정상 동작한 뒤에만, 예전 E2 인스턴스를 **Stop** 또는 **Terminate** 합니다. (무료 VM 개수·한도에 따라 **둘 다 켜 두면** 제한에 걸릴 수 있습니다.)

#### A-1. OCI 콘솔 — A1 Flex + 메모리 4~6GB (단계별)

화면 이름은 콘솔 업데이트로 조금 다를 수 있습니다. **핵심은 “ARM 이미지 + A1.Flex + 메모리 슬라이더 + Always Free 표시”** 입니다.

1. 상단 리전이 **E2를 만들었던 홈 리전**과 같은지 확인합니다. (다르면 A1 무료 한도가 따로일 수 있음.)
2. **Compute** → **Instances** → **Create instance**.
3. **Name:** 예: `raid-bot-a1` (구분만 되면 됨).
4. **Placement:** 기본 가용 영역(AD) 유지.
5. **Image and shape** (또는 **Image** / **Change image**):
   - **Change image** 로 들어가 **Platform images** 에서 **Oracle Linux 9** 를 고릅니다.  
   - **아키텍처 확인 방법 (콘솔):**
     - **Shape를 먼저 `A1.Flex`로 바꾼 뒤** 이미지를 고르면, 목록이 **ARM 전용**으로 필터되는 경우가 많습니다. (그럼 잘못 고를 확률이 줄어듭니다.)
     - 이미지 선택 창에 **Architecture**, **Processor type**, **aarch64**, **ARM 64-bit** 같은 **열·필터·배지**가 있으면 그 값이 **aarch64 / ARM64** 인 행만 고릅니다.
     - 표에 **x86_64**, **64-bit AMD** 만 보이면 **아직 x86용 목록**일 수 있으니, **Shape를 A1 Flex로 바꿨는지** 다시 확인합니다.
     - 한 줄 요약: **A1 Flex + Oracle Linux 9** 조합에서, 화면에 아키텍처가 나오면 **ARM/aarch64** 만 선택합니다.
   - **최종 확인(가장 확실):** 인스턴스 생성 후 SSH로 들어가 `uname -m` 을 칩니다. **`aarch64`** 가 나오면 맞습니다. **`x86_64`** 면 이미지/템플릿을 잘못 고른 것이므로, 인스턴스를 지우고 **ARM 이미지**로 다시 만듭니다.
6. **Shape** → **Change shape** → **Browse all shapes** (또는 유사 메뉴):
   - **Shape series**(또는 상단 타일)에서 **`Specialty and previous generation`** 만 선택되어 있으면 **E2 Micro·Intel·AMD** 같은 **x86** 목록만 나옵니다.  
   - 반드시 **`Ampere`** 타일을 누릅니다. (설명에 **Arm-based processor** 가 붙어 있는 시리즈입니다.)  
   - 그다음 아래 목록에서 **`VM.Standard.A1.Flex`** 를 고릅니다. (여기서 **Always Free-eligible** 표시가 나오는지 확인합니다.)  
   - **Ampere** 를 눌렀는데도 A1이 안 보이면: 리전·가용 영역(AD)에 **용량이 없거나**, 테넌시에 Ampere 무료 한도가 없을 수 있습니다. 다른 AD/리전을 시도하거나 [Always Free 문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)·OCI 지원을 확인합니다.

#### A-1a. `VM.Standard.A1.Flex` 용량 부족(AD-1 등) 오류

다음과 같은 메시지가 나오면 **그 가용성 도메인(AD)에 A1 물리 용량이 일시적으로 없는 것**입니다.

> 가용성 도메인 AD-1에서 VM.Standard.A1.Flex 형태의 인스턴스 용량이 부족합니다. 다른 가용성 도메인에…

영문 API 예시:

> `Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1` … Create the instance in a **different availability domain** or try again later.

**대응 순서:**

1. **Placement** / **Availability domain** 을 **AD-2** 로 바꿔 **Create** → 또 실패하면 **AD-3** … 리전에 있는 **모든 AD**를 순서대로 시도합니다. (콘솔에서 드롭다운에 나오는 AD만 해당.)
2. **Fault domain** 은 이미 **Let Oracle choose** 면 그대로 두고, **직접 골랐다면** 자동 선택으로 바꿉니다.
3. **리전 전체에서 A1이 계속 안 잡히면:**  
   - **몇 시간~며칠 뒤** 같은 리전에서 다시 시도 (용량 풀림은 Oracle 쪽 스케줄).  
   - 또는 **다른 홈 리전**에서 새 VCN + A1 인스턴스 생성 (지연·네트워크는 본인이 감수).  
   - **Paid capacity** / 유료 용량 예약은 무료만 쓰려면 **선택하지 않습니다.**
4. A1이 당분간 불가능하면 **E2 Micro + 스왑 + tarball(§6·§3-2 B/C)** 로 봇만 먼저 올리는 현실적인 우회가 있습니다.

#### A-1b. `Estimated cost` 에 부트 볼륨 $/월이 보일 때

인스턴스 만들기 **Review** 단계에 **Estimated cost** 가 나오고, **Boot volume** 에 월 **몇 달러**가 찍혀도 **당장 “유료 확정”은 아닐 수 있습니다.**

- 콘솔 견적은 **표준 단가 기준**이고, **Always Free·크레딧**을 **견적에 완전히 반영하지 않는 경우**가 많습니다. **Compute가 `Always Free-eligible`** 이고 **부트 볼륨 크기가 무료 한도 안**이면, 실제 청구는 **$0**에 가깝게 나오는 경우가 많습니다. (정책·테넌시 종류는 **[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)** 가 기준입니다.)
- **확인:** Review에서 **Compute** 행에도 무료/자격 안내가 있는지, 부트 볼륨 **GB**가 과하게 크지 않은지(기본 50GB 전후가 흔함) 봅니다.
- **불안하면:** **Budget·알림**을 켜 두고, 생성 후 **Cost Analysis** 로 며칠 뒤 실제 소비를 확인합니다.
- **Compute가 무료 자격이 아니면** 부트 볼륨 포함 **견적대로 유료**될 수 있으므로, **`Always Free-eligible` 없음 + 유료 경고**면 생성을 멈추고 Shape·한도를 다시 확인합니다.
   - **Show advanced options** / 세부가 있으면 열어 **OCPU** 와 **Memory in GB** 슬라이더를 조절합니다.
   - **목표 예시:** **OCPU 1**, **Memory 4 GB** 또는 **6 GB**. (슬라이더가 OCPU에 따라 허용 범위를 제한할 수 있습니다. 4~6GB가 안 되면 **한도 안에서 가능한 최대 메모리**로 올립니다.)
   - 화면 어딘가에 **Always Free eligible** / 무료 자격 / 한도 안이라는 **녹색·안내 문구**가 있는지 확인합니다. **과금 경고**가 뜨면 슬라이더를 줄이거나 한도 문서를 다시 확인합니다.  
   - **`Always Free-eligible` 배지가 안 보이면:** 서브 창만 그럴 수도 있지만, **무료만 쓰겠다면 “배지 없음 = 무료”로 가정하지 마세요.** **Review** 단계·요금 안내에 **유료(종량제)** 경고가 없는지 꼭 확인합니다. 유료 Shape/OCPU·RAM을 쓰면 **청구**될 수 있습니다. (정책은 **[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)** 가 기준입니다.)
7. **Networking:** 기존 E2와 같이 **같은 VCN** + **퍼블릭 서브넷** + **퍼블릭 IPv4 할당 예** 를 선택합니다. (새 VCN을 또 만들 필요는 보통 없습니다.)
8. **Add SSH keys:** 예전과 동일하게 **Paste public keys** 에 `oci_raid_bot.pub` 한 줄을 넣습니다.
9. **Boot volume:** 기본값(약 50GB)으로도 무료 한도 안인지 콘솔 안내를 확인합니다.
10. **Create** → **RUNNING** 이 되면 인스턴스 상세에서 **Public IP** 를 확인합니다. (E2 때와 **IP가 다릅니다.**)

#### A-2. SSH 접속 (ARM도 사용자는 보통 `opc`)

```powershell
ssh -o GSSAPIAuthentication=no -i "$env:USERPROFILE\.ssh\oci_raid_bot" opc@새공인IP
```

접속 후 확인:

```bash
uname -m
# aarch64 가 나와야 합니다.
free -h
```

#### A-3. Node·봇 (ARM)

- **§6-1 tarball** 에서 **`ARCH=arm64`**, 파일명 **`linux-arm64`** 를 사용합니다. (`VER` 는 [latest-v20.x](https://nodejs.org/dist/latest-v20.x/) 에 맞춤.)  
- **§7·§8·§10** 은 E2 때와 동일하되, `systemd` 의 `ExecStart` 는 **`/opt/node20/bin/node`** 처럼 **실제 경로**로 맞춥니다.

#### A-4. 예전 E2 인스턴스

봇이 새 VM에서 잘 돌아가는 것을 확인한 뒤, **Compute → Instances** 에서 예전 E2 인스턴스를 **Terminate** 하면 IP·자원이 정리됩니다. (아직 비교가 필요하면 **Stop** 만 해 두어도 됩니다.)

### B. E2 Micro 유지 + 스왑(Swap) 추가 (디스크 여유 필요)

RAM은 1GB 그대로지만, **디스크 일부를 가상 메모리**로 써서 `dnf` 가 OOM으로 `Killed` 나는 일을 줄입니다. §6의 **스왑 예시 명령**을 참고합니다. (부트 볼륨 여유가 있어야 합니다.)

### C. E2 Micro 유지 + Node는 tarball (§6-1)

`dnf` 를 거의 쓰지 않아 **메모리 부담이 적습니다.** x86_64 tarball 절차는 §6-1에 있습니다.

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

**중요:** 아래 **첫 줄(`curl … | bash`)만** 실행하면 **저장소 설정만** 되고, **`node` / `npm` 은 아직 없습니다.** 반드시 **둘째 줄 `sudo dnf install -y nodejs`** 까지 끝내야 합니다.

```bash
# ① NodeSource 저장소 등록 (끝나면 프롬프트로 돌아옴)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -

# ② Node 패키지 설치 — 이걸 안 하면 `node: command not found` 가 납니다
sudo dnf install -y nodejs

node -v
npm -v
```

**정상일 때:** ②를 치면 곧바로(또는 잠시 뒤) 터미널에 **메타데이터 확인·패키지 목록·다운로드 진행률·`Installing/Complete`** 같은 줄들이 **계속 올라옵니다.** 아무 글자도 없이 **몇 분째 멈춘 것처럼** 보이면, Micro VM(1GB)에서 **메모리 부족·다른 `dnf` 잠금·느린 미러**일 수 있습니다. 다른 SSH 창에서 `ps aux | grep dnf` 로 잠금 여부를 보거나, 더 자세한 로그는 `sudo dnf install -y nodejs -v` 로 시도해 볼 수 있습니다.

- ②에서 **오류·충돌 메시지**가 나오면 그대로 복사해 두었다가 확인합니다. (`--allowerasing` 이 필요한 경우도 드묽니다: `sudo dnf install -y nodejs --allowerasing`)  
- **`dnf` 가 오래 멈춘 것처럼 보이면** (Micro 1GB에서 흔함): SSH를 **새로 연 뒤** `sudo pkill dnf`(필요 시)·`sudo rm -f /var/run/dnf.pid` 등으로 정리하고 **②만** 다시 실행해 보거나, 바로 아래 **§6-1 tarball** 절차를 씁니다.  
- **`Killed` 한 줄만** 나오고 종료되면: 설치 스크립트가 “터진” 것이 아니라, **메모리 부족(OOM Killer)** 이 `dnf` 를 죽인 경우가 대부분입니다. (Always Free **E2.1 Micro 1GB** 에서 자주 발생.) 확인: `sudo dmesg -T | tail -20` 근처에 `Out of memory: Killed process` / `dnf` 가 보이는지 봅니다.  
  - **대응 1 — 스왑 추가 후 다시 ②:** 예시(2G 스왑, 디스크 여유 필요):

    ```bash
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    free -h
    sudo dnf install -y nodejs
    ```

  - **대응 2:** 아래 **§6-1 tarball** 로 설치(`dnf` 거의 안 씀).

### 6-0. 설치됐는지 확인

```bash
rpm -q nodejs
command -v node
command -v npm
```

`rpm -q` 가 `package nodejs is not installed` 이면 **②를 아직 안 했거나 실패**한 것입니다.

### 6-1. `dnf` 가 어려울 때 — 공식 tarball 로 Node 20

`uname -m` 으로 아키텍처를 확인한 뒤, [Node 20 릴리스](https://nodejs.org/dist/latest-v20.x/)에서 같은 버전의 **`linux-x64`** 또는 **`linux-arm64`** `.tar.xz` 를 고릅니다.

- **E2 Micro (x86_64)** → `linux-x64` (아래 예시).  
- **§3-2 의 A1 Flex (aarch64)** → 파일명이 `linux-arm64` 인 tarball.

```bash
cd ~
VER=20.19.5   # 예: 위 링크 디렉터리에서 최신 20.x 파일명에 맞게 수정
# x86_64(E2)면 x64, aarch64(A1)면 arm64
ARCH=x64
curl -fsLO "https://nodejs.org/dist/v${VER}/node-v${VER}-linux-${ARCH}.tar.xz"
tar -xJf "node-v${VER}-linux-${ARCH}.tar.xz"
sudo rm -rf /opt/node20
sudo mv "node-v${VER}-linux-${ARCH}" /opt/node20
grep -q '/opt/node20/bin' ~/.bashrc || echo 'export PATH=/opt/node20/bin:$PATH' >> ~/.bashrc
export PATH="/opt/node20/bin:$PATH"
node -v
npm -v
```

새 SSH 세션에서도 쓰려면 `source ~/.bashrc` 한 번 하거나 재접속합니다. (systemd `ExecStart` 에는 **`/opt/node20/bin/node`** 처럼 **전체 경로**를 쓰면 PATH에 의존하지 않아도 됩니다.)

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
