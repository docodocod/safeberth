# 실행 방법 (팀 공유용)

> 목적별로 3단계입니다. **A만 하면 1분 안에 UI 전체를 볼 수 있습니다** (DB·백엔드·키 불필요).

| 단계 | 보이는 것 | 준비물 | 소요 |
|---|---|---|---|
| **A. UI만** | 대시보드·3D 트윈 전 화면 (mock 데이터) | Node.js 18+ | 1분 |
| **B. 실데이터** | A + 실제 선박·기상·선석 점유 | A + Docker, 백엔드 dev, .env | 20분 |
| **C. Omniverse 트윈** | B + Isaac Sim 3D 스트리밍 | B + NVIDIA GPU, Isaac Sim 6.0 | 별도 |

---

## A. UI만 보기 (권장 — 리뷰·시연 확인용)

```bash
git clone https://github.com/SmartPortMAS/frontend.git
cd frontend
git checkout feature/onsan-ui     # 또는 머지 후 dev
npm install
npm run dev
```
→ http://localhost:3000

백엔드가 없으면 **내장 mock 데이터로 자동 폴백**되므로 화면은 전부 동작합니다.
헤더에 "연결 끊김"이 뜨는 건 정상입니다(실서버가 없다는 뜻).

**볼 것**: 지도(온산 선석 12개소·혼재감시 연결선) / 기상 패널 4단계 판정 뱃지 /
선박 클릭 → 상세 패널(여정·안전판정·**계류 물리검증**) / 상단 `2D Map ↔ 3D View` 전환

---

## B. 실데이터까지 보기

### B-1. 인프라
```bash
# backend 레포에서 (.env 필요 — 노션 참고)
docker compose -f docker-compose.dev.yml up -d
```
PostgreSQL 5433 / Neo4j 7687·7474 가 뜹니다.

### B-2. 데이터 적재
```bash
# data-pipeline 레포에서 (.env 에 API 키 8종 — 노션 참고)
python -m data_pipeline.run_pipeline all          # 수집→전처리→적재
python -m data_pipeline.loaders.berth_neo4j_loader        # 선석 지식그래프
python -m data_pipeline.loaders.berth_weather_threshold_pg_loader  # 기상 임계값 시드
psql -f mart_views.sql                            # mart 뷰
```
> 임계값 시드 로더는 현재 `merge/combination-onsan-mvp` 브랜치에만 있습니다 (dev 머지 예정).

### B-3. 백엔드 + 프론트
```bash
# backend 레포에서
alembic upgrade head
uvicorn app.main:app --port 8001

# frontend 레포에서 (별도 터미널)
python mock-server/dashboard_server.py   # 포트 8000 (하역작업·시나리오 데이터)
npm run dev                              # 포트 3000
```

프론트는 **8000(mock)과 8001(실백엔드)을 동시에 호출해 병합**합니다
(`src/api/backendAdapter.js`). 한쪽이 죽어도 나머지로 화면이 유지됩니다.

**확인 포인트**
- 지도 우측 "지도 옵션" → **☑ 실선박 AIS** → 실측 선박 표시
- http://localhost:8001/docs 에서 API 직접 호출
- 헤더가 "실시간 연동 중" + 실측 풍속·관측시각으로 바뀜

---

## C. Omniverse 디지털트윈 (선택)

NVIDIA GPU + Isaac Sim 6.0 필요. `digital-twin/` 참고.
React 트윈과 **동일한 `/api/dashboard`를 2초 폴링**해 두 트윈이 같은 데이터를 봅니다.

물리검증 스크립트(Isaac 없이 근사식만 실행 가능):
```bash
python digital-twin/physics/mooring_berthing_sim.py --dwt 20000 --wind 17 --wave 1.0 --no-physx
```

---

## 자주 겪는 문제

| 증상 | 원인/해결 |
|---|---|
| 헤더 "연결 끊김" | 8000·8001 미기동 (A단계면 정상) |
| 기상이 "판단불가/오래됨" | 마지막 수집 후 3시간 경과 → `run_pipeline all` 재실행 |
| Neo4j 컨테이너 즉시 종료 | 7474/7687 포트를 다른 컨테이너가 선점 → 해당 컨테이너 정지 |
| `asyncpg` 설치 실패 | Python 3.12+ 에서 0.27 빌드 실패 → 0.31 이상 사용 |
| 파고 수집 실패 | 기상청 서버 간헐 지연 → `run_pipeline wave` 재시도 |
