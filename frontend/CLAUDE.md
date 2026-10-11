# CLAUDE.md — 울산항 액체화물 관제 시스템 / UI(frontend) 작업 브리핑

> 이 파일은 Antigravity IDE + Claude Code extension 에서 UI 작업을 이어가기 위한
> 컨텍스트 문서다. frontend 프로젝트 루트에 두면 Claude 가 자동으로 읽는다.

## 1. 프로젝트 개요

- **멀티 에이전트 기반 액체화물 하역 스케줄링 및 안전 관제 시스템** (2026 스마트해운물류×ICT 멘토링, 2026.06~10)
- 팀: 함현우(조장·**UI 담당·이 세션의 사용자**), 이영서(데이터 엔지니어), 김동안(백엔드 AI·Neo4j/GraphRAG)
- 차별화 포인트: GraphRAG 기반 위험물 혼재금지 추론 + 실시간 데이터 통합 관제
- 사용자(함현우)는 git/개발 초보 — 명령·개념은 단계별로 쉽게 설명할 것

## 2. 저장소 구조 (GitHub org: SmartPortMAS)

| 레포 | 내용 | 상태 |
|---|---|---|
| `data-pipeline` | 수집→전처리→DB적재 (13종 데이터, run_pipeline.py) | ✅ 동작 검증 완료 |
| `backend` | FastAPI + Alembic + docker-compose.dev.yml | 골격 (API 개발 예정) |
| `frontend` | React UI (이 프로젝트) | Antigravity 초안 → 고도화 대상 |

- **브랜치 규칙: dev 에서 브랜치 생성 → 작업 → PR 은 dev 로** (main 직접 push 금지)
- 기존 Antigravity 산출물: `frontend-react/` (React18+Vite, Dockerfile, nginx.conf, 포트 3000:80,
  docker-compose 는 구 프로젝트 `울산항만_프로젝트_최종본`에 있었음) → frontend 레포 dev 로 이관 필요

## 3. 로컬 실행 환경 (이미 구축됨)

```bash
# DB 등 인프라 (backend 레포에서)
docker compose -f docker-compose.dev.yml up -d
# PostgreSQL: localhost:5433 (5432 아님! 구 프로젝트 컨테이너와 충돌 방지)
# Neo4j: smartport-neo4j-dev
# 접속정보: 각 레포 .env (노션에 원본, git 에 커밋 금지)
```

DB에 실데이터 적재 완료: upa_port_call(1.1만행)·upa_vessel_position·
upa_berth_facility·upa_anchorage·ais_vessel_position·ais_vessel_static·portmis_vessel·
tide_obs·wave_obs·weather_obs·msds_chemical(34종)

## 4. 데이터 → UI 연결 구조 (합의된 아키텍처)

```
PostgreSQL(5433) 원본 테이블
  → mart 뷰 (mart.dashboard_current 등 6개; 이영서가 완성 담당, SQL 초안 있음)
  → FastAPI (김동안; GET /api/dashboard 등)
  → React UI (이 프로젝트)
```

**API 계약(초안) — 백엔드 완성 전까지 이 형태의 mock JSON 으로 개발할 것:**

```json
GET /api/dashboard
{
  "vessels": [
    { "port_call_id": "D7ABC_2026_001", "callsgn": "D7ABC", "vessel_name": "HMM GOODWILL",
      "mmsi": 440559000, "is_liquid_cargo_vessel": true,
      "latitude": 35.44, "longitude": 129.13, "sog": 12.2,
      "nav_status_category": "UNDER_WAY", "arrival_at_utc": "2026-07-12T09:00:00Z" }
  ],
  "weather": { "wind_speed_ms": 6.2, "wind_dir_deg": 335, "wave_height_sig_m": 0.8,
               "tide_level_cm": 120, "visibility_m": 19.8, "observed_at_utc": "..." },
  "alerts": [
    { "level": "DANGER", "type": "SEGREGATION", "message": "3번 선석: 메탄올-황산 혼재금지",
      "port_call_id": "...", "created_at_utc": "..." }
  ]
}
```

**온산 MVP 에이전트 API (2026-07-20 로컬 프로토타입에 구현·검증 완료, 정식 backend 이식 예정)
— 아래 응답 형태 그대로 mock 으로 써서 UI 를 먼저 만들 것:**

```json
GET /api/v1/weather/assess?berth_group=정일1/2부두(산암리)&wind_speed=13&wave_height=1.2
{
  "berth_group": "정일1/2부두(산암리)",
  "status": "하역중단",   // 정상|하역중단|이안|호스분리|판단불가 (5단계 뱃지로 표시)
  "reasons": ["파고 1.2 m >= 1.0 m -> 하역중단"],
  "thresholds_used": { "stop": {"wind": 17.0, "wave": 1.0}, "unberth": {"wind": 19.0},
                       "disconnect": {"wind": 21.0, "wave": 2.0}, "source": "정일_입항정보_9.8" },
  "forecast_warning": null, "is_stale": false
}

GET /api/v1/weather/berth-groups   // 선석 선택 드롭다운용
{ "berth_groups": ["정일1/2부두(산암리)", "OTK1/2부두(처용리)", "..."] }

POST /api/v1/safety/assess         // 신규 입항 안전 판정 카드용
{
  "risk_level": "위험",             // 안전|주의|위험|배정불가 (결정론, 색상 매핑)
  "risk_level_basis": { "rule_engine_floor": "안전", "imdg_segregation_code": 2,
                        "flammability_grade": "저인화점", "gate_hits": ["R13", "R15"] },
  "gates": [ { "rule": "R13", "name": "인화성 인접작업 격리", "hit": true,
               "severity": "HOLD", "reason": "인접 'OTK 2부두' ... 배정 보류" } ],  // 15개 전부 옴
  "explanation": { "summary": "...", "reasoning": ["[R13] ..."], "checklist": ["..."] }
}

GET /api/agent/orchestrate?...&dwt=9000&draught=7.5&gt=8000
{
  "status": "APPROVED",             // APPROVED|REJECTED|WAITING_ANCHORAGE
  "berth_assigned": "OTK 2부두",
  "berth_decision": { "path": "대체",   // 전용|대체|정박지대기 (판단 경로 타임라인 UI 소재)
                      "anchorage": null,
                      "trace": ["전용 선석 'OTK 1부두' 점유 중", "대체 선석 'OTK 2부두' 게이트 통과 -> 배정"] },
  "risk_level": "주의", "safety_assessment": { "...": "POST /api/v1/safety/assess 와 동일 구조" }
}
```

## 5. UI 요구 화면 (우선순위 순)

1. **지도 패널**: react-leaflet(OSM) + 선박 마커(위험물선 강조) + **울산 bbox 사각형 표시**
2. **입항 목록**: port_call 테이블 (선박명/입출항시각/목적/위험물 여부)
3. **기상 패널**: 풍속·파고·조위·시정 + **선석별 4단계 판정 뱃지**(정상/하역중단/이안/호스분리
   — `/api/v1/weather/assess`, 선석 드롭다운은 `/api/v1/weather/berth-groups`)
4. **경고/체크리스트 패널**: alerts 표시 + 안전 게이트 R1~R15 결과 카드(`risk_level` 색상,
   히트 게이트 사유) + MSDS 기반 안전 체크리스트
5. (8월, 후순위) **디지털트윈**: Omniverse WebRTC 스트림을 iframe 으로 임베드
   (기존 방식: 백엔드가 USD 파일 좌표 조작 → 향후 localhost:8111 스트리밍 임베드)

**울산 bbox (2026-07 실측 재조정, PR 완료)**: lat 35.18~35.82 / lon 129.22~129.76
— 지도 초기 뷰와 bbox 오버레이에 이 값 사용. 지도 중심 대략 (35.47, 129.40).

## 6. 사용 가능한 실데이터 (mock 만들 때 참고)

- 실제 울산항 화물: 에탄올(UN1170)·자일렌(1307)·등유(1223)·가솔린(1203)·용융황(2448)·
  톨루엔(1294)·벤젠(1114)·부타디엔(1010) 등 — `upa_cargo_manifest_sample.csv` 365행
  (실제 하역기록 기반 생성, is_synthetic=True, data-pipeline 쪽에 있음)
- MSDS 34종: UN번호·IMDG등급·인화점·GHS — Neo4j 에도 적재됨
- 품질 플래그 체계: OK / MISSING_* / OUT_OF_ULSAN_BBOX / INVALID_* (staging 전 행 보존)

## 7. 기술 스택 (확정)

- React 18 + Vite / 상태관리 Zustand / 스타일 TailwindCSS / 차트 Recharts
- 지도: react-leaflet 권장 / 실시간: 폴링(30s) 우선, WebSocket 은 후순위
- Docker: 멀티스테이지 빌드 → nginx 서빙 (3000:80), nginx 가 /api 를 backend(8000)로 프록시

## 8. 하드웨어 연동 (데모 확장, 참고만)

- A. 선석 기상노드(ESP32+풍속계) → MQTT 입력 / B. 사전 승인 게이트(라즈베리파이+릴레이,
  페일세이프·인터락) — UI 에서 게이트 상태(승인/차단)와 경광등 상태 표시 위젯이 나중에 필요

## 9. 작업 규칙

- node_modules/dist/.env 는 절대 커밋 금지 (.gitignore 확인)
- 커밋은 작게, 메시지는 한국어 OK (예: "feat: 지도 패널 bbox 오버레이 추가")
- 완성 화면보다 **mock 데이터로 동작하는 화면 먼저** → API 나오면 fetch 만 교체
