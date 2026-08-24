# TW-Overlay 개인정보처리방침 (Privacy Policy)

**시행일자**: 2026년 8월 24일

> 💡 **요약**: **TW-Overlay**는 사용자의 개인정보를 외부 서버에 수집·저장하지 않으며, 클라우드 동기화 기능 사용 시 모든 데이터는 사용자의 개인 **Google Drive 전용 숨김 폴더(AppData)**에만 안전하게 보관됩니다.

---

## 1. 수집하는 개인정보 항목 및 수집 방법
TW-Overlay는 별도의 회원가입 없이 사용할 수 있는 오픈소스 데스크톱 애플리케이션입니다. 구글 드라이브 동기화 기능을 사용할 때에 한하여 다음과 같은 정보가 활용됩니다:

* **Google 계정 이메일 주소**: 사용자가 연동된 계정을 식별하고 앱 내에 표시하기 위한 목적으로만 사용됩니다.
* **사용자 환경설정**: 알림 사용 여부·키워드·음량·내장 사운드 선택, 단축키·퀵슬롯·메뉴, 채팅 오버레이 탭·필터·색상, 사용자 지정 알람, 계산기 설정 등.
* **숙제 체크리스트 데이터**: 숙제 정의와 리셋 규칙, 캐릭터 ID·사용자 지정 이름, 캐릭터별 완료·해제·N/A·횟수·완료 시각, 캐릭터 선택 전 미반영 완료 이력 등.
* **동기화하지 않는 민감·PC 종속 정보**: Discord Webhook URL, Google OAuth 토큰, 채팅/메신저 로그 경로, 커스텀 사운드 절대경로, 창 위치·크기, 일지 DB·채팅 로그·알람 이력은 Google Drive 동기화 파일에 포함하지 않습니다.

정확한 필드별 포함·제외 목록은 [Google Drive 클라우드 동기화 가이드](./docs/google-drive-sync.md)를 따릅니다.

---

## 2. 개인정보의 이용 목적
수집·활용되는 정보는 다음의 목적 이외의 용도로는 사용되지 않습니다:

1. 다중 PC 환경(집 PC, 노트북, PC방 등) 간 숙제 체크리스트 및 사용자 환경설정 동기화
2. 사용자 본인의 구글 드라이브에 안전한 백업 파일 생성 및 복원

---

## 3. 개인정보의 보관 및 제3자 제공
* **외부 서버 미전송**: TW-Overlay는 자체 데이터베이스나 중앙 서버를 운영하지 않습니다. 동기화 데이터는 사용자 본인의 Google Drive 앱 전용 격리 공간(`appDataFolder`)에 `tw_overlay_settings.json`, `tw_overlay_checklist.json`, `tw_overlay_sync_meta.json`으로 직접 저장됩니다.
* **암호화 범위**: Google과의 통신은 HTTPS를 사용하지만 TW-Overlay가 세 JSON 파일에 별도의 종단간 암호화를 추가하지는 않습니다. 따라서 비밀 자격증명과 PC 종속 경로는 동기화 대상에서 제외합니다.
* **제3자 제공 없음**: 개발자를 포함한 어떠한 제3자에게도 사용자의 개인정보나 인게임 데이터를 제공, 공유, 판매하지 않습니다.

---

## 4. Google API 사용자 데이터 정책 준수 (Google API Services User Data Policy)
TW-Overlay의 Google API 사용은 **[Google API 서비스 사용자 데이터 정책](https://developers.google.com/terms/api-services-user-data-policy)**(Limited Use 요건 포함)을 엄격히 준수합니다:

* 요청하는 권한(`.../auth/drive.appdata`)은 오직 TW-Overlay가 생성한 앱 데이터 JSON 파일에만 접근하며, 사용자의 일반 Google Drive 파일(사진, 문서 등)에는 접근하지 않습니다.
* 사용자의 구글 데이터를 AI 모델 훈련 또는 광고 타겟팅 등의 다른 용도로 일체 사용하지 않습니다.

---

## 5. 개인정보의 파기 및 권한 철회 방법
사용자는 언제든지 데이터 동기화를 중단하고 개인정보 및 저장된 데이터를 영구 파기할 수 있습니다:

1. **앱 내 연동 해제**: 설정 > 데이터 관리에서 `[연동 해제]` 버튼을 클릭하면 로컬에 저장된 암호화 인증 토큰이 즉시 영구 삭제됩니다.
2. **Google 계정에서 권한 삭제**: [Google 계정 권한 관리 페이지](https://myaccount.google.com/permissions)에서 언제든지 TW-Overlay의 접근 권한을 철회할 수 있습니다.
3. **클라우드 데이터 영구 삭제**: Google Drive 웹 접속 > 우측 상단 [설정] ⚙️ > [앱 관리] > TW-Overlay > [숨겨진 앱 데이터 삭제]를 선택하여 드라이브 내 동기화 파일을 영구 삭제할 수 있습니다.

---

## 6. 문의처
개인정보 보호와 관련된 문의사항이나 건의사항은 아래의 공식 창구를 통해 문의해 주시기 바랍니다.

* **버그 제보 & 개선 제안 설문**: [https://forms.gle/n5u4shgfF6unQR8N6](https://forms.gle/n5u4shgfF6unQR8N6)
* **GitHub 이슈**: [https://github.com/twliker/tw-overlay/issues](https://github.com/twliker/tw-overlay/issues)
