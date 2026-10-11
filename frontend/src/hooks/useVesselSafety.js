import { useEffect, useState } from 'react';
import useOnsanApi from './useOnsanApi';
import { fetchAdjacentCargos } from '../api/backendAdapter';

// ─────────────────────────────────────────────
// 선박별 안전 판정 — 백엔드 안전 에이전트(POST /api/v1/safety/assess) 직결.
//
// 이전에는 mocks/mockAssessment.js 가 UN번호 4개짜리 하드코딩 표로 판정을 만들었다.
// 표에 없는 화물은 전부 '안전'을 반환해서, 두 가지 문제가 있었다.
//   1) 위반 케이스(UN1978 프로페인·UN1830 황산 등)가 화면에서 '안전'으로 보였다.
//   2) "모르면 가능하다고 하지 않는다"는 우리 설계 원칙과 정반대였다.
// 이제 판정은 실제 MSDS·IMDG 격리 검사에서 나오고, 모르는 화물은 '판단불가'다.
//
// 이웃 화물은 백엔드 GET /scheduling/adjacent-cargos 로 받는다 — 판정 잡(10분)과 같은
// 인접 계산이다. [2026-09-27] 예전엔 프론트 자체 인접표(온산 13곳)를 써서, 그 밖 선석
// (접안선 32척 중 22척)은 이웃 0건으로 판정받아 이웃에 무엇이 있든 '안전'이 나왔다.
// ─────────────────────────────────────────────

const EMPTY = { risk_level: '안전', gates_hit: [], checklist: [], source: 'NOT_APPLICABLE' };
// [2026-09-25] 액체화물선인데 화물을 모르면 '안전'이 아니라 판단불가다. 선종 추정 화물을
// 없앤 뒤로 이런 배가 EMPTY('안전')로 떨어져, 판정한 적 없는 배가 안전으로 보였다.
const NO_CARGO = {
  risk_level: '판단불가',
  gates_hit: [{ rule: '-', severity: 'HOLD', reason: '화물 미확인 — 현재 입항 건 화물이 없어 판정하지 않았습니다' }],
  checklist: [],
  source: 'NO_CARGO',
};

/** 백엔드 판정 결과 → 화면이 쓰던 계약(risk_level/gates_hit/checklist)으로 변환 */
function toPanelShape(result) {
  return {
    risk_level: result.risk_level,
    gates_hit: (result.gates || []).filter((g) => g.hit).map((g) => ({
      rule: g.rule, severity: g.severity, reason: g.reason,
    })),
    checklist: result.explanation?.checklist || [],
    summary: result.explanation?.summary || '',
    // [2026-09-29] 확인 필요('대상 — 이유')와 화물 특성(LLM 1~2문장)
    needs_check: result.explanation?.needs_check || [],
    // [2026-09-29] 등급의 근거 — 백엔드가 **모든 화물**에서 모아 화물 이름을 붙인 줄(verdict_basis).
    //   예전 패널은 gates_hit(대표 화물의 충돌만 프론트가 다시 조립)을 보여줘, 다른 화물의 충돌이 빠졌다.
    verdict_basis: result.explanation?.basis || [],
    // 화물 특성·유해성·체크리스트는 대표 화물 하나로 만든다 — 누구 기준인지 제목에 적는다.
    governing_name: result.target_cargo_name || '',
    profile: result.explanation?.profile || '',
    hazards: result.explanation?.reasoning || [],
    basis: result.risk_level_basis,
    msds_sections_used: result.msds_sections_used || [],
    // [2026-09-25] 화물별 판정(여러 종을 실은 배). 대표 등급은 is_governing 인 화물의 것.
    cargo_verdicts: result.cargo_verdicts || [],
    onboard_conflicts: result.onboard_conflicts || [],
    is_local_fallback: Boolean(result.is_local_fallback),
    source: result.source,
  };
}

export default function useVesselSafety(vessel) {
  const { assessSafetyVerdict, assessSafetyGates } = useOnsanApi();
  // narrativeLoading — 등급은 나왔지만 체크리스트/근거문장이 아직 오는 중.
  // 화면은 이 플래그로 체크리스트 자리에만 스켈레톤을 띄운다(등급 뱃지는 이미 확정).
  const [state, setState] = useState({ assessment: null, loading: false, narrativeLoading: false });

  // 대상 화물: 입항 건 화물만. 없으면 판정하지 않는다(선종 추정은 2026-09-25 폐지).
  const effCargo = vessel?.cargo ?? null;
  const cargoName = effCargo?.name || null;
  const cargoCasNo = effCargo?.cas_no || null;
  // [2026-09-25] 같은 입항 건의 화물 전부.
  const extraCargos = vessel?.cargos || [];
  const extraKey = extraCargos.map((c) => c.chem_id).join('|');
  const berth = vessel?.berth || null;
  const isLiquid = Boolean(vessel?.is_liquid_cargo_vessel);

  // 이웃 화물 — undefined: 조회 중, null: 조회 실패(판단불가로 처리), 배열: 결과.
  // 선석이 없으면(정박지·항해 중) 이웃이 없다.
  const [adjacent, setAdjacent] = useState(undefined);
  const callSign = vessel?.callsgn || null;
  useEffect(() => {
    if (!berth) { setAdjacent([]); return undefined; }
    let cancelled = false;
    setAdjacent(undefined);
    fetchAdjacentCargos({ wharf_name: berth, call_sign: callSign })
      .then((list) => { if (!cancelled) setAdjacent(list); })
      .catch(() => { if (!cancelled) setAdjacent(null); });
    return () => { cancelled = true; };
  }, [berth, callSign]);

  const adjacentKey = adjacent == null ? String(adjacent)
    : adjacent.map((a) => `${a.berth_name}:${a.chem_id}`).join('|');

  useEffect(() => {
    if (!isLiquid || !cargoName) {
      setState({ assessment: null, loading: false, narrativeLoading: false });
      return;
    }
    if (adjacent === undefined) return; // 이웃 조회 중
    if (adjacent === null) {
      // 이웃을 모르고 판정하면 '이웃 0건 = 안전'이 된다 — 판정하지 않는다(fail-safe).
      setState({
        assessment: {
          risk_level: '판단불가', gates_hit: [{
            rule: '-', severity: 'HOLD', reason: '이웃 화물 조회 실패 — 판단 보류',
          }], checklist: [], is_local_fallback: true, source: 'ERROR',
        },
        loading: false, narrativeLoading: false,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, narrativeLoading: false }));

    // cas_no는 실화물 조인(mart.berth_current_cargo)에서 이미 확정된 값이라
    // 그대로 넘긴다 — 화물명 하드코딩 사전(cargoRef)을 안 거치므로 표기 불일치로
    // 인한 "CAS 매핑 없음" 오탐이 없다.
    // [2026-08-23] 2단계 조회 — 판정(65ms)을 먼저 그리고 서술(2.5초)을 이어 채운다.
    // 두 등급이 항상 같으므로(백엔드가 규칙엔진 값을 그대로 씀) 먼저 그린 뱃지가
    // 나중에 바뀌지 않는다. 서술 조회가 실패해도 등급은 이미 화면에 있으므로
    // 판정 전체를 '판단불가'로 떨어뜨리지 않는다 — 예전보다 오히려 견고하다.
    const req = {
      // chem_id 도 넘긴다 — 화물 목록과 같은 키로 대표 화물을 식별해야 중복 판정이 안 생긴다.
      chem_id: effCargo?.chem_id || null,
      cargo_name: cargoName, cas_no: cargoCasNo, adjacent_operations: adjacent, extra_cargos: extraCargos,
      // 호출부호 — 백엔드가 이 배의 입항 건 신고에서 하역방식을 채운다. 없으면 용기등급 Ⅰ 화물마다
      // "하역방식 신고가 없어"가 확인 필요로 떴다(신고엔 '펌프'가 있다, 2026-09-29).
      call_sign: callSign,
    };

    // 서술이 먼저 도착할 수도 있다(네트워크 상황). 그때 늦게 온 판정이 서술을
    // 덮어쓰면 체크리스트가 화면에서 사라지므로 플래그로 막는다.
    let narrativeArrived = false;

    assessSafetyVerdict(req)
      .then((res) => {
        if (!cancelled && res && !narrativeArrived) {
          setState({ assessment: toPanelShape(res), loading: false, narrativeLoading: true });
        }
      })
      .catch(() => { /* 판정 실패는 아래 assessSafetyGates의 catch가 처리한다 */ });

    assessSafetyGates(req)
      .then((res) => {
        narrativeArrived = true;
        if (!cancelled) setState({ assessment: toPanelShape(res), loading: false, narrativeLoading: false });
      })
      .catch(() => {
        // 실패해도 '안전'으로 떨어뜨리지 않는다 — fail-safe
        if (!cancelled) {
          setState({
            assessment: {
              risk_level: '판단불가', gates_hit: [{
                rule: '-', severity: 'HOLD',
                reason: '안전 에이전트 조회 실패 — 판단 보류',
              }], checklist: [], is_local_fallback: true, source: 'ERROR',
            },
            loading: false,
            narrativeLoading: false,
          });
        }
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargoName, cargoCasNo, berth, isLiquid, adjacentKey, extraKey, callSign]);

  // 액체화물선이 아니면 판정 대상이 아니다. 액체화물선인데 화물을 모르면 판단불가.
  if (!isLiquid) return { assessment: EMPTY, loading: false, narrativeLoading: false };
  if (!cargoName) return { assessment: NO_CARGO, loading: false, narrativeLoading: false };
  return state.assessment
    ? { assessment: state.assessment, loading: state.loading, narrativeLoading: state.narrativeLoading }
    : { assessment: null, loading: true, narrativeLoading: false };
}
