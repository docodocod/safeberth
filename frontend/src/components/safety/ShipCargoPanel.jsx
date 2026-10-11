import { useEffect, useMemo, useRef, useState } from 'react';
import useOnsanApi from '../../hooks/useOnsanApi';
import { fetchAdjacentCargos, fetchAlternativeBerths } from '../../api/backendAdapter';
import useDashboardData from '../../hooks/useDashboardData';
import useSensorStore from '../../stores/useSensorStore';
import useVesselThread, { normKey } from '../../hooks/useVesselThread';
import { COLORS } from '../../utils/constants';
import { berthKey } from '../../utils/verdict';
import SafetyResult, { RISK_STYLE } from './SafetyResult';
import HelpTip from '../common/HelpTip';
import { FaShieldAlt } from 'react-icons/fa';

// ─────────────────────────────────────────────────────────────────────────────
// 고른 선박의 화물 혼재 (2026-09-30) — 선박 판정 화면 안
//
// 예전 '화물 혼재 심사'는 따로 떨어진 화면이었고, 거기서 배를 또 고르거나 화물 · 선석 · 이웃 화물을 손으로 넣었다.
// 그래서 추적 띠에 올린 배와 심사하는 배가 달라질 수 있었다(현우 9/30: "이미 선박을 하나 골라 흐름을 진행 중인데
// 왜 또 골라서 심사하나"). 이제 대상은 늘 추적 중인 배 한 척이다.
//   혼재 근거      그 배의 선석(지금 접안 또는 사전배정) · 실은 화물 전부 · 실제 이웃 화물 — 선박 판정의 혼재 단계와 같은 입력
//   대체 선석 검토  그 배를 다른 선석에 대면 어떻게 되나. 고를 수 있는 선석은 선석 검증 에이전트가 낸 후보뿐이고
//                  (수심 · 취급 화물 · 점유), 이웃 화물은 그 선석의 실제 이웃이다. 배정이 아니라 제안 검토다.
// 직접 입력 칸은 없다 — 선택지는 그 배의 상황이 정한다.
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_TEXT = { 입항전: '입항 전', 접안직전: '접안 직전', 하역중: '하역 중' };
const CACHE_MS = 5 * 60 * 1000;
const basisCache = new Map();   // `${callsgn}|${berth}|${화물}` → { at, result, adjacent, full }

const uniqCargos = (list) => {
  const out = [];
  for (const c of list || []) {
    if (c?.chem_id && !out.some((x) => x.chem_id === c.chem_id)) out.push({ chem_id: c.chem_id, cas_no: c.cas_no ?? null, name: c.name || c.cargo_name || c.chem_id });
  }
  return out;
};

/** 추적 중인 배 → 심사 대상(선석 · 화물 · 흘수). 판정 표와 같은 출처 순서로 고른다 */
function subjectOf(thread, dash) {
  if (!thread) return null;
  const cs = thread.callsgn;
  const berthRows = (dash?.berth_cargo ?? []).filter((r) => normKey(r.callsgn) === normKey(cs));
  const sources = thread.slot
    ? [thread.traffic?.cargos, berthRows, thread.arrival?.cargos]      // 접안 중 — 지금 입항 건 화물
    : [thread.arrival?.cargos, thread.traffic?.cargos, berthRows];     // 입항 전 — 입항 신고 건 화물
  const raw = sources.find((s) => (s || []).length) || [];
  const cargos = uniqCargos(raw);
  return {
    callsgn: cs,
    name: thread.name,
    berth: thread.berth,
    berthSource: thread.slot ? '지금 접안' : thread.arrival ? '사전배정' : null,
    stage: thread.stage,
    level: thread.level,
    cargos,
    unidentified: Math.max(0, raw.length - raw.filter((c) => c?.chem_id).length),
    draught: Number(thread.traffic?.draught_m) > 0 ? Number(thread.traffic.draught_m)
      : Number(thread.arrival?.draught_m) > 0 ? Number(thread.arrival.draught_m) : null,
    eta: !thread.slot && thread.arrival?.arrival_at_utc ? thread.arrival.arrival_at_utc : null,
  };
}

const reqOf = (subj, berth, adjacent) => ({
  cargo_name: subj.cargos[0].name,
  chem_id: subj.cargos[0].chem_id,
  cas_no: subj.cargos[0].cas_no,
  berth_name: berth,
  adjacent_operations: adjacent || [],
  extra_cargos: subj.cargos.slice(1).map((c) => ({ chem_id: c.chem_id, cas_no: c.cas_no })),
  call_sign: subj.callsgn,
});

const signedM = (m) => `${m >= 0 ? '+' : ''}${m.toFixed(2)} m`;   // 둘째 자리까지 — 첫째 자리 반올림은 여유를 부풀린다(0.25 → 0.3)

function RiskPill({ level }) {
  const c = RISK_STYLE[level]?.color || COLORS.textDim;
  return <span className="sc-pill" style={{ color: c, borderColor: c }}>{level || '—'}</span>;
}

export default function ShipCargoPanel() {
  const { thread, berths } = useVesselThread();
  const { data: dash } = useDashboardData();
  const { assessSafetyVerdict, assessSafetyGates } = useOnsanApi();
  const threadFocus = useSensorStore((s) => s.threadFocus);
  const [tab, setTab] = useState('basis');
  const rootRef = useRef(null);

  const subject = useMemo(() => subjectOf(thread, dash),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thread?.callsgn, thread?.berth, thread?.stage, thread?.level, dash?.berth_cargo, thread?.traffic, thread?.arrival]);
  const key = subject ? `${normKey(subject.callsgn)}|${berthKey(subject.berth)}|${subject.cargos.map((c) => c.chem_id).join(',')}` : null;

  // ── 혼재 근거 — 대상이 바뀌면 바로 심사한다(등급은 규칙으로 즉시, 설명은 뒤따라 온다) ──
  const [basis, setBasis] = useState({ state: 'idle' });
  const token = useRef(0);
  useEffect(() => {
    if (!subject || !subject.berth || !subject.cargos.length) { setBasis({ state: 'idle' }); return undefined; }
    const hit = basisCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) { setBasis({ state: 'ready', ...hit, narrative: hit.full ? 'done' : 'none' }); return undefined; }
    const my = ++token.current;
    let alive = true;
    (async () => {
      setBasis({ state: 'loading' });
      try {
        const adjacent = await fetchAdjacentCargos({ wharf_name: subject.berth, call_sign: subject.callsgn });
        const req = reqOf(subject, subject.berth, adjacent);
        const quick = await assessSafetyVerdict(req);
        if (!alive || my !== token.current) return;
        if (quick) setBasis({ state: 'ready', result: quick, adjacent, narrative: 'loading' });
        const full = await assessSafetyGates(req);
        if (!alive || my !== token.current) return;
        const result = full || quick;
        if (!result) { setBasis({ state: 'error' }); return; }
        basisCache.set(key, { at: Date.now(), result, adjacent, full: Boolean(full) });
        setBasis({ state: 'ready', result, adjacent, narrative: 'done' });
      } catch {
        if (alive && my === token.current) setBasis({ state: 'error' });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ── 대체 선석 검토 — 탭을 열 때 후보를 받아 후보마다 혼재 등급을 낸다 ──
  const [alts, setAlts] = useState({ state: 'idle' });
  const [picked, setPicked] = useState(null);   // 자세히 볼 후보 선석 이름
  const altKey = useRef(null);                  // 받았거나 받는 중인 대상 — 상태가 바뀔 때마다 다시 부르지 않게
  useEffect(() => { setAlts({ state: 'idle' }); setPicked(null); altKey.current = null; }, [key]);
  useEffect(() => {
    if (tab !== 'alt' || !subject?.cargos.length || altKey.current === key) return;
    altKey.current = key;
    const mine = key;
    const done = (v) => { if (altKey.current === mine) setAlts(v); };
    if (!subject.draught) { done({ state: 'error', error: '흘수 없음' }); return; }
    (async () => {
      done({ state: 'loading' });
      try {
        const main = subject.cargos[0];
        const res = await fetchAlternativeBerths({
          draught_m: subject.draught, chem_id: main.chem_id, cas_no: main.cas_no, name_hint: subject.name,
          hours: 24, extra_cargos: subject.cargos.slice(1), exclude_wharf_name: subject.berth,
          start: subject.eta && Date.parse(subject.eta) > Date.now() ? new Date(subject.eta) : null,
        });
        const byWharf = new Map();
        for (const c of res?.candidates || []) if (!byWharf.has(c.wharf_name)) byWharf.set(c.wharf_name, c);
        const rows = await Promise.all([...byWharf.values()].map(async (c) => {
          try {
            const adjacent = await fetchAdjacentCargos({ wharf_name: c.wharf_name, call_sign: subject.callsgn });
            const verdict = await assessSafetyVerdict(reqOf(subject, c.wharf_name, adjacent));
            return { ...c, adjacent, verdict };
          } catch {
            return { ...c, adjacent: null, verdict: null };
          }
        }));
        done({ state: 'ready', rows });
      } catch (e) {
        done({ state: 'error', error: e.message });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, key]);

  // 추적 띠 · 근거 서랍 · 경고에서 넘어오면 이 카드로 온다
  useEffect(() => {
    if (threadFocus?.target !== 'cargo') return;
    setTab('basis');
    const id = setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    return () => clearTimeout(id);   // eslint-disable-line consistent-return
  }, [threadFocus?.at, threadFocus?.target]);

  if (!subject) return null;

  const hereRow = berths.find((b) => berthKey(b.wharf_name) === berthKey(subject.berth));
  // 대체 후보 줄과 같은 잣대(해도 + 체류 중 최저 조위)의 여유는 판정이 흘수로 걸렸을 때만 이유 문장에 있다.
  // 없으면 해도수심만으로 계산한다 — 조위가 빠져 실제보다 조금 작게(보수적으로) 나온다.
  const judged = (thread?.reasons || []).map((r) => r.match(/선석 '([^']+)' 가용수심.*흘수여유가 (-?[\d.]+)m/))
    .find((m) => m && berthKey(m[1]) === berthKey(subject.berth));
  const hereMargin = judged ? Number(judged[2])
    : hereRow?.depth_m != null && subject.draught ? Number(hereRow.depth_m) - subject.draught : null;
  const pickedRow = alts.state === 'ready' ? alts.rows.find((r) => r.wharf_name === picked) : null;
  const noCargo = !subject.cargos.length;

  return (
    <div className="glass-card ship-cargo" ref={rootRef}>
      <div className="glass-card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h3 className="glass-card-title" style={{ display: 'flex', alignItems: 'center' }}>
          <FaShieldAlt style={{ marginRight: 8, color: COLORS.teal }} />
          {subject.name} · 화물 혼재
          <HelpTip title="화물 혼재">
            <div><strong>혼재 근거</strong> — 이 선박을 그 선석(지금 접안 또는 PORT-MIS 사전배정) · 실은 화물 전부 · 실제 이웃 선석 화물로 심사합니다.
              선박 판정의 혼재 단계와 같은 에이전트 · 같은 입력이라 결과가 같습니다.</div>
            <div style={{ marginTop: 4 }}><strong>대체 선석 검토</strong> — 이 선박을 다른 선석에 대면 어떻게 되는지 봅니다. 고를 수 있는 선석은 선석 검증 에이전트가
              수심 · 취급 화물 · 점유로 추린 후보이고, 이웃 화물은 그 선석의 실제 이웃입니다. 배정이 아니라 선석 운영 주체에 넘길 제안을 검토하는 자리이며 판정 이력에는 남지 않습니다.</div>
            <div style={{ marginTop: 4 }}>판정 기준 — 46 CFR 150 산적 호환성 그룹 · MSDS 반응성 · 포장 · 근거 미확인 시 최소 주의. IMDG 격리표는 선내 적재 규정이라 부두 사이 판정에는 참고로만 봅니다.</div>
          </HelpTip>
        </h3>
        <div className="seg" role="tablist" aria-label="보기">
          <button type="button" role="tab" aria-selected={tab === 'basis'} className={tab === 'basis' ? 'on' : ''} onClick={() => setTab('basis')}>혼재 근거</button>
          <button type="button" role="tab" aria-selected={tab === 'alt'} className={tab === 'alt' ? 'on' : ''} onClick={() => setTab('alt')} disabled={noCargo}>대체 선석 검토</button>
        </div>
      </div>

      <div className="sg-facts">
        <span><em>선석{subject.berthSource ? ` · ${subject.berthSource}` : ''}</em><strong>{subject.berth || '—'}</strong></span>
        <span><em>시점</em><strong>{STAGE_TEXT[subject.stage] || '—'}</strong></span>
        <span title={subject.cargos.map((c) => c.name).join(', ')}>
          <em>화물</em><strong>{noCargo ? '미확인' : `${subject.cargos.length}종`}</strong>
          {subject.unidentified > 0 && <small>미확인 {subject.unidentified}</small>}
        </span>
        <span className={basis.state === 'error' ? 'bad' : ''}>
          <em>이웃 화물</em>
          <strong>{basis.state === 'ready' ? `${(basis.adjacent || []).length}건` : basis.state === 'loading' ? '…' : basis.state === 'error' ? '조회 실패' : '—'}</strong>
        </span>
      </div>

      {tab === 'basis' && (
        <div style={{ marginTop: 14 }}>
          {noCargo && <p className="sc-dim">화물 미확인 — 혼재를 판정할 수 없습니다.</p>}
          {!noCargo && !subject.berth && <p className="sc-dim">선석 없음 — 접안하거나 사전배정된 선석이 있어야 심사합니다.</p>}
          {basis.state === 'loading' && <p className="sc-dim">심사 중…</p>}
          {basis.state === 'error' && <p className="sc-dim" style={{ color: COLORS.red }}>혼재 심사를 받지 못했습니다.</p>}
          {basis.state === 'ready' && (
            <SafetyResult
              result={basis.result}
              narrativeLoading={basis.narrative === 'loading'}
              berthName={subject.berth}
              cargoName={subject.cargos[0]?.name}
            />
          )}
        </div>
      )}

      {tab === 'alt' && (
        <div style={{ marginTop: 14 }}>
          {alts.state === 'loading' && <p className="sc-dim">후보 선석을 찾는 중…</p>}
          {alts.state === 'error' && <p className="sc-dim">후보를 받지 못했습니다 — {alts.error}</p>}
          {alts.state === 'ready' && (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="sc-table">
                  <thead>
                    <tr><th>선석</th><th>구분</th><th>수심 여유</th><th>점유</th><th>이웃 화물</th><th>혼재</th></tr>
                  </thead>
                  <tbody>
                    <tr className={`base${picked == null ? ' on' : ''}`} onClick={() => setPicked(null)}>
                      <td><strong>{subject.berth || '—'}</strong></td>
                      <td>{subject.berthSource || '—'}</td>
                      <td className="num">{hereMargin != null ? signedM(hereMargin) : '—'}</td>
                      <td>이 선박</td>
                      <td className="num">{basis.state === 'ready' ? `${(basis.adjacent || []).length}건` : '—'}</td>
                      <td><RiskPill level={basis.result?.risk_level} /></td>
                    </tr>
                    {alts.rows.map((r) => (
                      <tr key={r.wharf_name} className={picked === r.wharf_name ? 'on' : ''} onClick={() => setPicked(r.wharf_name)}>
                        <td><strong>{r.wharf_name}</strong></td>
                        <td>대체 후보 {r.rank}</td>
                        <td className="num">{r.draught_margin_m != null ? signedM(Number(r.draught_margin_m)) : '—'}</td>
                        <td>{r.occupancy_status || '—'}{r.conflicting_port_calls?.length ? ` · 겹침 ${r.conflicting_port_calls.length}` : ''}</td>
                        <td className="num">{r.adjacent ? `${r.adjacent.length}건` : '—'}</td>
                        <td><RiskPill level={r.verdict?.risk_level} /></td>
                      </tr>
                    ))}
                    {alts.rows.length === 0 && (
                      <tr><td colSpan={6} className="sc-dim">조건(수심 · 취급 화물 · 점유)에 맞는 대체 선석이 없습니다.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 14 }}>
                {pickedRow ? (
                  pickedRow.verdict
                    ? (
                      <SafetyResult
                        result={pickedRow.verdict} berthName={pickedRow.wharf_name} cargoName={subject.cargos[0]?.name}
                        heading={<>대체 후보 <b>{pickedRow.wharf_name}</b>에 댈 때 — 혼재 <b style={{ color: RISK_STYLE[pickedRow.verdict.risk_level]?.color }}>{pickedRow.verdict.risk_level}</b></>}
                        compact
                      />
                    )
                    : <p className="sc-dim">이 선석의 혼재 심사를 받지 못했습니다.</p>
                ) : basis.state === 'ready' ? (
                  <SafetyResult
                    result={basis.result} berthName={subject.berth} cargoName={subject.cargos[0]?.name}
                    heading={<>{subject.berthSource || '지금 선석'} <b>{subject.berth}</b> — 혼재 <b style={{ color: RISK_STYLE[basis.result?.risk_level]?.color }}>{basis.result?.risk_level}</b> <span className="sc-dim">· 표에서 후보 선석을 누르면 그 선석의 결과</span></>}
                    compact
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
