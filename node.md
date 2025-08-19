# Node.js 설치 경로 확인 및 관리

## 목표
Windows 11 Pro 시스템에서 Node.js 설치 경로를 확인하고 관리하는 방법

## 상황 분석

### 초기 상황
- Windows 11 Pro 시스템
- Node.js가 PATH에 없는 상태
- `where node` 명령어로 경로를 찾지 못함

### 발견된 설치 위치
```
C:\Users\N\AppData\Roaming\fnm\node-versions\v22.14.0\installation\node.exe
C:\Users\N\AppData\Roaming\fnm\aliases\default\node.exe
```

**관리 도구**: FNM (Fast Node Manager)
**현재 버전**: v22.14.0

## Node.js 설치 경로 확인 방법

### 1. 일반적인 확인 방법
```cmd
where node
node --version
npm --version
```

### 2. PowerShell을 통한 확인
```powershell
Get-Command node -ErrorAction SilentlyContinue
```

### 3. 일반적인 설치 경로들
- `C:\Program Files\nodejs`
- `C:\Program Files (x86)\nodejs`
- `%USERPROFILE%\AppData\Roaming\npm`
- `%USERPROFILE%\AppData\Local\Programs\nodejs`
- `C:\ProgramData\chocolatey\lib\nodejs` (Chocolatey)
- `%USERPROFILE%\AppData\Roaming\nvm` (NVM)
- `%USERPROFILE%\AppData\Roaming\fnm` (FNM)

### 4. 수동 검색 방법
- Windows 탐색기에서 `node.exe` 파일 검색
- 레지스트리에서 확인: `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
- 설정 → 앱에서 Node.js 검색

## FNM (Fast Node Manager) 관리

### FNM 구조 이해
- **실제 설치 경로**: `fnm\node-versions\v22.14.0\installation\`
- **별칭 경로**: `fnm\aliases\default\` (기본 버전을 가리키는 심볼릭 링크)
- PATH는 `aliases\default` 경로를 참조

### FNM 명령어
```cmd
# 현재 상태 확인
fnm --version
fnm list
fnm current
fnm ls-remote

# 버전 설치/삭제
fnm install 18.20.0
fnm uninstall 22.14.0

# 버전 전환
fnm use 18.20.0
fnm default 22.14.0
```

## Node.js 삭제 방법

### 1. FNM을 통한 삭제
```cmd
# 특정 버전 삭제
fnm uninstall 22.14.0

# 모든 버전 확인 후 삭제
fnm list
```

### 2. FNM 완전 제거
```cmd
# PowerShell 관리자 권한에서
Remove-Item -Recurse -Force "$env:USERPROFILE\AppData\Roaming\fnm"

# 환경변수에서 FNM 경로 제거
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$newPath = ($currentPath -split ';' | Where-Object { $_ -notlike "*fnm*" }) -join ';'
[Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
```

### 3. 일반 Node.js 완전 삭제
```cmd
# npm 캐시 정리
npm cache clean --force

# 폴더 삭제
rmdir /s /q "%USERPROFILE%\AppData\Roaming\npm"
rmdir /s /q "%USERPROFILE%\AppData\Roaming\npm-cache"
rmdir /s /q "C:\Program Files\nodejs"
rmdir /s /q "C:\Program Files (x86)\nodejs"

# 환경변수 정리
# PowerShell에서
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
$newPath = ($currentPath -split ';' | Where-Object { $_ -notlike "*node*" -and $_ -notlike "*npm*" }) -join ';'
[Environment]::SetEnvironmentVariable("PATH", $newPath, "Machine")
```

## 문제 해결

### 액세스 거부 오류 (Error 5)
**오류**: `Can't delete Node.js version: 액세스가 거부되었습니다. (os error 5)`

**해결 방법**:

1. **관리자 권한으로 실행**
   - `Win + X` → "Windows 터미널(관리자)"
   - `Win + R` → `cmd` → `Ctrl + Shift + Enter`

2. **Node.js 프로세스 종료**
   ```cmd
   tasklist | findstr node
   taskkill /f /im node.exe
   taskkill /f /im npm.exe
   ```

3. **강제 삭제 (PowerShell 관리자)**
   ```powershell
   # 프로세스 강제 종료
   Get-Process | Where-Object {$_.Name -like "*node*"} | Stop-Process -Force
   
   # 폴더 강제 삭제
   Remove-Item -Recurse -Force "$env:USERPROFILE\AppData\Roaming\fnm\node-versions\v22.14.0"
   Remove-Item -Recurse -Force "$env:USERPROFILE\AppData\Roaming\fnm\aliases\default"
   ```

4. **안전 모드에서 삭제**
   - `Win + R` → `msconfig` → 부팅 → 안전 부팅
   - 안전 모드에서 `rmdir /s /q "%USERPROFILE%\AppData\Roaming\fnm"`

## 권장 해결 순서

1. **관리자 권한 CMD**에서 `fnm uninstall` 시도
2. **프로세스 종료** 후 재시도
3. **PowerShell 강제 삭제** 방법 사용
4. **안전 모드 삭제** (최후 수단)

## 주의사항

- `aliases\default\node.exe`를 직접 삭제하지 말 것
- 항상 FNM 명령어를 통해 관리
- 중요한 프로젝트는 삭제 전 백업
- 완전 제거 후에는 새로운 Node.js 설치 필요

## 다음 단계

### FNM 유지하는 경우
- 다른 Node.js 버전 설치 및 관리
- 프로젝트별 버전 전환 활용

### 완전 제거하는 경우
- nodejs.org에서 공식 installer로 재설치
- 또는 다른 버전 관리 도구 사용 (NVM, Volta 등)

---

**작성일**: 2024년 12월 20일
**시스템**: Windows 11 Pro
**도구**: FNM (Fast Node Manager)
**버전**: Node.js v22.14.0