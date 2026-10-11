import { useMemo, useState } from 'react';
import { showDisclosure } from '../../utils/disclosure';
import { useNavigate } from 'react-router-dom';
import useSensorStore from '../../stores/useSensorStore';
import { COLORS, NAV_STATUS, WEATHER_STATUS_COLORS } from '../../utils/constants';
import { cargoSummary } from '../../utils/cargoText';
import { ONSAN_BERTHS, ONSAN_WEATHER_GROUP, OMNIVERSE_BERTH_IDS, findBerthIdByName } from '../../utils/geoUtils';
import useVesselSafety from '../../hooks/useVesselSafety';
import useDashboardData from '../../hooks/useDashboardData';
import { FaTimes, FaShieldAlt, FaAnchor, FaCloudSun, FaBell, FaCogs, FaMapMarkerAlt, FaShip } from 'react-icons/fa';
import { simulateMooring } from '../../utils/mooringPhysics';
import { alertId, ackOf, mergeAlerts, alertParts, levelStyle, SCOPE_LABEL } from '../../utils/alertUtils';
import AgentChip from '../../utils/AgentChip';
import ConflictBasisList from '../common/ConflictBasisList';
import DemoChip from '../common/DemoChip';
import SyntheticChip from '../common/SyntheticChip';
import { useDemoCargo } from '../../utils/demoCargo';
import { fetchAlternativeBerths, estimateEta, estimateBerthRelease } from '../../api/backendAdapter';

const RISK_COLORS = {
  '안전': COLORS.teal, '주의': COLORS.yellow, '위험': COLORS.red,
  '배정불가': COLORS.red, '판단불가': COLORS.textDim,
};
// 화물 칩 정렬 순서 — 심각한 것부터
const RISK_RANK = { '배정불가': 4, '위험': 3, '주의': 2, '판단불가': 1, '안전': 0 };

// AIS 로 실제 확인되는 항내 단계만 둔다.
//
// 예전 단계는 ['안전 심사','선석 배정','입항','접안','하역','출항'] 이었고 인덱스를
// AIS 항해상태 하나로만 정했다(UNDER_WAY→2). 그래서 앞의 '안전 심사'·'선석 배정'이
// 항상 완료로 칠해졌다 — 심사를 한 적도, 선석을 배정한 적도 없는 배까지.
// 묘박 중이고 화물·선석이 전부 미확인인 배가 "안전 심사 ✓ 선석 배정 ✓"로 보였다.
//
// 안전 심사와 선석 배정은 사람이 실행하는 행위라 AIS 로 알 수 없다. 그 둘은
// 스테퍼에서 빼고, 실행 여부는 아래 각 섹션이 스스로 보여준다.
// (하역 여부도 AIS 로는 알 수 없다 — 접안까지만 확인 가능하고, 화물이 확인된
//  접안선을 '하역'으로 본다.)
const STEPS = ['항해', '정박지 대기', '접안', '하역'];

/** AIS 항해상태(+화물 확인 여부) → 스테퍼 인덱스. 모르면 -1(아무 단계도 칠하지 않음) */
function journeyIndex(vessel) {
  switch (vessel.nav_status_category) {
    case 'UNDER_WAY': return 0;
    case 'AT_ANCHOR': return 1;
    case 'MOORED': return vessel.cargo ? 3 : 2;
    default: return -1;   // 항해상태 미상(Class B 소형선) — 단정하지 않는다
  }
}

const berthIdByName = (name) => findBerthIdByName(name);

const formatKST = (utc) =>
  utc ? new Date(utc).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Seoul',
  }) : '-';

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', lineHeight: 1.9 }}>
      <span style={{ color: COLORS.textSecondary, flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function SectionTitle({ icon, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700,
      color: COLORS.info, margin: '18px 0 8px', borderBottom: `1px solid ${COLORS.border}`, paddingBottom: '6px',
    }}>
      {icon} {children}
    </div>
  );
}

const MOOR_VERDICT_COLORS = { '정상': COLORS.teal, '주의': COLORS.yellow, '경고': '#D2601A', '위험': COLORS.red };
const ASSUMED_DWT = 20000; // 케미컬 탱커 가정값 (하드코딩 유지 — 실DWT 소스 없음)

const DRAUGHT_VERDICT_STYLE = {
  NOT_ALLOWED: { label: '접안 불가', color: COLORS.red },
  MARGINAL: { label: '여유 부족', color: COLORS.yellow },
  // 선석별 수심이 다른 부두(SK5 7~11m 등)라 어느 선석인지 확인해야 판정이 끝나는 경우
  CHECK: { label: '선석 확인 요청', color: COLORS.info },
  UNKNOWN: { label: '판정 불가', color: COLORS.textDim },
  OK: { label: '정상', color: COLORS.teal },
};

export default function VesselDetailPanel() {
  const demo = useDemoCargo();
  const vessel = useSensorStore((s) => s.selectedVessel);
  const navigate = useNavigate();
  const [moorSim, setMoorSim] = useState(null);
  const [simLoading, setSimLoading] = useState(false);
  const [moorDwt, setMoorDwt] = useState(ASSUMED_DWT);
  // 배정 가능 선석 (스케줄링 에이전트)
  const [cands, setCands] = useState(null);
  const [candLoading, setCandLoading] = useState(false);
  const [candError, setCandError] = useState(null);
  const setSelectedVessel = useSensorStore((s) => s.setSelectedVessel);
  const setSelectedBerthGroup = useSensorStore((s) => s.setSelectedBerthGroup);
  const requestOmniverse = useSensorStore((s) => s.requestOmniverse);
  const berthWeather = useSensorStore((s) => s.berthWeather);
  const alertAcks = useSensorStore((s) => s.alertAcks);
  const ackAlert = useSensorStore((s) => s.ackAlert);
  const { data } = useDashboardData();

  const { assessment, loading: safetyLoading } = useVesselSafety(vessel);

  if (!vessel) return null;

  const status = NAV_STATUS[vessel.nav_status_category] || NAV_STATUS.UNKNOWN;
  const stepIdx = journeyIndex(vessel);
  const berthId = vessel.berth ? berthIdByName(vessel.berth) : null;
  const berthInfo = berthId ? ONSAN_BERTHS[berthId] : null;
  const weatherGroup = berthId ? ONSAN_WEATHER_GROUP[berthId] : null;
  const groupVerdict =
    berthWeather && weatherGroup && berthWeather.berth_group === weatherGroup
      ? berthWeather.status
      : null;
  const riskColor = RISK_COLORS[assessment?.risk_level] || COLORS.textDim;
  // 이 선박에 걸린 경고.
  //
  // 예전엔 port_call_id 로 대조했는데 백엔드 경고에는 그 값이 절대 없어(경고는
  // 요청형 판정이 아니라 재항 전수 판정에서 나온다) "관련 경고"가 영구히 0건이었다.
  // 지금은 경고가 callsgns 를 실어 보내므로 그걸로 찾는다. 접안 선석이 같은 경고도
  // 이 배와 무관하지 않으므로 함께 본다.
  const vesselAlerts = mergeAlerts(data?.alerts || []).filter((a) => {
    if (vessel.callsgn && (a.callsgns || []).includes(vessel.callsgn)) return true;
    return Boolean(vessel.berth) && a.berth_name === vessel.berth;
  });
  // 대체 선석 제안은 지금 선석이 부적합일 때만 보인다 — 혼재 판정 배정불가 또는 흘수 접안 불가.
  const draughtVerdict = (data?.draught_checks || []).find((r) => r.callsgn === vessel.callsgn)?.draught_verdict;
  const berthUnsuitable = assessment?.risk_level === '배정불가' || draughtVerdict === 'NOT_ALLOWED';

  return (
    <div className="vessel-detail-panel" style={{
      position: 'fixed', top: 0, right: 0, height: '100vh', width: '390px', zIndex: 2500,
      background: 'rgba(255, 255, 255, 0.98)', backdropFilter: 'blur(12px)',
      borderLeft: `1px solid ${COLORS.borderHover}`, boxShadow: '-12px 0 40px rgba(18, 53, 79, 0.16)',
      padding: '20px', overflowY: 'auto', color: COLORS.textPrimary,
    }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '19px' }}>{vessel.vessel_name}</h2>
            {vessel.is_liquid_cargo_vessel && (
              <span style={{ background: COLORS.red, color: '#fff', borderRadius: '4px', padding: '2px 7px', fontSize: '11px', fontWeight: 700 }}>위험물</span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: COLORS.textDim, marginTop: '4px' }}>{vessel.port_call_id}</div>
        </div>
        <button
          onClick={() => setSelectedVessel(null)}
          aria-label="닫기"
          title="닫기"
          style={{ background: 'none', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', fontSize: '18px', padding: '4px' }}
        >
          <FaTimes />
        </button>
      </div>

      {/* 여정 스테퍼 — AIS 로 확인되는 항내 단계만. 안전 심사·선석 배정은 사람이
          실행하는 행위라 여기서 완료로 칠하지 않는다(각 섹션이 스스로 보여준다). */}
      {stepIdx < 0 && (
        <div style={{ fontSize: '11.5px', color: COLORS.textDim, margin: '14px 0 2px', textAlign: 'center' }}>
          AIS 항해상태 미수신 — 항내 단계를 표시할 수 없습니다
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', margin: '18px 0 4px', opacity: stepIdx < 0 ? 0.35 : 1 }}>
        {STEPS.map((s, i) => {
          const done = i < stepIdx;
          const current = i === stepIdx;
          const c = current ? COLORS.teal : done ? COLORS.info : COLORS.textDim;
          return (
            <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              {i > 0 && (
                <div style={{
                  position: 'absolute', top: '7px', right: '50%', width: '100%', height: '2px',
                  background: i <= stepIdx ? COLORS.info : COLORS.card,
                }} />
              )}
              <div style={{
                width: current ? '16px' : '12px', height: current ? '16px' : '12px', borderRadius: '50%',
                background: done || current ? c : COLORS.card, border: `2px solid ${c}`,
                zIndex: 1, boxShadow: current ? `0 0 10px ${COLORS.teal}` : 'none',
              }} />
              <span style={{ fontSize: '10px', color: c, marginTop: '5px', fontWeight: current ? 700 : 400, whiteSpace: 'nowrap' }}>
                {s}
              </span>
            </div>
          );
        })}
      </div>
      {/* anchorage(정박지 코드)는 AIS·PORT-MIS 어느 쪽에서도 오지 않는다
          (backendAdapter.mapVessel 이 만들지 않는 필드). 예전엔 그대로 찍어
          "정박지 undefined 에서 선석 대기 중"이 떴다. 아는 것만 말한다. */}
      {vessel.nav_status_category === 'AT_ANCHOR' && (
        <div style={{ fontSize: '12px', color: COLORS.yellow, textAlign: 'center', marginTop: '6px' }}>
          {vessel.anchorage
            ? `정박지 ${vessel.anchorage} 에서 선석 대기 중`
            : '정박지 대기 중 — 지정 정박지 코드는 수집 소스 없음'}
        </div>
      )}

      {/* 기본 정보 */}
      <SectionTitle icon={<FaAnchor />}>선박 · 입항 정보</SectionTitle>
      <Row label="상태">
        <span style={{ color: status.color, fontWeight: 700 }}>{status.label}</span> · {vessel.sog} kn
      </Row>
      <Row label="호출부호 / MMSI">{vessel.callsgn} / {vessel.mmsi}</Row>
      <Row label={<>화물<SyntheticChip align="right" /></>}>
        {vessel.cargo
          /* [2026-09-29] 화물이 합성이라는 표식을 칩으로 되살렸다(SyntheticChip). 2026-08-23 에는
             화면에 두지 않기로 했는데, 화면이 실제 배·선석을 쓰게 되면서 화물만 만든 값이라는 사실이
             보이지 않게 됐다 — 현우 9월 원칙(가상을 실제처럼 꾸미지 않는다). */
          ? (vessel.cargos?.length > 1
            // 같은 입항 건에 실은 화물 전부 — 한 줄에 하나씩(UN 번호 포함)
            ? (
              <span>
                {vessel.cargos.map((c) => (
                  <span key={c.chem_id} style={{ display: 'block' }}>
                    {c.name} ({c.un_no}){' '}
                    {c.is_demo && <DemoChip entries={demo.ofShip(vessel.callsgn).filter((e) => e.cargo_name === c.name)} />}
                  </span>
                ))}
              </span>
            )
            : <span>{vessel.cargo.name} ({vessel.cargo.un_no}) <DemoChip entries={demo.ofShip(vessel.callsgn)} /></span>)
          : vessel.liquid_by_ship_type === true ? '액체화물선 · 화물 미확인'
            : vessel.liquid_by_ship_type === false ? '일반화물' : '미확인'}
      </Row>
      {vessel.ship_kind_nm && <Row label="선종 (PORT-MIS)">{vessel.ship_kind_nm}</Row>}
      {/* arrival_at_utc 는 지도 마커로 연 경우에만 채워진다(PortMap 이 붙여준다).
          목록·경고에서 연 경우엔 없으므로 AIS 최근 수신 시각을 대신 보여준다. */}
      <Row label={vessel.arrival_at_utc ? '입항시각 (KST)' : '위치 최근 수신 (KST)'}>
        {formatKST(vessel.arrival_at_utc || vessel.received_at_utc)}
      </Row>
      {/* [2026-09-29] AIS 위치로 본 접안 선석이다 — 우리는 배정하지 않는다(검증만). '배정 선석/미배정'은 뜻이 틀렸다. */}
      <Row label="접안 선석 (AIS)">{vessel.berth || '접안 안 함'}</Row>
      {/* 항해 중인 배에만 도착 추정을 붙인다.
          PORT-MIS 의 입항 예정 시각은 원천에서 전부 비어 와서(실측), 지금 데이터로
          낼 수 있는 건 AIS 속력 기반 직선 외삽뿐이다. 그래서 '예정'이 아니라
          '현재 속력 기준'이라고 적는다 — 항로 우회·감속·도선 대기가 빠져 있어
          실제 도착은 항상 이보다 늦다. */}
      {(() => {
        const eta = estimateEta(vessel);
        if (!eta) return null;
        return (
          <Row label="온산 도착 추정">
            <span style={{ color: COLORS.info, fontWeight: 700 }}>약 {eta.hours}시간 후</span>
            <span style={{ color: COLORS.textDim, fontSize: '11.5px' }}>
              {' '}· {formatKST(eta.etaUtc)}
              <br />직선 {eta.distanceNm}해리 / {eta.sog}kn — 항로·대기 미반영
            </span>
          </Row>
        );
      })()}
      {berthInfo && (
        <Row label="선석 제원">
          {berthInfo.operator} · 최대 {berthInfo.maxDwt.toLocaleString()} DWT · 수심 {berthInfo.depthM}m
        </Row>
      )}
      {(() => {
        const dc = (data?.draught_checks || []).find((r) => r.callsgn === vessel.callsgn);
        if (!dc) return null;
        const v = DRAUGHT_VERDICT_STYLE[dc.draught_verdict] || DRAUGHT_VERDICT_STYLE.UNKNOWN;
        return (
          // [2026-09-27] 이 값은 **지금 조위**로 잰 여유다. 판정(체류 중 예보 최저 조위)과
          // 시점이 달라 여유 수치가 다를 수 있다(실측 WDH3033: 지금 1.21m · 체류 중 최저 1.01m).
          // 필요 여유는 판정과 같은 규칙 max(1.0m, 흘수 10%)다(alembic 0034).
          <Row label="흘수·UKC (현재 조위 기준)">
            <span style={{ color: v.color, fontWeight: 700 }}>{v.label}</span>
            {dc.ukc_m != null && ` · 여유 ${dc.ukc_m}m (필요 ${dc.ukc_required_m}m = max(1.0m, 흘수 10%))`}
          </Row>
        );
      })()}

      {/* 하역 작업 진행률 */}
      {(() => {
        const op = (data?.operations || []).find(
          (o) => !o.is_real_record && o.vessel_name === vessel.vessel_name
        );
        if (!op) return null;
        const opColor = op.status === 'IN_PROGRESS' ? COLORS.teal : COLORS.yellow;
        return (
          <div style={{ marginTop: '10px', padding: '10px 12px', background: COLORS.card, borderRadius: '10px', border: `1px solid ${COLORS.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', marginBottom: '6px' }}>
              <span style={{ fontWeight: 700 }}>
                하역 작업 {op.status === 'IN_PROGRESS' ? '진행 중' : '대기'}
              </span>
              <span style={{ color: opColor, fontWeight: 800 }}>{Math.round(op.progress_pct)}%</span>
            </div>
            <div style={{ height: '9px', background: COLORS.bg, borderRadius: '5px', overflow: 'hidden' }}>
              <div style={{ width: `${op.progress_pct}%`, height: '100%', background: opColor, borderRadius: '5px', transition: 'width 1s' }} />
            </div>
            {op.planned_tons != null && (
              <div style={{ fontSize: '11.5px', color: COLORS.textSecondary, marginTop: '5px' }}>
                {(op.done_tons ?? 0).toLocaleString()} / {op.planned_tons.toLocaleString()} t · {op.cargo}
              </div>
            )}
            {/* 간트차트에는 "진행률은 데모값" 고지가 있는데 여기엔 없어서, 같은
                데이터가 한 화면에선 데모, 다른 화면에선 실측처럼 보였다. */}
            {showDisclosure() && (
              <div style={{ fontSize: '11px', color: COLORS.yellow, marginTop: '6px' }}>
                데모값 — 유량계 미도입으로 실시간 진행률 수집 소스가 없습니다
              </div>
            )}
          </div>
        );
      })()}

      {/* 안전 심사 — 백엔드 안전 에이전트 (MSDS 혼재금지 + 46 CFR 150 호환성 그룹) */}
      <SectionTitle icon={<FaShieldAlt />}>혼재 심사<AgentChip agent="safety" /></SectionTitle>
      {!assessment ? (
        <div style={{ fontSize: '13px', color: COLORS.textDim, lineHeight: 1.7 }}>
          안전 에이전트 조회 중…
          <div style={{ fontSize: '11px' }}>처음 조회하는 물질은 MSDS 수집에 1~2분 걸릴 수 있습니다</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{
              display: 'inline-block', padding: '4px 14px', borderRadius: '999px',
              border: `2px solid ${riskColor}`, color: riskColor, fontWeight: 800, fontSize: '15px',
            }}>
              {assessment.risk_level}
            </div>
            {safetyLoading && <span style={{ fontSize: '11px', color: COLORS.textDim }}>갱신 중…</span>}
          </div>
          {/* [2026-09-29] ① 왜 이 등급인가 — 백엔드가 모든 화물에서 모은 근거(verdict_basis)를 그대로 싣는다.
              예전엔 프론트가 대표 화물의 충돌만 게이트로 다시 조립했고, 충돌이 없으면 "인접 선석 화물과
              혼재금지·격리 충돌 없음"을 고정으로 찍어 선석이 없는 배(비교 대상 없음)에도 떴다.
              근거가 없는 응답(조회 실패·화물 미확인 등 fail-safe)만 게이트 목록을 쓴다. */}
          {assessment.verdict_basis?.length > 0 ? (
            <ConflictBasisList basis={assessment.verdict_basis} color={riskColor} />
          ) : assessment.gates_hit.length > 0 && (
            <ul style={{ margin: '4px 0', paddingLeft: '16px', fontSize: '12.5px', lineHeight: 1.7 }}>
              {assessment.gates_hit.map((g, i) => (
                <li key={`${g.rule}-${i}`}>
                  <strong style={{ color: g.severity === 'BLOCK' ? COLORS.red : g.severity === 'HOLD' ? '#D2601A' : COLORS.yellow }}>
                    {g.rule}
                  </strong>{' '}{g.reason}
                </li>
              ))}
            </ul>
          )}

          {/* ② 화물이 여럿이면 화물마다 등급 — 위험한 순으로, 안전한 화물은 접는다(6종이 한 줄에 늘어서면
              문제 화물이 묻힌다). */}
          {assessment.cargo_verdicts?.length > 1 && (() => {
            const sorted = [...assessment.cargo_verdicts]
              .sort((a, b) => (RISK_RANK[b.risk_level] ?? 0) - (RISK_RANK[a.risk_level] ?? 0));
            const flagged = sorted.filter((v) => v.risk_level !== '안전');
            const safe = sorted.filter((v) => v.risk_level === '안전');
            const chip = (v) => (
              <span key={v.chem_id} style={{ display: 'inline-block', marginRight: '10px' }}>
                {v.target_cargo_name} <b style={{ color: RISK_COLORS[v.risk_level] }}>{v.risk_level}</b>{v.is_governing ? ' (대표)' : ''}
              </span>
            );
            // [2026-09-29] 안전 아닌 화물이 전부 같은 등급이면 이름을 나열하지 않고 한 번만 말한다(이름은 접어 둔다)
            const oneLevel = flagged.length > 1 && flagged.every((v) => v.risk_level === flagged[0].risk_level);
            return (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '6px' }}>
                <span style={{ fontWeight: 700, marginRight: '8px' }}>화물 {sorted.length}종</span>
                {oneLevel ? (
                  <details style={{ display: 'inline', marginRight: '10px' }}>
                    <summary style={{ display: 'inline', cursor: 'pointer' }}>
                      {safe.length ? `${flagged.length}종` : '모두'}{' '}
                      <b style={{ color: RISK_COLORS[flagged[0].risk_level] }}>{flagged[0].risk_level}</b>
                    </summary>
                    <div style={{ marginTop: '2px' }}>{flagged.map((v) => v.target_cargo_name).join(' · ')}</div>
                  </details>
                ) : flagged.map(chip)}
                {safe.length > 0 && (
                  <details style={{ display: 'inline' }}>
                    <summary style={{ display: 'inline', cursor: 'pointer', color: COLORS.info }}>
                      {flagged.length ? `나머지 ${safe.length}종 안전` : '모두 안전'}
                    </summary>
                    <div style={{ marginTop: '2px' }}>{safe.map(chip)}</div>
                  </details>
                )}
              </div>
            );
          })()}
          {/* [2026-09-28] 같은 선박 화물끼리의 혼재 충돌 — 근거(①) 첫 줄이 이미 말하므로 근거가 없는
              옛 응답에서만 따로 보인다. */}
          {!assessment.verdict_basis?.length && assessment.onboard_conflicts?.length > 0 && (
            <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '6px' }}>
              <div style={{ fontWeight: 700 }}>같은 선박 화물 혼재 충돌 — 격리 적재 확인 필요</div>
              {assessment.onboard_conflicts.map((c) => (
                <div key={`${c.cargo_a_chem_id}-${c.cargo_b_chem_id}-${c.basis}-${c.detail}`}>
                  {c.cargo_a_name} ↔ {c.cargo_b_name} <span style={{ color: COLORS.textDim }}>({c.basis} {c.detail})</span>
                </div>
              ))}
            </div>
          )}

          {/* [2026-09-29] 판정에 쓰지 못한 근거 — 관제사가 챙길 일이라 접지 않는다. */}
          {assessment.needs_check?.length > 0 && (
            <div style={{ fontSize: '12px', color: COLORS.textSecondary, margin: '6px 0' }}>
              <div style={{ fontWeight: 700, color: COLORS.yellow }}>확인 필요</div>
              {assessment.needs_check.map((c) => <div key={c}>· {c}</div>)}
            </div>
          )}

          {/* ④ 참고 정보 — 판단 사유·주요 유해성(MSDS GHS 분류, 항목마다 물질명)·체크리스트.
              [2026-09-29] 주요 유해성이 화물별로 이름을 달고 오므로 제목에는 물질 이름을 넣지 않는다.
              등급의 근거가 아니라 접어 둔다. 판단 사유는 머리 뒤 줄바꿈이 있어 pre-line 으로 그린다. */}
          {(assessment.profile || assessment.summary || assessment.hazards?.length > 0
            || assessment.checklist.length > 0) && (
            <details style={{ marginTop: '10px' }}>
              <summary style={{
                fontSize: '12px', fontWeight: 700, color: COLORS.textSecondary,
                cursor: 'pointer', listStyle: 'revert',
              }}>
                {/* 제목에 물질 이름을 넣지 않는다 — 여러 종이면 이름 나열이 됐다(사용자 요청 9/29).
                    화물 특성(LLM)은 꺼져 있어 대개 판단 사유가 들어간다. */}
                참고 정보 — {assessment.profile ? '화물 특성' : '판단 사유'}
                {assessment.hazards?.length > 0 && ` · 유해성 ${assessment.hazards.length}`}
                {assessment.checklist.length > 0 && ` · 체크리스트 ${assessment.checklist.length}`}
              </summary>
              <div style={{ fontSize: '12.5px', color: COLORS.textSecondary, lineHeight: 1.65, marginTop: '4px', whiteSpace: 'pre-line' }}>
                {assessment.profile || assessment.summary}
              </div>
              {assessment.hazards?.length > 0 && (
                <>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: COLORS.textSecondary, marginTop: '6px' }}>주요 유해성 (MSDS)</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: '16px', fontSize: '12.5px', color: COLORS.textSecondary, lineHeight: 1.7 }}>
                    {assessment.hazards.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                </>
              )}
              {assessment.checklist.length > 0 && (
                <>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: COLORS.textSecondary, marginTop: '6px' }}>하역 전 안전 체크리스트</div>
                  <ul style={{ margin: '2px 0 0', paddingLeft: '16px', fontSize: '12.5px', color: COLORS.textSecondary, lineHeight: 1.7 }}>
                    {assessment.checklist.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </>
              )}
            </details>
          )}

          <div style={{ fontSize: '11px', color: COLORS.textDim, marginTop: '6px', lineHeight: 1.6 }}>
            {assessment.source === 'NO_CARGO'
              ? '※ 판정 입력(화물)이 없어 안전 에이전트를 호출하지 않았습니다. 모르는 화물을 안전으로 보지 않습니다'
              : assessment.is_local_fallback
                ? '※ 안전 에이전트가 응답하지 않아 판단을 보류합니다. 임의로 안전 판정하지 않습니다'
                // IMDG 7.2 는 한 선박 안 적부 기준이라 부두 간 판정에 쓰지 않는다 — 실제 기준만 적는다.
                // [2026-09-29] 앞머리 '백엔드 안전 에이전트 판정 —' 는 뺐다(사용자 요청).
                : '※ MSDS 혼재금지 + 46 CFR 150 호환성 그룹 기준'}
            {assessment.msds_sections_used?.length > 0
              && ` · 근거 섹션 ${assessment.msds_sections_used.length}개`}
          </div>
        </>
      )}

      {/* 선석 기상 판정 연동 */}
      {weatherGroup && (
        <>
          <SectionTitle icon={<FaCloudSun />}>부두 기상 판정</SectionTitle>
          <Row label="기상 임계군">{weatherGroup}</Row>
          {groupVerdict && (
            <Row label="최근 판정">
              <span style={{ color: WEATHER_STATUS_COLORS[groupVerdict], fontWeight: 800 }}>{groupVerdict}</span>
            </Row>
          )}
          <button
            onClick={() => setSelectedBerthGroup(weatherGroup)}
            style={{
              marginTop: '8px', width: '100%', padding: '9px', borderRadius: '8px', border: 'none',
              background: `linear-gradient(135deg, ${COLORS.teal}, ${COLORS.tealDark})`,
              color: '#FFFFFF', fontWeight: 700, cursor: 'pointer', fontSize: '13px',
            }}
          >
            부두 기상 판정 패널에서 보기
          </button>
        </>
      )}

      {/* ── 대체 선석 제안 (POST /scheduling/alternatives) ──
          [2026-09-27] 예전 '배정 가능 선석(후보)'은 조위를 빼고 top-3 를 새로 골랐다.
          우리는 배정하지 않는다 — 판정 잡이 부적합일 때 붙이는 대체안과 같은 계산으로,
          지금 부두를 뺀 **제안**만 보인다(조위 반영 가용수심, 필요 여유 max(1.0m, 흘수 10%)). */}
      {berthUnsuitable && (<>
      <SectionTitle icon={<FaMapMarkerAlt />}>대체 선석 제안<AgentChip agent="scheduling" /></SectionTitle>
      {/* 판정 입력 화물: 입항 건 화물만. 없으면 조회하지 않는다 */}
      {(() => { return null; })()}
      {(vessel.draught_m == null || !(vessel.cargo?.chem_id || vessel.cargo?.cas_no)) ? (
        <div style={{ fontSize: '12.5px', color: COLORS.textDim, lineHeight: 1.7 }}>
          {/* 없는 값을 가정으로 채워 후보를 만들지 않는다 — 근거 없는 "배정 가능"이 된다 */}
          조회 불가 — {vessel.draught_m == null ? '흘수 미수신' : ''}
          {vessel.draught_m == null && !(vessel.cargo?.chem_id || vessel.cargo?.cas_no) ? ' · ' : ''}
          {!(vessel.cargo?.chem_id || vessel.cargo?.cas_no) ? '화물 미확인(현재 입항 건 화물 없음)' : ''}
        </div>
      ) : (
        <>
          <button
            disabled={candLoading}
            onClick={async () => {
              setCandLoading(true); setCandError(null);
              try {
                setCands(await fetchAlternativeBerths({
                  draught_m: vessel.draught_m,
                  chem_id: vessel.cargo.chem_id,
                  cas_no: vessel.cargo.cas_no,
                  name_hint: vessel.vessel_name,
                  extra_cargos: vessel.cargos || [],
                  exclude_wharf_name: vessel.presence_berth_name ?? null,
                }));
              } catch (e) {
                setCandError(e.message);
              } finally {
                setCandLoading(false);
              }
            }}
            style={{
              width: '100%', padding: '9px', borderRadius: '8px', border: 'none',
              background: `linear-gradient(135deg, ${COLORS.info}, ${COLORS.blue})`,
              color: '#FFFFFF', fontWeight: 700, cursor: 'pointer', fontSize: '13px',
            }}
          >
            {candLoading ? '선석 검증 에이전트 조회 중...' : '이 선박의 대체 선석 제안 보기'}
          </button>
          <div style={{ fontSize: '11.5px', color: COLORS.textDim, marginTop: '6px', lineHeight: 1.6 }}>
            흘수 {vessel.draught_m} m · {vessel.cargos?.length > 1
              ? `화물 ${vessel.cargos.length}종(${cargoSummary(vessel.cargos, 3)})`
              : vessel.cargo.name} 기준, 앞으로 24시간 창.
            {vessel.presence_berth_name ? `지금 부두(${vessel.presence_berth_name})를 뺀 ` : ''}
            조위를 반영한 수심·화물 조건을 만족하는 제안이며, 배정이 아닙니다.
          </div>
          {candError && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: COLORS.yellow, lineHeight: 1.6 }}>
              조회 실패 — {candError}
            </div>
          )}
          {cands && (
            <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {cands.candidates?.length === 0 && (
                <div style={{ fontSize: '12.5px', color: COLORS.yellow }}>
                  제안할 선석이 없습니다{cands.note ? ` — ${cands.note}` : ''}
                </div>
              )}
              {(cands.candidates ?? []).map((c) => {
                const free = c.occupancy_status === '여유';
                return (
                  <div key={c.berth_id} style={{
                    border: `1px solid ${free ? COLORS.teal : COLORS.border}`,
                    borderRadius: '10px', padding: '9px 11px', background: COLORS.card,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }}>
                        <span style={{ color: COLORS.textDim, marginRight: '6px' }}>{c.rank}순위</span>
                        {c.wharf_name}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: free ? COLORS.teal : COLORS.yellow }}>
                        {c.occupancy_status}
                      </span>
                    </div>
                    <div style={{ fontSize: '11.5px', color: COLORS.textSecondary, marginTop: '3px' }}>
                      수심 {c.depth_m} m · 흘수 여유 {c.draught_margin_m?.toFixed(2)} m(체류 중 최저 조위 반영)
                      {c.onsan_scope ? ' · 온산' : ''}
                      {c.adjacent_cargos?.length > 0 ? ` · 인접 화물 ${c.adjacent_cargos.length}건` : ''}
                    </div>
                    {/* 점유 선석은 "언제 비는가"까지 말한다 — 그게 없으면 관제사가
                        이 줄을 보고 할 수 있는 판단이 없다. 근거는 그 선석의 실제
                        재항 이력 중앙값이고, 추정임을 표본 수와 함께 밝힌다. */}
                    {!free && (() => {
                      const rel = estimateBerthRelease(
                        c.wharf_name,
                        c.conflicting_port_calls,
                        data?.berth_dwell,
                      );
                      if (!rel) return null;
                      return (
                        <div style={{ fontSize: '11.5px', color: COLORS.yellow, marginTop: '3px' }}>
                          {rel.overdue
                            ? `중앙값 ${rel.medianHours}h 초과 (재항 ${rel.elapsedHours}h) — 곧 해제 가능성`
                            : `약 ${rel.remainingHours}h 후 해제 예상`}
                          <span style={{ color: COLORS.textDim }}>
                            {' '}· 이 선석 재항 중앙값 {rel.medianHours}h (실측 {rel.sampleCount}건)
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      </>)}

      {/* 계류 물리 검증 (8월 시나리오 S1 — 준정적 근사, PhysX 스크립트로 검증) */}
      {vessel.berth && (
        <>
          {/* [이 항목은 하드웨어와 무관하다]
              "하드웨어 안 하기로 했는데 왜 있나"는 질문이 나왔다. 8/3 에 보류한 것은
              탱크 수위계·유량계·게이트 릴레이 같은 '실물 계측/제어 장비'다.
              이 계산은 장비가 필요 없는 순수 수식이다 — 지금 부는 바람(실측 풍속)과
              선박 제원으로 계류삭 장력을 구한다. 설계문서 v1 4-4절의 항목이고,
              Isaac Sim PhysX 동역학으로 교차검증까지 해 둔 우리 차별점이다
              (2만 DWT 기준 근사식 137.6 kN vs PhysX 146.8 kN — 오차 6.7%). */}
          {/* 기본으로 접어 둔다.
              이 계산의 "주의" 임계는 풍속 20 m/s 인데, 온산 선석 기상 임계표의
              하역중단선은 12~17 m/s 다. 즉 계류가 주의로 넘어가기 훨씬 전에
              선석 판정이 이미 중단을 띄운다 — 관제 판단을 바꾸는 정보가 아니다.
              게다가 DWT 는 실수집이 안 돼 가정값(2만 t)으로 돌린다.
              참고 자료로는 의미가 있어 남기되, 펼쳐야 보이게 한다. */}
          <details>
            <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
              <SectionTitle icon={<FaCogs />}>계류 안정성 물리 검증 (참고)</SectionTitle>
            </summary>
          <div style={{ fontSize: '11.5px', color: COLORS.textDim, lineHeight: 1.6, marginBottom: '8px' }}>
            OCIMF 계열 준정적 근사식. 판정 권위는 선석 기상 임계표에 있고, 이 값은
            참고용입니다{showDisclosure() ? ' (DWT 가정값 기반)' : ''}.
          </div>
          {/* 예전엔 mock-server(:8000)의 /sim/mooring 을 호출했는데, mock-server 를
              걷어낸 뒤로는 그 주소가 죽어 항상 "응답 없음"만 떴다. 같은 상수·같은
              식을 utils/mooringPhysics.js 로 옮겨 화면에서 계산한다(순수 함수라
              서버 왕복이 필요 없다). */}
          <button
            disabled={simLoading || !data?.weather}
            onClick={() => {
              setSimLoading(true);
              try {
                const wind = data?.weather?.wind_speed_ms;
                const wave = data?.weather?.wave_height_sig_m;
                if (wind == null) {
                  // 관측이 없으면 임의값으로 계산하지 않는다 — 없는 근거로 낸
                  // "정상"은 가장 위험한 종류의 답이다.
                  setMoorSim({ error: '풍속 관측값이 없어 계산할 수 없습니다 (판단 보류)' });
                } else {
                  setMoorSim(simulateMooring(moorDwt, wind, wave ?? 0));
                }
              } finally {
                setSimLoading(false);
              }
            }}
            style={{
              width: '100%', padding: '9px', borderRadius: '8px',
              border: `1px solid ${COLORS.info}`, background: 'transparent',
              color: COLORS.info, fontWeight: 700, cursor: 'pointer', fontSize: '13px',
            }}
          >
            {simLoading ? '계산 중...' : '현재 기상으로 계류삭 장력 검증'}
          </button>
          {/* DWT 는 AIS·PORT-MIS 어느 쪽도 수집하지 않는다. 고정 가정값을 숨기고
              쓰면 "이 배의 실제 계산"으로 오해하므로, 가정값임을 드러내고 조정도
              할 수 있게 한다. */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            fontSize: '11.5px', color: COLORS.textDim, marginTop: '7px',
          }}>
            DWT
            <input
              type="number" step="1000" min="1000" value={moorDwt}
              onChange={(e) => { setMoorDwt(Number(e.target.value) || ASSUMED_DWT); setMoorSim(null); }}
              style={{
                width: '92px', background: COLORS.card, color: COLORS.textPrimary,
                border: `1px solid ${COLORS.border}`, borderRadius: '6px',
                padding: '3px 7px', fontSize: '11.5px',
              }}
            />
            <span>t{showDisclosure() ? ' — 실 DWT 미수집(선박위치·PORT-MIS 모두 없음), 가정값' : ''}</span>
          </label>
          {moorSim && !moorSim.error && (
            <div style={{ marginTop: '8px', padding: '10px 12px', background: COLORS.card, borderRadius: '10px', border: `1px solid ${MOOR_VERDICT_COLORS[moorSim.verdict] || COLORS.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                <span style={{ fontWeight: 800, color: MOOR_VERDICT_COLORS[moorSim.verdict] }}>
                  {moorSim.verdict} — 장력 {moorSim.tension_pct}%
                </span>
                <span style={{ color: COLORS.textSecondary }}>
                  {moorSim.line_tension_kn} / {moorSim.mbl_kn} kN
                </span>
              </div>
              <div style={{ height: '8px', background: COLORS.bg, borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(100, moorSim.tension_pct)}%`, height: '100%',
                  background: MOOR_VERDICT_COLORS[moorSim.verdict], borderRadius: '4px',
                }} />
              </div>
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '6px' }}>
                {moorSim.action} · 정상 한계풍속 <strong style={{ color: COLORS.textPrimary }}>{moorSim.safe_wind_limit_ms} m/s</strong>
              </div>
              <div style={{ fontSize: '10.5px', color: COLORS.textDim, marginTop: '4px' }}>{moorSim.model}</div>
            </div>
          )}
          {moorSim?.error && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: COLORS.yellow }}>{moorSim.error}</div>
          )}
          {/* [2026-09-28] 정밀 검토(Omniverse) 버튼은 3D 관제 화면 머리의 [정밀 검토 영상] 하나로 합쳤다(현우 D4). */}
          </details>
        </>
      )}

      {/* 관련 경고 */}
      <SectionTitle icon={<FaBell />}>관련 경고 ({vesselAlerts.length})</SectionTitle>
      {vesselAlerts.length === 0 && (
        <div style={{ fontSize: '13px', color: COLORS.textDim }}>이 선박 관련 경고 없음</div>
      )}
      {vesselAlerts.map((a) => {
        // ACK 키는 공용 규칙(alertUtils.alertId) 하나만 쓴다. 예전엔 여기만
        // `${type}-${created_at_utc}` 라는 두 번째 규칙을 갖고 있어서, 헤더 벨에서
        // 확인한 경고가 여기서는 미확인으로 남았다(게다가 백엔드 경고엔
        // created_at_utc 가 없어 같은 유형이 전부 한 키로 뭉쳤다).
        // [2026-09-30] 줄글 한 덩어리 대신 경고 벨과 같은 칸으로 — 대상 · 선석 · 화물 · 이유 · 조치 → 받는 곳
        const id = alertId(a);
        const ack = ackOf(a, alertAcks);
        const p = alertParts(a, (cs) => (data?.real_traffic || []).find((v) => v.callsgn === cs)?.vessel_name || null);
        const st = levelStyle(a.level);
        return (
          <div key={id} className="alert-card vd-alert" title={p.full} style={{ borderLeftColor: st.color, opacity: ack ? 0.6 : 1 }}>
            <div className="alert-card-top">
              <span className="alert-row-level" style={{ color: st.color, borderColor: st.color }}>{st.label}</span>
              {p.scope && (
                <span className="alert-scope">
                  {p.scope === 'ship' ? <FaShip aria-hidden="true" /> : <FaAnchor aria-hidden="true" />}{SCOPE_LABEL[p.scope]}
                </span>
              )}
              <strong className="alert-card-title">{p.title}</strong>
              {p.level && <span className="alert-card-level" style={{ color: st.color }}>{p.level}</span>}
              <span className="vd-alert-ack" style={{ color: ack ? COLORS.teal : COLORS.textDim }}>{ack ? `✓ ${ack.by}` : '미확인'}</span>
            </div>
            <dl className="alert-card-grid">
              {p.place && (<><dt>선석</dt><dd>{p.place}{p.stage ? <span className="alert-card-stage">{p.stage}</span> : null}</dd></>)}
              {p.cargo && (<><dt>화물</dt><dd>{p.cargo}</dd></>)}
              {p.why && (<><dt>이유</dt><dd>{p.why}</dd></>)}
              {p.action && (<><dt>조치</dt><dd>{p.action}{p.recipient ? <> → <b>{p.recipient}</b></> : null}</dd></>)}
            </dl>
          </div>
        );
      })}
    </div>
  );
}
