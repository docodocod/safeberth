/**
 * 울산항 위경도를 3D 공간의 X, Z 좌표로 변환하는 유틸리티
 */

// 3D 트윈 투영 기준점 — 온산 (아래 _C3 와 반드시 같아야 한다).
//
// [2026-08-15] 예전에는 여기가 울산본항 중심(35.50, 129.38)에 1도=10000 이었고,
// 3D 온산 배치(_C3)는 온산 중심(35.45, 129.357)에 1도=20000 이었다. 기준이 서로
// 달라서 실 AIS 좌표로 세운 배가 선석과 500유닛 넘게 어긋났다 — 화면에서는
// "입항 중인 배가 탱크팜 안쪽 육지에 떠 있는" 모습으로 나타났다.
// 같은 화면에 투영이 둘일 이유가 없으므로 온산 기준으로 통일한다.
const CENTER_LAT = 35.45;
const CENTER_LON = 129.357;

// 1도 = 20000유닛 (1유닛 ≈ 5.5m). 위도(북)가 커질수록 화면 -Z 방향.
const SCALE_X = 20000;
const SCALE_Z = -20000;

/**
 * 위도/경도를 3D 벡터(x, 0, z) 형태로 변환합니다.
 * @param {number} lat - 위도
 * @param {number} lon - 경도
 * @returns {Array} [x, y, z] 배열
 */
export function convertLatLonToVector3(lat, lon) {
  if (lat == null || lon == null) return [0, 0, 0];
  
  const x = (lon - CENTER_LON) * SCALE_X;
  const z = (lat - CENTER_LAT) * SCALE_Z;
  
  return [x, 0, z];
}

// ─────────────────────────────────────────────
// 3D 디지털트윈 — 온산 실배치 (실측 위경도 투영)
// 중심 (35.4500, 129.3570), 1도 = 20000유닛 (1유닛 ≈ 5.5m).
// 실제 해안은 처용리(UTK/OTK/대한유화, 북서) → 산암리(S-Oil/효성) →
// 정일(남동)로 이어지는 대각선이고 수역(만)은 그 북동쪽이다.
// 같은 터미널 대표점을 공유하는 선석은 해안 접선 방향으로 이격(shift)해
// 잔교가 겹치지 않게 한다. 좌표 출처: onsan_berth_master.csv
// ─────────────────────────────────────────────
// 위 CENTER_LAT/LON/SCALE 과 같은 기준. 둘 중 하나만 바꾸면 배와 선석이 어긋난다.
const _C3 = { lat: CENTER_LAT, lon: CENTER_LON, scale: SCALE_X };
const _proj = (lat, lon) => [(lon - _C3.lon) * _C3.scale, -(lat - _C3.lat) * _C3.scale];

const _P_UTK = _proj(35.46225, 129.34753);
const _P_OTK = _proj(35.45661, 129.35119);
const _P_DHY = _proj(35.45417, 129.35194);
const _P_SO = _proj(35.451, 129.356);
const _P_HS = _proj(35.44239, 129.35778);
const _P_JI = _proj(35.43778, 129.36694);

// 해안 접선 T(북서 UTK → 남동 정일)와 수역(만) 방향 법선 N
const _dxT = _P_JI[0] - _P_UTK[0];
const _dzT = _P_JI[1] - _P_UTK[1];
const _lenT = Math.hypot(_dxT, _dzT);
export const SHORE_T = [_dxT / _lenT, _dzT / _lenT];
export const SHORE_N = [SHORE_T[1], -SHORE_T[0]];
export const shoreShift = (p, k) => [p[0] + SHORE_T[0] * k, p[1] + SHORE_T[1] * k];
export const bayShift = (p, k) => [p[0] + SHORE_N[0] * k, p[1] + SHORE_N[1] * k];

// 잔교 회전각: 잔교의 육지측(local +x)이 -N(내륙)을 향하게 한다
export const PIER_ROT = Math.atan2(SHORE_N[1], -SHORE_N[0]);
// 계류 선수각: 선수(+z)가 해안 접선(+T, 남동) 방향
export const MOOR_HEADING = Math.atan2(SHORE_T[0], SHORE_T[1]);

const _mk = (anchor, shift, name) => {
  const pos = shoreShift(anchor, shift);
  return { pos, rotY: PIER_ROT, moor: bayShift(pos, 15), name };
};

export const ONSAN_BERTHS_3D = {
  'CY-UTK': _mk(_P_UTK, 0, 'UTK 부두'),
  'CY-OTK1': _mk(_P_OTK, -16, 'OTK 1부두'),
  'CY-OTK2': _mk(_P_OTK, 16, 'OTK 2부두'),
  'CY-DHY': _mk(_P_DHY, 20, '대한유화 부두'),
  'SA-SO1': _mk(_P_SO, -48, 'S-Oil 1부두'),
  'SA-SO2': _mk(_P_SO, -16, 'S-Oil 2부두'),
  'WS-SO3': _mk(_P_SO, 16, 'S-Oil 3부두'),
  'WS-SO4': _mk(_P_SO, 48, 'S-Oil 4부두'),
  'SA-HS': _mk(_P_HS, 0, '효성 부두'),
  'SA-JI1': _mk(_P_JI, -16, '정일 1부두'),
  'SA-JI2': _mk(_P_JI, 16, '정일 2부두'),
};

// 해안선 경로(육지측 라인): 잔교 배후 -34유닛, 양끝 140유닛 연장.
// 육지 폴리곤·안벽 배관 랙이 이 경로를 따른다.
const _shorePts = Object.values(ONSAN_BERTHS_3D).map((b) => bayShift(b.pos, -34));
export const ONSAN_SHORE_PATH = [
  shoreShift(_shorePts[0], -140),
  ..._shorePts,
  shoreShift(_shorePts[_shorePts.length - 1], 140),
];

// 탱크팜 중심 (S-Oil 배후지) / 석유공사 원유부이(원해, 축척 축소 표시)
export const TANK_BASE_3D = bayShift(_P_SO, -110);
export const ONSAN_KNOC_3D = bayShift(shoreShift([0, 0], 330), 130);

// 묘박지 (실제 E 계열 정박지는 동측 원해 — 만 안쪽에 축척 축소 표시)
export const ONSAN_ANCHORAGE_3D = {
  E2: { pos: bayShift(shoreShift([0, 0], 130), 250), radius: 45, name: 'E2 묘박지' },
};

// 선박 3D 스케일: 재화중량(cargoAmount)에 비례 (0.42 ~ 0.72)
export const shipScale = (cargoAmount) =>
  0.42 + 0.3 * Math.min(1, (cargoAmount || 12000) / 32000);

// 실제 울산항의 지리적 만(Bay) 형태를 모사한 정밀 위경도 매핑
export const BERTHS = {
  "B001": { lat: 35.495, lon: 129.370, name: "OTK 1부두" },
  "B002": { lat: 35.498, lon: 129.372, name: "OTK 2부두" },
  "B003": { lat: 35.502, lon: 129.375, name: "OTK 3부두" },
  "B004": { lat: 35.505, lon: 129.380, name: "정일 1터미널" },
  "B005": { lat: 35.506, lon: 129.385, name: "정일 2터미널" },
  "B006": { lat: 35.504, lon: 129.390, name: "현대오일 부두" },
  "B007": { lat: 35.499, lon: 129.395, name: "SK에너지 부두" },
  "B008": { lat: 35.492, lon: 129.398, name: "S-OIL 부두" },
};

// ─────────────────────────────────────────────
// 온산항 MVP 선석 (onsan_berth_master.csv 실측 좌표, 2026-07-21)
// offset 은 같은 터미널 대표점을 공유하는 선석의 지도 표시용 미세 이격(약 130m).
// 실제 좌표는 lat/lon 그대로이며 팝업에 '터미널 대표점'으로 표기한다.
// BU-SOIL/BU-OILHUB(SPM 부이 2기)는 좌표 미확보(해도 필요)로 지도에서 제외.
// ─────────────────────────────────────────────
export const ONSAN_BERTHS = {
  'CY-DP': { lat: 35.4394, lon: 129.35444, name: '달포부두', operator: '공용부두', waterway: '산암리(추정)', maxDwt: 3000, lengthM: 325, depthM: 7, berthCount: 1, cargoTypes: '유류·잡화', singleton: true },
  'CY-OTK1': { lat: 35.45661, lon: 129.35119, name: 'OTK 1부두', operator: '오드펠터미널코리아', waterway: '처용리', maxDwt: 40000, lengthM: 391, depthM: 11, berthCount: 2, cargoTypes: '케미칼류' },
  'CY-OTK2': { lat: 35.45661, lon: 129.35119, name: 'OTK 2부두', operator: '오드펠터미널코리아', waterway: '처용리', maxDwt: 10000, lengthM: 275, depthM: 9, berthCount: 2, cargoTypes: '케미칼류', offset: [-0.0012, 0], rep: true },
  'CY-UTK': { lat: 35.46225, lon: 129.34753, name: 'UTK 부두', operator: '유나이티드터미널코리아', waterway: '처용리', maxDwt: 30000, lengthM: 287, depthM: 12, berthCount: 2, cargoTypes: '케미칼류' },
  'CY-DHY': { lat: 35.45417, lon: 129.35194, name: '대한유화 부두', operator: '대한유화', waterway: '처용리', maxDwt: 80000, lengthM: 320, depthM: 12, berthCount: 2, cargoTypes: '케미칼류' },
  'SA-JI1': { lat: 35.43778, lon: 129.36694, name: '정일 1부두', operator: '정일스톨트헤븐', waterway: '산암리', maxDwt: 40000, lengthM: 354, depthM: 11, berthCount: 2, cargoTypes: '케미칼류' },
  'SA-JI2': { lat: 35.43778, lon: 129.36694, name: '정일 2부두', operator: '정일스톨트헤븐', waterway: '산암리', maxDwt: 40000, lengthM: 256, depthM: 12.5, berthCount: 2, cargoTypes: '케미칼류', offset: [-0.0012, 0], rep: true },
  'SA-HS': { lat: 35.44239, lon: 129.35778, name: '효성 부두', operator: '효성', waterway: '산암리', maxDwt: 30000, lengthM: 240, depthM: 12, berthCount: 1, cargoTypes: '케미칼류', singleton: true },
  'SA-SO1': { lat: 35.45100, lon: 129.35600, name: 'S-Oil 1부두', operator: 'S-OIL', waterway: '산암리', maxDwt: 50000, lengthM: 280, depthM: 11, berthCount: 2, cargoTypes: '유류/케미칼류', offset: [-0.0018, 0], rep: true },
  'SA-SO2': { lat: 35.45100, lon: 129.35600, name: 'S-Oil 2부두', operator: 'S-OIL', waterway: '산암리', maxDwt: 120000, lengthM: 340, depthM: 15.5, berthCount: 3, cargoTypes: '유류/케미칼류', offset: [-0.0006, 0], rep: true },
  'WS-SO3': { lat: 35.45100, lon: 129.35600, name: 'S-Oil 3부두', operator: 'S-OIL', waterway: '원산리', maxDwt: 50000, lengthM: 280, depthM: 14, berthCount: 2, cargoTypes: '유류/케미칼류', offset: [0.0006, 0], rep: true },
  'WS-SO4': { lat: 35.45100, lon: 129.35600, name: 'S-Oil 4부두', operator: 'S-OIL', waterway: '원산리', maxDwt: 30000, lengthM: 585, depthM: 12, berthCount: 3, cargoTypes: '케미칼류', offset: [0.0018, 0], rep: true },
  'BU-KNOC': { lat: 35.38633, lon: 129.39300, name: '석유공사 부이', operator: '한국석유공사', waterway: '부이(해상)', maxDwt: 325000, depthM: 27, berthCount: 1, cargoTypes: '원유', singleton: true },
};

// 지도 표시 좌표 (대표점 공유 선석은 미세 이격 적용)
//
// 원천에 선석별 좌표가 없어 같은 터미널의 여러 선석이 대표점 하나를 공유한다.
// 지도에서는 그대로 겹쳐 그려져 부두 이름표가 서로를 덮었다(S-Oil 1~4가 특히
// 심했다 — 네 개가 한 점). 그래서 세로로 벌려 사다리처럼 놓는다.
// 이 이격은 '표시용'이다 — 판정·조인은 전부 선석 이름으로 하므로 좌표가 결과를
// 바꾸지 않는다. 위아래 순서는 실제 부두 번호 순서(1→4)를 따른다.
export function onsanDisplayPos(b) {
  const [dLat, dLon] = b.offset || [0, 0];
  return [b.lat + dLat, b.lon + dLon];
}

// 실DB 선석명(VTS/화물 매니페스트 표기, 공백·붙임 표기가 제각각 — 예: '정일1부두',
// 'S-Oil 1부두')을 ONSAN_BERTHS 큐레이션 키로 찾는다. 공백만 제거하고 비교한다
// (백엔드 mart.norm_facility()와 같은 원칙 — 정규화 규칙을 늘리면 다른 선석과
// 잘못 묶일 수 있어 공백 제거 하나로만 제한한다).
const normBerthName = (s) => (s || '').replace(/\s+/g, '');

export function findBerthIdByName(berthName) {
  const target = normBerthName(berthName);
  if (!target) return null;
  return Object.keys(ONSAN_BERTHS).find((k) => normBerthName(ONSAN_BERTHS[k].name) === target) || null;
}

// 선석명 → ADJACENT_TO 인접 선석명 목록 (안전 게이트 R13 인접작업 입력용)
export function onsanAdjacentBerthNames(berthName) {
  const id = findBerthIdByName(berthName);
  if (!id) return [];
  const names = [];
  for (const { a, b } of ONSAN_ADJACENCY) {
    if (a === id) names.push(ONSAN_BERTHS[b]?.name);
    else if (b === id) names.push(ONSAN_BERTHS[a]?.name);
  }
  return names.filter(Boolean);
}

// 두 선석의 ADJACENT_TO 실측 거리(m). 표에 없는 조합이면 null —
// "인접하다고 들었지만 이 값은 근거표에 없다"를 구분하기 위해 0으로 얼버무리지 않는다.
export function onsanAdjacencyDistanceM(berthNameA, berthNameB) {
  const idA = findBerthIdByName(berthNameA);
  const idB = findBerthIdByName(berthNameB);
  if (!idA || !idB) return null;
  const edge = ONSAN_ADJACENCY.find(
    ({ a, b }) => (a === idA && b === idB) || (a === idB && b === idA)
  );
  return edge ? edge.distanceM : null;
}

// 정밀 검토(Omniverse) 장면에 있는 선석 — D:\omniverse\open_scene.py 의 BERTH_MAP 11곳.
// 3D 관제 화면(ONSAN_BERTHS)에는 달포부두·석유공사 부이가 더 있지만 Omniverse 장면에는
// 없다. 이 목록 밖 선석을 지목하면 Omniverse 가 보여줄 자리가 없으므로 버튼을 막는다.
export const OMNIVERSE_BERTH_IDS = new Set([
  'CY-UTK', 'CY-OTK1', 'CY-OTK2', 'CY-DHY', 'SA-HS', 'SA-JI1', 'SA-JI2',
  'SA-SO1', 'SA-SO2', 'WS-SO3', 'WS-SO4',
]);

// 선석 → 기상 임계 선석군 (berth_weather_thresholds.csv 의 berth_group)
// 지도에서 선석 클릭 시 선석별 하역 판정 패널과 연동하는 데 쓴다.
export const ONSAN_WEATHER_GROUP = {
  'CY-OTK1': 'OTK1/2부두(처용리)',
  'CY-OTK2': 'OTK1/2부두(처용리)',
  'CY-UTK': 'UTK부두(처용리)',
  'CY-DHY': '대한유화부두(처용리)',
  'SA-JI1': '정일1/2부두(산암리)',
  'SA-JI2': '정일1/2부두(산암리)',
  'SA-HS': '효성부두(산암리)',
  'SA-SO1': 'S-Oil1~4부두(산암리/원산리)',
  'SA-SO2': 'S-Oil1~4부두(산암리/원산리)',
  'WS-SO3': 'S-Oil1~4부두(산암리/원산리)',
  'WS-SO4': 'S-Oil1~4부두(산암리/원산리)',
  'BU-KNOC': '한국석유공사원유부이',
};

// ADJACENT_TO (onsan_adjacency_edges.csv, 좌표거리 500m 임계) — 혼재/근접 위험 감시 쌍
export const ONSAN_ADJACENCY = [
  { a: 'CY-OTK1', b: 'CY-OTK2', distanceM: 0.0 },
  { a: 'CY-OTK1', b: 'CY-DHY', distanceM: 279.7 },
  { a: 'CY-OTK2', b: 'CY-DHY', distanceM: 279.7 },
  { a: 'SA-JI1', b: 'SA-JI2', distanceM: 0.0 },
  { a: 'SA-SO1', b: 'SA-SO2', distanceM: 0.0 },
  { a: 'SA-SO1', b: 'WS-SO3', distanceM: 0.0 },
  { a: 'SA-SO1', b: 'WS-SO4', distanceM: 0.0 },
  { a: 'SA-SO2', b: 'WS-SO3', distanceM: 0.0 },
  { a: 'SA-SO2', b: 'WS-SO4', distanceM: 0.0 },
  { a: 'WS-SO3', b: 'WS-SO4', distanceM: 0.0 },
];
