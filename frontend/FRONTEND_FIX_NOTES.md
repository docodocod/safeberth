# 프론트 수정 내역 (김동안, 2026-08-12)

> 백엔드 API 연동 확인하다가 프론트-백엔드 계약이 안 맞는 부분·버그를 여러 개 발견해서
> 함현우 님 UI 코드에 제가 직접 손을 좀 댔습니다. 무엇을 왜 바꿨는지 정리해둡니다.

## 요약

| 영역 | 문제 | 상태 |
|---|---|---|
| 입항 선박 목록 | mock 데이터만 표시, 정렬/페이징 없음 | ✅ 수정 |
| 안전 심사 결과 | 다른 화면에서 선박 클릭만 해도 결과가 덮어써짐 | ✅ 수정 |
| 관제 콘솔(AgentConsole) | 드롭박스 고르면 선박 상세 패널이 같이 열림 | ✅ 수정 |
| 안전 심사 화물 목록 | 11종 하드코딩, 실제 DB(36종)와 불일치 | ✅ 수정 |
| 혼재 검사(인접 선석) | mock 선박 목록을 보고 있어 사실상 항상 무결과 | ✅ 수정 |
| 질의응답 근거 표시 | 마크다운 깨짐, 근거 전부 나열돼 지저분함 | ✅ 수정 |
| 하역 작업 현황(간트) 상단 | mock 데모 선박 | ⏸ 보류 (원인만 파악, 아래 참고) |
| `.gitignore` | `venv/`가 안 걸려 있어 통째로 untracked | ✅ 수정 |

---

## 1. 입항 선박 목록 (`PortCallTable.jsx`)

- **mock → 실데이터**: `data.vessels`(mock, mock-server 꺼져 있어 항상 내장 데모값)를 보고
  있었음 → `data.real_traffic`(백엔드 `/dashboard/vessels` 실제 조인 결과)로 교체.
- 실데이터엔 `arrival_at_utc`가 없어서(위치 API라 "최근 수신시각"만 있음) 정렬·표시 기준을
  `received_at_utc`로 변경. 컬럼 헤더도 "입항시각" → "최근 수신"으로 수정.
- 컬럼 클릭 정렬(오름/내림 토글), 페이지네이션(10개씩) 추가.
- `table-layout: fixed` + `colgroup`으로 컬럼 폭 고정 — 정렬할 때마다 폭이 흔들리던 것 해결.

## 2. 안전 심사 결과가 다른 선박 값으로 덮어써지는 버그

**증상**: `SafetyGatesPanel`(안전 관제 탭의 "신규 입항 안전 심사" 폼)에서 화물을 선택해 심사를
돌려도, 지도나 입항 목록에서 다른 선박을 클릭하기만 하면 그 선박의 판정 결과로 화면이
조용히 바뀌었습니다. 대시보드 "최근 안전 심사" KPI 카드도 마찬가지.

**원인**: `assessSafetyGates()`(`useOnsanApi.js`) 함수가 호출될 때마다 전역 스토어
`gateAssessment`에 결과를 직접 썼는데, 이 함수를 **두 군데**가 같이 씁니다.
- `SafetyGatesPanel`의 수동 "안전 심사 실행" 버튼
- `useVesselSafety`(선박을 클릭할 때마다 자동으로 도는 판정 훅, `VesselDetailPanel`용)

**수정**: `assessSafetyGates()`에서 스토어에 쓰는 부분을 없애고 결과만 반환하도록 바꿨습니다.
전역 상태에 반영할지는 호출자가 결정 — `SafetyGatesPanel`만 명시적으로
`setGateAssessment(res)`를 호출합니다. `useVesselSafety`는 원래부터 자기 로컬 state로만
관리하고 있었어서 그대로 둬도 됩니다.

## 3. 관제 콘솔(`AgentConsole.jsx`) 드롭박스 → 선박 상세 패널이 같이 뜨는 문제

**증상**: 우하단 "에이전트 협상 로그" 콘솔에서 선박을 고르면, 뒤에서 `VesselDetailPanel`(그
선박의 상세 정보 큰 패널)이 같이 열렸습니다.

**원인**: 콘솔의 `<select>`가 전역 `setSelectedVessel()`을 호출했는데, 이게
`VesselDetailPanel`이 뜨는 조건과 완전히 같은 상태였습니다.

**수정**: 콘솔 전용 로컬 상태(`localTarget`)를 추가해 드롭박스는 이제 그것만 바꿉니다.
지도/입항목록 클릭 → 콘솔이 그 선박을 자동으로 따라가는 동작(전역 상태 읽기)은 그대로
유지했습니다 — 콘솔에서 직접 고른 게 없을 때만 전역 값을 씀.

## 4. 안전 심사 화물 목록이 실제 DB와 다른 문제

**증상**: "신규 입항 안전 심사" 폼의 화물 드롭다운이 11종으로 하드코딩돼 있었고, 그중
`'자일렌(혼합)'`·`'스티렌'`은 CAS 매핑 사전(`CARGO_CAS`)의 표기와 안 맞거나 아예 없어서
골라도 무조건 "CAS 매핑 없음"으로 실패했습니다.

**수정**:
- 백엔드에 이미 있던 `GET /api/v1/chatbot/chemicals`(지식그래프 등재 화물 전체, 현재 36종)를
  불러오는 훅 `useChemicalList()`를 `useOnsanApi.js`에 추가하고, `SafetyGatesPanel`의 두
  드롭다운(화물/인접 선석 화물)을 여기 연결했습니다.
- 화물 선택도 이름 문자열이 아니라 `chem_id`로 직접 넘기게 바꿔서, 이름 표기 불일치로 인한
  매핑 실패가 구조적으로 없어졌습니다.
- (참고) `AgentConsole`의 자유 텍스트 질의응답 쪽 화물 인식은 이번에 손 안 댔습니다 — 문장에서
  화물명을 스스로 찾아내는 별개 로직이라 성격이 다릅니다.

## 5. 혼재금지 검사가 사실상 항상 "충돌 없음"으로 나오던 문제

**원인**: `useVesselSafety.js`가 인접 선석 화물을 찾을 때 `data.vessels`(mock 데모 선박 목록)를
보고 있었습니다. 실제 선박은 여기 안 들어있으니 인접 화물이 거의 항상 빈 배열로 잡혀서,
혼재금지 검사가 사실상 무력화돼 있었습니다.

**수정**: `data.real_traffic`(실AIS+실화물 조인)으로 교체. 겸사겸사 대상 화물·인접 화물 모두
`cas_no`를 실데이터에서 바로 넘기도록 바꿔서(이미 DB에서 조인된 값이라 이름 사전을 거칠
필요가 없음), 표기 불일치로 인한 오탐도 줄였습니다.

## 6. 질의응답(RAG 챗봇) 근거 표시 정리

- LLM 답변에 `**굵게**`, "1. 2. 3." 번호매김이 그대로 텍스트로 노출되던 것 → 최소 파서로
  굵게 처리 + 번호 항목마다 줄바꿈.
- 근거(citation)를 전부 나열해서 지저분해 보이던 것 → 확정값(정형 데이터) 우선, 그다음
  유사도 높은 순으로 **최대 2개만** 한 줄 칩으로 표시. 클릭하면 콘솔 안에 팝업 오버레이로
  원문이 뜸(채팅 스크롤 위치 안 흔들림).
- 근거 헤더(화학물질명·섹션명)와 중복되던 본문의 `[화학물질명 - 섹션명]` 접두어 제거.
- KOSHA MSDS 원문이 항목별 라벨을 반복하며 줄바꿈 없이 이어붙어 오는 경우(예: "인체를
  보호하기 위해 필요한 조치사항 및 보호구: ..."가 여러 번 반복) → 라벨 기준으로 다시 잘라
  항목마다 문단을 나누도록 처리.

## 7. 보류한 것 — 하역 작업 현황(간트차트) 상단

`GanttChart.jsx`의 "진행 중/예정 작업" 섹션(HMM GOODWILL 등)은 여전히 mock입니다. 화면에도
이미 "진행률은 데모값 (실시간 유량 센서 미수집)"이라고 스스로 밝혀두고 있어서 이번엔 안
건드렸습니다. UPA 하역정보 API(`getUnloadRcdInfo`)로 실데이터 대체를 검토했는데:
- 실시간 %진행률 자체는 어떤 API로도 못 구합니다(하드웨어 유량센서가 있어야 함).
- 지금 DB에 있는 505건도 `vessel_name` 대부분 결측, 물량 필드가 정제 안 된 텍스트라 바로 쓸
  품질이 아닙니다. 데이터 정제 작업이 별도로 필요합니다.

## 8. 리팩토링 (기능 변경 없음)

- `useOnsanApi.js`: `chem_id → cas_no → cargoRef` 3단 분기가 두 군데(대상 화물/인접 화물)에
  똑같이 중복돼 있던 걸 `resolveCargoRef()` 공통 함수로 뺐습니다.
- `AgentConsole.jsx`: 근거 카드 렌더링이 JSX 안에 즉시실행함수(IIFE)로 박혀 있어 중첩이
  깊었던 걸 `pickTopCitations()` + `CitationList` 컴포넌트로 분리했습니다.

## 9. 기타

- `.gitignore`에 `venv/`가 빠져 있어서 `git status`가 파이썬 venv 파일 수천 개를 untracked로
  잡고 있었습니다 — 추가했습니다.

---

## 건드린 파일 목록

```
frontend/.gitignore
frontend/src/components/dashboard/AgentConsole.jsx
frontend/src/components/dashboard/PortCallTable.jsx
frontend/src/components/safety/SafetyGatesPanel.jsx
frontend/src/hooks/useOnsanApi.js
frontend/src/hooks/useVesselSafety.js
```

## 참고 — 백엔드/DB 쪽에서 같이 한 것 (별도 레포)

- `data-pipeline/mart_views.sql`을 다시 적용했습니다. 지난번에 적용이 중간에 실패해서
  `mart.facility_alias`(시설명 정규화) 등 새 뷰가 반쪽만 반영돼 있었는데, 이번에
  `mart_views_check.sql` 검증 13개 항목 전부 PASS까지 확인했습니다.
- `run_pipeline.py all`을 한 번 수동 실행했습니다. `weather_forecast`(403, 기상청 서비스키
  문제로 추정)와 `port_call`(429, UPA API 요청제한)는 이번 실행에서 실패했고, 자동 갱신
  스케줄러 자체가 아직 없다는 점은 별도로 계속 남아있는 문제입니다.
