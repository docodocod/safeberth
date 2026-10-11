import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ReferenceDot,
} from 'recharts';
import { fetchUpcomingArrivals, fetchPendingApprovals, postAssessAndRecord } from '../api/backendAdapter';
import useSensorStore from '../stores/useSensorStore';
import { COLORS } from '../utils/constants';
import { cargoNames, cargoFit } from '../utils/cargoText';
import HelpTip from '../components/common/HelpTip';
import DemoChip from '../components/common/DemoChip';
import SyntheticChip from '../components/common/SyntheticChip';
import { useDemoCargo } from '../utils/demoCargo';
import BerthOccupiedList from '../components/dashboard/BerthOccupiedList';
import AgentConsole from '../components/dashboard/AgentConsole';
import GanttChart from '../components/dashboard/GanttChart';
import ShipCargoPanel from '../components/safety/ShipCargoPanel';
import useVesselThread, { normKey } from '../hooks/useVesselThread';
import useDashboardData from '../hooks/useDashboardData';
import { VERDICT_COLOR, VERDICT_RANK } from '../utils/verdict';

// ─────────────────────────────────────────────
// 선박 판정 (SafeBerth 방향 C, 2026-09-17 · 2026-09-27 선석 현황 통합)
//
// 기존 선석 배정(항만공사 선석회의 → PORT-MIS 입항 신고의 계류시설)은 그대로 따른다.
// 배 한 척을 입항 전 → 접안 직전 → 하역 중 순서로 따라가는 화면이다.
//   [2026-09-29 밤] 시점 탭 하나로 합쳤다 — 입항 전 · 접안 직전(PORT-MIS 입항 신고 표) → 하역 중(선박위치로 본 실제 접안 목록),
//   그리고 탭 줄 끝의 확인 대기(관제사가 아직 보지 않은 판정). 예전엔 입항 선박 표와 접안 선박 목록이 위아래로 따로 있어
//   '하역 중'이 두 곳에서 다른 숫자로 보였고, 위에 번호 붙은 사용 순서 띠가 있었다(현우 9/29 지적으로 둘 다 정리).
//   아래) 사후 검토 — 실제로 있었던 날의 재생(세 시점 판정과 조치안 · 받는 곳). 데이터는 data-pipeline/data_pipeline/checks/
//      export_demo_replays.py 가 만든 public/demo/replays.json (정적 파일이라 백엔드가 꺼져 있어도 재생된다)
//
// 판정 등급은 에이전트가 정한다(assessment_history, D1). 목록의 "표 수심 여유"는
// 조위를 더하지 않은 참고값이라 판정처럼 색칠하지 않는다.
// ─────────────────────────────────────────────

const LEVEL_STYLE = {
  적합: { color: COLORS.teal, bg: '#E2F1ED' },
  주의: { color: COLORS.yellow, bg: '#FBEFD9' },
  부적합: { color: COLORS.red, bg: '#F8E2E1' },
  판정불가: { color: COLORS.purple, bg: '#ECE6F6' },
  확인요청: { color: COLORS.purple, bg: '#ECE6F6' },
};
const STAGE_LABEL = { 입항전: '입항 전', 접안직전: '접안 직전', 하역중: '하역 중' };
// 판정 이유의 첫 줄은 대개 결론을 되풀이한다("배정된 선석이 이 선박·화물 조건에 맞습니다/맞지 않습니다").
// 표에는 그 다음의 구체적인 이유 한 줄을 보인다. 전체 이유는 칩에 마우스를 올리면 보인다.
// [2026-09-29] 9/29 부터 주어가 출처대로 바뀌었다("지금 접안한 선석이", "PORT-MIS 신고 선석이").
//   옛 기록("배정된 선석이")과 백엔드가 표시용으로 고친 문장("이 선석이")까지 함께 알아본다.
const GENERIC_REASON = /^(배정된|이|지금 접안한|PORT-MIS 신고) 선석이 이 선박·화물 조건에 맞/;
function keyReason(reasons) {
  const list = (reasons || []).map(String).filter(Boolean);
  return list.find((t) => !GENERIC_REASON.test(t)) || list[0] || null;
}
const RECIPIENT_NOTE = {
  '선석 운영 주체': '선석회의 · 재배정 조정 근거',
  VTS: 'VHF 지시의 근거',
  '터미널 안전관리자': '하역 개시·중단 → 게이트',
};

function kst(iso, withDate = true) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', hour12: false,
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit',
  });
}

function LevelPill({ level }) {
  const s = LEVEL_STYLE[level] || { color: COLORS.textDim, bg: COLORS.cardHover };
  const text = level === '확인요청' ? '확인 요청' : level;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
      color: s.color, background: s.bg, borderRadius: 999, padding: '3px 10px',
      fontSize: 12, fontWeight: 700,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color }} />
      {text}
    </span>
  );
}

const th = { padding: '7px 8px', fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap' };
const td = { padding: '7px 8px', verticalAlign: 'top' };

// ── 1. 선박 판정 — 시점 탭 하나로 ─────────────────
// [2026-09-29 밤] 예전엔 위에 '입항 선박 판정' 표(시점 카드로 거르기), 아래에 '접안 선박' 목록이 따로 있었다.
//   표의 '하역 중'은 최근 입항 신고분만, 아래 목록은 지금 접안한 배 전부라 같은 시점이 두 곳에서 다른 숫자로 보였다(현우).
//   이제 시점 탭 하나가 한 자리를 바꾼다 — 입항 전 · 접안 직전은 입항 신고(PORT-MIS) 표, 하역 중은 실제 접안(선박위치) 목록.
//   확인 대기는 시점이 아니라 "관제사가 아직 보지 않은 판정"이라 탭 줄 끝에 따로 둔다(대시보드 '확인 대기 판정' 타일이 여기로 온다).
const STAGES = ['입항전', '접안직전', '하역중'];
const BAR_ORDER = ['부적합', '판정불가', '주의', '적합'];

/** 시점 탭 아래 가는 막대 — 그 시점 선박의 판정 비율(판정 전은 빈칸) */
function LevelBar({ levels, total }) {
  if (!total) return <span className="vt-bar" />;
  return (
    <span className="vt-bar" aria-hidden="true">
      {BAR_ORDER.map((lv) => (levels[lv] ? (
        <i key={lv} style={{ width: `${(levels[lv] / total) * 100}%`, background: VERDICT_COLOR[lv] }} />
      ) : null))}
    </span>
  );
}

function UpcomingSection({ initialTab }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [scope, setScope] = useState('onsan');
  // 화면에서 바로 요청한 판정의 진행 상태 — { [call_sign]: 'busy' | { error } }
  const [judging, setJudging] = useState({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => fetchUpcomingArrivals()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    load();
    const id = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [reloadKey]);

  // 확인 대기 — 판정 감시가 기록했는데 관제사가 아직 확인하지 않은 판정(선박마다 가장 최근 것)
  const [pending, setPending] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchPendingApprovals()
      .then((rows) => { if (alive) setPending(rows); })
      .catch(() => { if (alive) setPending(null); });
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const pendingRows = useMemo(() => {
    const m = new Map();
    for (const r of pending ?? []) {
      const key = normKey(r.call_sign || r.vessel_name || String(r.id));
      const cur = m.get(key);
      if (!cur || String(r.assessed_at_utc) > String(cur.assessed_at_utc)) m.set(key, r);
    }
    return [...m.values()].sort((a, b) => (VERDICT_RANK[a.level] ?? 9) - (VERDICT_RANK[b.level] ?? 9)
      || String(b.assessed_at_utc).localeCompare(String(a.assessed_at_utc)));
  }, [pending]);

  const requestConsole = useSensorStore((st) => st.requestConsole);
  const tracked = useSensorStore((st) => st.trackedVessel);
  const trackVessel = useSensorStore((st) => st.trackVessel);
  const demo = useDemoCargo();
  // 판정 감시 작업은 10분마다 "지금 항내에 있는 배"만 훑는다. 아직 오지 않은 배는 관제사가
  // 여기서 직접 판정을 요청한다 — 결과는 판정 이력에 남고 표가 다시 읽는다.
  const setJudgeBusy = useSensorStore((st) => st.setJudgeBusy);
  const focus = useSensorStore((st) => st.reasoningFocus);
  const judge = async (r) => {
    const key = r.call_sign;
    setJudging((m) => ({ ...m, [key]: 'busy' }));
    setJudgeBusy(key, true);
    try {
      await postAssessAndRecord({
        callSign: r.call_sign, vesselName: r.vessel_name, draughtM: r.draught_m,
        chemId: r.chem_id, casNo: r.cas_no, cargoName: r.cargo_name,
        wharfName: r.wharf_name || r.facility_name,
        // 이 행의 화물 전부 · PORT-MIS 사전배정 선석 · 이 행의 입항 건 — 표에 같은 입항 건 판정만 붙는다
        cargos: r.cargos || [], targetSource: 'PORT-MIS', portCallKey: r.port_call_key,
      });
      setJudging((m) => { const n = { ...m }; delete n[key]; return n; });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setJudging((m) => ({ ...m, [key]: { error: e.message } }));
    } finally {
      setJudgeBusy(key, false);
    }
  };
  // 판정을 요청할 수 없는 이유 — 지어내지 않고 무엇이 없는지 말한다
  const cannotJudge = (r) => {
    if (!(r.wharf_name || r.facility_name)) return '계류시설 없음';
    if (!(Number(r.draught_m) > 0)) return '흘수 없음';
    if (!(r.chem_id || r.cas_no)) return '화물 미확인';
    return null;
  };

  const items = data?.items || [];
  // 범위 = PORT-MIS 입항 신고의 계류시설 기준(백엔드 arrivals: facility_type · is_onsan).
  //   berth  울산항 계류시설 — 부두·돌핀·부이로 신고한 배(정박지·미확인 신고 제외)
  //   onsan  그중 온산항 계류시설
  //   all    정박지 포함 전체 — 액체화물선 입항 신고 전부
  const inScope = useMemo(() => items.filter((r) => (
    scope === 'all' ? true : scope === 'onsan' ? r.is_onsan : r.facility_type === 'BERTH'
  )), [items, scope]);

  // 하역 중 = 지금 선석에 접안한 배(항만공사 선박위치) — 선석 현황판·지도와 같은 자료
  const { berths, thread } = useVesselThread();
  const berthed = useMemo(() => berths
    .filter((b) => (scope === 'onsan' ? b.port_name === '온산항' : true))
    .flatMap((b) => (b.slots || []).filter((s) => s.call_sign)), [berths, scope]);

  const [tab, setTab] = useState(initialTab || '입항전');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);

  // 탭마다 척수와 판정 비율
  const tabStats = useMemo(() => {
    const out = {};
    for (const k of ['입항전', '접안직전']) {
      const rows = inScope.filter((r) => r.stage === k);
      const levels = {};
      rows.forEach((r) => { const lv = r.assessment?.level; if (lv) levels[lv] = (levels[lv] || 0) + 1; });
      out[k] = { n: rows.length, levels };
    }
    const levels = {};
    berthed.forEach((s) => { if (s.status) levels[s.status] = (levels[s.status] || 0) + 1; });
    out['하역중'] = { n: berthed.length, levels };
    return out;
  }, [inScope, berthed]);
  const shown = useMemo(() => inScope.filter((r) => r.stage === tab), [inScope, tab]);

  // 추적 띠·경고에서 넘어오면 그 배의 시점 탭을 열고 그 줄로 간다
  const threadFocus = useSensorStore((st) => st.threadFocus);
  useEffect(() => {
    if (!['verdict', 'cargo'].includes(threadFocus?.target) || !tracked?.callsgn) return undefined;
    const stage = thread?.slot ? '하역중' : thread?.arrival?.stage;
    if (stage && STAGES.includes(stage)) setTab(stage);
    if (threadFocus.target === 'cargo') return undefined;   // 화물 혼재 카드가 스스로 내려간다(ShipCargoPanel)
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      const row = [...document.querySelectorAll('tr[data-cs]')].find((tr) => normKey(tr.dataset.cs) === normKey(tracked.callsgn));
      if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); clearInterval(id); }
      if (tries > 20) clearInterval(id);
    }, 400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadFocus?.at, threadFocus?.target, tracked?.callsgn]);

  // 확인 대기 행의 [근거] — 그 배가 있는 표와 같은 입력(선석·흘수·화물)으로 판단 과정을 연다
  const { data: dash } = useDashboardData();
  const openReasoning = (row) => {
    const cs = normKey(row.call_sign);
    const arr = items.find((r) => normKey(r.call_sign) === cs);
    const slot = berths.flatMap((b) => (b.slots || []).map((s) => ({ ...s, wharf_name: b.wharf_name })))
      .find((s) => normKey(s.call_sign) === cs);
    const record = {
      level: row.level, stage: row.stage, action: row.action, recipient: row.recipient,
      assessed_at_utc: row.assessed_at_utc, acknowledged_by: row.acknowledged_by || null,
    };
    if (slot) {
      const tv = (dash?.real_traffic || []).find((t) => normKey(t.callsgn) === cs);
      requestConsole(row.call_sign, slot.cargo_chem_id ? { chem_id: slot.cargo_chem_id, name: slot.cargo_name } : null, {
        subject: {
          vessel_name: slot.vessel_name, wharf: slot.wharf_name, draught_m: tv?.draught_m ?? null,
          cargo: slot.cargo_chem_id ? { chem_id: slot.cargo_chem_id, name: slot.cargo_name } : null,
        },
        record,
      });
    } else if (arr) {
      requestConsole(arr.call_sign, arr.chem_id ? { chem_id: arr.chem_id, name: arr.cargo_name } : null, {
        subject: {
          vessel_name: arr.vessel_name, wharf: arr.wharf_name || arr.facility_name, draught_m: arr.draught_m, source: 'PORT-MIS',
          cargo: arr.chem_id || arr.cas_no ? { chem_id: arr.chem_id, cas_no: arr.cas_no, name: arr.cargo_name } : null,
          cargos: arr.cargos || [],
        },
        record,
      });
    } else {
      requestConsole(row.call_sign, null, { record });
    }
  };

  const scopes = [
    ['onsan', `온산 ${data?.onsan_count ?? ''}`.trim(), '온산 계류시설'],
    ['berth', `울산항 ${data?.berth_count ?? ''}`.trim(), '울산항 계류시설(정박지 제외)'],
    ['all', `전체 ${data?.count ?? ''}`.trim(), '정박지 포함 전체'],
  ];
  const liveOf = (k) => (k === '하역중'
    ? berthed.some((s) => judging[s.call_sign] === 'busy' || focus?.callsgn === s.call_sign)
    : items.some((r) => r.stage === k && (judging[r.call_sign] === 'busy' || focus?.callsgn === r.call_sign)));

  return (
    <div className="glass-card">
      <div className="glass-card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 className="glass-card-title" style={{ display: 'flex', alignItems: 'center', fontSize: 18, margin: 0 }}>
          선박 판정
          <HelpTip title="선박 판정">
            <div>기존 선석 배정(선석회의 · PORT-MIS 신고)은 그대로 따릅니다. 선박 한 척을 <strong>입항 전 → 접안 직전 → 하역 중</strong> 순서로 다시 판정하고,
            기상·조위·흘수·인접 화물이 기준을 벗어나면 조치안을 만들어 권한 있는 곳 — 선석 운영 주체 · VTS · 터미널 — 에 근거와 함께 넘깁니다.</div>
            <div style={{ marginTop: 4 }}>시점은 사실로 정합니다 — 입항 전(입항 예정 시각 전) · 접안 직전(입항 시각이 지났거나 묘박 대기)은 PORT-MIS 입항 신고(12시간 전 ~ 72시간 뒤),
            하역 중은 항만공사 선박위치로 본 실제 접안입니다.</div>
            <div style={{ marginTop: 4 }}>세 시점은 조치안을 받는 곳이 다릅니다 — 입항 전은 선석 운영 주체(선석 조정), 접안 직전은 VTS(접안 · 대기 지시), 하역 중은 터미널 안전관리자(하역 개시 · 중단 → 게이트).</div>
            <div style={{ marginTop: 4 }}>확인 대기는 판정 감시가 기록했지만 관제사가 아직 확인하지 않은 판정입니다. 판정 옆 [근거]를 누르면 선석 → 기상 → 혼재 → 종합 순서로 판단 과정이 열리고, 거기서 [판정 확인]을 남깁니다.</div>
            <div style={{ marginTop: 4 }}>판정이 없는 선박은 [판정 요청]으로 그 자리에서 판정하고 결과는 판정 이력에 남습니다.</div>
          </HelpTip>
        </h2>
        {tab !== 'pending' && (
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
            {scopes.map(([key, label, full]) => (
              <button
                key={key} type="button" onClick={() => setScope(key)} title={full}
                style={{
                  border: `1px solid ${scope === key ? COLORS.navy : COLORS.border}`,
                  background: scope === key ? COLORS.navy : COLORS.card,
                  color: scope === key ? COLORS.white : COLORS.textSecondary,
                  borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                }}
              >{label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="verdict-tabs" role="tablist" aria-label="판정 시점">
        {STAGES.map((k, i) => {
          const st = tabStats[k] || { n: 0, levels: {} };
          return (
            <div key={k} className="vt-wrap">
              {i > 0 && <span className="vt-arrow" aria-hidden="true" />}
              <button
                type="button" role="tab" aria-selected={tab === k}
                className={`vt-tab${tab === k ? ' on' : ''}${liveOf(k) ? ' stage-live' : ''}`}
                onClick={() => setTab(k)}
              >
                <span className="vt-label">{STAGE_LABEL[k]}</span>
                <span className="vt-num">{data || k === '하역중' ? st.n : '-'}<small>척</small></span>
                <LevelBar levels={st.levels} total={st.n} />
              </button>
            </div>
          );
        })}
        <div className="vt-wrap vt-inbox-wrap">
          <button
            type="button" role="tab" aria-selected={tab === 'pending'}
            className={`vt-tab vt-inbox${tab === 'pending' ? ' on' : ''}`}
            onClick={() => setTab('pending')}
          >
            <span className="vt-label">확인 대기</span>
            <span className="vt-num">{pending ? pendingRows.length : '-'}<small>척</small></span>
            <LevelBar
              levels={pendingRows.reduce((acc, r) => { acc[r.level] = (acc[r.level] || 0) + 1; return acc; }, {})}
              total={pendingRows.length}
            />
          </button>
        </div>
      </div>

      {tab === '하역중' && (
        <div id="berthed"><BerthOccupiedList scope={scope === 'onsan' ? 'onsan' : 'all'} bare /></div>
      )}

      {tab === 'pending' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>
                <th style={th}>판정(KST)</th>
                <th style={th}>선박</th>
                <th style={th}>시점</th>
                <th style={th}>선석</th>
                <th style={{ ...th, minWidth: 160 }}>판정</th>
                <th style={{ ...th, minWidth: 200 }}>조치안 → 받는 곳</th>
              </tr>
            </thead>
            <tbody>
              {pendingRows.map((r) => (
                <tr
                  key={r.id}
                  data-cs={r.call_sign}
                  onClick={() => trackVessel({ callsgn: r.call_sign, vessel_name: r.vessel_name })}
                  className={['row-pick', tracked && normKey(tracked.callsgn) === normKey(r.call_sign) ? 'row-track' : ''].join(' ').trim()}
                  style={{ borderBottom: `1px solid ${COLORS.border}` }}
                >
                  <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' }}>{kst(r.assessed_at_utc)}</td>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{r.vessel_name || '(선명 미상)'}</div>
                    <div style={{ fontSize: 11, color: COLORS.textDim }}>{r.call_sign}</div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{STAGE_LABEL[r.stage] || r.stage || '-'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.wharf_name || '-'}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <LevelPill level={r.level} />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); trackVessel({ callsgn: r.call_sign, vessel_name: r.vessel_name }); openReasoning(r); }}
                        title="왜 이 판정인지 선석 → 기상 → 혼재 순서로 보고 [판정 확인]을 남깁니다"
                        style={{ border: 'none', background: 'transparent', color: COLORS.navy, padding: 0, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        근거
                      </button>
                    </span>
                    {keyReason(r.reasons) && (
                      <div style={{ fontSize: 11.5, color: COLORS.textSecondary, marginTop: 3, maxWidth: 320 }}>{keyReason(r.reasons).slice(0, 90)}</div>
                    )}
                  </td>
                  <td style={{ ...td, fontSize: 12 }}>
                    {r.action ? <>{r.action}{r.recipient && <> → <strong>{r.recipient}</strong></>}</> : <span style={{ color: COLORS.textDim }}>-</span>}
                  </td>
                </tr>
              ))}
              {pending && pendingRows.length === 0 && (
                <tr><td style={{ ...td, color: COLORS.textDim }} colSpan={6}>확인할 판정이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(tab === '입항전' || tab === '접안직전') && (
        <>
          {error && (
            <p style={{ color: COLORS.red, fontSize: 13 }}>
              입항 예정 목록을 불러오지 못했습니다 — 관제 서버에 연결할 수 없습니다.
            </p>
          )}
          {!error && data && data.has_assessment_history === false && (
            <p style={{ color: COLORS.textDim, fontSize: 12, margin: '0 0 8px' }}>
              판정 이력 저장이 아직 연결되지 않아 판정 열은 비어 있습니다.
            </p>
          )}

          <div style={{ overflowX: 'auto' }} id="arrival-table">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>
                  <th style={th}>입항(KST)</th>
                  <th style={th}>선박</th>
                  <th style={th}>신고</th>
                  <th style={th}>화물<SyntheticChip /></th>
                  <th style={th}>사전배정 계류시설</th>
                  <th style={th}>수심</th>
                  <th style={th}>흘수</th>
                  <th style={th}>표 수심 여유</th>
                  <th style={{ ...th, minWidth: 150 }}>판정 · 조치안</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={`${r.call_sign}-${r.arrival_at_utc}`}
                    data-cs={r.call_sign}
                    onClick={() => trackVessel({ callsgn: r.call_sign, vessel_name: r.vessel_name })}
                    className={[
                      'row-pick',
                      tracked?.callsgn === r.call_sign ? 'row-track' : '',
                      focus?.callsgn === r.call_sign ? 'row-focus' : '',
                      judging[r.call_sign] === 'busy' || (focus?.callsgn === r.call_sign && focus.loading) ? 'row-busy' : '',
                    ].join(' ').trim() || undefined}
                    style={{ borderBottom: `1px solid ${COLORS.border}` }}
                  >
                    <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' }}>{kst(r.arrival_at_utc)}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{r.vessel_name || '(선명 미상)'}</div>
                      <div style={{ fontSize: 11, color: COLORS.textDim }}>{r.ship_kind} · {r.call_sign}</div>
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: r.report_type === '최종' ? COLORS.textPrimary : COLORS.textSecondary }}>{r.report_type || '-'}</td>
                    {/* 이 입항 건에 단 화물 전부 — 입항 후 위치 화면과 같은 키(입항 건)라 같은 화물이다 */}
                    <td style={{ ...td, maxWidth: 200 }} title={cargoNames(r.cargos).join(', ')}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.cargos?.length ? cargoFit(r.cargos, 17) : <span style={{ color: COLORS.textDim }}>미확인</span>}
                      </div>
                      <DemoChip entries={demo.ofShip(r.call_sign)} />
                    </td>
                    <td style={td}>
                      <div>{r.wharf_name || r.facility_name}</div>
                      {r.wharf_name && r.facility_name !== r.wharf_name && (
                        <div style={{ fontSize: 11, color: COLORS.textDim }}>신고 표기 {r.facility_name}</div>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace' }}>{r.depth_m != null ? `${r.depth_m} m` : '-'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{r.draught_m != null ? `${r.draught_m} m` : '없음'}</span>
                      <div style={{ fontSize: 11, color: COLORS.textDim }}>{r.draught_basis || '미신고'}</div>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', color: COLORS.textSecondary }}>
                      {/부이/.test(r.wharf_name || r.facility_name || '')
                        ? <span style={{ fontFamily: 'inherit', color: COLORS.textDim }}>해당 없음(부이)</span>
                        : r.chart_margin_m != null ? `${r.chart_margin_m >= 0 ? '+' : ''}${r.chart_margin_m.toFixed(2)} m` : '-'}
                    </td>
                    <td style={td}>
                      {r.assessment ? (
                        <div title={(r.assessment.reasons || []).join('\n')}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <LevelPill level={r.assessment.level} />
                            {r.assessment.level !== '적합' && (() => {
                              const d = demo.around(r.call_sign, r.wharf_name || r.facility_name);
                              return d.any ? <DemoChip derived entries={[...d.own, ...d.near]} /> : null;
                            })()}
                            <button
                              type="button"
                              onClick={() => requestConsole(r.call_sign, r.chem_id ? { chem_id: r.chem_id, name: r.cargo_name } : null, {
                                subject: {
                                  vessel_name: r.vessel_name, wharf: r.wharf_name || r.facility_name, draught_m: r.draught_m,
                                  // 이 표의 계류시설은 PORT-MIS 사전배정이다 — 판정 문구가 "배정된 선석"이 된다(2026-09-29)
                                  source: 'PORT-MIS',
                                  cargo: r.chem_id || r.cas_no ? { chem_id: r.chem_id, cas_no: r.cas_no, name: r.cargo_name } : null,
                                  cargos: r.cargos || [],
                                },
                                record: r.assessment,
                              })}
                              title="왜 이 판정인지 선석 → 기상 → 혼재 순서로 봅니다"
                              style={{ border: 'none', background: 'transparent', color: COLORS.navy, padding: 0, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
                            >
                              근거
                            </button>
                          </span>
                          {/* 적합은 칩만 — 같은 문장이 줄마다 반복되던 것을 없앴다. 벗어난 배만 이유와 조치안을 보인다. */}
                          {r.assessment.level !== '적합' && keyReason(r.assessment.reasons) && (
                            <div style={{ fontSize: 11.5, color: COLORS.textSecondary, marginTop: 3, maxWidth: 280 }}>
                              {keyReason(r.assessment.reasons).slice(0, 90)}
                            </div>
                          )}
                          {r.assessment.level !== '적합' && r.assessment.action && (
                            <div style={{ fontSize: 11.5, marginTop: 2, maxWidth: 280 }}>
                              <span style={{ color: COLORS.textDim }}>조치안</span> {r.assessment.action}
                              {r.assessment.recipient && <> → <strong>{r.assessment.recipient}</strong></>}
                            </div>
                          )}
                        </div>
                      ) : judging[r.call_sign] === 'busy' ? (
                        <span style={{ color: COLORS.info, fontSize: 12 }}>판정 중… (10~20초)</span>
                      ) : cannotJudge(r) ? (
                        <span style={{ color: COLORS.textDim, fontSize: 12, whiteSpace: 'nowrap' }} title="판정에 필요한 값이 없습니다 — 판정불가">
                          판정불가 · {cannotJudge(r)}
                        </span>
                      ) : (
                        <div>
                          <button
                            type="button" onClick={() => judge(r)}
                            style={{ border: `1px solid ${COLORS.navy}`, background: COLORS.card, color: COLORS.navy, borderRadius: 4, padding: '3px 9px', fontSize: 12, cursor: 'pointer' }}
                            title="지금 이 배를 판정합니다 — 결과는 판정 이력에 남습니다"
                          >
                            판정 요청
                          </button>
                          {judging[r.call_sign]?.error && (
                            <div style={{ fontSize: 11, color: COLORS.red, marginTop: 3, maxWidth: 260 }}>{judging[r.call_sign].error}</div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {data && shown.length === 0 && (
                  <tr><td style={{ ...td, color: COLORS.textDim }} colSpan={9}>이 범위에 {STAGE_LABEL[tab]} 선박이 없습니다.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── 2. 실제로 있었던 날 재생 ────────────────────
function StageCard({ stage }) {
  const note = RECIPIENT_NOTE[stage.recipient];
  return (
    <article style={{
      border: `1px solid ${stage.gate === 'LOCKED' ? COLORS.red : COLORS.border}`, borderRadius: 6,
      background: COLORS.card, display: 'grid', gridTemplateRows: 'auto 1fr auto',
    }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardHover, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{stage.label}</div>
          {stage.at && <div style={{ fontSize: 11, color: COLORS.textDim, fontFamily: 'ui-monospace, Consolas, monospace' }}>{kst(stage.at)}</div>}
        </div>
        <span style={{ marginLeft: 'auto' }}><LevelPill level={stage.level} /></span>
      </header>
      <ul style={{ margin: 0, padding: '10px 12px 10px 28px', fontSize: 13, display: 'grid', gap: 4 }}>
        {stage.facts.map((f) => <li key={f}>{f}</li>)}
        {stage.basis_note && <li style={{ color: COLORS.textDim, fontSize: 12 }}>{stage.basis_note}</li>}
      </ul>
      <footer style={{ padding: '10px 12px', borderTop: `1px solid ${COLORS.border}`, fontSize: 13, display: 'grid', gap: 4 }}>
        <div><span style={{ color: COLORS.textDim, fontSize: 11, marginRight: 6 }}>조치안</span>{stage.action || '없음 — 배정대로 진행'}</div>
        <div>
          <span style={{ color: COLORS.textDim, fontSize: 11, marginRight: 6 }}>받는 곳</span>
          <strong>{stage.recipient}</strong>{note && <span style={{ color: COLORS.textDim }}> · {note}</span>}
        </div>
        {stage.gate && (
          <div>
            <span style={{ color: COLORS.textDim, fontSize: 11, marginRight: 6 }}>게이트</span>
            <strong style={{ color: stage.gate === 'LOCKED' ? COLORS.red : stage.gate === 'CAUTION' ? COLORS.yellow : COLORS.teal }}>
              {stage.gate === 'LOCKED' ? '닫힘 (하역 개시 요청 거부)' : stage.gate === 'CAUTION' ? '주의 — 개시 전 확인' : '열림 가능'}
            </strong>
          </div>
        )}
      </footer>
    </article>
  );
}

function VesselReplay({ replay }) {
  const series = replay.tide_series;
  const nearest = (iso) => {
    const target = new Date(iso).getTime();
    return series.reduce((best, p) => (
      Math.abs(new Date(p.t).getTime() - target) < Math.abs(new Date(best.t).getTime() - target) ? p : best
    ), series[0]);
  };
  const arrival = nearest(replay.arrival);
  const low = nearest(replay.stages.find((s) => s.key === 'cargo_ops').at);
  const minY = Math.floor(Math.min(0, ...series.map((p) => p.margin_m)) * 2) / 2;
  const maxY = Math.ceil(Math.max(replay.margin_threshold_m + 0.5, ...series.map((p) => p.margin_m)) * 2) / 2;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: 13, color: COLORS.textSecondary }}>
        <span><strong style={{ color: COLORS.textPrimary }}>{replay.vessel.name}</strong> · {replay.vessel.kind}</span>
        <span>{replay.berth.name} · 표 수심 {replay.berth.depth_m} m</span>
        <span>흘수 {replay.draught.m} m ({replay.draught.basis})</span>
        <span>입항 {kst(replay.arrival)} → 출항 {kst(replay.departure)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {replay.stages.map((s) => <StageCard key={s.key} stage={s} />)}
      </div>
      <figure style={{ margin: 0 }}>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 16, right: 24, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
              <XAxis dataKey="t" tickFormatter={(v) => kst(v)} minTickGap={48} tick={{ fontSize: 11, fill: COLORS.textDim }} />
              <YAxis domain={[minY, maxY]} tickFormatter={(v) => `${v.toFixed(1)}`} tick={{ fontSize: 11, fill: COLORS.textDim }} width={44} unit=" m" />
              <Tooltip
                labelFormatter={(v) => kst(v)}
                formatter={(v, name) => [`${v >= 0 ? '+' : ''}${Number(v).toFixed(2)} m`, name === 'margin_m' ? '흘수 여유' : '조위']}
                contentStyle={{ backgroundColor: '#FFFFFF', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.textPrimary, fontSize: 12 }}
              />
              <ReferenceLine y={replay.margin_threshold_m} stroke={COLORS.yellow} strokeDasharray="6 4"
                label={{ value: `기준 여유 ${replay.margin_threshold_m} m`, position: 'insideTopRight', fill: COLORS.yellow, fontSize: 11 }} />
              <ReferenceLine y={0} stroke={COLORS.red} strokeOpacity={0.5} />
              <Line type="monotone" dataKey="margin_m" stroke={COLORS.navy} strokeWidth={2} dot={false} isAnimationActive={false} />
              <ReferenceDot x={arrival.t} y={arrival.margin_m} r={6} fill={COLORS.teal} stroke="#fff"
                label={{ value: `접안 ${arrival.margin_m >= 0 ? '+' : ''}${arrival.margin_m.toFixed(2)} m`, position: 'top', fill: COLORS.teal, fontSize: 11 }} />
              <ReferenceDot x={low.t} y={low.margin_m} r={6} fill={low.margin_m < 0 ? COLORS.purple : COLORS.yellow} stroke="#fff"
                label={{ value: `최저 ${low.margin_m >= 0 ? '+' : ''}${low.margin_m.toFixed(2)} m`, position: 'bottom', fill: low.margin_m < 0 ? COLORS.purple : COLORS.yellow, fontSize: 11 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <figcaption style={{ fontSize: 11.5, color: COLORS.textDim }}>
          흘수 여유 (m) · 점선 = 기준 1 m
        </figcaption>
      </figure>
    </div>
  );
}

function SwellReplay({ replay }) {
  const { summary } = replay;
  const data = replay.days.map((d) => ({ ...d, label: d.date.slice(5).replace('-', '/') }));
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {[
          ['평상시 하루 입항', summary.normal_avg, `${summary.normal_days}일 평균`, COLORS.textPrimary],
          ['너울 기간 하루 입항', summary.swell_avg, `${summary.swell_days}일 평균 · 외해 파고 ≥ ${replay.threshold_m} m`, COLORS.yellow],
          ['해소 직후', summary.peak_arrivals, `${summary.peak_date.slice(5).replace('-', '/')} · 기간 최대`, COLORS.red],
        ].map(([label, value, sub, color]) => (
          <div key={label} style={{ borderTop: `2px solid ${color}`, padding: '8px 2px' }}>
            <div style={{ fontSize: 12, color: COLORS.textDim }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: 'ui-monospace, Consolas, monospace' }}>
              {value}<span style={{ fontSize: 13, color: COLORS.textDim, marginLeft: 4 }}>척</span>
            </div>
            <div style={{ fontSize: 11, color: COLORS.textDim }}>{sub}</div>
          </div>
        ))}
      </div>
      <figure style={{ margin: 0 }}>
        <div style={{ height: 250 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: COLORS.textDim }} minTickGap={16} />
              <YAxis yAxisId="n" tick={{ fontSize: 11, fill: COLORS.textDim }} width={36} />
              <YAxis yAxisId="w" orientation="right" domain={[0, 4]} tick={{ fontSize: 11, fill: COLORS.textDim }} width={36} unit=" m" />
              <Tooltip
                formatter={(v, name) => (name === 'arrivals' ? [`${v}척`, '액체화물선 입항'] : [`${v} m`, '외해 유의파고 일평균'])}
                contentStyle={{ backgroundColor: '#FFFFFF', border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.textPrimary, fontSize: 12 }}
              />
              <ReferenceLine yAxisId="w" y={replay.threshold_m} stroke={COLORS.yellow} strokeDasharray="6 4" />
              <Bar yAxisId="n" dataKey="arrivals" isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={d.date} fill={d.swell ? COLORS.yellow : d.date === summary.peak_date ? COLORS.red : '#9CC3DE'} />
                ))}
              </Bar>
              <Line yAxisId="w" type="monotone" dataKey="wave_avg_m" stroke={COLORS.navy} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <figcaption style={{ fontSize: 11.5, color: COLORS.textDim }}>
          막대 입항 척수(주황 = 너울일) · 선 외해 파고(오른쪽 축)
        </figcaption>
      </figure>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {replay.stages.map((s) => <StageCard key={s.key} stage={s} />)}
      </div>
    </div>
  );
}

function ReplaySection() {
  // 실무 화면이 아니라 교육·사후 검토용(9/27 현우 결정) — 아래에 접어 두고, 펼칠 때만 자료를 읽는다.
  const [open, setOpen] = useState(false);
  const [replays, setReplays] = useState(null);
  const [active, setActive] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || replays) return;
    fetch('/demo/replays.json')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { setReplays(d); setActive(d.replays[0]?.id); })
      .catch((e) => setError(e.message));
  }, [open, replays]);

  const current = replays?.replays.find((r) => r.id === active);
  const tabLabel = (r) => (r.kind === 'swell' ? '외해 너울 9/4~9/11' : `${r.vessel.name} ${r.arrival.slice(5, 10).replace('-', '/')}`);

  return (
    <div className="glass-card">
      <div className="glass-card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3 className="glass-card-title" style={{ display: 'flex', alignItems: 'center' }}>
          <button
            type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            style={{ background: 'transparent', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span style={{ display: 'inline-block', width: 12, color: COLORS.textDim }}>{open ? '▾' : '▸'}</span>
            사후 검토 — 지난 입항 건 판정 재생
            <span style={{ fontSize: 12, fontWeight: 400, color: COLORS.textDim }}>(실측 기록 · 접어 둠)</span>
          </button>
          <HelpTip title="사후 검토">
            <div>지난 입항 건을 그날의 실측 조위·기상으로 되돌려 입항 전 → 접안 직전 → 하역 중 세 시점 판정과 조치안이 어떻게 달라졌는지 봅니다.</div>
            <div style={{ marginTop: 4 }}>쓰는 때: 사고·이의 제기가 있을 때 "그 시각에 무엇을 근거로 어떤 판정이 났는가"를 되짚을 때, 그리고 새 관제사 교육. 평소 관제에는 쓰지 않아 접어 둡니다.</div>
            <div>흘수 여유 = 표 수심 + 조위 − 흘수. 판정 기준은 조위를 반영한 흘수 여유 1.0 m(체류 중 최저 여유)입니다.</div>
            {current?.source && <div style={{ marginTop: 4 }}>{current.source}</div>}
            {current?.caveat && <div style={{ marginTop: 4 }}>{current.caveat}</div>}
            {replays && (
              <div style={{ marginTop: 4, color: COLORS.textSecondary }}>
                재생 자료 기준일 {new Date(replays.generated_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })}
              </div>
            )}
          </HelpTip>
        </h3>
        {open && <div role="tablist" style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {replays?.replays.map((r) => (
            <button
              key={r.id} type="button" role="tab" aria-selected={active === r.id} onClick={() => setActive(r.id)}
              style={{
                border: `1px solid ${active === r.id ? COLORS.navy : COLORS.border}`,
                background: active === r.id ? COLORS.navy : COLORS.card,
                color: active === r.id ? COLORS.white : COLORS.textSecondary,
                borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              }}
            >{tabLabel(r)}</button>
          ))}
        </div>}
      </div>
      {open && error && <p style={{ color: COLORS.red, fontSize: 13 }}>재생 데이터를 불러오지 못했습니다 ({error}).</p>}
      {open && current && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{current.headline}</p>
          {current.kind === 'swell' ? <SwellReplay replay={current} /> : <VesselReplay replay={current} />}
        </div>
      )}
    </div>
  );
}

export default function ArrivalVerificationPage() {
  const review = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('review') === '1';
  // 대시보드 '확인 대기 판정' 타일은 ?view=pending 으로 온다
  const [params] = useSearchParams();
  const initialTab = params.get('view') === 'pending' ? 'pending' : null;
  const trackedCs = useSensorStore((st) => st.trackedVessel?.callsgn);
  return (
    <div className="dashboard-page">
      {/* [2026-09-29 밤] 사용 순서 띠(1 입항 선박 → … → 5 게이트)를 뺐다 — 선박 추적 띠와 시점 탭이 같은 흐름을
          자리와 색으로 보이므로 번호 띠는 같은 말을 한 번 더 하는 글이었다(현우). */}
      <div className="dash-section"><UpcomingSection initialTab={initialTab} /></div>
      {/* [2026-09-30] 화물 혼재 심사를 이 화면 안으로 합쳤다 — 추적 중인 배 한 척의 혼재 근거와 대체 선석 검토.
          배를 고르지 않았으면 볼 대상이 없어 카드가 없다. */}
      {trackedCs && <div className="dash-section" id="cargo"><ShipCargoPanel /></div>}
      {/* 부두별 접안 이력은 대시보드 선석 상세 서랍으로 옮겼다 — 보고서·영상 촬영용으로만 ?review=1 */}
      {review && <div className="dash-section"><GanttChart /></div>}
      {/* [2026-09-29] 사후 검토는 실측 기록 재생이라 실제 시스템에도 있을 기능 — 숨기지 않고 접어서 둔다(현우) */}
      <div className="dash-section"><ReplaySection /></div>
      {/* 판단 과정 서랍 — 판정 옆 [근거]로 연다(2026-09-28: 전 화면 떠 있는 창에서 이 화면으로 옮겼다) */}
      <AgentConsole mode="reasoning" />
    </div>
  );
}
