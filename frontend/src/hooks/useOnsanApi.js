import { useCallback, useEffect, useState } from 'react';
import { BACKEND_BASE } from '../api/backendAdapter';
import { ONSAN_WEATHER_GROUP } from '../utils/geoUtils';
import useSensorStore from '../stores/useSensorStore';

// ─────────────────────────────────────────────
// 온산 에이전트 API 어댑터 (실백엔드 ↔ 화면 계약 변환)
//
// 백엔드(dev 머지본)는 POST + 본문 방식이고, 관측치는 서버가 DB에서 직접 읽는다.
// 화면 컴포넌트는 기존 프로토타입 응답 형태를 그대로 쓰므로, 변환은 이 훅에서만 한다.
//   POST /api/v1/weather/assess      { berth_group }                  → 4단계 판정
//   POST /api/v1/safety/assess       { target_cargo, adjacent_cargos } → 혼재/IMDG/LLM 판정
//   POST /api/v1/orchestrator/assess { vessel, cargo, window_* }       → 전용→대체→정박지
// 백엔드가 없거나 실패하면 로컬 폴백으로 화면은 계속 동작한다(플래그로 구분 표시).
// ─────────────────────────────────────────────

// 화물명 → CAS 번호. 백엔드가 CAS로 KOSHA MSDS를 lazy-fetch 한다.
// (처음 조회하는 물질은 응답이 1~2분 걸리고, 이후에는 DB 캐시로 즉시 응답)
const CARGO_CAS = {
  '에탄올': '64-17-5', '메탄올': '67-56-1', '톨루엔': '108-88-3', '벤젠': '71-43-2',
  '자일렌': '1330-20-7', '스티렌': '100-42-5', '황산': '7664-93-9', '부타디엔': '106-99-0',
  '휘발유': '86290-81-5', '가솔린': '86290-81-5', '경유': '68334-30-5',
  '등유': '8008-20-6', '나프타': '64742-49-0',
  // 위반 시나리오 7종 화물 (violation_scenarios.csv) — 시나리오 ① 판정 대상
  '프로페인': '74-98-6', '프로판': '74-98-6', 'LPG': '74-98-6',
  '원유': '8002-05-9', 'LNG': '74-82-8', '메테인': '74-82-8',
};

const cargoRef = (name) => (CARGO_CAS[name] ? { cas_no: CARGO_CAS[name], name_hint: name } : null);

// chem_id/cas_no를 이미 아는 호출자(화물 마스터 목록에서 고르거나, 실화물 조인 결과에서
// 온 경우)는 그걸 그대로 CargoRef로 쓴다 — CARGO_CAS 이름 사전을 안 거치므로 표기
// 불일치로 인한 매핑 실패가 없다. target/adjacent 양쪽에서 같은 우선순위로 써서 하나로 뺐다.
const resolveCargoRef = ({ chem_id, cas_no, cargo_name }) => {
  if (chem_id) return { chem_id, name_hint: cargo_name };
  if (cas_no) return { cas_no, name_hint: cargo_name };
  return cargoRef(cargo_name);
};

// [2026-09-25] 같은 입항 건의 나머지 화물 → 요청 cargos. 주 화물과 같은 물질은 뺀다.
// 주 화물이 cas_no 로만 올 때도 있어서(resolveCargoRef) 둘 다 대조한다.
const extraCargoRefs = (extraCargos, primary) => (extraCargos || [])
  .filter((c) => c?.chem_id && c.chem_id !== primary?.chem_id
    && !(primary?.cas_no && c.cas_no === primary.cas_no))
  .map((c) => ({ chem_id: c.chem_id, cas_no: c.cas_no ?? null }));

/** 질문 문장이 화물명을 스스로 지목하는가 — cargo_hint 를 붙일지 판단하는 데 쓴다 */
export const namesAnyCargo = (text) =>
  Object.keys(CARGO_CAS).some((name) => text.includes(name));

// ─── 화물 마스터 목록 (GET /chatbot/chemicals) ───
// 위 CARGO_CAS는 채팅 자유 텍스트에서 화물명을 스스로 찾아낼 때 쓰는 소규모 사전이고,
// 이거는 지식그래프에 실제 등재된 전체 화물 목록이다(현재 36종) — "판정까지 가능한
// 화물"의 정본. 신규 입항 안전 심사(SafetyGatesPanel) 같은 화면은 하드코딩된 목록
// 대신 이걸 써야 한다: 화면 목록이 실제 DB/그래프와 어긋나면(이름 표기 불일치,
// 새로 추가된 화물 누락 등) 골라도 "CAS 매핑 없음"으로 항상 실패하는 문제가 있었다.
// 여러 컴포넌트가 같은 요청을 반복하지 않도록 모듈 스코프에 한 번만 캐시한다.
let _chemicalsPromise = null;
function fetchChemicalList() {
  if (!_chemicalsPromise) {
    _chemicalsPromise = fetch(`${BACKEND_BASE}/chatbot/chemicals`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return _chemicalsPromise;
}

/** @returns {Array<{chem_id:string, name_ko:string, name_en:string, cas_no:string, un_no:string}>} */
export function useChemicalList() {
  const [chemicals, setChemicals] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchChemicalList().then((list) => { if (!cancelled) setChemicals(list); });
    return () => { cancelled = true; };
  }, []);
  return chemicals;
}

// KOSHA MSDS 16개 섹션. 백엔드 kosha_client.DETAIL_ENDPOINTS 와 같은 이름을 쓴다.
const MSDS_SECTIONS = {
  detail01: '화학제품과 회사에 관한 정보', detail02: '유해성·위험성',
  detail03: '구성성분의 명칭 및 함유량', detail04: '응급조치요령',
  detail05: '폭발·화재시 대처방법', detail06: '누출사고시 대처방법',
  detail07: '취급 및 저장방법', detail08: '노출방지 및 개인보호구',
  detail09: '물리화학적 특성', detail10: '안정성 및 반응성',
  detail11: '독성에 관한 정보', detail12: '환경에 미치는 영향',
  detail13: '폐기시 주의사항', detail14: '운송에 필요한 정보',
  detail15: '법적 규제현황', detail16: '그 밖의 참고사항',
};

// 질문 키워드 → 우선 조회 섹션. 벡터 검색이 없을 때 쓰는 규칙 기반 라우팅이다.
const SECTION_KEYWORDS = [
  [['불', '화재', '소화', '폭발', '연소'], 'detail05'],
  [['응급', '흡입', '삼켰', '눈에', '피부에', '구조', '응급조치'], 'detail04'],
  [['누출', '유출', '엎질', '방제'], 'detail06'],
  [['보관', '저장', '취급', '적재', '보관법'], 'detail07'],
  [['보호구', '마스크', '장갑', '방독', '보호복', '환기'], 'detail08'],
  [['인화점', '끓는점', '비점', '증기압', '비중', '밀도', '물성', '녹는점'], 'detail09'],
  [['반응', '안정성', '금지', '피해야', '혼촉'], 'detail10'],
  [['독성', '급성', '발암', '유해성 분류'], 'detail11'],
  [['환경', '수생', '생분해', '오염'], 'detail12'],
  [['폐기', '처리', '처분'], 'detail13'],
  [['운송', 'un', '포장등급', '해상운송', 'imdg'], 'detail14'],
  [['규제', '법규', '법적', '허가', '신고'], 'detail15'],
  [['위험성', '유해성', 'ghs', '경고표지', '그림문자'], 'detail02'],
];

const _NULL_VALUES = new Set(['자료없음', '해당없음', '-', '', 'N/A', '없음']);

/** 질문에서 화물명을 찾는다 (등록된 CAS 매핑 기준). */
function detectCargo(question) {
  const q = String(question || '');
  return Object.keys(CARGO_CAS).find((name) => q.includes(name)) || null;
}

/** 질문 키워드로 조회할 섹션 순서를 정한다. 매칭 없으면 안전관제 기본 5종. */
function rankSections(question) {
  const q = String(question || '').toLowerCase();
  const hits = SECTION_KEYWORDS
    .filter(([words]) => words.some((w) => q.includes(w)))
    .map(([, section]) => section);
  const fallback = ['detail02', 'detail07', 'detail08', 'detail04', 'detail10'];
  return [...new Set([...hits, ...fallback])];
}

/**
 * 규칙 기반 근거 인용 — MSDS 원문 섹션을 그대로 인용해 답한다.
 * WBS 리스크 대응의 "RAG 미완 시 폴백"을 실제로 구현한 경로다.
 * 문장을 생성하지 않으므로 환각이 원천적으로 없다(대신 요약은 못 한다).
 */
async function localMsdsAnswer({ question, cargoHint }) {
  const cargoName = cargoHint || detectCargo(question);
  const cas = cargoName ? CARGO_CAS[cargoName] : null;

  if (!cas) {
    return {
      answer: '어떤 화물에 대한 질문인지 확인하지 못했습니다. 화물명을 함께 적어주세요. '
        + `(조회 가능: ${Object.keys(CARGO_CAS).slice(0, 8).join(', ')} 등)`,
      citations: [], is_local_fallback: true, source: 'NO_CARGO',
    };
  }

  let payload = null;
  try {
    const res = await fetch(`${BACKEND_BASE}/msds/${encodeURIComponent(cas)}`);
    if (res.ok) payload = (await res.json())?.msds_payload;
  } catch {
    payload = null;
  }
  if (!payload) {
    return {
      // 관제사에게 포트 번호는 정보가 아니다 — 무엇이 안 됐고 어디를 보면 되는지만 말한다
      answer: `'${cargoName}' 정보를 조회하지 못했습니다. 관제 서버 연결 상태를 확인한 뒤 다시 시도해주세요.`,
      citations: [], is_local_fallback: true, source: 'MSDS_UNAVAILABLE',
    };
  }

  const citations = [];
  for (const section of rankSections(question)) {
    const data = payload[section]?.data;
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      const text = String(item?.itemDetail || '').trim();
      if (text && !_NULL_VALUES.has(text)) {
        citations.push({
          chem_name: cargoName, cas_no: cas, section,
          section_name: MSDS_SECTIONS[section], text, score: null,
        });
      }
      if (citations.length >= 6) break;
    }
    if (citations.length >= 6) break;
  }

  return {
    answer: citations.length
      ? `'${cargoName}' MSDS에서 관련 섹션 ${new Set(citations.map((c) => c.section)).size}개를 찾았습니다. 원문을 그대로 인용합니다.`
      : `'${cargoName}' MSDS에 해당 내용이 없습니다. (모르는 것은 만들어내지 않습니다)`,
    citations, is_local_fallback: true, source: 'MSDS_RULE_CITATION',
  };
}

// ─── 로컬 폴백 임계 (백엔드 미가동 시에도 데모 가능하게) ───
// DB berth_weather_threshold 8행을 그대로 옮긴 표다 (2026-08-15 대조).
//
// 백엔드 판정 응답에는 임계값이 실려 오지 않아 화면 칩 표시는 이 표를 쓴다.
// 그래서 이 표가 DB와 어긋나면 "판정은 DB 임계로, 표시는 다른 임계로" 하는
// 화면이 된다 — 실제로 예전 표에는 3개 선석군만 있었고 석유공사부이(중단 12)가
// default(중단 14)로 표시되던 오류가 있었다. DB를 고치면 이 표도 같이 고칠 것.
// 파고 임계는 중단 단계에만 있다(DB에 unberth/disconnect 파고 컬럼 없음).
const LOCAL_THRESHOLDS = {
  '정일1/2부두(산암리)': {
    stop: { wind: 17, wave: 1.0 }, unberth: { wind: 19, wave: null },
    disconnect: { wind: 21, wave: null }, source: '정일_입항정보_9.8',
  },
  'OTK1/2부두(처용리)': {
    stop: { wind: 14, wave: 2.0 }, unberth: { wind: 18, wave: null },
    disconnect: { wind: 21, wave: null }, source: 'OTK_입항정보_9.8',
  },
  'UTK부두(처용리)': {
    stop: { wind: 14, wave: 2.0 }, unberth: { wind: 17, wave: null },
    disconnect: { wind: 21, wave: null }, source: 'UTK_입항정보',
  },
  '대한유화부두(처용리)': {
    stop: { wind: 14, wave: 2.0 }, unberth: { wind: 18, wave: null },
    disconnect: { wind: 21, wave: null }, source: '대한유화_입항정보',
  },
  '효성부두(산암리)': {
    stop: { wind: 14, wave: 2.0 }, unberth: { wind: 21, wave: null },
    disconnect: { wind: 21, wave: null }, source: '효성_입항정보',
  },
  'S-Oil1~4부두(산암리/원산리)': {
    stop: { wind: 14, wave: null }, unberth: { wind: 17, wave: null },
    disconnect: { wind: 21, wave: null }, source: 'S-Oil_입항정보',
  },
  '한국석유공사원유부이': {
    // 부이 계류는 부두보다 임계가 낮다 — 온산 전체에서 가장 먼저 걸리는 중단 풍속
    stop: { wind: 12, wave: 1.5 }, unberth: { wind: 15, wave: null },
    disconnect: { wind: 15, wave: null }, source: '석유공사_입항정보',
  },
  default: {
    stop: { wind: 14, wave: 1.5 }, unberth: { wind: null, wave: null },
    disconnect: { wind: null, wave: null }, source: '전역 기본 임계(__GLOBAL_DEFAULT__)',
  },
};

function localAssessWeather({ berthGroup, windSpeed, waveHeight, isStale, precipObserved = false, extraCondition = false }) {
  const th = LOCAL_THRESHOLDS[berthGroup] || LOCAL_THRESHOLDS.default;
  if (isStale) {
    return {
      berth_group: berthGroup, status: '판단불가',
      reasons: ['관측값이 오래돼 판단할 수 없습니다'],
      thresholds_used: th, is_local_fallback: true,
    };
  }
  const w = parseFloat(windSpeed) || 0;
  const h = parseFloat(waveHeight) || 0;
  const reasons = [];
  let status = '정상';
  const over = (v, lim) => lim != null && v >= lim;
  if (over(w, th.disconnect.wind) || over(h, th.disconnect.wave)) {
    status = '호스분리';
    if (over(w, th.disconnect.wind)) reasons.push(`풍속 ${w} m/s >= ${th.disconnect.wind} m/s -> 호스분리`);
    if (over(h, th.disconnect.wave)) reasons.push(`파고 ${h} m >= ${th.disconnect.wave} m -> 호스분리`);
  } else if (over(w, th.unberth.wind) || over(h, th.unberth.wave)) {
    status = '이안';
    if (over(w, th.unberth.wind)) reasons.push(`풍속 ${w} m/s >= ${th.unberth.wind} m/s -> 이안`);
    if (over(h, th.unberth.wave)) reasons.push(`파고 ${h} m >= ${th.unberth.wave} m -> 이안`);
  } else if (over(w, th.stop.wind) || over(h, th.stop.wave)) {
    status = '하역중단';
    if (over(w, th.stop.wind)) reasons.push(`풍속 ${w} m/s >= ${th.stop.wind} m/s -> 하역중단`);
    if (over(h, th.stop.wave)) reasons.push(`파고 ${h} m >= ${th.stop.wave} m -> 하역중단`);
  } else {
    reasons.push(`풍속 ${w} m/s · 파고 ${h} m — 모든 임계 미만`);
  }
  // 강수·특별조건 — 백엔드 rule_engine 과 같은 순서로 풍속/파고 판정 위에 얹는다
  const RANK = { '정상': 0, '하역중단': 1, '이안': 2, '호스분리': 3 };
  if (precipObserved && RANK[status] < RANK['하역중단']) {
    status = '하역중단';
    reasons.push('강수 육안 확인 → 하역중단 (산업안전보건기준 규칙 제383조 제2호 준용: 강우 1mm/h 이상 작업중지)');
  } else if (precipObserved) {
    reasons.push('강수 육안 확인 — 이미 상위 단계 판정 적용 중');
  }
  if (extraCondition && RANK[status] < RANK['하역중단']) {
    // 백엔드 rule_engine 과 동일: 정성조건 발효 시 최소 '하역중단'으로 상향
    status = '하역중단';
    reasons.push('정성조건 발효(대기정체/심한뇌우/태풍경로) -> 최소 하역중단');
  } else if (extraCondition) {
    reasons.push('정성조건 발효 — 이미 상위 단계 판정 적용 중');
  }
  return { berth_group: berthGroup, status, reasons, thresholds_used: th, is_local_fallback: true };
}

const LOCAL_BERTH_GROUPS = [...new Set(Object.values(ONSAN_WEATHER_GROUP))];

// ─── 응답 변환기 ──────────────────────────────────────
function fmtForecastWarning(fw) {
  if (!fw) return null;
  if (typeof fw === 'string') return fw;
  const at = fw.expected_completion_at || fw.at_utc || fw.forecast_at_utc;
  const when = at ? new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '';
  return `예보 경고: ${fw.status || fw.level || '주의'}${when ? ` (${when} 기준)` : ''}` +
    (fw.reasons?.length ? ` — ${fw.reasons.join(', ')}` : '');
}

/** 백엔드 thresholds_used(ThresholdsUsed) → 화면 칩 형식 */
function mapThresholds(t) {
  if (!t) return null;
  return {
    stop: { wind: t.stop?.wind_ms ?? null, wave: t.stop?.wave_m ?? null },
    unberth: { wind: t.unberth?.wind_ms ?? null, wave: t.unberth?.wave_m ?? null },
    disconnect: { wind: t.disconnect?.wind_ms ?? null, wave: t.disconnect?.wave_m ?? null },
    source: t.source || (t.is_global_default ? '전역 기본 임계' : t.berth_group),
    berth_group: t.berth_group,
    is_global_default: Boolean(t.is_global_default),
  };
}

function mapWeather(r, berthGroup) {
  return {
    berth_group: berthGroup,
    status: r.status,
    reasons: r.reasons || [],
    // 판정에 실제로 쓴 임계값을 백엔드가 함께 돌려준다(thresholds_used).
    // 로컬 표는 백엔드가 죽었을 때만 쓰는 폴백이다 — 예전에는 응답에 임계가 없어
    // 항상 로컬 표를 그렸고, 그 표에 8개 부두그룹 중 3개만 있어서 "판정은 DB
    // 임계로, 표시는 다른 임계로" 하는 화면이 됐다(석유공사부이 중단 12 → 14로 표시).
    thresholds_used: mapThresholds(r.thresholds_used)
      || LOCAL_THRESHOLDS[berthGroup] || LOCAL_THRESHOLDS.default,
    observed: {
      wind: r.wind?.value ?? null, wave: r.wave?.value ?? null,
      station: r.wind?.station_name || r.wave?.station_name || null,
      observed_at_utc: r.wind?.observed_at_utc || r.wave?.observed_at_utc || null,
      is_stale: Boolean(r.wind?.is_stale || r.wave?.is_stale),
    },
    forecast_warning: fmtForecastWarning(r.forecast_warning),
    assessed_at_utc: r.assessed_at_utc,
    is_local_fallback: false,
    source: 'BACKEND_AGENT',
  };
}

function mapSafety(r, requestedAdjacent = [], targetChemId = null) {
  const conflicts = r.conflicts || [];
  const imdg = r.imdg_conflicts || [];
  const imdgClasses = r.imdg_classes || {}; // chem_id -> class code (충돌 여부와 무관하게 화물 자신의 Class)
  // 2026-08-21 추가 — 벌크 액체화학물질 호환성그룹 참고축(MSDS·IMDG와 별개
  // 세 번째 신호, backend/app/agents/safety/bulk_compatibility.py 참고)과
  // "IMDG 미확정" 판정을 백엔드가 이미 정확히 계산해 내려준다. 예전엔 여기서
  // targetClass/adjacentClass가 둘 다 있으면 무조건 "공인 X(안전 확정)"로
  // 프론트가 자체 재계산했는데, 이건 백엔드가 2026-08-21에 고친 것과 같은
  // 버그다(같은 Class끼리만 우연히 맞고, 서로 다른 Class인데 확정 안 된
  // 조합은 잘못 안전으로 표시됨). 판정 로직의 권위는 백엔드 하나뿐이어야
  // 하므로, 프론트는 재계산하지 말고 백엔드가 내려주는 목록을 그대로 읽는다.
  const bulk = r.bulk_compatibility_conflicts || [];
  const imdgUnconfirmedIds = new Set((r.imdg_unconfirmed_pairs || []).map((p) => p.adjacent_chem_id));
  // [2026-08-23] 판정 근거 부족(unassessed_pairs) — 백엔드가 rule_engine_floor를
  // 최소 '주의'로 격상시키는 **실제 판정 근거**다. 그런데 화면이 이걸 안 읽어서,
  // 등급은 '주의'인데 사유가 어디에도 안 나오는 상태였다(실측: 프로페인+크실렌
  // 조합에서 '주의'의 진짜 이유는 "크실렌 MSDS에 화물 대상 기피 정보 없음"인데
  // 화면은 엉뚱하게 IMDG 격리코드를 사유로 보여줬다).
  const unassessedByChemId = new Map(
    (r.unassessed_pairs || []).map((u) => [u.adjacent_chem_id, u])
  );

  // 인접 화물쌍(선석+화물) 단위로 MSDS 신호와 IMDG 신호를 한 gate로 묶는다.
  // 예전엔 "MSDS 충돌"과 "IMDG 충돌"을 서로 다른 gate로 쪼개서, 같은 화물쌍인데도
  // 카드가 둘로 나뉘고 추론 그래프도 각자 따로 펼쳐야 했다(한쪽만 걸리면 다른 쪽은
  // 아예 안 보임). service.py가 인접 화물마다 두 그래프(INCOMPATIBLE_WITH·SEGREGATE)를
  // 항상 같이 조회하므로, 화면도 같은 화물쌍이면 한 카드·한 그래프에서 두 신호를
  // 같이 보여준다 — detail.msds / detail.imdg 가 각각 null(조회 안 됨) 또는
  // {hit, ...} 로 채워진다.
  const pairKey = (berth, chemId) => `${berth} ${chemId}`;
  const pairs = new Map();
  const ensurePair = (berth, chemId, label) => {
    const key = pairKey(berth, chemId);
    if (!pairs.has(key)) {
      pairs.set(key, {
        berth, chemId, label, msds: null, imdg: null, bulk: null,
        unassessed: unassessedByChemId.get(chemId) || null,
      });
    }
    const p = pairs.get(key);
    if (label && !p.label) p.label = label;
    return p;
  };

  conflicts.forEach((c) => {
    ensurePair(c.adjacent_berth, c.adjacent_chem_id, c.adjacent_name).msds = {
      hit: true, category: c.shared_category,
    };
  });
  imdg.forEach((c) => {
    ensurePair(c.adjacent_berth, c.adjacent_chem_id, c.adjacent_name).imdg = {
      hit: true, targetClass: c.target_imdg_class, adjacentClass: c.adjacent_imdg_class,
      segregationCode: c.segregation_code,
    };
  });
  bulk.forEach((c) => {
    ensurePair(c.adjacent_berth, c.adjacent_chem_id, c.adjacent_name).bulk = {
      hit: true, targetGroup: c.target_group, targetGroupName: c.target_group_name,
      adjacentGroup: c.adjacent_group, adjacentGroupName: c.adjacent_group_name,
      reason: c.reason,
    };
  });
  // 실제로 요청에 실렸던(=그래프에 실제로 조회된) 인접 화물만 대상으로, 아직 안 채워진
  // 신호를 채운다. chem_id가 없는 대상(CAS만 아는 경우)은 그래프 id 매칭이 안 되니
  // 건너뛴다.
  //
  // IMDG 통과는 "관계 없음(SEGREGATE 엣지 없음)"이 공인 규정상 X(격리 불필요)인지,
  // 이 Class 조합 자체가 그래프에 안 실려서 모르는 건지 구분해야 한다(imdgClasses가
  // 그 구분용 — 로더가 9x9 전체가 아니라 실제 등재된 화물의 Class만 SEGREGATE로
  // 적재하기 때문에 엣지 부재만으로는 "확인된 안전"을 단정할 수 없다).
  const targetClass = targetChemId ? imdgClasses[targetChemId] : undefined;
  for (const { berth_name, cargo } of requestedAdjacent) {
    if (!cargo?.chem_id) continue;
    const p = ensurePair(berth_name, cargo.chem_id, cargo.name_hint);
    if (!p.msds) p.msds = { hit: false };
    if (!p.bulk) p.bulk = { hit: false };
    if (!p.imdg) {
      const adjacentClass = imdgClasses[cargo.chem_id];
      p.imdg = {
        hit: false,
        targetClassKnown: targetClass ?? null,
        adjacentClassKnown: adjacentClass ?? null,
        // 백엔드가 imdg_unconfirmed_pairs로 이미 확정한 값을 그대로 읽는다 —
        // 이 목록에 있으면 "진짜 미확정", 없으면(둘 다 Class를 알면서) NO_SEGREGATION_
        // REQUIRED로 확인된 "공인 X" 확정이다(rule_engine.compute_imdg_unconfirmed_floor
        // 참고). 프론트가 다시 계산하지 않는다.
        confirmedNoRequirement: Boolean(targetClass && adjacentClass) && !imdgUnconfirmedIds.has(cargo.chem_id),
      };
    }
  }

  // [2026-08-23] IMDG를 위반 목록에서 뺐다. 부두 간 판정에서 IMDG는 판정 근거가
  // 아니라 참고 정보다(백엔드 compute_imdg_berth_adjacency_floor는 항상 SAFE를
  // 반환한다 — IMDG Ch.7.2는 단일 선박 내 적부 규정이라 부두 간에는 적용 대상이
  // 없고, IMO도 항만 구역은 MSC.1/Circ.1216으로 분리해 둔다). 이름에 "IMDG 격리
  // 위반"이라고 쓰면 화면이 판정과 다른 말을 하게 된다.
  const nameOf = (p) => {
    const hits = [p.msds?.hit && 'MSDS 혼재금지', p.bulk?.hit && '벌크호환성그룹'].filter(Boolean);
    if (hits.length > 1) return `${hits.join(' + ')} 동시 위반`;
    if (hits.length === 1) return `${hits[0]} 위반`;
    if (p.unassessed) return '인접 화물 혼재 검사 — 판정 근거 부족';
    return '인접 화물 혼재 검사 통과';
  };
  const ruleOf = (p, i) => {
    const bits = [];
    if (p.msds?.hit) bits.push(`MSDS-${i + 1}`);
    if (p.bulk?.hit) bits.push(`BULK-${p.bulk.targetGroup}x${p.bulk.adjacentGroup}`);
    if (!bits.length && p.unassessed) bits.push(`UNASSESSED-${i + 1}`);
    return bits.length ? bits.join('+') : `PASS-${i + 1}`;
  };
  // 판정 근거가 된 축을 먼저 쓰고, IMDG는 "참고"로 명시해 뒤에 붙인다 —
  // 같은 줄에 섞어 쓰면 관제사가 IMDG 때문에 등급이 나온 것으로 읽는다.
  const reasonOf = (p) => {
    const parts = [];
    if (p.msds?.hit) parts.push(`MSDS ${p.msds.category} 충돌`);
    else if (p.msds) parts.push('MSDS 상극 관계 없음');
    if (p.bulk?.hit) parts.push(`46 CFR 150 호환성 그룹 ${p.bulk.reason}`);
    if (p.unassessed) parts.push(`판정 근거 부족 — ${p.unassessed.reason}`);
    const ref = p.imdg?.hit
      ? `IMDG Class ${p.imdg.targetClass}↔${p.imdg.adjacentClass} 격리코드 ${p.imdg.segregationCode} (선내 적부 기준 — 부두 간 판정에는 미적용)`
      : null;
    const head = `${p.berth} ${p.label} — ${parts.join(' · ') || '충돌 근거 없음'}`;
    return ref ? `${head}  [참고] ${ref}` : head;
  };

  // hit 판정에서 IMDG를 뺀다 — hit는 빨간 카드 렌더링과 "판단 과정 N건" 카운트를
  // 동시에 좌우하므로, 판정 근거가 아닌 신호가 여기 들어가면 라벨을 아무리 바꿔도
  // 구조가 "이게 판정 이유다"라고 말하게 된다.
  const gates = [...pairs.values()].map((p, i) => {
    const hit = Boolean(p.msds?.hit || p.bulk?.hit);
    return {
      rule: ruleOf(p, i),
      name: nameOf(p),
      hit,
      severity: p.msds?.hit
        ? 'BLOCK'
        : p.bulk?.hit
          ? 'HOLD'
          // 판정 근거 부족은 "확인 안 됨"이지 "통과"가 아니다 — 백엔드도 이걸
          // 최소 '주의'로 격상한다(rule_engine.compute_assessability_floor).
          : p.unassessed ? 'UNKNOWN' : 'INFO',
      reason: reasonOf(p),
      detail: {
        adjacentBerth: p.berth, adjacentCargoName: p.label,
        msds: p.msds, imdg: p.imdg, bulk: p.bulk, unassessed: p.unassessed,
      },
    };
  });

  if (gates.length === 0) {
    gates.push({
      rule: 'MSDS/IMDG', name: '인접 화물 혼재 검사', hit: false, severity: 'INFO',
      reason: '인접 선석 화물과 혼재금지·격리 충돌 없음',
    });
  }
  const flam = (r.key_hazards || []).find((h) => h.includes('인화')) || '정보 없음';
  return {
    risk_level: r.risk_level,
    risk_level_basis: {
      rule_engine_floor: r.rule_engine_floor,
      // [2026-08-23] null 고정. 이 값은 뱃지 옆에 "· IMDG 격리코드 N"으로 붙어
      // 등급의 근거처럼 읽혔는데, 부두 간 판정에서 IMDG는 근거가 아니다.
      // 참고 정보는 게이트 카드의 [참고] 문구로만 노출한다.
      imdg_segregation_code: null,
      flammability_grade: flam,
      gate_hits: gates.filter((g) => g.hit).map((g) => g.rule),
    },
    gates,
    explanation: {
      // summary 는 옛 서술(등급 이유 + 화물 특성)이다 — 스냅샷처럼 새 필드가 없는 응답의 대체용.
      summary: r.reasoning,
      reasoning: r.key_hazards || [],
      checklist: r.checklist || [],
      // [2026-09-29] 등급의 근거(코드) · 확인 필요 · 화물 특성(LLM)을 따로 받는다. 예전엔 한 덩어리
      // reasoning 을 두 줄만 보여줘, 정작 등급의 원인(같은 선박 충돌 등)이 잘려 안 보였다.
      basis: r.verdict_basis || [],
      needs_check: r.needs_check || [],
      profile: r.cargo_profile || '',
    },
    target_cargo_name: r.target_cargo_name,
    cargo_verdicts: r.cargo_verdicts || [],
    // [2026-09-28] 같은 선박 화물끼리의 혼재 충돌 — 있으면 등급이 최소 '주의'.
    onboard_conflicts: r.onboard_conflicts || [],
    msds_sections_used: r.msds_sections_used || [],
    is_local_fallback: false,
    source: 'BACKEND_LLM',
  };
}

// 백엔드 OverallDecision 값 → 화면 상태.
//
// [2026-09-22] 부분 문자열 매칭(`d.includes('승인')`)을 정확 매칭으로 바꿨다.
// 백엔드가 "승인가능" -> "적합" 으로 어휘를 바꾸면서(우리는 승인하지 않는다)
// 부분 매칭이 위험해졌다 — '전 후보 부적합'.includes('적합') 도, '적합선석없음'
// .includes('적합') 도 참이라, 부적합 판정이 전부 APPROVED 로 뒤집힌다.
const DECISION_TO_STATUS = {
  '적합': 'APPROVED',
  '기상불가_중단권고': 'REJECTED',
  '적합선석없음': 'REJECTED',
  '전 후보 부적합': 'REJECTED',
};

// [2026-09-29] 화면 등급은 백엔드 level(판정 기록과 같은 함수)로 정한다. overall_decision 으로
// 정하면 혼재 '주의'가 초록 '적합'으로, 근거 부족(판정불가)이 빨간 '적합선석없음'으로 보였다.
const LEVEL_TO_STATUS = {
  '적합': 'APPROVED',
  '주의': 'CAUTION',
  '부적합': 'REJECTED',
  '판정불가': 'UNKNOWN',
};

function mapOrchestration(r) {
  const d = r.overall_decision || '';
  // level 이 없는 응답(옛 스냅샷)은 귀결 어휘로 대신한다. 모르는 값은 REJECTED 로 떨어뜨린다 —
  // 새 값이 생겼을 때 조용히 '적합'으로 보이는 것보다, 보수적으로 막히고 눈에 띄는 편이 낫다.
  const status = LEVEL_TO_STATUS[r.level] ?? DECISION_TO_STATUS[d] ?? 'REJECTED';
  const trace = r.assignment_trace || [];
  return {
    status,
    decision_label: r.level || d,
    // 등급의 이유 한 줄 · 도구별 의견(등급·근거·못 본 것) · 확인 필요 · 교차 확인 조건
    headline: r.headline || '',
    opinions: r.opinions || [],
    needs_check: r.needs_check || [],
    conditions: r.conditions || [],
    // [2026-09-27] 검증모드 전용 — 배정한 선석이 아니라 **판정한 선석**이다.
    // 정박지 배정(anchorage_assignment)·대체 배정(assignment_changed)은 백엔드에서 없어졌다.
    berth_assigned: r.selected_berth?.wharf_name || null,
    berth_decision: { path: '검증', trace },
    // 부적합일 때 붙는 대체 선석 **제안**(배정 아님)
    suggested_alternatives: r.suggested_alternatives || [],
    suggestion_note: r.suggestion_note || null,
    risk_level: r.safety_assessment?.risk_level || null,
    // 안전 판정의 근거 — 예전엔 등급만 넘겨서 협상 콘솔의 안전 에이전트 발화가
    // "안전 판정: 위험" 한 줄로 끝났다(기상·스케줄링은 근거를 보여주는데 안전만
    // 비어 있었다). "왜 위험인지"가 이 시스템의 핵심인데 그게 안 보였다.
    safety_reasoning: r.safety_assessment?.reasoning || null,
    // [2026-09-29] 전문·화물 특성·유해성은 대표 화물 하나로 만든다 — 화면이 "○○ 기준"을 적는 데 쓴다.
    safety_target_name: r.safety_assessment?.target_cargo_name || '',
    safety_hazards: r.safety_assessment?.key_hazards || [],
    // [2026-09-29] 화물 특성(LLM, 참고) — 등급의 이유가 아니다. 이유는 opinions 의 혼재 근거에 있다.
    safety_profile: r.safety_assessment?.cargo_profile || '',
    // [2026-08-23] IMDG는 **참고 정보**로 내렸다 — 판정 근거 목록과 분리한다.
    //
    // 예전 문구: "S-Oil 4부두 부탄 (3 ↔ 2.1) 격리코드 2"
    // 선석 이름과 격리코드를 한 줄에 붙여 놓아, 마치 그 부두에 그 화물이 있어서
    // 격리 규정을 위반한 것처럼 읽혔다. 실제로는 IMDG Ch.7.2가 **단일 선박 안**의
    // 화물 적부 기준(이격 3~24m)이라 부두와 부두 사이에는 적용 대상이 아니고,
    // 백엔드도 이 맥락에서는 판정에 쓰지 않는다(compute_imdg_berth_adjacency_floor는
    // 항상 SAFE). 그래서 "안전 판정: 안전"인데 바로 아래 격리코드가 뜨는 모순이
    // 화면에 그대로 나왔다.
    safety_imdg_reference: (r.safety_assessment?.imdg_conflicts || []).map(
      (c) => `${c.adjacent_name}: IMDG Class ${c.target_imdg_class} ↔ ${c.adjacent_imdg_class} 격리코드 ${c.segregation_code}`
    ),
    safety_conflicts: (r.safety_assessment?.conflicts || []).map(
      (c) => `${c.adjacent_berth} ${c.adjacent_name} — ${c.shared_category} 혼재금지`
    ),
    // 벌크 호환성그룹은 실제 판정 근거다(배정불가 62건 전부 이 축에서 나온다).
    safety_bulk: (r.safety_assessment?.bulk_compatibility_conflicts || []).map(
      (c) => `${c.adjacent_berth} ${c.adjacent_name} — 호환성그룹 ${c.target_group_name}(${c.target_group}) ↔ ${c.adjacent_group_name}(${c.adjacent_group})`
    ),
    // 판정 근거 부족 — 등급을 최소 '주의'로 올리는 실제 근거인데 화면에 없었다.
    safety_unassessed: (r.safety_assessment?.unassessed_pairs || []).map(
      (u) => `${u.adjacent_berth} ${u.adjacent_name} — ${u.assessability}: ${u.reason}`
    ),
    safety_checklist: r.safety_assessment?.checklist || [],
    // [2026-09-25] 화물별 혼재 판정. 대표 등급(risk_level)은 is_governing 인 화물의 것.
    safety_cargo_verdicts: r.safety_assessment?.cargo_verdicts || [],
    // [2026-09-28] 같은 선박 화물끼리의 혼재 충돌(격리 적재 확인 필요).
    safety_onboard: (r.safety_assessment?.onboard_conflicts || []).map(
      (c) => `${c.cargo_a_name} ↔ ${c.cargo_b_name} — ${c.basis} ${c.detail}`
    ),
    weather_grade: r.weather_assessment?.status || null,
    weather_reasons: r.weather_assessment?.reasons || [],
    summary: r.summary,
    // GanttChart 가 승인 건을 예정 작업으로 얹을 때 쓰는 표시용 이름.
    // 예전엔 이 두 필드가 없어 간트에 "undefined (시뮬레이션 배정)"이 생겼다.
    vessel_name: r._vessel_name || null,
    cargo_name: r._cargo_name || null,
    rejected_candidates: r.rejected_candidates || [],
    // [2026-09-28] 에이전트별 의견 — 무엇을 확인했고(checked) 무엇을 근거로(evidence) 무엇을 못 봤는지(missing).
    // 백엔드가 늘 돌려주던 값인데 화면이 버리고 있었다.
    opinions: r.opinions || [],
    evidence_missing: Boolean(r.evidence_missing),
    weather_source: r.weather_assessment ? {
      station: r.weather_assessment.wind?.station_name || null,
      berth_group: r.weather_assessment.thresholds_used?.berth_group || null,
      stop_wind: r.weather_assessment.thresholds_used?.stop?.wind_ms ?? null,
      forecast_points: r.weather_assessment.forecast_warning?.forecast_points_checked ?? null,
    } : null,
    msds_sections_used: r.safety_assessment?.msds_sections_used || [],
    berth_facts: r.selected_berth ? {
      depth_m: r.selected_berth.depth_m ?? null,
      margin_m: r.selected_berth.draught_margin_m ?? null,
      adjacent: (r.selected_berth.adjacent_cargos || []).length,
    } : null,
    is_local_fallback: false,
    source: 'BACKEND_ORCHESTRATOR',
  };
}

export default function useOnsanApi() {
  const setBerthGroups = useSensorStore((s) => s.setBerthGroups);
  const setBerthWeather = useSensorStore((s) => s.setBerthWeather);
  const setOrchestration = useSensorStore((s) => s.setOrchestration);

  const postJson = useCallback(async (path, body) => {
    try {
      const res = await fetch(`${BACKEND_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`[OnsanAPI] ${path} 실패 → 로컬 폴백:`, err.message);
      return null;
    }
  }, []);

  // 승인/반려 계열 전용 — postJson 과 달리 실패 사유(detail)를 삼키지 않는다.
  //
  // postJson 은 실패 시 null 을 돌려주고 호출부가 로컬 폴백으로 도망가는 조회용
  // 계약이다. 그런데 승인은 폴백이 없다 — 실패했으면 "왜"가 화면에 떠야 한다.
  // 예전엔 여기서도 postJson 을 써서, 스냅샷 배포본의 "읽기 전용" 503 사유가
  // "백엔드 응답이 없습니다"라는 개발자 문구로 뭉개졌다(2026-08-23 실사고 —
  // 사용자가 배포본에서 승인을 눌렀는데 왜 안 되는지 알 수 없었다).
  const postJsonStrict = useCallback(async (path, body) => {
    let res;
    try {
      res = await fetch(`${BACKEND_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('관제 서버가 응답하지 않습니다. 연결 상태를 확인해주세요.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.detail || `요청이 거부되었습니다 (HTTP ${res.status})`);
      // 공개 배포본이 막은 것인지 진짜 실패인지 화면이 구분할 수 있게 표식을 넘긴다.
      err.readOnly = Boolean(data?.read_only);
      throw err;
    }
    if (data == null) throw new Error('서버 응답을 해석할 수 없습니다.');
    return data;
  }, []);


  // 선석군 목록 — 백엔드에 조회 엔드포인트가 없어 로컬 매핑을 쓴다
  // (berth_weather_threshold 시드와 동일한 문자열)
  const fetchBerthGroups = useCallback(async () => {
    setBerthGroups(LOCAL_BERTH_GROUPS);
    return { berth_groups: LOCAL_BERTH_GROUPS };
  }, [setBerthGroups]);

  // 선석별 4단계 기상 판정 — 백엔드 기상 에이전트가 DB 관측치로 직접 판정
  const assessBerthWeather = useCallback(
    async ({ berthGroup, windSpeed, waveHeight, isStale = false, precipObserved = false, extraCondition = false }) => {
      const data = await postJson('/weather/assess', {
        berth_group: berthGroup,
        precip_observed: Boolean(precipObserved),
        extra_condition_active: Boolean(extraCondition),
      });
      const verdict = data ? mapWeather(data, berthGroup)
        : localAssessWeather({ berthGroup, windSpeed, waveHeight, isStale, precipObserved, extraCondition });
      setBerthWeather(verdict);
      return verdict;
    },
    [postJson, setBerthWeather]
  );

  // 안전 판정 — MSDS 혼재금지 + IMDG 격리 + LLM 근거 생성.
  // 스토어에 결과를 쓰지 않는다(순수 fetch) — SafetyGatesPanel(수동 R1~R15 심사)과
  // useVesselSafety(선박 선택 시 자동 판정)가 둘 다 이 함수를 쓰는데, 예전엔 여기서
  // 바로 setGateAssessment 하는 바람에 지도/목록에서 선박만 클릭해도 SafetyGatesPanel·
  // DashboardPage KPI에 표시되던 "최근 안전 심사" 결과가 다른 선박 값으로 조용히
  // 덮어써졌다. 이제 전역 상태에 반영할지는 호출자가 결정한다
  // (SafetyGatesPanel만 반영 — useVesselSafety는 자기 로컬 state만 씀).
  // [2026-08-23] 판정만 먼저 받는 경로 — POST /safety/verdict (LLM 미사용, 실측 65ms).
  // assessSafetyGates(=/safety/assess)는 LLM 서술까지 기다리느라 2.5~4초가 걸리는데,
  // 등급과 충돌 근거는 규칙엔진이 그 전에 이미 확정한다. 화면이 결론을 먼저 띄우고
  // 체크리스트만 나중에 채우도록 둘로 나눴다.
  //
  // 여기서 받은 risk_level은 뒤이어 오는 /safety/assess의 risk_level과 **항상 같다** —
  // 등급을 규칙엔진이 정하므로 뒤집히지 않는다(백엔드 실측 격상률 0%). 그래서 먼저
  // 표시해도 안전하다. 반환 모양은 assessSafetyGates와 같게 맞춰서(explanation만 비어
  // 있음) 화면이 같은 컴포넌트로 렌더링할 수 있게 한다.
  const assessSafetyVerdict = useCallback(
    async (req) => {
      const target = resolveCargoRef(req);
      const adj = (req.adjacent_operations || [])
        .map((o) => {
          const c = resolveCargoRef(o);
          return c ? { berth_name: o.berth_name, cargo: c } : null;
        })
        .filter(Boolean);
      if (!target) return null;

      const data = await postJson('/safety/verdict', {
        target_cargo: target, target_cargos: extraCargoRefs(req.extra_cargos, target), adjacent_cargos: adj,
        // 불러온 배면 호출부호 — 백엔드가 그 입항 건 신고의 하역방식을 채운다(2026-09-29)
        call_sign: req.call_sign || null,
      });
      if (!data) return null;
      // mapSafety는 checklist/reasoning이 없어도 동작한다(옵셔널 체이닝).
      return { ...mapSafety(data, adj, target.chem_id), is_verdict_only: true };
    },
    [postJson]
  );

  const assessSafetyGates = useCallback(
    async (req) => {
      const target = resolveCargoRef(req);
      const adj = (req.adjacent_operations || [])
        .map((o) => {
          const c = resolveCargoRef(o);
          return c ? { berth_name: o.berth_name, cargo: c } : null;
        })
        .filter(Boolean);

      const data = target
        ? await postJson('/safety/assess', {
          target_cargo: target, target_cargos: extraCargoRefs(req.extra_cargos, target), adjacent_cargos: adj,
          // 불러온 배면 호출부호 — 백엔드가 그 입항 건 신고의 하역방식을 채운다(2026-09-29)
          call_sign: req.call_sign || null,
        })
        : null;

      const result = data ? mapSafety(data, adj, target?.chem_id) : {
        risk_level: '판단불가',
        risk_level_basis: { rule_engine_floor: '판단불가', imdg_segregation_code: null, flammability_grade: '정보 없음', gate_hits: [] },
        gates: [{
          rule: '-', name: '안전 판정', hit: true, severity: 'HOLD',
          reason: target ? '안전 에이전트 응답 없음 — 판단 보류'
            : `화물 '${req.cargo_name}' CAS 매핑 없음 — MSDS 조회 불가`,
        }],
        explanation: { summary: '판정을 확정할 수 없어 보류합니다. (모르면 가능하다고 하지 않는다)', reasoning: [], checklist: [] },
        is_local_fallback: true,
        source: 'LOCAL_FALLBACK',
      };
      return result;
    },
    [postJson]
  );

  // 오케스트레이터 — 기상 → 스케줄링(전용/대체/정박지) → 안전 순차 판단
  // casNo가 오면(실AIS+berth-cargo 조인으로 이미 CAS를 아는 경우) 데모용 이름사전
  // cargoRef()를 거치지 않고 그대로 쓴다 — 실물질명은 사전 12종 밖일 수 있어서다.
  //
  // [2026-09-27] 검증모드 전용 — assignedWharfName(배가 실제로 붙은 부두)이 필수다.
  // 선석을 새로 고르는 탐색모드는 백엔드에서 없어졌다(27번 설계안 D단계).
  const orchestrate = useCallback(
    async ({ cargoName, casNo, chemId = null, dwt, draught, vesselName = '신규 입항선', assignedWharfName = null, targetSource = 'AIS', callSign = null, extraCargos = [] }) => {
      // [2026-09-29] chem_id 도 받는다(판정 기록 경로 recordAssessment 와 같게). 선박 판정 표에서 연 배는
      //   cas_no 없이 chem_id·이름만 와서, 이름 사전에 없는 화물(케로젠)이 "CAS 매핑 없음 → 판단 보류"가 됐다.
      const cargo = resolveCargoRef({ chem_id: chemId, cas_no: casNo, cargo_name: cargoName });
      // [2026-09-29] 흘수를 모르면 판정하지 않는다. 예전엔 7.5m 를 지어 보내, AIS 목록에서 빠진 우선호(실측
      //   흘수 4.5m)를 수심 7.0m 달포부두에서 "흘수 여유 -0.17m → 부적합"으로 판정했다(모르면 가능하다고도,
      //   불가하다고도 하지 않는다).
      const draughtM = Number(draught) > 0 ? Number(draught) : null;
      const now = Date.now();
      const data = cargo && assignedWharfName && draughtM
        ? await postJson('/orchestrator/assess', {
          vessel: {
            draught_m: draughtM,
            dwt_t: dwt ? Number(dwt) : null,
            name_hint: vesselName,
            // 이 배가 이미 받아 둔 추천을 "점유"로 세지 않게 한다 — 없으면
            // 추천받은 배가 자기 예약에 막혀 승인 조건에 도달하지 못한다.
            call_sign: callSign ?? null,
          },
          cargo,
          cargos: extraCargoRefs(extraCargos, cargo),
          window_start: new Date(now).toISOString(),
          window_end: new Date(now + 8 * 3600 * 1000).toISOString(),
          assigned_wharf_name: assignedWharfName,
          // 위치 판정의 실제 접안 부두면 'AIS'("지금 접안한 선석"), 입항 판정 표에서 연
          // 사전배정 계류시설이면 'PORT-MIS'("배정된 선석")다(2026-09-29). 예전엔 늘 'AIS'라
          // 입항 전 배도 "지금 접안한"으로 나왔다.
          target_source: targetSource,
        })
        : null;

      // 백엔드 응답에는 "무슨 배로 물었는지"가 없다(요청만 알고 있는 정보다).
      // 화면이 결과를 그 배 이름으로 표시할 수 있게 요청값을 함께 실어 둔다.
      const result = data ? mapOrchestration({ ...data, _vessel_name: vesselName, _cargo_name: cargoName }) : {
        status: 'PENDING',
        decision_label: '판단 보류',
        berth_assigned: null,
        berth_decision: { path: null, trace: [] },
        risk_level: null, weather_grade: null,
        vessel_name: vesselName, cargo_name: cargoName,
        summary: !assignedWharfName
          ? '이 배가 지금 접안한 부두가 확인되지 않아 콘솔에서 판정할 수 없습니다. '
            + '접안 전 사전 검토는 판정 잡이 PORT-MIS 신고 선석으로 10분마다 합니다(확인 대기 목록).'
          : !cargo ? `화물 '${cargoName}' 식별 정보(chem_id·CAS)가 없어 조회할 수 없습니다.`
            : !draughtM ? '이 배의 흘수가 지금 수신되지 않아(AIS 위치 목록 밖) 다시 판정하지 않았습니다. 위의 기록된 판정을 보세요.'
              : '판정 서버가 응답하지 않아 판단을 보류합니다.',
        is_local_fallback: true, source: 'LOCAL_FALLBACK',
      };
      setOrchestration(result);
      return result;
    },
    [postJson, setOrchestration]
  );

  // 판정 + 판정 이력 기록 — POST /orchestrator/assess-and-record.
  //
  // [2026-09-22] 옛 commitAssignment(/assess-and-commit) 와 rejectAssignment
  // (/orchestrator/reject) 를 이걸로 합쳤다. 두 경로 모두 버튼이 곧 배정이던
  // 시절의 것이고, 지금 백엔드에는 아예 없다(둘 다 404).
  //
  // 우리는 선석을 배정하지 않는다. 그러니 확정할 것도 반려할 것도 없다 —
  // 남는 일은 "이 배가 지금 있는 자리가 조건에 맞는가"를 판정해 기록하는 것뿐이다.
  //
  // assigned_wharf_name 이 필수다(없으면 백엔드가 400). 탐색모드(새 자리를
  // 추천받는 호출)로는 기록할 수 없다는 뜻인데, 그게 맞다 — 기록하려면 "어느
  // 자리에 대한 판정인가"가 있어야 한다. 그 자리는 위치 판정이 알려준다
  // (/vessels 의 presence_berth_name).
  //
  // chem_id 를 orchestrate() 보다 하나 더 챙긴다 — 실화물 조인 결과는 chem_id 를
  // 이미 알고 있으므로(cas_no 경유 없이) 그대로 써야 판정 행의 물질이 정확하다.
  const recordAssessment = useCallback(
    async ({
      cargoName, chemId, casNo, dwt, draught, vesselName, callSign, imoNo, assignedWharfName,
      extraCargos = [],
    }) => {
      const cargo = resolveCargoRef({ chem_id: chemId, cas_no: casNo, cargo_name: cargoName });
      if (!cargo) throw new Error(`화물 '${cargoName}' 식별 불가 — chem_id/CAS 매핑이 없습니다.`);
      if (!assignedWharfName) {
        throw new Error('이 배가 지금 어느 선석에 있는지 확인되지 않아 판정을 기록할 수 없습니다.');
      }
      // 흘수를 지어내지 않는다 — orchestrate() 와 같은 이유(2026-09-29).
      if (!(Number(draught) > 0)) {
        throw new Error('이 배의 흘수가 수신되지 않아 판정을 기록할 수 없습니다.');
      }
      const now = Date.now();
      const data = await postJsonStrict('/orchestrator/assess-and-record', {
        vessel: {
          draught_m: Number(draught),
          dwt_t: dwt ? Number(dwt) : null,
          name_hint: vesselName,
          call_sign: callSign ?? null,
        },
        cargo,
        cargos: extraCargoRefs(extraCargos, cargo),
        window_start: new Date(now).toISOString(),
        window_end: new Date(now + 8 * 3600 * 1000).toISOString(),
        assigned_wharf_name: assignedWharfName,
        target_source: 'AIS',
        call_sign: callSign,
        vessel_name: vesselName,
        imo_no: imoNo ?? null,
      });
      // 실패는 postJsonStrict 가 사유와 함께 throw 한다
      return {
        // 직전 판정과 시점·등급·조치안이 모두 같으면 기록하지 않는다(변화만 남긴다).
        // 그건 실패가 아니라 "바뀐 게 없다"는 뜻이라 화면이 구분해서 말해야 한다.
        recorded: data.recorded,
        level: data.level,
        stage: data.stage ?? null,
        orchestration: mapOrchestration({ ...data.result, _vessel_name: vesselName, _cargo_name: cargoName }),
      };
    },
    [postJsonStrict]
  );

  // ─── 관제사 질의응답 (RAG) ───
  // 백엔드 /rag/query 가 준비되면 그대로 쓰고, 없으면 MSDS 섹션 직접 인용으로 답한다.
  // 폴백이라도 "근거 없는 문장"은 만들지 않는다 — 원문 문장을 그대로 인용한다.
  // 요청 계약 주의 3가지 (backend app/agents/chatbot/schemas.py)
  //  - top_k 는 보내지 않는다. extra="forbid" 라 422로 거절되고, 애초에 근거 청크 수는
  //    intent별로 서버가 튜닝한다(일반 8 / 혼재판정 4 / 그 외 6). 더 보여주는 건 UI 문제다.
  //  - cargo_hint 는 화면이 화물을 이미 특정한 경우에만. 자유 채팅에선 생략한다
  //    (사용자는 CAS번호를 모르고, LLM 플래너가 질문에서 물질명을 뽑는다).
  //  - cargo_hint 를 보낼 땐 chem_id 우선. cas_no 는 msds_chemical 에서 nullable 이다.
  const ragQuery = useCallback(
    async ({ question, cargoHint = null }) => {
      const hint = cargoHint ? cargoRef(cargoHint) : null;
      const body = { question };
      if (hint?.chem_id) body.cargo_hint = { chem_id: hint.chem_id };
      else if (hint?.cas_no) body.cargo_hint = { cas_no: hint.cas_no };

      const data = await postJson('/rag/query', body);
      if (data) {
        return {
          answer: data.answer,
          citations: (data.citations || []).map((c) => ({
            chem_name: c.chem_name, cas_no: c.cas_no,
            section: c.section, section_name: c.section_name || MSDS_SECTIONS[c.section],
            text: c.text,
            // score === null 은 유사도가 낮은 게 아니라 '확정값'(정형 컬럼·그래프 관계)이다.
            // 벡터 발췌보다 신뢰도가 높으므로 화면에서 유사도 뱃지와 구분해야 한다.
            score: c.score ?? null,
            is_exact: c.score === null || c.score === undefined,
          })),
          confidence: data.confidence || null,
          // 비어 있지 않으면 "혼재금지 관계 없음(안전)"이 아니라 "판정 불가"다 — 경고 대상
          unresolved: data.unresolved || [],
          assessment: data.assessment || null,
          is_local_fallback: false,
          source: 'BACKEND_RAG',
        };
      }
      return localMsdsAnswer({ question, cargoHint });
    },
    [postJson]
  );

  return {
    fetchBerthGroups, assessBerthWeather, assessSafetyVerdict, assessSafetyGates,
    orchestrate, recordAssessment, ragQuery,
  };
}
