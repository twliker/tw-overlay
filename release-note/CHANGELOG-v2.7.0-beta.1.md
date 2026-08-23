# 📦 TW-Overlay Beta Release - v2.7.0-beta.1 (2026-08-24)

이번 **v2.7.0-beta.1 테스트 빌드**는 Google Drive AppData 기반의 클라우드 자동 동기화 기능 및 웹 가이드 문서 시스템이 추가된 테스트 버전입니다.

---

## 🛠️ 주요 변경 사항

### 1. Google Drive AppData 클라우드 동기화 (1단계)
* **Google OAuth 2.0 PKCE 로그인**: 웹 브라우저를 통한 안전한 구글 계정 연동 및 Windows DPAPI 암호화 토큰 보관
* **드라이브 숨김 격리 저장**: 사용자 개인 Google Drive의 전용 앱 숨김 폴더(`appDataFolder`)를 활용하여 숙제 체크리스트 및 설정 동기화
* **스마트 디바운스 자동 백업**: 숙제 체크 및 설정 변경 시 5초 후 백그라운드 자동 업로드
* **설정 창 내 [데이터 확인] 뷰어**: 클라우드에 보관된 최신 JSON 원본 데이터를 열람하고 클립보드로 복사할 수 있는 모달 팝업 추가

### 2. 웹 공식 홈페이지 & 24개 기능 가이드 뷰어
* **공식 웹 랜딩 페이지**: `https://twliker.github.io/tw-overlay/`
* **인터랙티브 웹 가이드 뷰어**: `https://twliker.github.io/tw-overlay/guide/` (24개 전체 기능 마크다운 실시간 렌더링 및 검색 지원)
* **공식 개인정보처리방침 웹페이지**: `https://twliker.github.io/tw-overlay/privacy/`

### 3. 버그 제보 & 피드백 설문지 갱신
* 앱 내부 About 탭 및 공식 웹사이트 전체에 새 설문지(`https://forms.gle/n5u4shgfF6unQR8N6`) 링크 적용

---

## 📥 테스트 설치 방법

1. Releases 페이지 하단 Assets에서 `twOverlay-Setup-2.7.0-beta.1.exe`를 다운로드하여 실행합니다.
2. 기존 데이터와 설정을 유지한 채 테스트 버전이 설치됩니다.
