import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  FaCloudSun, FaRoute, FaShieldAlt, FaRobot, FaComments, FaTimes, FaPlay, FaSpinner,
  FaSearch, FaPaperPlane, FaBookOpen, FaUser,
} from 'react-icons/fa';
import useOnsanApi, { namesAnyCargo } from '../../hooks/useOnsanApi';
import useSensorStore from '../../stores/useSensorStore';
import useDashboardData from '../../hooks/useDashboardData';
import { fetchPendingApprovals, postAcknowledgement } from '../../api/backendAdapter';
import { COLORS, OPERATOR_NAME } from '../../utils/constants';
import { ONSAN_WEATHER_GROUP, findBerthIdByName } from '../../utils/geoUtils';
import { cargoSummary } from '../../utils/cargoText';
import DemoChip from '../common/DemoChip';
import { useDemoCargo } from '../../utils/demoCargo';
import { showDisclosure } from '../../utils/disclosure';
import { stripPairs } from '../../utils/pairList';

// 기록된 판정 카드 — 표와 같은 색·같은 말
// 화면 공용 판정 색(utils/verdict) — 판정불가는 보라
const LEVEL_COLOR = { '적합': COLORS.teal, '주의': COLORS.yellow, '부적합': COLORS.red, '판정불가': COLORS.purple };
// 서버 종합 판정값(내부 이름)을 화면 말로. '적합선석없음'은 선석을 확인 못 한 판정불가, 나머지 둘은 원인이 붙은 부적합.
const DECISION_KO = {
  '적합': '적합', '승인가능': '적합',
  '적합선석없음': '판정불가 · 선석 확인 불가',
  '기상불가_중단권고': '부적합 · 기상',
  '전 후보 부적합': '부적합 · 혼재',
};
const decisionKo = (d) => DECISION_KO[d] || d || '';
const decisionLevel = (d) => (DECISION_KO[d] || '').split(' ·')[0];
const STAGE_TEXT = { '입항전': '입항 전', '접안직전': '접안 직전', '하역중': '하역 중' };
// 실물 하역 개시 게이트가 있는 부두 — 현장 설비 화면의 게이트 A·B
const gateOfBerth = (name) => {
  const n = String(name || '').replace(/\s/g, '');
  if (n.startsWith('OTK1')) return 'A';
  if (n.startsWith('정일1')) return 'B';
  return null;
};
const kstShort = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

// ─────────────────────────────────────────────
// 멀티 에이전트 협상 콘솔 (우하단 플로팅 탭)
//
// "그래서 멀티 에이전트가 어떻게 연동되나?" 에 대한 화면상의 답.
// 선석 → 기상 → 혼재(안전) → 종합 순으로(백엔드 감독자와 같은 순서) 각 에이전트가 낸 판단과 근거를
// 메신저 대화처럼 시간순으로 보여준다.
//
// 데이터는 새로 만들지 않는다 — 백엔드 오케스트레이터 응답에 이미 들어 있는
// weather_assessment / assignment_trace / rejected_candidates /
// safety_assessment / summary 를 발화로 옮길 뿐이다.
// ─────────────────────────────────────────────

const AGENTS = {
  weather: { name: '기상 분석 에이전트', short: '기상 분석', icon: FaCloudSun, color: '#1E6FA8', role: '부두 기준 풍속·파고 실측과 체류 중 예보' },
  scheduling: { name: '선석 검증 에이전트', short: '선석 검증', icon: FaRoute, color: '#5B3E9B', role: '선석 수심·조위와 흘수, 이웃 선석 화물' },
  safety: { name: '혼재 심사 에이전트', short: '혼재 심사', icon: FaShieldAlt, color: '#B26A00', role: '화물 MSDS·호환성 그룹과 이웃 화물 조합' },
  orchestrator: { name: '종합 판정 (오케스트레이터)', short: '종합', icon: FaRobot, color: COLORS.teal, role: '세 의견을 모아 등급·조치안' },
};

// 근거 신뢰도 — LLM이 아니라 근거 종류로 백엔드 코드가 산정한 값
const CONFIDENCE_LABEL = { high: '높음', medium: '보통', low: '낮음 (근거 부족)' };

const RISK_COLOR = (lv) => ({
  '안전': COLORS.teal, '주의': COLORS.yellow, '위험': COLORS.red, '배정불가': COLORS.red,
}[lv] || COLORS.textDim);

const VERDICT_COLOR = {
  APPROVED: COLORS.teal, CAUTION: COLORS.yellow,
  REJECTED: COLORS.red, UNKNOWN: COLORS.purple, PENDING: COLORS.info,   // 판정불가 = 보라(화면 공용 판정 색)
};

// 도구 의견(백엔드 opinions) 중 한 축. 옛 응답(스냅샷)에는 없다 — 그때는 옛 근거로 대신한다.
const opinionOf = (orchestration, axis) => (orchestration.opinions || []).find((o) => o.axis === axis);

/** 오케스트레이터 결과 → 에이전트별 발화 목록 */
// [2026-09-30] 판단 과정 줄의 '같은 선박 화물끼리 혼재 충돌 18쌍(A↔B, …)' — 쌍 목록은 떼고 결론 한 줄만.
//   쌍은 '혼재 근거 자세히 →'의 화물별 표에서 본다(혼재 카드와 같은 규칙, 현우 9/30).
const tidyLine = (d) => (typeof d === 'string' ? stripPairs(d).text : d);

function toMessages({ orchestration, berthWeather, vessel }) {
  if (!orchestration) return [];
  const msgs = [];
  const at = (s) => new Date(Date.now() - s * 1000).toLocaleTimeString('ko-KR', { hour12: false });

  // [2026-09-28] 발화 순서를 백엔드 감독자와 같게 — 선석 → 기상 → 혼재 → (부적합이면) 대체 제안 → 종합.
  // 예전엔 기상이 늘 먼저 나와, 보고서·영상의 "선석이 정해져야 그 부두 기상 기준과 이웃 화물이 정해진다"와
  // 화면 순서가 달랐다. 판정 내용은 그대로이고 보여 주는 순서만 바꿨다.
  //
  // 1) 선석 — 지금 붙은 부두가 이 배에 맞는가(검증). [2026-09-27] 배정·정박지 경로는 없어졌다.
  const trace = orchestration.berth_decision?.trace || [];
  if (trace.length) {
    msgs.push({
      agent: 'scheduling', time: at(9),
      text: orchestration.berth_assigned
        ? `판정 선석: ${orchestration.berth_assigned}`
        : '지금 선석이 이 배·화물 조건에 맞지 않거나 확인할 수 없습니다.',
      detail: trace,
    });
  }
  // 2) 기상 — 오케스트레이터 결과 우선, 없으면 패널에서 본 판정 사용.
  // 상태·근거·선석 이름 셋 다 반드시 같은 출처에서 함께 가져온다.
  const usingOrchestrationWeather = Boolean(orchestration.weather_grade);
  const wStatus = orchestration.weather_grade || berthWeather?.status;
  if (wStatus) {
    const obs = usingOrchestrationWeather ? null : berthWeather?.observed;
    // [2026-09-29] 기상 의견의 근거만 싣는다 — '파고 … 적용하지 않음 - 참고값'처럼 등급과 무관한
    // 문장은 백엔드가 근거에서 뺐다(항내 부두 31건 중 30건에 떠 있었다).
    const weatherOpinion = opinionOf(orchestration, '기상');
    const reasons = usingOrchestrationWeather
      ? (weatherOpinion?.evidence ?? orchestration.weather_reasons)
      : berthWeather?.reasons;
    const wBerthName = usingOrchestrationWeather
      ? (orchestration.berth_assigned || vessel?.berth || '대상 선석')
      : (vessel?.berth || '대상 선석');
    msgs.push({
      agent: 'weather', time: at(8),
      text: `${wBerthName} 기상 판정: ${wStatus}` +
        (obs ? ` (실측 풍속 ${obs.wind ?? '-'} m/s · 파고 ${obs.wave ?? '-'} m)` : ''),
      detail: reasons || [],
    });
  }

  // 3) 혼재(안전) — 혼재/IMDG/LLM 근거
  //
  // 근거를 반드시 함께 싣는다. 예전엔 detail: [] 고정이라 "안전 판정: 위험" 한 줄로
  // 끝났다 — 기상·스케줄링 발화는 근거를 보여주는데 안전만 비어 있어서, 정작 이
  // 시스템의 핵심인 "왜 위험한가"를 협상 로그에서 확인할 수 없었다.
  if (orchestration.risk_level) {
    // [2026-09-29] IMDG 참고는 한 줄로 묶는다. 이웃 선석마다 같은 화물이 되풀이돼(가솔린 ×4 등)
    //   체크리스트가 참고 줄 26개에 묻혔다. 판정에 쓰지 않는 값이라 이웃 화물 이름만 모은다.
    const imdgNames = [...new Set((orchestration.safety_imdg_reference || []).map((t) => t.split(':')[0]))];
    const imdgRef = imdgNames.length
      ? [`[참고 · 판정 미반영] IMDG 격리코드 해당 이웃 화물 ${imdgNames.length}종(${imdgNames.join(', ')}) — 선내 적부 기준이라 부두 간 배치에는 적용되지 않습니다`]
      : [];
    // [2026-08-23] 판정 근거를 먼저, 참고 정보는 맨 뒤에 접두사를 붙여 싣는다.
    // 예전엔 IMDG 격리코드가 목록 맨 위에 선석 이름과 붙어 나와, 부두 간 배치가
    // 규정을 위반한 것처럼 읽혔다(IMDG는 단일 선박 내 적부 기준이라 부두 간에는
    // 적용 대상이 아니다 — useOnsanApi.safety_imdg_reference 주석 참고).
    const detail = [
      ...(orchestration.safety_conflicts || []),
      ...(orchestration.safety_bulk || []),
      ...(orchestration.safety_unassessed || []),
      ...(orchestration.safety_hazards?.length
        ? [`주요 위험성: ${orchestration.safety_hazards.join(' · ')}`] : []),
      ...imdgRef,
    ];
    // [2026-09-25] 한 배가 여러 화물을 실으면 화물마다 판정하고 가장 위험한 쪽이
    // 대표 등급이 된다. 어느 화물 때문에 이 등급인지를 맨 앞에 보여준다.
    const verdicts = orchestration.safety_cargo_verdicts || [];
    // [2026-09-29] 모든 화물이 같은 등급이면 한 번만 말한다 — 이웃 질산 하나 때문에 탄화수소 6종이
    //   전부 배정불가일 때 "케로젠 배정불가 · 가솔린 배정불가 · …"가 같은 말을 6번 했다(사용자 지적).
    const sameLevel = verdicts.length > 1 && verdicts.every((v) => v.risk_level === verdicts[0].risk_level);
    const verdictLine = verdicts.length <= 1 ? []
      : sameLevel ? [`화물 ${verdicts.length}종 모두 ${verdicts[0].risk_level}${verdicts[0].risk_level === '안전' ? '' : ' — 원인은 아래 충돌'}`]
      : [`화물 ${verdicts.length}종 판정: ${verdicts.map(
        (v) => `${v.target_cargo_name} ${v.risk_level}${v.is_governing ? '(대표)' : ''}`,
      ).join(' · ')}`];
    // [2026-09-28] 같은 선박 화물끼리의 혼재 충돌. 인접 충돌이 없어도 이것 때문에 '주의'일 수 있다.
    const onboardLines = (orchestration.safety_onboard || []).map(
      (t) => `[같은 선박] ${t} — 격리 적재 확인 필요`
    );
    // [2026-09-29] 등급의 근거는 백엔드가 코드로 만든 혼재 의견(verdict_basis)만 싣는다. 예전엔
    // LLM 서술(300자 안팎)이 근거 목록에 섞여, 등급의 원인을 화물 유해성으로 잘못 설명했다
    // ("발암성 때문에 주의"). 화물 특성·유해성·체크리스트는 참고라 접어 둔다.
    const segregation = opinionOf(orchestration, '혼재');
    // [2026-09-29] 전문·특성·유해성·체크리스트는 안전이 아닌 화물들로, 모두 안전이면 전 화물을 묶어
    //   만든다(백엔드 _focus). 화물 특성(LLM)은 화물이 하나일 때만 온다.
    const fold = [
      ...(orchestration.safety_profile ? [orchestration.safety_profile] : []),
      // 주요 위험성은 아래 hazardLines 로 따로 둔다 — 2줄 이하면 펼치고, 그보다 길면 별도로 접는다.
      ...(orchestration.safety_checklist || []).map((c) => `☐ ${c}`),
      ...imdgRef,
    ];
    msgs.push({
      agent: 'safety', time: at(6),
      text: `혼재 판정: ${orchestration.risk_level}`,
      detail: segregation
        ? [...verdictLine, ...segregation.evidence]
        : [
          ...verdictLine,
          ...onboardLines,
          ...(detail.length ? detail : ['인접 선석 화물과 혼재금지 충돌 없음']),
        ],
      fold: segregation ? fold : [],
      // 체크리스트·전문 제목에는 물질 이름을 넣지 않는다 — 화물이 여러 종이면 제목이 이름 나열이 됐다(사용자 요청 9/29).
      foldLabel: '화물 특성·체크리스트',
      // [2026-09-29] 주요 위험성은 백엔드가 MSDS GHS 분류로 만든 줄이다(여러 화물이면 항목마다 물질명).
      //   한 줄에 ' · '로 이으면 항목 안의 '·'와 섞여 읽히지 않아 줄마다 나눈다.
      hazardLines: orchestration.safety_hazards?.length ? orchestration.safety_hazards : null,
      // [2026-09-29] 판단 사유 전문 — 코드가 만든 검사 사실 + 화물 특성(LLM). 등급 원인을 LLM 이 쓰던 예전
      //   서술(9/29 이전)이 아니라서 다시 둔다. 근거·특성과 겹치므로 접어 둔다.
      longText: orchestration.safety_reasoning || null,
      longTextLabel: '판단 사유 전문',
    });
  }

  // 3.5 에서 먼저 쓰므로 여기서 선언한다 (2026-09-28: 순서 바꾸며 TDZ 오류 — 종합 판정 시 화면 전체가 꺼졌음)
  const rejected = orchestration.rejected_candidates || [];

  // 3.5) 후보가 없어 안전 심사까지 가지 못한 경우.
  //
  // 안전 에이전트가 "왜 조용한지"를 화면이 말하지 않으면, 관제사에게는 세 에이전트
  // 협업이라는 구조 자체가 보이지 않는다("안전은 안 돌았나?"는 질문이 실제로 나왔다,
  // 2026-08-21). 안전 심사는 구체적 선석이 정해진 뒤에야 그 선석의 인접 화물로
  // 실행되므로, 생략된 이유를 안전 에이전트의 발화로 남긴다.
  if (!orchestration.risk_level && (trace.length || rejected.length)) {
    msgs.push({
      agent: 'safety', time: at(5),
      text: '혼재 심사 생략 — 선석 또는 기상 단계에서 판정이 끝났습니다',
      detail: ['혼재 심사는 선석이 정해진 뒤 그 선석의 인접 화물 기준으로 실행됩니다.'],
    });
  }

  // 3.7) 혼재 판정으로 지금 선석이 부적합이면 — 그때만 대체 선석을 제안한다(배정 아님).
  // [2026-09-29] reason 은 혼재 근거(verdict_basis)를 '; '로 이은 문장이라, 위 혼재 심사 메시지와 같은 내용이
  //   한 덩어리로 되풀이됐다(사용자 지적). 여기서는 충돌 쌍만 줄마다 보이고 기준·근거는 혼재 심사에 맡긴다.
  if (rejected.length) {
    const pairsOf = (reason) => (reason || '').split('; ')
      .filter((t) => t.startsWith('이웃 화물 충돌: '))
      .map((t) => t.replace('이웃 화물 충돌: ', '').split(' — ')[0]);
    msgs.push({
      agent: 'scheduling', time: at(4),
      text: `혼재 판정으로 ${rejected.map((r) => r.berth_id).join(', ')}이(가) 부적합합니다 — 충돌 근거는 혼재 심사 참고`,
      detail: rejected.flatMap((r) => {
        const pairs = pairsOf(r.reason);
        return pairs.length ? pairs.map((p) => `충돌 · ${p}`) : [r.reason];
      }),
    });
  }
  const alts = orchestration.suggested_alternatives || [];
  if (alts.length || orchestration.suggestion_note) {
    msgs.push({
      agent: 'scheduling', time: at(3),
      text: alts.length
        ? `대체 선석 제안 ${alts.length}곳 — 제안이며 배정이 아닙니다`
        : `대체 선석을 제안하지 못했습니다: ${orchestration.suggestion_note}`,
      detail: alts.map((c) => `${c.wharf_name} (흘수 여유 ${c.draught_margin_m?.toFixed(2)} m · ${c.occupancy_status})`),
    });
  }

  // 4) 종합
  // [2026-09-28] 에이전트마다 무엇을 확인했고 무엇을 못 봤는지, 어떤 자료를 썼는지 붙인다(백엔드 opinions).
  const byAxis = Object.fromEntries((orchestration.opinions || []).map((o) => [o.axis, o]));
  const AXIS_OF = { scheduling: '선석', weather: '기상', safety: '혼재' };
  const ws = orchestration.weather_source;
  const bf = orchestration.berth_facts;
  const SOURCE = {
    scheduling: `선석 제원${bf?.depth_m != null ? ` 수심 ${bf.depth_m} m` : ''} · 국립해양조사원 조석예보 · 이웃 선석 재항 화물`,
    weather: ws ? `기상청 ${ws.station || ''} 관측 · 단기예보 ${ws.forecast_points ?? '-'}개 시각 · ${!ws.berth_group || /GLOBAL_DEFAULT/.test(ws.berth_group) ? '공통 기준(부두 기준 없음)' : `${ws.berth_group} 기준`}${ws.stop_wind ? `(중단 ${ws.stop_wind} m/s)` : ''}` : null,
    safety: `MSDS ${orchestration.msds_sections_used?.length || 0}개 절 · 46 CFR 150 호환성 그룹 · 혼재금지 규칙`,
  };
  const seen = new Set();
  for (const m of msgs) {
    if (!AXIS_OF[m.agent] || seen.has(m.agent)) continue;
    seen.add(m.agent);
    const o = byAxis[AXIS_OF[m.agent]];
    if (o) { m.level = o.level; m.checked = o.checked || []; m.notes = o.notes || []; }
    m.source = SOURCE[m.agent];
  }

  // 종합 — 등급(백엔드 level)과 LLM 이 정리한 문장, 그리고 관제사가 챙길 것(확인 필요·조건).
  // [2026-09-29] '확인 필요'는 LLM 문장과 별개로 항상 코드가 보여준다 — 모델이 빠뜨려도 사라지지 않게.
  msgs.push({
    agent: 'orchestrator', time: at(1),
    text: orchestration.summary || `${orchestration.decision_label || orchestration.status}`,
    detail: (orchestration.conditions || []).map((c) => `조건: ${c}`),
    checks: orchestration.needs_check || [],
    verdict: orchestration.status,
    verdictLabel: decisionKo(orchestration.decision_label),
    axes: (orchestration.opinions || []).map((o) => ({ axis: o.axis, level: o.level })),
    missingAny: orchestration.evidence_missing,
  });
  return msgs;
}

// 관제사가 자주 묻는 질문 — 빈 화면 대신 바로 눌러볼 수 있게 둔다
const SUGGESTED = [
  '벤젠 취급 시 착용해야 할 보호구는?',
  '메탄올이 누출되면 어떻게 대처하나요?',
  '황산은 어떤 물질과 함께 두면 안 되나요?',
  '톨루엔 인화점이 몇 도인가요?',
];

/**
 * 배정현황이 지목한 화물로 판정 대상의 화물을 맞춘다.
 *
 * 한 배는 후보 선석마다 다른 화물 행을 갖는다(mart.berth_current_cargo 가 선석별
 * 취급화물로 만들어지기 때문). 어댑터는 그 중 첫 행을 집는데 그게 이 배정의 선석이라는
 * 보장이 없어, 표에는 톨루엔·콘솔에는 메틸 알코올이 뜨고 안전 판정이 엉뚱한 물질로
 * 돌아간다(2026-08-24 실측: 승인 대기 5건 중 4건).
 *
 * chem_id 가 같은 원본 행을 찾아 통째로 쓴다 — CAS·UN번호·IMDG 등급이 한 물질에서
 * 같이 와야 판정 근거가 어긋나지 않는다. 못 찾으면 대상을 건드리지 않는다(이름만
 * 바꿔 놓으면 화면과 판정이 또 어긋난다).
 */
function withRequestedCargo(vessel, wanted, berthCargo) {
  if (!wanted?.chem_id || !vessel?.callsgn) return vessel;
  const cs = vessel.callsgn.trim().toUpperCase();
  const row = berthCargo.find(
    (c) => c.chem_id === wanted.chem_id
      && (c.callsgn || '').trim().toUpperCase() === cs,
  );
  if (!row) return vessel;
  return { ...vessel, cargo: { ...row, name: row.cargo_name ?? wanted.name } };
}

/**
 * 이 배의 확인 대기 판정 id. 없으면 null.
 *
 * 호출부호로만 찾는다 — /approvals/pending 은 이미 확인되지 않은 건만 주므로
 * 추가 조건이 필요 없다. 같은 배의 판정이 여럿이면 가장 최근 것을 쓴다(응답이
 * assessed_at_utc 내림차순이라 첫 건이 그것이다).
 *
 * 조회 실패를 throw 하지 않는다 — 확인할 건을 못 찾는 것은 판정 자체를 막을
 * 이유가 아니다. 그때는 '판정 기록'만 보여주면 된다.
 */
async function findPendingAssessmentId(callsgn) {
  if (!callsgn) return null;
  try {
    // includeFit — 배 한 척을 지목해 찾는 자리라 '적합'도 포함해야 한다.
    // 기본값으로 부르면 적합 판정이 빠져서, 조건에 맞는 배는 확인 버튼이
    // 영영 안 뜬다(실측: 적합 판정 DSPH2 가 대기 목록에 없었다).
    const pending = await fetchPendingApprovals({ includeFit: true });
    return pending.find((p) => p.call_sign === callsgn)?.id ?? null;
  } catch {
    return null;
  }
}

export default function AgentConsole({ mode = 'qa' }) {
  // 3D 관제 화면에서는 띄우지 않는다 — 전체화면 연출과 HUD 를 가린다
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('negotiation'); // negotiation | qa
  const [loading, setLoading] = useState(false);
  // 관제사 최종 결정 — null(미결정) | 'APPROVED' | 'REJECTED'.
  //
  // 예전엔 boolean 이라 "반려" 버튼이 setApproved(false) 였는데, 그 버튼이 보이는
  // 조건 자체가 approved === false 여서 눌러도 아무 변화가 없었다(이미 false).
  // [2026-09-22] 승인/반려를 없애고 **확인(피드백)** 하나로 바꿨다.
  //
  // 우리는 선석을 배정하지 않는다. 배정하지 않으면 승인할 대상도 반려할 대상도
  // 없다 — 우리가 내는 건 요청이 아니라 의견이기 때문이다. 옛 경로 셋
  // (/approvals/{id}/decision · /orchestrator/assess-and-commit ·
  //  /orchestrator/reject)은 백엔드에서 전부 없어졌다(실측 404).
  //
  // 남는 동작은 둘이다.
  //   판정 기록  이 배가 지금 있는 자리가 조건에 맞는지 판정해 이력에 남긴다.
  //   확인       관제사가 그 판정을 봤다는 사실을 남긴다. 동의하지 않으면 의견을
  //              함께 적는다 — 그게 다음 판정 규칙을 고칠 근거가 된다.
  // 어느 쪽도 자리를 잠그지 않는다.
  const [ackState, setAckState] = useState(null);      // null | 'RECORDED' | 'ACKNOWLEDGED'
  const [assessmentId, setAssessmentId] = useState(null);
  const [assessmentChecked, setAssessmentChecked] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState(null);
  // 관제사 의견 — 판정에 동의하지 않을 때 적는다. 비어 있어도 확인은 된다.
  const [ackNote, setAckNote] = useState('');
  // 조회 전용(공개 배포본) 때문에 막힌 것인지 — 문구 색을 가르는 근거
  const [decisionReadOnly, setDecisionReadOnly] = useState(false);
  const { orchestrate, assessBerthWeather, ragQuery } = useOnsanApi();
  const setOrchestration = useSensorStore((s) => s.setOrchestration);
  const setBerthWeather = useSensorStore((s) => s.setBerthWeather);

  // 질의응답 탭 상태
  const [question, setQuestion] = useState('');
  const [qaLog, setQaLog] = useState([]);
  const [qaLoading, setQaLoading] = useState(false);
  const qaEndRef = useRef(null);
  const orchestration = useSensorStore((s) => s.orchestration);
  const berthWeather = useSensorStore((s) => s.berthWeather);
  const selectedVessel = useSensorStore((s) => s.selectedVessel);
  const { data } = useDashboardData();
  // VesselDetailPanel(선박 목록/지도 클릭 시 뜨는 우측 상세 패널, width 390px)도
  // 이 콘솔처럼 항상 화면 오른쪽에 고정이라, 배를 하나 고르면 그 패널이 이 콘솔의
  // 플로팅 버튼 위에 그대로 겹쳐 떴다(실사용 중 발견, 2026-08-20). 왼쪽으로
  // 비키는 대신 — 콘솔이 접혀 있을 때(!open)는 상세 패널이 열려 있는 동안 버튼
  // 자체를 숨긴다. 이미 펼쳐서 보던 중이면(open) 유지한다 — 관제사가 협상 로그를
  // 보면서 배 상세도 같이 보고 싶을 수 있어, 그건 강제로 닫지 않는다.
  const hideFloatingButton = !open && Boolean(selectedVessel);

  // 이 콘솔 안에서만 쓰는 선택 상태. 전역 selectedVessel(지도/입항목록 클릭)을
  // setSelectedVessel로 되돌려 쓰지 않는다 — 그러면 VesselDetailPanel이 selectedVessel
  // 하나만 보고 뜨는 조건이라, 콘솔 드롭박스에서 선박만 골라도 그 큰 상세 패널이
  // 뒤에서 같이 열려버렸다(지도/목록 클릭 때와 똑같은 조건을 공유해서 생긴 부작용).
  const [localTarget, setLocalTarget] = useState(null);
  const consoleRequest = useSensorStore((st) => st.consoleRequest);
  const clearConsoleRequest = useSensorStore((st) => st.clearConsoleRequest);
  // [2026-09-29 밤] 혼재 단계 → 화물 혼재 심사 화면(같은 혼재 에이전트, 같은 입력)으로 이어 준다
  const requestThreadFocus = useSensorStore((st) => st.requestThreadFocus);

  // 판정 대상: 실AIS + berth-cargo(실 신고 위험물) 조인 결과를 우선 쓰고,
  // DB에 재항 위험물 신고가 하나도 없을 때만(로컬 mock-server 등) 데모 시나리오로 대체한다.
  const realCargoVessels = useMemo(
    // 입항 건 화물이 확인된 액체화물선만 판정 대상. 선종 추정 화물은 없앴다(2026-09-25).
    () => (data?.real_traffic ?? []).filter((v) => v.is_liquid_cargo_vessel && v.cargo),
    [data]
  );
  // 폴백 없음 — 실화물이 확인된 배만 판정 대상으로 둔다.
  // mock 데모 선박으로 대체하면 실제로 없는 배를 판정하게 된다.
  const vessels = realCargoVessels;
  // 승인 대기 건이 지목한 배가 화면 목록에 없을 수 있다(AIS 신호 끊김 —
  // 어댑터 offscreenJudgeable 주석 참고). 그 배만 예외로 찾아 쓴다.
  const offscreen = data?.offscreen_judgeable ?? [];
  // 우선순위: 콘솔에서 직접 고른 선박 > 지도/목록에서 클릭한 선박(전역) > 첫 번째 후보
  // localTarget 이 화면 목록에 없어도(신호 끊긴 승인 대기 배) 유효한 대상으로 둔다 —
  // 예전엔 목록 멤버십을 요구해서, 그런 배를 지목하면 조용히 첫 배로 되돌아갔다.
  // [2026-09-28] 대상은 [근거]로만 정한다. 예전엔 드롭다운 + [종합 판정]이 있어 선박 판정 화면의
  // [판정 요청]과 같은 엔진을 두 번째 입구로 돌렸고(기록은 안 남김), 그래서 [판정 기록]이 또
  // 필요했다(현우: "판정 요청과 판단 과정의 차이를 모르겠다"). 실행은 [판정 요청] 한 곳이다.
  const target = localTarget;
  // 이력에 남은 판정 — 표의 행이 실어 보낸다. 창 맨 위에 그대로 보인다.
  const [recorded, setRecorded] = useState(null);
  const navigate = useNavigate();

  // 배정현황의 "협상 로그 →" 클릭을 받는다 — 그 배를 대상으로 콘솔을 연다.
  // 실제 판정 대상 목록(vessels)에서 호출부호로 찾은 실선박만 지정한다.
  // 목록에 없으면(화물·선종 모두 미확인) 대상 지정 없이 열기만 한다 —
  // 가짜 항목을 만들어 채우지 않는다.
  useEffect(() => {
    if (mode !== 'reasoning' || !consoleRequest) return;
    const want = (consoleRequest.callsgn || '').trim().toUpperCase();
    const match = (v) => v.callsgn && v.callsgn.trim().toUpperCase() === want;
    // 화면 목록 우선, 없으면 신호 끊긴 판정 대상에서 찾는다.
    const hit = vessels.find(match) || offscreen.find(match);
    const sub = consoleRequest.subject;
    if (sub) {
      // 표의 행이 판정에 쓴 값(PORT-MIS 사전배정 계류시설 또는 위치 판정 선석 · 흘수 · 화물)을 그대로 쓴다.
      // 선박위치 목록에 있으면 그 배를 바탕으로, 없으면(입항 전) 행 값만으로 대상을 만든다.
      const base = hit ? withRequestedCargo(hit, consoleRequest.cargo, data?.berth_cargo ?? []) : {};
      const t = {
        ...base,
        port_call_id: `req:${want}:${sub.wharf || ''}`,
        vessel_name: sub.vessel_name || base.vessel_name,
        callsgn: base.callsgn || consoleRequest.callsgn,
        presence_berth_name: sub.wharf || base.presence_berth_name || null,
        // 행이 넘긴 계류시설의 출처. 없으면 위치 판정(AIS) 부두다.
        target_source: sub.wharf ? (sub.source || 'AIS') : 'AIS',
        berth: sub.wharf || base.berth || null,
        draught_m: Number(sub.draught_m) > 0 ? Number(sub.draught_m) : (base.draught_m ?? null),
        cargo: base.cargo || sub.cargo || null,
        cargos: base.cargos?.length ? base.cargos : (sub.cargos || []),
      };
      setLocalTarget(t);
      setRecorded(consoleRequest.record || null);
      setTab('negotiation');
      setOpen(true);
      clearConsoleRequest();
      run(t);
      return;
    }
    setRecorded(consoleRequest.record || null);
    if (hit) {
      // 배정현황이 보여준 화물이 있으면 그것으로 판정한다.
      //
      // 한 배가 후보 선석마다 다른 화물 행을 갖는다(mart.berth_current_cargo 는
      // 선석별 취급화물로 만들어진다). 어댑터는 그 중 첫 행을 집는데, 그 선석이
      // 이 배정의 선석이라는 보장이 없다 — 표에는 톨루엔, 콘솔에는 메틸 알코올이
      // 뜨고 안전 판정이 엉뚱한 물질로 돌아간다(2026-08-24 실측 4/5건).
      //
      // 화면이 보여준 화물과 판정에 들어간 화물은 같아야 한다.
      // 판정은 CAS 로 MSDS·혼재규정을 찾는다. chem_id 만 갈아끼우고 CAS 를 그대로
      // 두면 물질과 근거가 어긋나므로, 화물 원본 행을 통째로 찾아 쓴다.
      setLocalTarget(withRequestedCargo(hit, consoleRequest.cargo, data?.berth_cargo ?? []));
    }
    setTab('negotiation');
    setOpen(true);
    clearConsoleRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleRequest, vessels]);

  // [2026-08-23] 대상 선박이 바뀌면 이전 배의 판정 로그를 비운다.
  // 드롭다운에서 다른 배를 고르면 화면의 배 이름만 바뀌고 아래 판정 내용은
  // 이전 배 것이 그대로 남아 있었다 — 판정을 다시 누르기 전까지 둘이 섞여 보인다.
  const shownTargetId = useRef(null);
  useEffect(() => {
    const id = target?.port_call_id ?? null;
    if (shownTargetId.current !== null && shownTargetId.current !== id) {
      setOrchestration(null);
      setBerthWeather(null);
      // [2026-09-22] setDecision · setApprovalId · setApprovalChecked 를 지금
      // 이름으로 바꿨다. 셋 다 23871ff("승인/반려를 없애고 판정 확인으로")에서
      // 상태를 갈아끼울 때 이 이펙트만 빠뜨린 자리라, **선언된 적 없는 함수**를
      // 부르고 있었다 — ReferenceError: setDecision is not defined.
      //
      // 이 조건은 첫 마운트에는 안 탄다(shownTargetId.current === null). 대상이
      // 한 번 정해진 뒤 **바뀔 때** 처음 터진다. 그 순간이 곧:
      //   · 드롭다운에서 다른 배를 고를 때
      //   · 배정현황 목록의 "판단 과정 로그 →" 가 다른 배를 지목할 때
      //   · 종합 판정이 도는 5~10초 사이 대시보드 폴링이 갱신돼 vessels[0]
      //     (기본 대상)이 바뀔 때 — 사용자가 아무것도 안 눌러도 바뀐다
      // 이고, 이펙트 안에서 던진 예외라 아무도 잡지 않는다. AgentConsole 은
      // Routes 밖(App.jsx)에 있어서 React 가 트리 **전체**를 언마운트한다 —
      // 주소는 그대로인데 화면만 백지가 되는 게 이것이다(실측 재현).
      setAckState(null);
      setAssessmentId(null);
      setAssessmentChecked(false);
      setAckNote('');
      setDecisionError(null);
      setDecisionReadOnly(false);
    }
    shownTargetId.current = id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.port_call_id]);

  const setReasoningFocus = useSensorStore((st) => st.setReasoningFocus);
  const setReasoningOpen = useSensorStore((st) => st.setReasoningOpen);
  const reasoningOpen = useSensorStore((st) => st.reasoningOpen);
  // 서랍이 닫히면 진행 표시도 끈다
  useEffect(() => {
    if (mode !== 'reasoning') return;
    setReasoningOpen(open);
    if (!open) setReasoningFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 질의응답의 화물 맥락 — 지금 고른 배의 화물. 사용자가 빼면 쓰지 않는다.
  const [qaCargoOff, setQaCargoOff] = useState(false);
  const qaCargo = qaCargoOff ? null : (target?.cargo?.name || selectedVessel?.cargo?.name || null);

  const demo = useDemoCargo();
  const demoAround = demo.around(target?.callsgn, target?.presence_berth_name ?? null);

  const messages = useMemo(
    () => toMessages({ orchestration, berthWeather, vessel: target }),
    [orchestration, berthWeather, target]
  );
  // [2026-09-28] 판정은 서버가 한 번에 계산해 돌려준다. 받은 결과를 실제 판단 순서(선석 → 기상 → 혼재 → 종합)대로
  // 하나씩 펼쳐 보인다 — 결과를 바꾸지 않고 보여주는 순서만 정한다.
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (!messages.length) { setRevealed(0); return undefined; }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setRevealed(messages.length); return undefined; }
    let i = 1;
    setRevealed(1);
    const id = setInterval(() => { i += 1; setRevealed(i); if (i >= messages.length) clearInterval(id); }, 550);
    return () => clearInterval(id);
  }, [messages]);
  const shownMessages = messages.slice(0, revealed);

  // 한 번의 실행으로 선석 → 기상 → 혼재 → 종합을 순차 수행(백엔드 감독자).
  //
  // [2026-09-27] 배가 실제로 붙은 부두(presence_berth_name)를 검증한다 — 판정 잡·'판정 기록'
  // 버튼과 같은 질문("이 자리가 맞나")이다. 예전엔 항상 탐색모드(top-3 새 추천)로 불러,
  // 실측 43척 중 42척에 기록된 판정과 다른 답(다른 선석 추천·'적합 선석 없음')을 보였다.
  // 접안 전인 배는 여기서 판정하지 않는다 — 이 목록의 facility_name 은 하루 늦은 VTS
  // 이력이라 믿을 수 없고, 사전 검토는 판정 잡이 PORT-MIS 신고 선석으로 한다.
  const run = async (t = target) => {
    if (!t) return;
    setLoading(true);
    if (mode === 'reasoning') setReasoningFocus({ callsgn: t.callsgn, loading: true });
    setAckState(null);   // 새로 판정하면 이전 확인은 무효다
    setAssessmentId(null);
    setAssessmentChecked(false);
    setAckNote('');
    setDecisionError(null);
    // [2026-08-23] 이전 판정 로그도 함께 비운다.
    //
    // 예전엔 decision/approvalId만 지우고 orchestration·berthWeather는 그대로
    // 뒀다. messages는 orchestration에서 만들어지므로, 판정이 도는 5~8초 동안
    // **직전 결과가 그대로 떠 있었다**. 게다가 toMessages는 vessel로 지금 선택된
    // 배를 받으므로, 배를 바꾸고 판정을 누르면 "새 배 이름 + 이전 배의 판정"이
    // 섞여 보였다 — 관제사가 그걸 새 결과로 읽으면 잘못된 배에 승인을 누른다.
    setOrchestration(null);
    setBerthWeather(null);
    try {
      const berthId = findBerthIdByName(t.berth);
      const group = berthId ? ONSAN_WEATHER_GROUP[berthId] : null;
      if (group) await assessBerthWeather({ berthGroup: group });
      await orchestrate({
        cargoName: t.cargo?.name,
        casNo: t.cargo?.cas_no,
        chemId: t.cargo?.chem_id ?? null,
        dwt: null, // 실AIS 위치 데이터엔 DWT가 없음 — 미상으로 보내 오케스트레이터가 보수적으로 판단하게 함
        draught: t.draught_m ?? undefined,
        vesselName: t.vessel_name,
        callSign: t.callsgn,
        assignedWharfName: t.presence_berth_name ?? null,
        targetSource: t.target_source ?? 'AIS',
        // 같은 입항 건의 나머지 화물
        extraCargos: t.cargos ?? [],
      });
      // orchestrate()는 매번 새로 계산하는 상태없는 판단이라 아무것도 기록하지
      // 않는다. arrival_watcher(10분 주기 배경 잡)가 같은 배를 이미 판정해 뒀으면
      // 그 행을 확인하면 되고, 없으면 여기서 '판정 기록'을 눌러 만든다.
      //
      // [2026-09-22] kind 로 걸러 찾던 것을 호출부호만으로 바꿨다.
      //   /approvals/pending 응답에 kind 필드가 없다(실측 — id · call_sign ·
      //   vessel_name · stage · wharf_name · level · action · recipient ·
      //   reasons · changed_from · assessed_at_utc). 없는 필드로 걸렀으니
      //   match 가 늘 undefined 였고, 확인할 수 있는 건이 있어도 못 찾았다.
      setAssessmentId(await findPendingAssessmentId(t.callsgn));
      setAssessmentChecked(true);
    } finally {
      setLoading(false);
      if (mode === 'reasoning') setReasoningFocus({ callsgn: t.callsgn, loading: false });
    }
  };

  // 이 배가 지금 붙어 있는 선석. 판정을 기록하려면 "어느 자리에 대한 판정인가"가
  // 있어야 하는데(백엔드가 assigned_wharf_name 없으면 400), 그 답은 위치 판정이
  // 준다 — /vessels 의 presence_berth_name. 화면이 스스로 추정하지 않는다.
  const berthNow = target?.presence_berth_name ?? null;


  // 관제사가 이 판정을 봤다는 사실을 남긴다. 의견이 있으면 함께 적는다.
  const acknowledge = async () => {
    if (decisionBusy || !assessmentId) return;
    setDecisionBusy(true);
    setDecisionError(null);
    setDecisionReadOnly(false);
    try {
      await postAcknowledgement(assessmentId, {
        acknowledgedBy: OPERATOR_NAME,
        note: ackNote.trim() || null,
      });
      setAckState('ACKNOWLEDGED');
    } catch (e) {
      setDecisionError(e.message);
      setDecisionReadOnly(Boolean(e.readOnly));
    } finally {
      setDecisionBusy(false);
    }
  };

  const ask = async (text) => {
    const q = (text ?? question).trim();
    if (!q || qaLoading) return;
    setQuestion('');
    setQaLog((prev) => [...prev, { role: 'user', text: q }]);
    setQaLoading(true);
    try {
      // cargo_hint 는 질문이 물질을 스스로 지목하지 않을 때만 붙인다.
      // "이 선박 화물의 보호구는?" 처럼 화면 맥락에 기대는 질문에는 도움이 되지만,
      // "황산과 벤젠을 같이 둬도 되나?" 처럼 물질이 문장에 있는 질문에 선택 선박의
      // 화물을 끼워 넣으면 엉뚱한 물질로 해석될 수 있다.
      const mentionsChemical = /[가-힣A-Za-z]{2,}/.test(q) && namesAnyCargo(q);
      const res = await ragQuery({
        question: q,
        cargoHint: mentionsChemical ? null : qaCargo,
      });
      setQaLog((prev) => [...prev, { role: 'agent', ...res }]);
    } catch (err) {
      setQaLog((prev) => [...prev, {
        role: 'agent', answer: `조회 중 오류가 발생했습니다: ${err.message}`,
        citations: [], is_local_fallback: true,
      }]);
    } finally {
      setQaLoading(false);
      setTimeout(() => qaEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  if (pathname.startsWith('/twin')) return null;

  if (!open) {
    if (mode === 'reasoning') return null;
    if (hideFloatingButton || reasoningOpen) return null;
    return (
      <button
        onClick={() => setOpen(true)}
        title="화물 안전 규정을 물어보면 MSDS 원문·규정에서 찾아 출처와 함께 답합니다"
        style={{
          position: 'fixed', right: 22, bottom: 22, zIndex: 3000,
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '12px 18px', borderRadius: 26, cursor: 'pointer',
          background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.tealDark})`,
          color: '#FFFFFF', border: 'none', fontWeight: 800, fontSize: 14,
          boxShadow: '0 6px 22px rgba(0,0,0,0.45)',
        }}
      >
        <FaBookOpen /> 화물 규정 질의응답
      </button>
    );
  }

  const drawer = mode === 'reasoning';
  return (
    <div style={{
      ...(drawer
        ? { position: 'fixed', top: 0, right: 0, height: '100vh', width: 470, maxWidth: '100vw', zIndex: 3000, borderRadius: 0 }
        : { position: 'fixed', right: 22, bottom: 22, zIndex: 3000, width: 460, maxWidth: 'calc(100vw - 44px)', height: 640, maxHeight: 'calc(100vh - 120px)' }),
      display: 'flex', flexDirection: 'column',
      // 라이트 통일 — 어두운 바탕은 라이트 팔레트 글자색과 만나 글자가 안 보였다
      background: COLORS.panel, border: `1px solid ${COLORS.border}`,
      ...(drawer ? {} : { borderRadius: 14 }), boxShadow: '0 10px 40px rgba(18,53,79,0.22)', overflow: 'hidden',
    }}>
      {/* 헤더 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '11px 14px', borderBottom: `1px solid ${COLORS.glassBorder}`,
        background: COLORS.cardHover,
      }}>
        {drawer ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textPrimary, fontWeight: 800 }}>
            <FaRobot color={COLORS.teal} /> 판정 근거 · 에이전트 판단 과정
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textPrimary, fontWeight: 800 }}>
              <FaBookOpen color={COLORS.teal} /> 화물 규정 질의응답
            </div>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>MSDS 원문 · 46 CFR 호환성 · 혼재금지 규칙에서 찾아 출처와 함께 답합니다</div>
          </div>
        )}
        <button
          onClick={() => setOpen(false)}
          aria-label="닫기"
          title="닫기"
          style={{
            background: 'none', border: 'none', color: COLORS.textDim, cursor: 'pointer', fontSize: 15,
          }}
        ><FaTimes /></button>
      </div>

      {!drawer ? (
        <QaPanel
          log={qaLog} loading={qaLoading} question={question}
          setQuestion={setQuestion} ask={ask} endRef={qaEndRef}
          cargoHint={qaCargo} onClearCargo={() => setQaCargoOff(true)}
          onNew={() => { setQaLog([]); setQaCargoOff(false); }}
        />
      ) : (
      <>
      {/* 대상 + 이력에 남은 판정. [2026-09-28] 실행 버튼 없음 — 선박 판정 화면의 [근거]로 연다. */}
      {target && (
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${COLORS.glassBorder}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 13.5, color: COLORS.textPrimary }}>{target.vessel_name || target.callsgn}</div>
              <div style={{ fontSize: 11.5, color: COLORS.textDim }}>
                {berthNow || '선석 미확인'} · {cargoSummary(target.cargos?.length ? target.cargos : [target.cargo].filter(Boolean)) || '화물 미확인'}
                {target.draught_m ? ` · 흘수 ${target.draught_m} m` : ''}
              </div>
              {showDisclosure() && demoAround.any && (
                <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 4, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <DemoChip derived={!demoAround.own.length} entries={[...demoAround.own, ...demoAround.near]} />
                  <span>
                    {[...new Set([...demoAround.own, ...demoAround.near].map((e) => `${e.cargo_name}${e.wharf ? `(${e.wharf})` : ''}`))].join(', ')}
                    {' '}— 시연을 위해 넣은 화물입니다
                  </span>
                </div>
              )}
            </div>
            {loading && (
              <span style={{ color: COLORS.info, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <FaSpinner className="spin" /> 판단 중
              </span>
            )}
          </div>
          {recorded && (
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: COLORS.textDim, fontWeight: 700 }}>기록된 판정</span>
                <span style={{ color: LEVEL_COLOR[recorded.level] ?? COLORS.textPrimary, fontWeight: 800 }}>{recorded.level}</span>
                {recorded.stage && <span style={{ color: COLORS.textDim }}>· {STAGE_TEXT[recorded.stage] ?? recorded.stage}</span>}
                {recorded.assessed_at_utc && <span style={{ color: COLORS.textDim }}>· {kstShort(recorded.assessed_at_utc)}</span>}
                {recorded.acknowledged_by && <span style={{ color: COLORS.teal, fontWeight: 700 }}>· 확인 {recorded.acknowledged_by}</span>}
              </div>
              {gateOfBerth(berthNow) && (
                <button
                  type="button"
                  onClick={() => navigate('/sensors')}
                  title="이 부두에는 실물 하역 개시 게이트가 있습니다. 하역 중 판정이 부적합·판정불가이거나 부두 기상이 정상이 아니면 잠깁니다."
                  style={{ marginTop: 5, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: '2px 8px', fontSize: 11.5, color: COLORS.navy, fontWeight: 700, cursor: 'pointer' }}
                >
                  하역 개시 게이트 {gateOfBerth(berthNow)} 보기 →
                </button>
              )}
              {recorded.action && recorded.level !== '적합' && (
                <div style={{ marginTop: 3, color: COLORS.textSecondary }}>
                  조치안 {recorded.action}{recorded.recipient ? <> → <strong>{recorded.recipient}</strong></> : null}
                </div>
              )}
            </div>
          )}
          {recorded && (
            <div style={{ fontSize: 11, color: COLORS.textDim }}>
              아래는 같은 선석·흘수·화물을 지금 자료로 다시 판단한 과정입니다. 기상·조위가 기록 시각과 다르면 결론이 다를 수 있습니다.
            </div>
          )}
        </div>
      )}

      {/* 에이전트 단계 — 판단 중에는 깜빡이고, 결과가 오면 판단 순서대로 켜진다 */}
      {target && (
        <div
          title="판정은 서버가 한 번에 계산합니다. 받은 결과를 실제 판단 순서대로 펼쳐 보입니다."
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderBottom: `1px solid ${COLORS.glassBorder}`, flexWrap: 'wrap' }}
        >
          {['scheduling', 'weather', 'safety', 'orchestrator'].map((k, idx) => {
            const a = AGENTS[k];
            const hit = shownMessages.find((x) => x.agent === k);
            const lv = k === 'orchestrator' ? (hit ? decisionLevel(orchestration?.decision_label) || orchestration?.decision_label : null) : hit?.level;
            const on = Boolean(hit);
            const c = on ? (LEVEL_COLOR[lv] || a.color) : COLORS.textDim;
            return (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {idx > 0 && <span aria-hidden="true" style={{ color: COLORS.textDim, fontSize: 11 }}>→</span>}
                <span
                  className={!on && loading ? 'stage-chip-busy' : undefined}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999,
                    fontSize: 11.5, fontWeight: 800, color: on ? '#FFFFFF' : COLORS.textDim,
                    background: on ? c : 'transparent', border: `1px solid ${on ? c : COLORS.border}`,
                    boxShadow: on ? `0 0 10px ${c}66` : 'none', transition: 'all .3s',
                  }}
                >
                  {a.short}{on && lv ? ` · ${lv}` : ''}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* 대화 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: COLORS.textDim, fontSize: 13, lineHeight: 1.8, textAlign: 'center', marginTop: 40 }}>
            {loading ? '판단 중입니다 (10~20초)' : (
              <>
                <strong style={{ color: COLORS.teal }}>선박 판정</strong> 화면에서 판정 옆 <strong style={{ color: COLORS.teal }}>[근거]</strong>를 누르면<br />
                선석 → 기상 → 혼재(안전) 에이전트가 차례로 판단한<br />
                과정이 여기에 나옵니다.
              </>
            )}
          </div>
        )}
        {shownMessages.map((m, i) => {
          const a = AGENTS[m.agent];
          const Icon = a.icon;
          return (
            <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <div style={{
                background: `${a.color}22`, color: a.color, borderRadius: '50%',
                width: 30, height: 30, display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0, fontSize: 13,
              }}><Icon /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 3 }}>
                  <strong style={{ color: a.color }}>{a.name}</strong> · {a.role}
                </div>
                <div style={{
                  background: m.verdict ? `${VERDICT_COLOR[m.verdict] || COLORS.info}1f` : COLORS.cardHover,
                  border: `1px solid ${m.verdict ? (VERDICT_COLOR[m.verdict] || COLORS.info) : 'transparent'}`,
                  borderRadius: 10, padding: '9px 12px',
                  fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.55,
                }}>
                  {m.verdict && (
                    <div style={{
                      fontWeight: 800, marginBottom: 4,
                      color: VERDICT_COLOR[m.verdict] || COLORS.info,
                    }}>
                      최종 판단: {m.verdictLabel || m.verdict}
                    </div>
                  )}
                  {m.text}
                  {/* 근거가 길면 접는다 — 스케줄링 trace 는 후보·대체 탐색이 전부 실려
                      십수 줄이 되는데, 관제사가 매번 읽을 글이 아니다(정보 과부하 피드백,
                      2026-08-21). 첫 2건으로 결론의 근거를 보이고 나머지는 펼침으로. */}
                  {m.detail?.length > 0 && (m.detail.length <= 3 ? (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                      {m.detail.map((d, j) => <li key={j}>{tidyLine(d)}</li>)}
                    </ul>
                  ) : (
                    <>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                        {m.detail.slice(0, 2).map((d, j) => <li key={j}>{tidyLine(d)}</li>)}
                      </ul>
                      <details style={{ marginTop: 3 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 11.5, color: COLORS.info, fontWeight: 600 }}>
                          판단 과정 {m.detail.length - 2}건 더 보기
                        </summary>
                        <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                          {m.detail.slice(2).map((d, j) => <li key={j}>{tidyLine(d)}</li>)}
                        </ul>
                      </details>
                    </>
                  ))}
                  {/* [2026-09-29] 판정에 쓰지 않은 참고값(외해 파고 등) — '확인' 칩에 두면 확인한 근거처럼 읽혀 글로 둔다 */}
                  {m.notes?.map((t, j) => (
                    <div key={`note-${j}`} style={{ fontSize: 11.5, color: COLORS.textDim, marginTop: 5 }}>참고 · {t}</div>
                  ))}
                  {m.checked?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 7, alignItems: 'center' }}>
                      <span style={{ fontSize: 10.5, color: COLORS.textDim, fontWeight: 700 }}>확인</span>
                      {m.checked.map((c, j) => (
                        <span key={j} style={{ fontSize: 10.5, color: a.color, border: `1px solid ${a.color}55`, background: `${a.color}0f`, borderRadius: 999, padding: '1px 7px' }}>{c}</span>
                      ))}
                    </div>
                  )}
                  {/* [2026-09-29] 에이전트별 '못 본 것'은 뺐다 — 종합 카드의 '확인 필요'가 같은 항목을 모아 보여 준다
                      (백엔드 needs_check = 의견들의 missing 합). 같은 문장이 근거·못 본 것·확인 필요에 세 번 떴다. */}
                  {m.source && (
                    <div style={{ fontSize: 10.5, color: COLORS.textDim, marginTop: 5 }}>자료 · {m.source}</div>
                  )}
                  {m.axes?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8, alignItems: 'center' }}>
                      {m.axes.map((x) => (
                        <span key={x.axis} style={{ fontSize: 11, fontWeight: 800, color: LEVEL_COLOR[x.level] ?? COLORS.textSecondary, border: `1px solid ${(LEVEL_COLOR[x.level] ?? COLORS.border)}66`, borderRadius: 6, padding: '1px 7px' }}>
                          {x.axis} {x.level}
                        </span>
                      ))}
                      <span style={{ fontSize: 11, color: COLORS.textDim }}>선석 → 기상 → 혼재 순서로 보고, 앞 단계에서 걸리면 거기서 멈춥니다</span>
                    </div>
                  )}
                  {/* 판정에 쓰지 못한 근거 — 관제사가 챙길 일이라 접지 않는다 */}
                  {m.checks?.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${COLORS.glassBorder}` }}>
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: COLORS.yellow }}>확인 필요</div>
                      <ul style={{ margin: '3px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                        {m.checks.map((c, j) => <li key={j}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                  {/* 주요 위험성 — 등급 근거는 아니지만 관제사가 바로 보고 싶어 하는 정보라 짧으면 펼쳐 둔다.
                      [2026-09-29] 여러 화물이면 줄이 판정 근거보다 길어져 접는다. 접히는 참고 칸(화물 특성·
                      체크리스트, 판단 사유 전문)과 한곳에 모아 둔다 — 확인 칩 위에 따로 떨어져 있었다(사용자 요청). */}
                  {m.hazardLines && (m.hazardLines.length <= 2 ? (
                    <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 6 }}>
                      <span style={{ fontWeight: 700 }}>주요 위험성</span>
                      <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                        {m.hazardLines.map((h) => <li key={h}>{h}</li>)}
                      </ul>
                    </div>
                  ) : (
                    <details style={{ marginTop: 5 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 11.5, color: COLORS.info, fontWeight: 600 }}>
                        주요 위험성 {m.hazardLines.length}건 보기
                      </summary>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                        {m.hazardLines.map((h) => <li key={h}>{h}</li>)}
                      </ul>
                    </details>
                  ))}
                  {/* 참고 정보(화물 특성·체크리스트) — 등급의 근거가 아니라 접어 둔다 */}
                  {m.fold?.length > 0 && (
                    <details style={{ marginTop: 5 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 11.5, color: COLORS.info, fontWeight: 600 }}>
                        {m.foldLabel} 보기
                      </summary>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: COLORS.textSecondary }}>
                        {m.fold.map((d, j) => <li key={j}>{d}</li>)}
                      </ul>
                    </details>
                  )}
                  {m.longText && (
                    <details style={{ marginTop: 5 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 11.5, color: COLORS.info, fontWeight: 600 }}>{m.longTextLabel || '판단 사유 전문'}</summary>
                      <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{m.longText}</div>
                    </details>
                  )}
                  {/* 혼재 단계의 자세한 근거(화물쌍 · 규정 그래프)는 이 화면 아래 '화물 혼재' 카드가 같은 입력으로 펼친다 */}
                  {mode === 'reasoning' && m.agent === 'safety' && !/생략/.test(String(m.text)) && (
                    <button
                      type="button"
                      className="console-link"
                      onClick={() => { requestThreadFocus('cargo'); setOpen(false); }}
                    >
                      혼재 근거 자세히 →
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 관제사 확인 (Human-in-the-loop).
          [2026-09-22] '승인'이 아니라 '확인'이다 — 우리는 자리를 주지 않는다.
          판정 등급과 무관하게 보여준다. 예전엔 '승인가능'일 때만 띄웠는데, 그건
          승인할 대상이 있을 때만 버튼이 필요했기 때문이다. 지금은 부적합·주의
          판정일수록 관제사가 봤다는 기록과 의견이 더 필요하다. */}
      {orchestration && (
        <div style={{
          padding: '10px 14px', borderTop: `1px solid ${COLORS.glassBorder}`,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {/* 확인 전에는 의견을 적을 수 있다. 비워 두고 확인만 눌러도 된다 —
              동의하지 않을 때 적으라는 칸이지 필수 입력이 아니다. */}
          {ackState !== 'ACKNOWLEDGED' && assessmentId && (
            <input
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder="판정에 동의하지 않으면 의견을 적어주세요 (선택)"
              style={{
                width: '100%', boxSizing: 'border-box', background: 'transparent',
                color: COLORS.textPrimary, border: `1px solid ${COLORS.border}`,
                borderRadius: 8, padding: '6px 10px', fontSize: 12,
              }}
            />
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {ackState === 'ACKNOWLEDGED' ? (
              <>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: COLORS.teal }}>
                  ✓ {OPERATOR_NAME} 확인 — 판정 이력에 기록
                </span>
                {/* "닫기"는 배너가 아니라 콘솔 전체를 닫는다(2026-08-20 — 배너만 닫히고
                    콘솔은 열려 있는 게 오히려 헷갈린다는 지적). */}
                <button onClick={() => setOpen(false)} style={{
                  background: 'transparent', color: COLORS.textDim, border: `1px solid ${COLORS.border}`,
                  borderRadius: 8, padding: '5px 10px', fontWeight: 700, fontSize: 11.5, cursor: 'pointer',
                }}>닫기</button>
              </>
            ) : !assessmentChecked ? (
              <span style={{ flex: 1, fontSize: 11.5, color: COLORS.textDim }}>
                판정 이력 확인 중…
              </span>
            ) : assessmentId ? (
              <>
                <span style={{ flex: 1, fontSize: 11.5, color: COLORS.textDim }}>
                  확인해도 자리가 잡히지 않습니다 — 이 판정을 봤다는 기록만 남습니다.
                </span>
                <button onClick={acknowledge} disabled={decisionBusy} style={{
                  background: COLORS.teal, color: '#FFFFFF', border: 'none', borderRadius: 8,
                  padding: '7px 14px', fontWeight: 800, fontSize: 12.5,
                  cursor: decisionBusy ? 'wait' : 'pointer', opacity: decisionBusy ? 0.6 : 1,
                }}>판정 확인</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 11.5, color: COLORS.textDim }}>
                  아직 기록된 판정이 없습니다. 선박 판정 화면의 [판정 요청]으로 기록합니다.
                </span>
              </>
            )}
          </div>
          {decisionError && (
            /* 조회 전용 배포본에서 누른 것은 고장이 아니다 — 빨간 "처리 실패"로
               그리면 심사자가 오류로 읽는다. 안내와 실패를 색으로 구분한다.
               (판정 결과 자체는 실제 서버가 낸 것이라 그대로 남는다) */
            <span style={{
              fontSize: 11,
              color: decisionReadOnly ? COLORS.textDim : COLORS.red,
            }}>
              {decisionReadOnly ? decisionError : `처리 실패: ${decisionError}`}
            </span>
          )}
        </div>
      )}
      </>
      )}

      <style>{`
        .spin { animation: agentspin 1s linear infinite; }
        @keyframes agentspin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// LLM 답변이 "1. **소제목**: 내용 2. **소제목**: ..." 처럼 줄바꿈 없이 번호매김만
// 있는 경우가 많아, 그대로 찍으면 별표가 글자 그대로 보이고 목록이 한 문단으로
// 뭉친다. 번호 항목 앞에 줄바꿈을 넣고 **굵게**만 최소 파싱해서 표시한다
// (전체 마크다운 라이브러리를 새로 추가하지 않고 이 정도만 처리).
function formatAnswer(text) {
  if (!text) return null;
  const withBreaks = text.replace(/(\d+)\.\s*(?=\*\*)/g, (match, _num, offset) => (offset === 0 ? match : `\n${match}`));
  return withBreaks.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return (
      <div key={i} style={{ marginTop: i === 0 ? 0 : 6 }}>
        {parts.map((p, j) => (p.startsWith('**') && p.endsWith('**')
          ? <strong key={j}>{p.slice(2, -2)}</strong>
          : <span key={j}>{p}</span>))}
      </div>
    );
  });
}

// 근거 본문이 "[화학물질명 - 섹션명] 내용" 형태로 오는 경우가 있는데, 그 화학물질명·
// 섹션명은 이미 칩/헤더에 표시하므로 본문에서는 중복 제거한다.
function stripCitationPrefix(text) {
  return (text || '').replace(/^\[[^\]]*\]\s*/, '');
}

// KOSHA MSDS 원문은 "인체를 보호하기 위해 필요한 조치사항 및 보호구: ..." 같은 항목별
// 라벨이 개행 없이 항목마다 반복되며 그대로 이어붙어 온다(항목 하나하나가 원래는
// 별도 행이었는데 citation.text 하나로 합쳐져서 온 것으로 보임). 첫 콜론 앞부분을
// 라벨로 보고, 그 라벨이 2번 이상 반복되면 라벨 기준으로 다시 잘라 항목마다 줄을
// 나눈다 — 라벨이 없거나 한 번만 나오는 일반 문장은 손대지 않는다.
function splitRepeatedLabel(text) {
  const colonIdx = text.indexOf(':');
  if (colonIdx < 0 || colonIdx > 40) return [text];
  const label = text.slice(0, colonIdx + 1);
  const chunks = text.split(label).filter((c) => c.trim());
  if (chunks.length < 2) return [text];
  return chunks.map((c) => `${label}${c}`.trim());
}

// 확정값(score 없음 — 정형 컬럼·그래프 관계)이 벡터 발췌보다 신뢰도가 높으므로 항상
// 우선하고, 그다음 유사도 높은 순으로 정렬해 상위 limit개만 남긴다.
function pickTopCitations(citations, limit = 2) {
  const sorted = [...citations].sort((a, b) => {
    if (a.is_exact !== b.is_exact) return a.is_exact ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });
  return { shown: sorted.slice(0, limit), hiddenCount: Math.max(0, sorted.length - limit) };
}

// 근거를 전부 나열하면 답변 아래에 카드가 줄줄이 쌓여 가독성이 떨어졌다 — 한 줄 칩만
// 보여주고, 눌렀을 때 원문을 어떻게 보여줄지는 호출부(onOpen)가 결정한다.
function CitationList({ citations, onOpen }) {
  const { shown, hiddenCount } = pickTopCitations(citations);
  return (
    <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {shown.map((c, j) => (
        <button key={j} onClick={() => onOpen(c)} style={{
          display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', cursor: 'pointer',
          background: COLORS.card, border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid ${c.is_exact ? COLORS.teal : COLORS.info}`,
          borderRadius: 8, padding: '6px 10px', fontSize: 11.5, color: COLORS.textSecondary,
        }}>
          <FaBookOpen size={10} style={{ flexShrink: 0, color: c.is_exact ? COLORS.teal : COLORS.info }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <strong style={{ color: c.is_exact ? COLORS.teal : COLORS.info }}>{c.chem_name}</strong> · {c.section_name}
            {c.cas_no && ` (CAS ${c.cas_no})`}
          </span>
          {c.is_exact && (
            <span style={{
              flexShrink: 0, padding: '1px 6px', borderRadius: 5, fontSize: 10,
              background: `${COLORS.teal}2e`, color: COLORS.teal, fontWeight: 700,
            }}>확정값</span>
          )}
        </button>
      ))}
      {hiddenCount > 0 && (
        <div style={{ fontSize: 10.5, color: COLORS.textDim }}>
          근거 {shown.length + hiddenCount}개 중 상위 {shown.length}개만 표시 (나머지 {hiddenCount}개 생략)
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 질의응답 패널 — 관제사가 규정·MSDS를 자연어로 묻는다.
//
// 답변은 반드시 근거(citation)와 함께 나온다. 백엔드 RAG(/rag/query)가 준비되면
// 그 결과를, 아직이면 MSDS 원문 섹션을 그대로 인용한다. 어느 쪽인지 화면에 표시해
// "무엇을 근거로 답했는지"를 관제사가 항상 알 수 있게 한다.
//
// 근거는 채팅 안에서 아코디언으로 펼치지 않는다 — 로그가 계속 쌓이는 채팅에서는
// 펼친 뒤 다시 접으려면 스크롤을 거슬러 올라가야 해서 번거롭다. 대신 한 줄 칩만
// 보여주고 클릭하면 콘솔 위에 오버레이로 띄운다 — 닫아도 채팅 스크롤 위치가 그대로다.
// ─────────────────────────────────────────────
const QA_GROUPS = [
  ['보호구 · 물성', ['벤젠 취급 시 착용해야 할 보호구는?', '톨루엔 인화점이 몇 도인가요?']],
  ['누출 · 화재 대응', ['메탄올이 누출되면 어떻게 대처하나요?', '가솔린 화재에는 어떻게 소화하나요?']],
  ['혼재 · 격리', ['황산은 어떤 물질과 함께 두면 안 되나요?', '아크릴로니트릴과 프로필렌옥사이드를 이웃 선석에서 동시에 하역해도 되나요?']],
];

function QaPanel({ log, loading, question, setQuestion, ask, endRef, cargoHint, onClearCargo, onNew }) {
  const [activeCitation, setActiveCitation] = useState(null);
  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(cargoHint || log.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {cargoHint && (
              <span style={{ fontSize: 11.5, color: COLORS.teal, border: `1px solid ${COLORS.teal}66`, background: `${COLORS.teal}10`, borderRadius: 999, padding: '2px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                지금 화물 · {cargoHint}
                <button type="button" onClick={onClearCargo} title="이 화물을 질문 맥락에서 뺍니다" style={{ border: 'none', background: 'none', color: COLORS.textDim, cursor: 'pointer', padding: 0, fontSize: 11 }}>✕</button>
              </span>
            )}
            {log.length > 0 && (
              <button type="button" onClick={onNew} style={{ marginLeft: 'auto', border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.textSecondary, borderRadius: 6, padding: '2px 9px', fontSize: 11.5, cursor: 'pointer' }}>
                새 대화
              </button>
            )}
          </div>
        )}
        {log.length === 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ color: COLORS.textSecondary, fontSize: 12.5, lineHeight: 1.7 }}>
              화물 안전 규정을 물어보세요. 답은 <strong style={{ color: COLORS.teal }}>MSDS 원문 절</strong>을 출처로 붙이고,
              두 화물의 혼재를 물으면 <strong style={{ color: COLORS.teal }}>규칙으로 확정한 등급</strong>을 함께 보여줍니다.
            </div>
            {cargoHint && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: COLORS.textDim, marginBottom: 5 }}>지금 화물 · {cargoHint}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[`${cargoHint} 취급 시 착용해야 할 보호구는?`, `${cargoHint}이(가) 누출되면 어떻게 대처하나요?`, `${cargoHint}과(와) 함께 두면 안 되는 물질은?`].map((q) => (
                    <button key={q} onClick={() => ask(q)} style={{ textAlign: 'left', background: `${COLORS.teal}0d`, cursor: 'pointer', border: `1px solid ${COLORS.teal}44`, borderRadius: 9, padding: '8px 12px', color: COLORS.textPrimary, fontSize: 12.5 }}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {QA_GROUPS.map(([head, qs]) => (
              <div key={head}>
                <div style={{ fontSize: 11, fontWeight: 800, color: COLORS.textDim, marginBottom: 5 }}>{head}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {qs.map((q) => (
                    <button key={q} onClick={() => ask(q)} style={{
                      textAlign: 'left', background: COLORS.cardHover, cursor: 'pointer',
                      border: `1px solid ${COLORS.glassBorder}`, borderRadius: 9, padding: '8px 12px',
                      color: COLORS.textSecondary, fontSize: 12.5, lineHeight: 1.5,
                    }}>{q}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {log.map((m, i) => m.role === 'user' ? (
          <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', flexDirection: 'row-reverse' }}>
            <div style={{
              background: `${COLORS.teal}22`, color: COLORS.teal, borderRadius: '50%',
              width: 30, height: 30, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0, fontSize: 12,
            }}><FaUser /></div>
            <div style={{
              background: `${COLORS.teal}1a`, border: `1px solid ${COLORS.teal}44`,
              borderRadius: 10, padding: '9px 12px', fontSize: 13,
              color: COLORS.textPrimary, lineHeight: 1.55, maxWidth: '80%',
            }}>{m.text}</div>
          </div>
        ) : (
          <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <div style={{
              background: `${COLORS.teal}22`, color: COLORS.teal, borderRadius: '50%',
              width: 30, height: 30, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0, fontSize: 13,
            }}><FaBookOpen /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                background: COLORS.cardHover, borderRadius: 10, padding: '9px 12px',
                fontSize: 13, color: COLORS.textPrimary, lineHeight: 1.55,
              }}>
                {formatAnswer(m.answer)}
              </div>

              {/* 혼재 판정 결과 — 답변 문장이 아니라 이 등급이 결론이다 (규칙엔진 하한 보정본) */}
              {m.assessment && (
                <div style={{
                  marginTop: 7, padding: '8px 11px', borderRadius: 8,
                  background: `${RISK_COLOR(m.assessment.risk_level)}1a`,
                  border: `1px solid ${RISK_COLOR(m.assessment.risk_level)}66`,
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: RISK_COLOR(m.assessment.risk_level) }}>
                    판정: {m.assessment.risk_level}
                    <span style={{ fontSize: 10.5, fontWeight: 400, color: COLORS.textDim }}>
                      {/* [2026-08-23] "(LLM이 낮출 수 없음)"을 뺐다 — 이제 LLM은
                          등급을 낮추지도 올리지도 않는다. 규칙엔진 값이 그대로
                          최종 등급이고(risk_level == rule_engine_floor), LLM은
                          근거 서술만 만든다. */}
                      {' '}· 규정 기준으로 확정
                    </span>
                  </div>
                  {m.assessment.reasoning && (() => {
                    const full = m.assessment.reasoning;
                    const hit = full.match(/^.*?(?:다\.|\.)(?=\s|$)/);
                    const head = hit ? hit[0] : full;
                    return (
                      <div style={{ fontSize: 11.5, color: COLORS.textSecondary, marginTop: 3, lineHeight: 1.55 }}>
                        {head}
                        {head.length < full.length && (
                          <details style={{ marginTop: 3 }}>
                            <summary style={{ cursor: 'pointer', color: COLORS.info, fontWeight: 600 }}>판단 사유 전문</summary>
                            <div style={{ marginTop: 3 }}>{full}</div>
                          </details>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* DB 미등재 — "혼재금지 관계 없음(안전)"이 아니라 "판정 불가"다 */}
              {m.unresolved?.length > 0 && (
                <div style={{
                  marginTop: 7, padding: '8px 11px', borderRadius: 8, fontSize: 12,
                  background: `${COLORS.yellow}14`, border: `1px solid ${COLORS.yellow}55`,
                  color: COLORS.yellow, lineHeight: 1.6,
                }}>
                  {/* [2026-08-23] "MSDS DB에 없습니다"는 관제사에게 시스템 용어다.
                      무엇이 문제이고 무엇을 확인하면 되는지로 바꿨다. */}
                  ⚠ <strong>판정하지 못했습니다</strong> — {m.unresolved.join(', ')}은(는)
                  {' '}울산항 화물 목록에 없습니다.
                  <div style={{ color: COLORS.textSecondary, fontSize: 11.5 }}>
                    “위험이 없다”는 뜻이 아니라 <strong>확인 자체를 못 했다</strong>는 뜻입니다.
                    화물명 표기를 다시 확인하시고, 맞다면 관제사가 직접 판단해 주세요.
                  </div>
                </div>
              )}

              {m.citations?.length > 0 && (
                <CitationList citations={m.citations} onOpen={setActiveCitation} />
              )}

              <div style={{ fontSize: 10.5, color: COLORS.textDim, marginTop: 5 }}>
                {m.is_local_fallback
                  ? '※ 규칙 기반 인용 — MSDS 원문 섹션을 그대로 표시합니다 (벡터 검색 미연결)'
                  : `※ GraphRAG 근거 — MSDS 원문·지식그래프·정형값${
                      m.confidence ? ` · 신뢰도 ${CONFIDENCE_LABEL[m.confidence] || m.confidence}` : ''
                    }`}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', gap: 9, alignItems: 'center', color: COLORS.textDim, fontSize: 12.5 }}>
            <FaSpinner className="spin" /> MSDS 근거를 찾는 중…
            <span style={{ fontSize: 11 }}>(처음 조회하는 물질은 1~2분 걸릴 수 있습니다)</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div style={{
        padding: '10px 14px', borderTop: `1px solid ${COLORS.glassBorder}`,
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
          placeholder={cargoHint ? `${cargoHint} 관련 질문…` : '화물명과 함께 물어보세요 (예: 벤젠 보호구)'}
          style={{
            flex: 1, minWidth: 0, background: COLORS.card, color: COLORS.textPrimary,
            border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '9px 11px', fontSize: 12.5,
          }}
        />
        <button onClick={() => ask()} disabled={loading || !question.trim()} style={{
          background: loading || !question.trim() ? COLORS.card : `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.tealDark})`,
          color: loading || !question.trim() ? COLORS.textDim : '#FFFFFF',
          border: 'none', borderRadius: 8, padding: '9px 13px', fontSize: 13,
          cursor: loading || !question.trim() ? 'default' : 'pointer',
        }}><FaPaperPlane /></button>
      </div>

      {/* 근거 원문 오버레이 — 채팅 스크롤과 분리되어 있어 닫아도 로그 위치가 안 흔들린다 */}
      {activeCitation && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          // 어두운 배경 잔재 — 콘솔을 라이트로 전환할 때(2026-08-21) 이 오버레이만
          // 남아, 어두운 바탕 위에 라이트 팔레트 잉크색 글자가 얹혀 읽을 수 없었다
          // (2026-08-22 실발견, /safety 인용 원문). 표면 규칙은 하나여야 한다.
          background: COLORS.panel, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            padding: '11px 14px', borderBottom: `1px solid ${COLORS.glassBorder}`,
          }}>
            <div>
              <div style={{
                fontSize: 12.5, fontWeight: 800,
                color: activeCitation.is_exact ? COLORS.teal : COLORS.info,
              }}>
                {activeCitation.chem_name} · {activeCitation.section_name}
              </div>
              <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>
                {[activeCitation.cas_no && `CAS ${activeCitation.cas_no}`, activeCitation.is_exact && '확정값']
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
            <button onClick={() => setActiveCitation(null)} style={{
              background: 'none', border: 'none', color: COLORS.textDim, cursor: 'pointer', fontSize: 16, flexShrink: 0,
            }}><FaTimes /></button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', fontSize: 13, color: COLORS.textSecondary, lineHeight: 1.7 }}>
            {splitRepeatedLabel(stripCitationPrefix(activeCitation.text)).map((para, i) => (
              <p key={i} style={{ margin: i === 0 ? 0 : '10px 0 0' }}>{para}</p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
