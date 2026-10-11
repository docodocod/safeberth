import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useSensorStore from '../../stores/useSensorStore';
import useDashboardData from '../../hooks/useDashboardData';
import useForecastAlerts from '../../hooks/useForecastAlerts';
import { COLORS } from '../../utils/constants';
import { alertId, alertIds, ackOf, mergeAlerts, SCOPE_LABEL, LEVEL_STYLE, levelStyle, alertParts } from '../../utils/alertUtils';
import { FaExclamationTriangle, FaCheck, FaTimes, FaChevronRight, FaShip, FaAnchor } from 'react-icons/fa';

// ─────────────────────────────────────────────────────────────────────────────
// 관제 경고 — 헤더 알림 벨 + 드롭다운
//
// 경고는 "항상 보고 있어야 하는 것"이 아니라 "떴을 때 열어보는 것"이므로 헤더 벨로 접는다.
// 미확인 건수는 벨 배지로 항상 보인다.
//
// [2026-09-29 밤] 줄글 한 덩어리를 칸으로 갈랐다(현우) — 대상(선박·화물쌍) / 선석 · 시점 / 이유 / 조치 → 받는 곳.
//   아래 회색 줄(자료 출처 이름)은 뺐다. 위 등급 수는 누르면 그 등급만 본다.
//   줄을 누르면 그 경고를 처리하는 화면으로 간다 — 그 배의 선박 판정(화물 경고는 그 배의 화물 혼재 카드).
// [2026-09-30] 화물 혼재 심사 화면을 선박 판정에 합치면서, 그 화면 오른쪽의 '현재 위험 선석'(같은 경고를 선석별로 묶은 것)은
//   이 벨의 [선석별] 보기로 옮겼다.
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_TONE = { 부적합: COLORS.red, 주의: COLORS.yellow, 판정불가: COLORS.purple };   // 화면 공용 판정 색

export default function AlertBell() {
  const { data } = useDashboardData();
  const alertAcks = useSensorStore((s) => s.alertAcks);
  const ackAlert = useSensorStore((s) => s.ackAlert);
  const trackVessel = useSensorStore((s) => s.trackVessel);
  const requestThreadFocus = useSensorStore((s) => s.requestThreadFocus);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [only, setOnly] = useState(null);   // 'DANGER' | 'WARNING' | 'INFO' | null
  const [byBerth, setByBerth] = useState(false);
  const wrapRef = useRef(null);

  // 같은 두 부두의 인접 혼재 경고는 한 건으로 묶는다(화물쌍은 카드 안 목록으로)
  const ahead = useForecastAlerts();   // 72시간 시뮬레이션의 '앞으로' 경고 — 기상 중단 · 정박지 대기 · 조위 대기
  const alerts = [...mergeAlerts(data?.alerts ?? []), ...ahead];
  const vessels = data?.real_traffic ?? [];
  const nameOf = (cs) => vessels.find((v) => v.callsgn === cs)?.vessel_name || null;
  // 배지 숫자는 참고(INFO)를 뺀 실제 경고만 센다. 참고 항목도 목록에는 남는다.
  const warnings = alerts.filter((a) => a.level !== 'INFO');
  const unacked = warnings.filter((a) => !ackOf(a, alertAcks));
  const ackAll = (a) => alertIds(a).forEach((id) => ackAlert(id));

  const counts = alerts.reduce((acc, a) => {
    const key = LEVEL_STYLE[a.level] ? a.level : 'INFO';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 경고를 처리하는 화면으로 — 그 배를 추적하고 선박 판정으로. 화물 경고는 그 배의 화물 혼재 카드까지 내려간다.
  const openAlert = (a, parts) => {
    // '앞으로' 경고는 3D 관제 화면의 앞으로 72시간을 그 시각으로 연다
    if (a.forecast) {
      navigate(`/twin?outlook=${encodeURIComponent(a.forecast.open || 'all')}&at=${a.forecast.at}`);
      setOpen(false);
      return;
    }
    const cs = (a.callsgns || [])[0];
    const cargo = !(parts.kind === 'verdict' || parts.kind === 'draught');
    if (cs) trackVessel({ callsgn: cs, vessel_name: cargo ? nameOf(cs) : parts.title });
    requestThreadFocus(cargo && cs ? 'cargo' : 'verdict');
    navigate('/arrivals');
    setOpen(false);
  };

  // 미확인을 위로 — 확인한 건 아래로 내려 흐리게 남긴다. 선석별 보기는 선석 이름으로 묶는다.
  const ordered = [...alerts]
    .filter((a) => !only || (LEVEL_STYLE[a.level] ? a.level : 'INFO') === only)
    .sort((a, b) => (byBerth ? String(a.berth_name || '힣').localeCompare(String(b.berth_name || '힣'), 'ko') : 0)
      || (ackOf(a, alertAcks) ? 1 : 0) - (ackOf(b, alertAcks) ? 1 : 0));

  return (
    <div className="alert-bell" ref={wrapRef}>
      <button
        type="button"
        className="header-badge alert-badge"
        onClick={() => setOpen((v) => !v)}
        title={`관제 경고 ${warnings.length}건 · 미확인 ${unacked.length}건`}
        aria-expanded={open}
      >
        <FaExclamationTriangle color={unacked.length > 0 ? COLORS.red : COLORS.textSecondary} />
        <span style={{ fontSize: '12px', color: unacked.length > 0 ? COLORS.red : COLORS.textSecondary }}>
          경고 {warnings.length}
        </span>
        {unacked.length > 0 && <span className="alert-count">{unacked.length}</span>}
      </button>

      {open && (
        <div className="alert-dropdown">
          <div className="alert-dropdown-head">
            <strong style={{ fontSize: '14px' }}>관제 경고</strong>
            <div className="alert-filter" role="group" aria-label="등급">
              {['DANGER', 'WARNING', 'INFO'].filter((lv) => counts[lv]).map((lv) => (
                <button
                  key={lv} type="button" aria-pressed={only === lv}
                  onClick={() => setOnly((cur) => (cur === lv ? null : lv))}
                  style={{ '--tone': LEVEL_STYLE[lv].color }}
                >
                  {LEVEL_STYLE[lv].label} <b>{counts[lv]}</b>
                </button>
              ))}
            </div>
            <div className="alert-filter" role="group" aria-label="묶기">
              <button type="button" aria-pressed={byBerth} onClick={() => setByBerth((v) => !v)} style={{ '--tone': COLORS.navy }}>선석별</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
              {unacked.length > 0 && (
                <button type="button" className="alert-dropdown-allack" onClick={() => unacked.forEach((a) => ackAll(a))}>
                  모두 확인
                </button>
              )}
              <button type="button" className="alert-dropdown-close" onClick={() => setOpen(false)} title="닫기">
                <FaTimes />
              </button>
            </div>
          </div>

          <div className="alert-dropdown-list">
            {ordered.length === 0 && (
              <div style={{ color: COLORS.textDim, fontSize: '13px', padding: '18px', textAlign: 'center' }}>
                활성 경고 없음
              </div>
            )}
            {ordered.map((a, i) => {
              const id = alertId(a);
              const ack = ackOf(a, alertAcks);
              const style = levelStyle(a.level);
              const p = alertParts(a, nameOf);
              const canOpen = Boolean((a.callsgns || [])[0]) || p.kind === 'verdict' || p.kind === 'draught' || p.kind === 'forecast';
              const head = byBerth && (i === 0 || (ordered[i - 1].berth_name || '') !== (a.berth_name || ''))
                ? (a.berth_name || '선석 없음') : null;
              return (
                <div key={id} style={{ display: 'contents' }}>
                {head && (
                  <div className="alert-group-head">
                    <strong>{head}</strong>
                    <span>{ordered.filter((x) => (x.berth_name || '') === (a.berth_name || '')).length}건</span>
                  </div>
                )}
                <div
                  className={`alert-card${canOpen ? ' can-open' : ''}`}
                  style={{ borderLeftColor: style.color, opacity: ack ? 0.45 : 1 }}
                  title={p.full}
                  role={canOpen ? 'button' : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  onClick={canOpen ? () => openAlert(a, p) : undefined}
                  onKeyDown={canOpen ? (e) => { if (e.key === 'Enter') openAlert(a, p); } : undefined}
                >
                  <div className="alert-card-top">
                    <span className="alert-row-level" style={{ color: style.color, borderColor: style.color }}>{style.label}</span>
                    {/* 선박 경고인가 선석 경고인가 — 선박은 그 배의 판정, 선석은 선석에 놓인 화물끼리 */}
                    {p.scope && (
                      <span className="alert-scope">
                        {p.scope === 'ship' ? <FaShip aria-hidden="true" /> : <FaAnchor aria-hidden="true" />}{SCOPE_LABEL[p.scope]}
                      </span>
                    )}
                    <strong className="alert-card-title">{p.title}</strong>
                    {p.level && <span className="alert-card-level" style={{ color: LEVEL_TONE[p.level] || style.color }}>{p.level}</span>}
                    {p.ahead && <span className="alert-ahead">앞으로</span>}
                    {canOpen && <FaChevronRight className="alert-card-go" aria-hidden="true" />}
                  </div>
                  <dl className="alert-card-grid">
                    {p.place && (<><dt>선석</dt><dd>{p.place}{p.stage ? <span className="alert-card-stage">{p.stage}</span> : null}</dd></>)}
                    {p.cargo && (<><dt>화물</dt><dd>{p.cargo}</dd></>)}
                    {p.why && (<><dt>이유</dt><dd>{p.why}</dd></>)}
                    {p.action && (<><dt>조치</dt><dd>{p.action}{p.recipient ? <> → <b>{p.recipient}</b></> : null}</dd></>)}
                  </dl>
                  {p.details?.length > 1 && (
                    <details className="alert-card-more" onClick={(e) => e.stopPropagation()}>
                      <summary>화물쌍 {p.details.length}건</summary>
                      <ul>{p.details.map((d) => <li key={d}>{d}</li>)}</ul>
                    </details>
                  )}
                  <div className="alert-card-ack">
                    {ack
                      ? <span style={{ color: COLORS.teal, fontSize: 11.5, fontWeight: 700 }}>✓ {ack.by}</span>
                      : (
                        <button
                          type="button" className="alert-row-btn alert-row-btn--ack" title="확인 처리"
                          onClick={(e) => { e.stopPropagation(); ackAll(a); }}
                        >
                          <FaCheck />
                        </button>
                      )}
                  </div>
                </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
