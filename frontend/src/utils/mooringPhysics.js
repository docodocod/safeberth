// ─────────────────────────────────────────────────────────────────────────────
// 계류 안정성 준정적 근사 (OCIMF 계열)
//
// 설계문서 v1 4-4절 "계류 안전 (물리 검증)"의 계산식이다. Isaac Sim PhysX 동역학
// 으로 교차 검증했고(2만 DWT 기준 근사식 137.6 kN vs PhysX 146.8 kN — 오차 6.7%,
// 판정 등급 동일), 그 검증 스크립트가
// frontend/digital-twin/physics/mooring_berthing_sim.py 다.
//
// [왜 프론트로 옮겼나]
// 이 계산은 원래 mock-server(:8000)의 POST /api/v1/sim/mooring 에 있었다. 그런데
// mock-server 를 걷어내면서(2026-08-15, 백엔드 8001 단일화) 그 엔드포인트가 사라졌고,
// 화면 버튼은 계속 8000 을 호출해 항상 "시뮬레이션 서버(8000) 응답 없음"만 띄웠다.
// 정식 백엔드에 이 엔드포인트를 새로 여는 건 이번 범위 밖이라, 상수와 식을 그대로
// 옮겨 화면에서 계산한다 — 서버 왕복이 필요 없는 순수 함수라 결과는 동일하다.
//
// [한계]
// DWT 실측 소스가 없어 호출측이 가정값을 넣는다(AIS·PORT-MIS 모두 DWT 미수집).
// 선박 제원(전장·수선상부 면적)도 DWT 회귀식 근사다. 정밀 계산이 아니라
// "지금 바람에 계류삭이 견디는가"를 등급으로 보는 용도다.
// ─────────────────────────────────────────────────────────────────────────────

const AIR_DENSITY = 1.225;      // kg/m³
const WIND_COEFF = 1.0;         // 횡풍 형상계수 (OCIMF 근사)
const LINE_EFFICIENCY = 2 * 0.9 + 4 * 0.25;  // 계류삭 6가닥 횡하중 유효 분담
const TENSION_SAFE_RATIO = 0.30;             // "정상" 상한 = MBL의 30%

/** DWT → 선박 제원 근사 (전장·수선상부 수풍면적·배수질량) */
function vesselParticulars(dwt) {
  const loa = 8.6 * dwt ** 0.316;
  const freeboard = 0.02 * loa + 3.0;
  return {
    loa,
    area: 0.75 * loa * (freeboard + 4.0),  // 횡방향 수풍면적 m²
    mass: dwt * 1000 * 1.35,               // 배수질량 kg
  };
}

/** DWT 급별 계류삭 최소파단하중(MBL) kN */
function lineMblKn(dwt) {
  if (dwt < 20000) return 392.0;
  if (dwt < 60000) return 588.0;
  return 784.0;
}

const VERDICTS = [
  { max: 30, verdict: '정상', action: '하역 계속 가능' },
  { max: 50, verdict: '주의', action: '하역 중단 검토 (라인 텐딩 강화)' },
  { max: 70, verdict: '경고', action: '이안 준비 권고' },
  { max: Infinity, verdict: '위험', action: '즉시 호스분리·비상 이안' },
];

/**
 * 계류삭 장력 판정.
 * @param {number} dwt        재화중량톤 (가정값 허용)
 * @param {number} windMs     풍속 m/s
 * @param {number} waveM      유의파고 m
 */
export function simulateMooring(dwt, windMs, waveM) {
  const p = vesselParticulars(dwt);
  const force = 0.5 * AIR_DENSITY * WIND_COEFF * p.area * windMs ** 2;  // N
  const daf = 1.0 + 0.35 * waveM;                                      // 파랑 동적증폭
  const tensionKn = (force * daf) / LINE_EFFICIENCY / 1000;
  const mbl = lineMblKn(dwt);
  const pct = (tensionKn / mbl) * 100;
  const { verdict, action } = VERDICTS.find((v) => pct < v.max);

  // 정상 한계 풍속 — 장력이 MBL의 30%에 닿는 풍속 역산
  const safeWind = Math.sqrt(
    (TENSION_SAFE_RATIO * mbl * 1000 * LINE_EFFICIENCY) /
    (0.5 * AIR_DENSITY * p.area * daf)
  );

  return {
    line_tension_kn: Math.round(tensionKn * 10) / 10,
    mbl_kn: mbl,
    tension_pct: Math.round(pct * 10) / 10,
    verdict,
    action,
    safe_wind_limit_ms: Math.round(safeWind * 10) / 10,
    model: '준정적 근사 (OCIMF 계열) — PhysX 교차검증 오차 6.7%',
  };
}
