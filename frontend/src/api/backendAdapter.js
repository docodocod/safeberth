// ─────────────────────────────────────────────
// 김동안 백엔드(FastAPI, dev 머지본) → 대시보드 계약 어댑터
//
// 백엔드는 GET /api/v1/dashboard/{weather,vessels,berths,anchorages}
// 4개 읽기 엔드포인트로 나뉘어 있다 (2026-07-25 dev 머지 기준).
// 프론트 화면은 기존 GET /api/dashboard 한 덩어리 계약을 쓰므로,
// 여기서 4개를 병렬 호출해 그 모양으로 합쳐준다 (팀 합의: 백엔드 수정 없이
// 프론트 어댑터로 흡수).
//
// 필드 매핑 (AIS 표준 → 기존 UI 필드):
//   sog(대지속력) → sog 그대로 / cog·heading → vessel_heading
//   nav_status_code(AIS 항해상태 코드) → nav_status_category
// ─────────────────────────────────────────────
import { ULSAN_BBOX } from '../utils/constants';

// 백엔드 주소를 앱 코드에 박지 않는다.
//
// 여기에 'http://localhost:8000' 같은 절대주소를 두면, 사람마다 uvicorn 띄우는
// 방식이 달라질 때(관제시스템_시작.bat 은 --port 8001, 맨손 uvicorn 은 기본 8000)
// 화면 전체가 "연결 끊김"이 된다. 실제로 이 값이 두 번 뒤집혔고(08-17, 08-19)
// 그때마다 다른 사람 쪽 화면이 통째로 죽었다.
//
// 개발: vite 프록시가 /api → 백엔드로 넘긴다(포트는 vite.config.js 한 곳에서 지정).
// 배포: nginx 가 같은 경로를 프록시한다.
// 어느 쪽이든 앱은 상대경로만 쓰므로 포트를 알 필요가 없다.
export const BACKEND_BASE = '/api/v1';

// 지도에 동시에 그리는 선박 수 상한. 마커가 많아지면 지도가 눈에 띄게 무거워진다.
// KPI 숫자는 이 상한과 무관하게 전체를 센다(realTrafficTotal) — 상한이 KPI 까지
// 잘라버리면 "관제 선박이 항상 200척"이라는 잘못된 인상을 준다.
export const MAP_VESSEL_LIMIT = 200;

// AIS 항해상태 코드(ITU-R M.1371 숫자) → UI 카테고리 — ais_vessel_position(레거시 소스) 행에서만 옴
const NAV_CODE_TO_CATEGORY = {
  0: 'UNDER_WAY', 1: 'AT_ANCHOR', 2: 'UNKNOWN', 3: 'UNDER_WAY', 4: 'UNDER_WAY',
  5: 'MOORED', 6: 'AT_ANCHOR', 7: 'UNDER_WAY', 8: 'UNDER_WAY',
};

// upa_vessel_position(주 소스, 실측 918척 중 900척 이상)의 nav_status_code는 숫자가 아니라
// 이 한글 텍스트로 온다(2026-08-11 실측). 이 매핑이 없으면 전부 byCode 미스로 SOG 추정
// 폴백을 타서 "정박(계류)"(실제 접안 180척)까지 전부 AT_ANCHOR로 잘못 잡힌다 — MOORED가
// 항상 0으로 보이던 원인.
const NAV_TEXT_TO_CATEGORY = {
  '항해(동력)': 'UNDER_WAY',
  '항해(비동력)': 'UNDER_WAY',
  '정박(계류)': 'MOORED',
  '정박(앵커링)': 'AT_ANCHOR',
  '낚시': 'UNDER_WAY',
  '기동 제한': 'UNKNOWN',
  '흘수에 의한 제한': 'UNKNOWN',
  '조종 불가': 'UNKNOWN',
  '후방 예인': 'UNDER_WAY',
};

// 위치 판정(mart.vessel_presence — 백엔드 /vessels 의 presence_zone) → UI 카테고리.
// 선석 점유(/berths)·정박지 대기(/anchorages)와 같은 기준이라, 판정이 있으면 AIS
// 자기신고 항해상태보다 먼저 쓴다. 자기신고는 선석에 멈춰 있어도 바꾸지 않는 배가
// 많다(2026-09-17 실측: 위치로 선석에 붙은 41척 중 '정박(계류)' 24척, '항해(동력)'
// 10척, 빈 값 4척). STOPPED(조선소 의장안벽·물양장·예인선 대기 등)는 선석·정박지가
// 아니므로 아래 자기신고 매핑으로 넘긴다 — 지도 아이콘용이고 KPI 는 따로 센다.
const PRESENCE_TO_CATEGORY = {
  BERTH: 'MOORED',
  ANCHORAGE: 'AT_ANCHOR',
  UNDERWAY: 'UNDER_WAY',
};

function navCategory(row) {
  const byPresence = PRESENCE_TO_CATEGORY[row.presence_zone];
  if (byPresence) return byPresence;
  const code = row.nav_status_code;
  const byText = NAV_TEXT_TO_CATEGORY[code];
  if (byText) return byText;
  const byCode = NAV_CODE_TO_CATEGORY[code];
  if (byCode) return byCode;

  // ── 항해상태 코드가 없는 배를 '묘박'으로 세지 않는다 ─────────────────────────
  //
  // 예전에는 `sog < 1 ? 'AT_ANCHOR' : 'UNDER_WAY'` 로 추정했다. 그 결과 KPI 의
  // "묘박/정박지 대기"가 56척으로 나왔는데, 그중 29척이 이 추정분이었다.
  //
  // [왜 코드가 없나 — AIS Class B]
  // 항해상태(nav status)는 Class A 위치보고(메시지 1/2/3)에만 있는 필드다.
  // 소형선이 쓰는 Class B 보고(메시지 18)에는 그 필드 자체가 없다. 그래서
  // 코드 결측은 대부분 **항내 소형 작업선**이다 — 실측(2026-08-17) 29척 전부
  // PORT-MIS 미대조였고, 청화호·울산지원호·동경102호·현중303호처럼 예선·급유선·
  // 통선·시운전선(S/T) 이름이다.
  //
  // [왜 '묘박'이 틀렸나 — 항만 운영 기준]
  // 정박지 대기는 "본선이 선석을 못 잡아 지정 정박지에서 기다리는 상태"를 뜻하는
  // 운영 지표다. 예선·급유선은 선석을 기다리는 배가 아니라 항내에서 대기·작업 중인
  // 서비스 선박이라, 여기 섞으면 "대기 선박 수"가 부풀려져 배정 판단이 왜곡된다.
  //
  // 좌표로도 확인된다 — 코드 결측 29척 중 **정박지 반경 안에 있는 배는 0척**이다
  // (upa_anchorage 20개소 대조). 반대로 '정박(앵커링)' 29척 중 9척은 정박지 안이다.
  //
  // 그래서 모르는 것은 모른다고 둔다. UNKNOWN 은 화면에서 '상태 미상'으로 표시되고
  // 묘박 집계에 들어가지 않는다.
  return 'UNKNOWN';
}

function inUlsanBbox(row) {
  return (
    row.latitude >= ULSAN_BBOX.minLat && row.latitude <= ULSAN_BBOX.maxLat &&
    row.longitude >= ULSAN_BBOX.minLon && row.longitude <= ULSAN_BBOX.maxLon
  );
}

// mart.dashboard_current 설계 의도(dashboard.py 주석): "프론트 기본 필터: presence_state
// = PRESENT". 지금까지 이 필터를 안 걸어서 신호 끊긴 지 오래된 선박(NO_SIGNAL)·출항
// 확정 선박(DEPARTED)까지 전부 "관제 선박"으로 잡혔다(실측: bbox 내 918척 중 PRESENT는
// 0척, 나머지는 STALE/NO_SIGNAL/DEPARTED). PRESENT만 쓰면 수집 주기(현재 10분)상 거의
// 항상 0척으로 보여 오히려 "죽은 화면"처럼 느껴지므로, 화면에 아직 회색 처리를 안 붙인
// 지금 단계에서는 STALE(30분~6시간 침묵)까지는 포함하고 NO_SIGNAL·DEPARTED만 제외한다.
function isRecentlyPresent(row) {
  return row.presence_state === 'PRESENT' || row.presence_state === 'STALE';
}

// PORT-MIS 선종 대조 결과는 3상태다 — true(액체화물선)/false(비액체)/null(대조 실패).
// null 을 false 로 접으면 "선종을 모르는 배"가 화면에서 "일반화물선"으로 둔갑한다.
// 실측(2026-08-15, 재항 356척): true 66 / false 19 / null 271.
// null 이 압도적인 이유는 조인 키 문제다 — PORT-MIS 에는 MMSI 컬럼이 없어 호출부호로만
// 붙일 수 있는데, AIS 호출부호는 선택 필드라 74척이 아예 빈 값이다.
// ─────────────────────────────────────────────────────────────────────────────
// [2026-09-25] 선종 → 대표 화물 추정(SHIP_KIND_ASSUMED_CARGO)을 없앴다.
// 케미칼선이면 무엇을 싣든 벤젠으로 판정하는 식이라 실제 화물과 무관한 값이었다
// (크롬 확인: 3EVD9 실제 5종 → 화면 '벤젠(선종 추정)'). 화물은 입항 건 화물만 쓰고,
// 없으면 '화물 미확인' — 판정 입력이 없으니 판정도 하지 않는다(입항 자동 판정과 같은 규칙).

const callsgnKey = (cs) => (cs ? String(cs).trim().toUpperCase() : '');

// [2026-09-29] 시연용 주입 화물 — cargo_basis 가 '시연-혼재충돌 …(의도적 주입)'으로 시작하는 행.
const isDemoBasis = (b) => typeof b === 'string' && b.startsWith('시연');

/** 주입 화물 목록. 선석은 재항 화물(berth-cargo)의 시설을 먼저 쓰고, 없으면 위치 판정 선석을 쓴다. */
function demoInjectedList(berthCargo, vesselCargo, vessels) {
  const byCs = new Map((vessels ?? []).filter((v) => v.callsgn).map((v) => [callsgnKey(v.callsgn), v]));
  const out = [];
  const seen = new Set();
  const take = (rows, wharfFromRow) => {
    for (const r of rows ?? []) {
      if (!isDemoBasis(r.cargo_basis)) continue;
      const cs = callsgnKey(r.callsgn);
      const k = `${cs}|${r.chem_id ?? r.cargo_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const v = byCs.get(cs);
      out.push({
        callsgn: r.callsgn,
        vessel_name: r.vessel_name ?? v?.vessel_name ?? null,
        cargo_name: r.cargo_name,
        chem_id: r.chem_id ?? null,
        wharf: (wharfFromRow ? r.facility_name : null) ?? v?.presence_berth_name ?? null,
        basis: r.cargo_basis,
      });
    }
  };
  take(berthCargo, true);
  take(vesselCargo, false);
  return out;
}

function liquidByShipType(row) {
  return row.is_liquid_cargo_vessel == null ? null : Boolean(row.is_liquid_cargo_vessel);
}

/** upa_vessel_position 행 → 기존 vessels 계약 필드 (+ is_real_ais 플래그)
 * cargoByCallsgn: /dashboard/vessel-cargo (배마다 지금의 입항 건 화물, 2026-09-25)를
 * callsgn으로 조인 — 위치 API 자체엔 화물 정보가 없어 이걸로 보강한다.
 * ambiguousCallsgns: 재항 선박 중 둘 이상이 같은 호출부호를 쓰는 값들(아래 설명). */
function mapVessel(row, cargoByCallsgn, ambiguousCallsgns, cargoListByCallsgn) {
  // 호출부호가 여러 배에 걸리면 화물을 붙이지 않는다. 붙이면 옆 배 위험물이
  // 엉뚱한 배에 표시되고, 그 배가 혼재·흘수 판정 입력으로까지 들어간다.
  // 모르는 것을 아는 척하느니 비워 두는 편이 맞다.
  const ambiguous = row.callsgn ? ambiguousCallsgns.has(row.callsgn) : false;
  const cargo = (!ambiguous && cargoByCallsgn?.get(callsgnKey(row.callsgn))) || null;
  const cargoRows = (!ambiguous && cargoListByCallsgn?.get(callsgnKey(row.callsgn))) || [];
  const byShipType = ambiguous ? null : liquidByShipType(row);
  return {
    // 식별자는 MMSI 우선(vessel_key = mart.vessel_identity 의 MMSI-First vessel_uid).
    //
    // 예전엔 `AIS_{호출부호||MMSI}` 였는데, AIS 호출부호에는 '500'·'301'·'ABCD'
    // 같은 쓰레기값이 있어 서로 다른 배가 같은 id 를 받았다(실측 4쌍). 그 결과
    // 입항 목록에서 React key 가 충돌해 같은 배가 두 줄로 보였다
    // (예: DAESU HO / 500 — 실제로는 EOHANG DONGHAE 3HO 와 다른 배다).
    port_call_id: `AIS_${row.vessel_key ?? row.mmsi ?? row.callsgn}`,
    vessel_key: row.vessel_key ?? null,
    callsgn: row.callsgn,
    // 이 호출부호로는 선종·화물을 붙일 수 없다는 사실 자체를 화면이 알게 한다
    callsgn_ambiguous: ambiguous,
    vessel_name: row.vessel_name,
    mmsi: row.mmsi,
    // 선종명(PORT-MIS 공식 51개 코드) — "석유제품 운반선"처럼 근거를 그대로 보여준다
    ship_kind_nm: row.ship_kind_nm ?? null,
    // 근거를 두 개로 나눠 보존한다. 예전엔 두 개를 is_liquid_cargo_vessel 하나에
    // 눌러 담아, 같은 이름이 화면마다 다른 뜻이었다(KPI는 선종 기준 66척, 목록은
    // 화물 매칭 기준 58척 — 둘 다 "위험물선"이라고 적혀 있었다).
    liquid_by_ship_type: byShipType,          // PORT-MIS 선종 기준 (true/false/null)
    has_dg_cargo: Boolean(cargo),             // 재항 위험물 신고가 실제로 붙었는가
    // 액체화물 하역 대상 = 선종이 액체화물선이거나, 위험물 화물이 확인된 배.
    // (2026-08-15 결정: 액체화물을 싣는 배는 전부 하역 대상으로 본다)
    is_liquid_cargo_vessel: Boolean(cargo) || byShipType === true,
    latitude: row.latitude,
    longitude: row.longitude,
    sog: row.sog,
    draught_m: row.draught ?? null, // dwt는 파이프라인 미수집 — null 유지(오케스트레이터가 "미상"으로 보수적 처리)
    vessel_heading: row.heading || row.cog || 0,
    nav_status_category: navCategory(row),
    // 위치 판정 원본 — BERTH/ANCHORAGE/STOPPED/UNDERWAY, 최신 스냅샷에 없으면 null
    presence_zone: row.presence_zone ?? null,
    presence_berth_name: row.presence_berth_name ?? null,
    presence_berth_basis: row.presence_berth_basis ?? null,
    presence_anchorage_name: row.presence_anchorage_name ?? null,
    received_at_utc: row.received_at_utc,
    is_real_ais: true,
    presence_state: row.presence_state,
    position_age_min: row.position_age_min,
    // VTS 확인 입출항 시각(mart.dashboard_current → port_call_overview → upa_port_call/
    // portmis_vessel 조인 결과). berth_assignment.actual_berthing_at/actual_departure_at과
    // 같은 소스 — 재항 중인 배는 departure_at_utc가 항상 null이다(아직 출항 전).
    arrival_at_utc: row.arrival_at_utc ?? null,
    departure_at_utc: row.departure_at_utc ?? null,
    // 지금 붙어 있는 선석(위치 판정). 예전엔 berth-cargo 행의 facility_name 이었는데
    // 그 값이 곧 vessel_presence.berth_name 이었다. 화물 출처를 입항 건으로 바꾸면서
    // facility_name 이 적하목록 신고 시설(정박지 등)이 되므로 원래 값을 직접 쓴다.
    berth: row.presence_berth_name ?? null,
    cargo: cargo ? {
      // chem_id 는 스케줄링·안전 에이전트가 화물을 식별하는 1순위 키다.
      // (UN 번호로는 조회할 수 없다 — msds_context 는 chem_id/cas_no 만 쓴다)
      name: cargo.cargo_name, chem_id: cargo.chem_id ?? null,
      un_no: cargo.dg_un_no, cas_no: cargo.cas_no,
      imdg_class: cargo.imdg_class, is_synthetic: cargo.is_synthetic,
    } : null,
    // 같은 입항 건에 함께 실은 화물 전부(cargo 포함). 판정 요청의 cargos 로 간다.
    cargos: cargoRows.map((c) => ({
      name: c.cargo_name, chem_id: c.chem_id, cas_no: c.cas_no ?? null, un_no: c.dg_un_no,
      // 시연을 위해 넣은 화물인가(cargo_basis 가 '시연'으로 시작) — 화면이 칩으로 밝힌다
      is_demo: isDemoBasis(c.cargo_basis),
    })),
  };
}

/** /dashboard/history 행 → GanttChart의 HistoryGantt 계약(job_id/vessel_name/berth/begin_utc/end_utc).
 * GanttChart.jsx는 이미 ops.filter(is_real_record) 로 이 모양을 기다리고 있었다 — 지금까지
 * 채워주는 API 호출이 없어 항상 빈 배열이었다. */
// 정박지·묘박지·자동차부두 등 액체화물 관제 대상이 아닌 시설은 접안 이력 막대에서 뺀다.
const NON_LIQUID_FACILITY = /(정박지|묘박지|자동차|컨테이너|여객)/;

function isLiquidHistoryRecord(row) {
  return Boolean(row.facility_name) && !NON_LIQUID_FACILITY.test(row.facility_name);
}

function mapHistoryRecord(row) {
  return {
    job_id: `HIST_${row.callsgn || row.vessel_name}_${row.arrival_at_utc}`,
    vessel_name: row.vessel_name,
    callsgn: row.callsgn,
    // "SK2부두 01" 의 슬롯 번호는 관제 화면에서 뜻이 없다 — 부두 이름만
    berth: String(row.facility_name).replace(/\s+\d{1,2}$/, ''),
    begin_utc: row.arrival_at_utc,
    end_utc: row.departure_at_utc,
    is_real_record: true,
  };
}

/** /dashboard/weather 응답 → 기존 weather 계약 (wind_dir_deg는 백엔드 미제공 — 호출측에서 병합) */
function mapWeather(w) {
  return {
    wind_speed_ms: w.wind?.value ?? null,
    // 예전 백엔드는 풍향을 안 줘서 null 고정이었다. mart.weather_now 전환 후
    // 풍향·돌풍이 응답에 생겼는데 여기서 버리면 mock-server 가 죽은 구성(클라우드
    // 배포 등)에서 풍향이 영영 비게 된다 — 그대로 통과시킨다.
    wind_dir_deg: w.wind_dir_deg ?? null,
    gust_ms: w.gust_ms ?? null,
    wave_height_sig_m: w.wave?.value ?? null,
    tide_level_cm: w.tide?.value ?? null,
    visibility_m: w.visibility_m ?? null,
    observed_at_utc: w.wind?.observed_at_utc ?? w.wave?.observed_at_utc ?? null,
    is_stale: Boolean(w.wind?.is_stale || w.wave?.is_stale),
  };
}

async function getJson(path) {
  const res = await fetch(`${BACKEND_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 백엔드 9개 엔드포인트를 병렬 호출해 대시보드 보강 데이터로 변환.
 * 기상+선박 둘 다 실패하면 null (백엔드 다운으로 간주 — 호출측이 기존 소스 유지).
 */
export async function fetchBackendDashboard() {
  const [weather, vessels, berths, anchorages, berthCargo, draughtCheck, history, pipelineHealth, stats, alerts, berthDwell, vesselCargo] =
    await Promise.allSettled([
      getJson('/dashboard/weather'),
      getJson('/dashboard/vessels'),
      getJson('/dashboard/berths'),
      getJson('/dashboard/anchorages'),
      getJson('/dashboard/berth-cargo'),
      getJson('/dashboard/draught-check'),
      getJson('/dashboard/history'),
      getJson('/dashboard/pipeline-health'),
      getJson('/dashboard/stats'),
      getJson('/dashboard/alerts'),
      getJson('/dashboard/berth-dwell'),
      getJson('/dashboard/vessel-cargo'),
    ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : null)));

  if (!weather && !vessels) return null;

  // [2026-09-25] 선박 화물은 /dashboard/vessel-cargo(배마다 **지금의 입항 건** 화물)로
  // 붙인다. 예전엔 /berth-cargo 로 붙였는데 그건 선석에 붙은 배만 담아서, 항해 중·
  // 정박지의 배는 입항 건에 화물이 있어도 '화물 미신고'로 보였다(크롬 확인 2026-09-25:
  // 목록의 액체화물선 12척 전부). 새 엔드포인트가 없는 백엔드면 예전 방식으로 떨어진다.
  //
  // cargo(대표 1종)는 목록 첫 행, cargos 는 그 입항 건 화물 전부(chem_id 중복 제거).
  // 키는 호출부호 대문자·공백 제거 — 백엔드 뷰가 그렇게 정규화해서 내려준다.
  const cargoByCallsgn = new Map();
  const cargoListByCallsgn = new Map();
  for (const row of vesselCargo ?? berthCargo ?? []) {
    const key = callsgnKey(row.callsgn);
    if (!key) continue;
    if (!cargoByCallsgn.has(key)) cargoByCallsgn.set(key, row);
    const list = cargoListByCallsgn.get(key) ?? [];
    if (row.chem_id && !list.some((c) => c.chem_id === row.chem_id)) list.push(row);
    cargoListByCallsgn.set(key, list);
  }

  // 지도에 그릴 수 있는 선박(좌표 있음 + bbox 내 + 최근 신호). 상한을 걸기 전 전체.
  const inBbox = (vessels ?? [])
    .filter((r) => r.latitude != null && r.longitude != null)
    .filter(inUlsanBbox)
    .sort((a, b) => new Date(b.received_at_utc) - new Date(a.received_at_utc));
  const presentVessels = inBbox.filter(isRecentlyPresent);

  // 호출부호는 AIS 에서 선택 입력이라 '500'·'301'·'1263'·'ABCD' 같은 값이 실제로
  // 들어온다(실측 4쌍이 서로 다른 배끼리 겹쳤다). 화물·선종을 이 키로 붙이므로,
  // 겹치는 호출부호를 먼저 찾아 두고 그런 배에는 아무것도 붙이지 않는다.
  const callsgnCount = new Map();
  for (const r of presentVessels) {
    const cs = r.callsgn;
    if (cs) callsgnCount.set(cs, (callsgnCount.get(cs) ?? 0) + 1);
  }
  const ambiguousCallsgns = new Set(
    [...callsgnCount.entries()].filter(([, n]) => n > 1).map(([cs]) => cs)
  );

  // KPI 분류 — mapVessel 과 같은 판정을 쓴다. 두 곳이 갈리면 KPI 와 목록 숫자가
  // 어긋나고, 어느 쪽이 맞는지 화면만 봐서는 알 수 없게 된다.
  const isAmbiguous = (r) => Boolean(r.callsgn) && ambiguousCallsgns.has(r.callsgn);
  const hasCargo = (r) => !isAmbiguous(r) && cargoByCallsgn.has(callsgnKey(r.callsgn));
  const shipType = (r) => (isAmbiguous(r) ? null : liquidByShipType(r));

  return {
    weather: weather ? mapWeather(weather) : null,
    // 지도 성능 때문에 200척만 그린다. 다만 KPI 까지 200 으로 보이면 "관제 선박이
    // 항상 200척"이라는 잘못된 인상을 준다 — 실제 수는 realTrafficTotal 로 따로 넘겨
    // 화면이 "몇 척 중 몇 척을 그리는 중"인지 정직하게 말할 수 있게 한다.
    // 상한(200척)은 지도 마커 성능 때문이지 판정 때문이 아니다. 그런데 이 목록이
    // 협상 콘솔의 판정 대상으로도 쓰여서, 상한에 잘린 액체화물선은 배정을 받아
    // 놓고도 콘솔에서 찾을 수 없었다 — 배정현황의 "협상 로그 →" 가 그 배 대신
    // 기본값을 여는 실사고(2026-08-23, 미시칸/D8BD). 판정 대상(액체화물선 중
    // 화물 확인)은 상한과 무관하게 항상 포함하고, 나머지 배경 표적만
    // 남은 자리를 채운다.
    realTraffic: (() => {
      const mapped = presentVessels.map((row) => mapVessel(row, cargoByCallsgn, ambiguousCallsgns, cargoListByCallsgn));
      const judgeable = mapped.filter((v) => v.is_liquid_cargo_vessel && v.cargo);
      const rest = mapped.filter((v) => !(v.is_liquid_cargo_vessel && v.cargo));
      return [...judgeable, ...rest.slice(0, Math.max(0, MAP_VESSEL_LIMIT - judgeable.length))];
    })(),
    realTrafficTotal: presentVessels.length,
    // AIS 신호가 끊긴 액체화물선 — 화면(지도·목록)에는 넣지 않고 '조회용'으로만 싣는다.
    //
    // 배정과 화면이 "이 배가 지금 여기 있다"를 다른 기준으로 본다:
    //   배정(arrival_watcher) = PORT-MIS 재항 기록(출항 신고 없음)
    //   화면(real_traffic)    = AIS 신호 신선도
    // 그래서 PORT-MIS 상 재항인데 AIS 가 끊긴 배가 추천·승인 대기에는 오르고
    // 화면 판정 목록에는 없는 상태가 생긴다(2026-08-24 실측: 승인 대기 9건이
    // 전부 NO_SIGNAL 이라 "협상 로그 →" 가 엉뚱한 배를 열었다).
    //
    // 이 배들을 지도·목록에 올리면 12일 전 위치를 현재처럼 보여주게 되므로 넣지
    // 않는다. 대신 승인 대기 건에서 지목될 때만 콘솔이 여기서 찾아 쓴다.
    offscreenJudgeable: inBbox
      .filter((r) => !isRecentlyPresent(r))
      .map((row) => mapVessel(row, cargoByCallsgn, ambiguousCallsgns, cargoListByCallsgn))
      .filter((v) => v.is_liquid_cargo_vessel && v.cargo),
    // 선석별 재항 위험물 화물 원본 — 안전 심사 폼이 "재항 선박에서 불러오기"에 쓴다.
    // (화물을 수기로 고르는 대신 지금 실제로 붙어 있는 배를 선택하게 하기 위함)
    berthCargo: berthCargo ?? [],
    demoInjected: demoInjectedList(berthCargo, vesselCargo, vessels),
    // 서버가 준 화물이 전부 합성인가 — 화면의 '합성 자료' 칩이 본다
    cargoAllSynthetic: (() => { const rows = vesselCargo ?? berthCargo ?? []; return rows.length > 0 && rows.every((r) => r.is_synthetic); })(),
    // KPI 는 지도 상한(200척)과 무관하게 전체를 세야 하므로 매핑 전 원본에서 센다.
    realTrafficLiquidTotal: presentVessels.filter(
      (r) => shipType(r) === true || hasCargo(r)
    ).length,
    // 선종을 "모르는" 배 — 나머지를 일반화물선으로 읽는 오해를 막으려고 따로 센다.
    realTrafficUnknownTotal: presentVessels.filter(
      (r) => shipType(r) === null && !hasCargo(r)
    ).length,
    // 접안 중·정박지 대기 KPI — 선석 점유(/berths)·정박지 현황(/anchorages)과 같은
    // 위치 판정으로 센다. 백엔드가 presence_zone 을 아직 안 주면(구버전) null 로 두고
    // 화면이 예전 방식(자기신고 항해상태)으로 센다.
    realTrafficBerthedTotal: presentVessels.some((r) => 'presence_zone' in r)
      ? presentVessels.filter((r) => r.presence_zone === 'BERTH').length
      : null,
    realTrafficAnchoredTotal: presentVessels.some((r) => 'presence_zone' in r)
      ? presentVessels.filter((r) => r.presence_zone === 'ANCHORAGE').length
      : null,
    berthOccupancy: berths ?? [],
    anchorages: anchorages ?? [],
    // 선석별 재항 소요시간 실측 통계 (mart.berth_dwell_stats) — 점유 선석의
    // "언제 비는가"를 추정하는 근거. 출항 예정 시각(ETD)이 원천에 전혀 오지
    // 않아서(779행 전부 NULL) 이 분포가 유일한 수단이다.
    berthDwell: berthDwell ?? [],
    // 조위 반영 흘수·UKC 판정 (mart.berth_draught_check) — callsgn별 원본 그대로 노출,
    // NOT_ALLOWED/MARGINAL/UNKNOWN 판정은 뷰 안에서 이미 끝나 있어 여기선 가공하지 않는다.
    draughtChecks: draughtCheck ?? [],
    // 완료된 접안 이력 — GanttChart의 "온산 선석 실제 접안 이력" 섹션용
    history: (history ?? []).filter(isLiquidHistoryRecord).map(mapHistoryRecord),
    // 수집기 생존 신호 — Header 신선도 배지(mart.pipeline_health)
    pipelineHealth: pipelineHealth ?? null,
    // total_port_calls/port_calls_by_facility_type/liquid_callsgns
    // (mock-server 전용이던 onsan_port_calls/ais_position_rows는 백엔드에 없음 — 그대로 없이 둔다)
    stats: stats ?? null,
    // 관제 경고 — 백엔드가 safety 규칙엔진(Neo4j 혼재금지 + IMDG 격리표)을 재항 화물에
    // 돌려 만든 실판정. 응답이 빈 배열([])인 것과 호출 실패(null)는 다르다:
    // 전자는 "위험 없음"이고 후자는 "모름"이라, 호출측이 구분할 수 있게 그대로 넘긴다.
    alerts: alerts ?? null,
  };
}


/**
 * 대체 선석 제안 — POST /scheduling/alternatives (LLM 미사용 결정적 판단).
 *
 * [2026-09-27] 예전 POST /scheduling/candidates(카테고리 기준 top-3, 조위 미반영)를 대체했다.
 * 판정 잡이 부적합일 때 붙이는 대체안과 같은 계산이다 — 조위를 더한 가용수심, 필요 여유
 * max(1.0m, 흘수 10%), 함께 실은 화물 카테고리 모두 취급. **배정이 아니라 제안이다.**
 * 지금 부두(exclude_wharf_name)는 뺀다. 후보가 없으면 note 에 이유가 온다.
 *
 * 흘수는 실측(AIS draught)만 쓴다. 미수집이면 호출하지 않는다 — 가정 흘수로
 * 낸 제안은 근거 없는 안전 판정이 된다.
 */
/**
 * 선석의 이웃 화물 — GET /scheduling/adjacent-cargos (판정 잡과 같은 인접 계산).
 * [2026-09-27] 선박 상세 패널이 프론트 자체 인접표(온산 13곳)를 쓰던 것을 대체한다.
 * 반환: [{ berth_name, chem_id, cas_no }] — 판정 요청의 adjacent_operations 모양.
 */
export async function fetchAdjacentCargos({ wharf_name, call_sign = null }) {
  const qs = new URLSearchParams({ wharf_name });
  if (call_sign) qs.set('call_sign', call_sign);
  const data = await getJson(`/scheduling/adjacent-cargos?${qs}`);
  return (data.adjacent_cargos || []).map((a) => ({
    berth_name: a.berth_name, chem_id: a.cargo.chem_id, cas_no: a.cargo.cas_no ?? null,
  }));
}

// start — 입항 전 선박은 입항 예정 시각부터의 점유를 본다(없으면 지금부터)
export async function fetchAlternativeBerths({ draught_m, chem_id, cas_no, name_hint, hours = 24, extra_cargos = [], exclude_wharf_name = null, start = null }) {
  if (draught_m == null) throw new Error('흘수 미수집 — 후보 조회 불가');
  if (!chem_id && !cas_no) throw new Error('화물 미확인 — 후보 조회 불가');
  const now = start instanceof Date && !Number.isNaN(start.getTime()) ? start : new Date();
  const res = await fetch(`${BACKEND_BASE}/scheduling/alternatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vessel: { draught_m, name_hint: name_hint ?? null },
      cargo: { chem_id: chem_id ?? null, cas_no: cas_no ?? null, name_hint: name_hint ?? null },
      // 함께 실은 화물 — 모든 화물 카테고리를 취급하는 선석만 제안된다.
      cargos: extra_cargos
        .filter((c) => c?.chem_id && c.chem_id !== chem_id)
        .map((c) => ({ chem_id: c.chem_id, cas_no: c.cas_no ?? null })),
      window_start: now.toISOString(),
      window_end: new Date(now.getTime() + hours * 3600 * 1000).toISOString(),
      exclude_wharf_name,
    }),
  });
  if (!res.ok) {
    // 404(MSDS 없음)는 실제로 난다.
    // 조용히 빈 목록으로 만들지 않는다 — 왜 안 나오는지 화면에 적어야 한다.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}


/**
 * 선석 배정현황 — GET /dashboard/berth-assignments (08_스케줄링_전면재설계_자동배정_설계문서.md §7).
 *
 * GET /dashboard/berths(VTS 관측 기준 "실제로 배가 있는가")와는 다른 질문에
 * 답한다 — 이건 "우리 시스템이 이 선석에 무엇을 배정(추천/승인)했는가"다.
 * 선석마다 slots 배열(슬롯 1..max_concurrent_vessels)이 있고, 빈 슬롯은
 * status:null이다.
 */
// 입항 예정 액체화물선 — PORT-MIS 입항 신고(오늘~+3일) + 사전배정 계류시설 + 흘수.
// 판정이 아니라 판정에 쓰일 사실이다(backend app/api/v1/arrivals.py, 2026-09-17).
export async function fetchUpcomingArrivals({ aheadHours = 72, pastHours = 12 } = {}) {
  const res = await fetch(`${BACKEND_BASE}/arrivals/upcoming?ahead_hours=${aheadHours}&past_hours=${pastHours}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 화면에서 바로 판정 요청 — POST /orchestrator/assess-and-record.
 * 판정 감시 작업(10분 주기)이 아직 안 훑은 배를 관제사가 지금 판정받을 때 쓴다.
 * 결과는 판정 이력(assessment_history)에 남고, 입항 예정 표가 다시 읽는다.
 * 흘수를 모르면 부르지 않는다(백엔드가 흘수 > 0 을 요구하고, 지어내면 판정이 거짓이 된다).
 */
export async function postAssessAndRecord({
  callSign, vesselName, draughtM, dwtT, chemId, casNo, cargoName, wharfName, hours = 8,
  cargos = [], targetSource = null, portCallKey = null,
}) {
  if (!wharfName) throw new Error('계류시설이 확인되지 않아 판정할 수 없습니다');
  if (!(Number(draughtM) > 0)) throw new Error('흘수가 없어 판정할 수 없습니다(판정불가)');
  const cargo = chemId ? { chem_id: chemId, name_hint: cargoName }
    : casNo ? { cas_no: casNo, name_hint: cargoName } : null;
  if (!cargo) throw new Error('화물이 확인되지 않아 판정할 수 없습니다(판정불가)');
  const now = Date.now();
  const res = await fetch(`${BACKEND_BASE}/orchestrator/assess-and-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vessel: { draught_m: Number(draughtM), dwt_t: dwtT ? Number(dwtT) : null, name_hint: vesselName, call_sign: callSign },
      cargo,
      // [2026-09-29] 같은 입항 건의 나머지 화물 · 선석 출처 · 입항 건 키. 예전엔 첫 화물 하나만 보내
      //   여러 화물 배도 한 화물로 기록됐고, 기록이 어느 입항 건 것인지 남지 않았다.
      cargos: cargos
        .filter((c) => c?.chem_id && c.chem_id !== cargo.chem_id)
        .map((c) => ({ chem_id: c.chem_id, name_hint: c.name })),
      window_start: new Date(now).toISOString(),
      window_end: new Date(now + hours * 3600 * 1000).toISOString(),
      assigned_wharf_name: wharfName,
      ...(targetSource ? { target_source: targetSource } : {}),
      call_sign: callSign,
      vessel_name: vesselName,
      ...(portCallKey ? { port_call_key: portCallKey } : {}),
    }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.detail ? String(j.detail).slice(0, 140) : detail; } catch { /* 본문 없음 */ }
    throw new Error(detail);
  }
  return res.json();
}

export async function fetchBerthAssignments() {
  const res = await fetch(`${BACKEND_BASE}/dashboard/berth-assignments`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 한 부두의 최근 접안 이력 — GET /dashboard/history?facility_like= (출항까지 확정된 입출항 신고).
 * [2026-09-29 밤] 대시보드 맨 아래 '부두별 접안 이력' 목록 대신 선석 상세 서랍에서 그 부두 것만 본다.
 */
export async function fetchBerthHistory(facilityLike, limit = 12) {
  const qs = new URLSearchParams({ limit: String(limit), facility_like: facilityLike });
  return getJson(`/dashboard/history?${qs}`);
}

/**
 * 확인 대기 판정 목록 — GET /approvals/pending.
 *
 * **작업 대기열이 아니다.** 여기 있는 항목을 확인하지 않아도 아무 자원도 잠기지
 * 않고 아무 배도 기다리지 않는다 — 관제사가 자기 판단에 확신을 더하려고 보는
 * 목록이다.
 *
 * includeFit: 기본값(false)은 백엔드 기본과 같아 '적합'을 뺀다 — 목록으로 훑을
 * 때는 볼 필요가 있는 것만 나오는 게 맞다. 반대로 **배 한 척을 지목해 그 배의
 * 판정을 찾을 때**는 true 여야 한다. 적합이어도 관제사가 봤다는 기록은 남길 수
 * 있어야 하는데, 빼 버리면 그 배는 영원히 '판정 기록' 버튼만 보인다.
 */
export async function fetchPendingApprovals({ includeFit = false } = {}) {
  const qs = includeFit ? '?only_actionable=false' : '';
  const res = await fetch(`${BACKEND_BASE}/approvals/pending${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 판정 확인 — POST /approvals/{assessmentId}/acknowledge.
 *
 * [2026-09-22] 옛 POST /approvals/{id}/decision(승인/반려) 자리다. 그 경로는
 * 백엔드에서 없어졌다(실측 404). 우리가 선석을 배정하지 않기로 하면서 승인할
 * 대상도 반려할 대상도 없어졌기 때문이다.
 *
 * **이 호출은 아무것도 확정하지 않는다.** 관제사가 이 판정을 봤다는 사실만 남는다.
 * 판정에 동의하지 않으면 note 에 적는다 — 그게 다음 판정 규칙을 고칠 근거가 된다.
 */
export async function postAcknowledgement(assessmentId, { acknowledgedBy, note }) {
  const res = await fetch(`${BACKEND_BASE}/approvals/${assessmentId}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledged_by: acknowledgedBy, note: note ?? null }),
  });
  if (!res.ok) {
    // 409(이미 확인됨)는 실제로 발생할 수 있다 — 그대로 드러낸다.
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.detail || `HTTP ${res.status}`);
    // 조회 전용 배포본이 막은 것과 진짜 실패를 화면이 다른 색으로 그린다.
    err.readOnly = Boolean(body.read_only);
    throw err;
  }
  return res.json();
}


// ─────────────────────────────────────────────────────────────────────────────
// 항해 중 선박의 도착 예상(ETA) — AIS 속력으로 낸 직선 외삽
//
// 계획서의 "입항 예정 시각"을 지금 있는 데이터만으로 낼 수 있는 유일한 방법이다
// (PORT-MIS 의 출입항 예정 시각 필드는 원천에서 전부 비어 온다).
//
// 한계를 숨기지 않는다 — 이건 예보가 아니라 산술이다:
//   · 대권/항로가 아니라 직선거리다. 실제 항로는 항상 이보다 길다.
//   · 지금 속력이 계속 유지된다고 본다. 감속·투묘·도선 대기는 반영하지 않는다.
//   · 도선사 승선·조석창 대기는 계산에 없다.
// 그래서 화면은 이 값을 '예정'이 아니라 '현재 속력 기준 추정'으로 적어야 한다.
// ─────────────────────────────────────────────────────────────────────────────

/** 두 좌표 사이 대권거리 [해리] */
function nauticalMiles(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // 지구 반경 [해리]
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 항해 중인 배가 목표 지점(기본: 온산 부두 중심)까지 걸릴 시간을 낸다.
 * 계산할 수 없으면 null — 없는 값을 0 이나 임의값으로 채우지 않는다.
 */
export function estimateEta(vessel, target = { lat: 35.4478, lon: 129.3577 }) {
  if (!vessel || vessel.latitude == null || vessel.longitude == null) return null;
  // 항해 중인 배만 대상. 접안·정박 중인 배에 "도착 예상"은 뜻이 없다.
  if (vessel.nav_status_category !== 'UNDER_WAY') return null;
  const sog = Number(vessel.sog);
  // 0.5 kn 미만은 표류·계류로 본다. 그 속력으로 나누면 수백 시간이 나와
  // 화면에 근거 없는 큰 숫자가 찍힌다.
  if (!Number.isFinite(sog) || sog < 0.5) return null;
  const distanceNm = nauticalMiles(vessel.latitude, vessel.longitude, target.lat, target.lon);
  const hours = distanceNm / sog;
  // 24시간을 넘으면 추정 의미가 없다(그 사이 속력·침로가 여러 번 바뀐다)
  if (hours > 24) return null;
  return {
    distanceNm: Math.round(distanceNm * 10) / 10,
    hours: Math.round(hours * 10) / 10,
    sog,
    etaUtc: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
  };
}

/**
 * 점유 선석이 언제 비는지 추정한다 — 재항 시작 시각 + 그 선석의 재항 중앙값.
 * 이미 중앙값을 넘겼으면 '초과'로 표시하도록 overdue 를 세운다.
 */
export function estimateBerthRelease(wharfName, conflicts, dwellStats) {
  if (!wharfName || !dwellStats?.length) return null;
  // 겹치는 재항 기록이 여러 건 올 수 있다(실측: SK2부두 228건). 그중 "지금 그
  // 자리를 쓰고 있는 배"는 가장 늦게 들어온 건이므로 그걸 기준으로 잡는다.
  // 첫 원소를 그냥 쓰면 몇 달 전 기록이 잡혀 "이미 한참 초과"로만 뜬다.
  const arrivalUtc = (conflicts ?? [])
    .map((c) => c?.arrival_at_utc)
    .filter(Boolean)
    .sort()
    .pop();
  if (!arrivalUtc) return null;
  const stat = dwellStats.find((d) => d.wharf_name === wharfName);
  if (!stat || stat.median_hours == null) return null;
  const median = Number(stat.median_hours);
  const elapsedH = (Date.now() - new Date(arrivalUtc).getTime()) / 3600000;
  if (!Number.isFinite(elapsedH)) return null;
  return {
    medianHours: median,
    p90Hours: stat.p90_hours == null ? null : Number(stat.p90_hours),
    sampleCount: stat.sample_count,
    elapsedHours: Math.round(elapsedH * 10) / 10,
    remainingHours: Math.round((median - elapsedH) * 10) / 10,
    overdue: elapsedH > median,
  };
}


/**
 * 정밀 검토(Omniverse) 지목 — POST /twin/focus.
 *
 * 브라우저와 Omniverse 앱이 직접 이야기할 길이 없어(WebRTC 는 화면만 보낸다) 백엔드에
 * 적어 두면 Omniverse 가 몇 초마다 읽어 그 선석으로 내려간다(backend app/api/v1/twin.py).
 * berth·call_sign 을 다 비우면 지목을 풀고 Omniverse 는 조감·과거 사례 순환으로 돌아간다.
 */
export async function postTwinFocus({ berth = null, call_sign = null, vessel_name = null } = {}) {
  const res = await fetch(`${BACKEND_BASE}/twin/focus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ berth, call_sign, vessel_name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 선석의 지금 판정과 앞으로 72시간 예보 판정 — GET /twin/outlook (backend twin.py).
 * Omniverse 정보판이 읽던 응답을 3D 관제 화면이 직접 그린다(2026-09-27, OutlookTimeline).
 * 판정은 백엔드가 이미 내렸다(기상 에이전트 규칙 + 조위 반영 흘수 여유) — 화면은 그리기만 한다.
 */
export async function fetchTwinOutlook({ berth, call_sign = null, hours = 72 }) {
  const q = new URLSearchParams({ berth, hours: String(hours) });
  if (call_sign) q.set('call_sign', call_sign);
  const res = await fetch(`${BACKEND_BASE}/twin/outlook?${q}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* 본문 없음 */ }
    throw new Error(detail);
  }
  return res.json();
}
