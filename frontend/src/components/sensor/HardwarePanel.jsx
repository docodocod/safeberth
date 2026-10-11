import { useEffect, useState } from 'react';
import useHardwareData from '../../hooks/useHardwareData';
import HelpTip from '../common/HelpTip';
import { COLORS } from '../../utils/constants';
import { isOperator } from '../../utils/operatorMode';
import { showDisclosure } from '../../utils/disclosure';
import DemoChip from '../common/DemoChip';
import useSensorStore from '../../stores/useSensorStore';
import useVesselThread from '../../hooks/useVesselThread';
import { useDemoCargo } from '../../utils/demoCargo';
import { FaLock, FaLockOpen, FaPlug, FaExclamationTriangle, FaFlask, FaShip } from 'react-icons/fa';

// 하역 개시 인터락 — 선석 A·B 게이트 실물(라즈베리파이 + 릴레이 + 상시닫힘 밸브 + LCD).
// 계약: 하드웨어/UI연동_전달사항_20260922.md. 판정은 백엔드가 기상 규칙·하역중 판정으로 내려 장치에 보내고,
// 장치는 잠긴 동안 어떤 열기 요청도 거부한다. 이 화면은 그 사실을 보여줄 뿐 판단하지 않는다.
//
// 2026-09-27 가독성 정리: 카드에는 상태 한 단어 + 근거 한 줄 + 배 한 줄만 두고, 기준·전체 근거·
// 장치 마지막 보고·원칙 설명은 (?) 도움말로 옮겼다(카드마다 6~7줄이라 발표 화면에서 안 읽혔다).

// 백엔드 LCD 용 근거 코드(bridge._short_reason) → 화면 핵심어
function shortReason(sent) {
  const r = sent?.reason || '';
  let m = r.match(/^WIND ([\d.]+)m\/s>=([\d.]+)/);
  if (m) return `풍속 ${m[1]} ≥ ${m[2]} m/s`;
  m = r.match(/^WAVE ([\d.]+)m>=([\d.]+)/);
  if (m) return `파고 ${m[1]} ≥ ${m[2]} m`;
  if (r.startsWith('VERDICT UNFIT')) return '하역 중 판정 부적합';
  if (r.startsWith('VERDICT UNKNOWN')) return '하역 중 판정불가';
  if (r.startsWith('NO WEATHER')) return '기상 자료 없음';
  if (r.startsWith('NO JUDGEMENT')) return '판정 전';
  return r || null;
}

function Lamp({ on, color, label }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <span style={{
        width: '20px', height: '20px', borderRadius: '50%',
        background: on ? color : COLORS.card, border: `1px solid ${on ? color : COLORS.border}`,
        boxShadow: on ? `0 0 12px ${color}` : 'none', transition: 'all 0.3s',
      }} />
      <span style={{ fontSize: '10.5px', color: COLORS.textDim }}>{label}</span>
    </div>
  );
}

function Chip({ color, children, strong = false }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
      fontSize: '11.5px', fontWeight: strong ? 800 : 600, color: strong ? '#FFFFFF' : color,
      background: strong ? color : 'transparent', border: `1px solid ${color}`,
      borderRadius: '999px', padding: '2px 9px',
    }}>
      {children}
    </span>
  );
}

function GateCard({ gate, onCommand, operator }) {
  const st = gate.status || {};
  const sent = gate.interlock;            // 백엔드가 장치에 보낸 마지막 판정
  const locked = st.interlock === 'LOCKED';
  const valveOpen = st.valve === 'OPEN';
  const [pending, setPending] = useState(null);   // 방금 보낸 요청 — 장치 응답 전까지 표시
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!pending) return undefined;
    const id = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(id);
  }, [pending, st.ts]);

  const send = async (action) => {
    setError(null);
    try {
      await onCommand(gate.gate_id, action);
      setPending(action);
    } catch (e) {
      setError(e.message);
    }
  };

  const edge = gate.offline ? COLORS.textDim : locked ? COLORS.red : valveOpen ? COLORS.teal : COLORS.yellow;
  const word = gate.offline ? '연결 끊김' : locked ? '잠김' : valveOpen ? '하역 중' : '해제';
  const wordColor = gate.offline ? COLORS.textDim : locked ? COLORS.red : COLORS.teal;
  const reason = locked ? shortReason(sent) : null;
  const both = sent?.lock_by?.weather && sent?.lock_by?.assessment;
  // [2026-09-29] 잠금을 만든 배를 먼저 — 첫 배만 보이면 '판정 전' 배가 떠서 왜 잠겼는지 안 보였다
  const vessels = Array.isArray(gate.vessels) ? gate.vessels : [];
  const vessel = vessels.find((v) => v.blocking) || vessels[0];
  const moreVessels = Math.max(0, vessels.length - 1);
  const demo = useDemoCargo();
  const dv = gate.demo_verdict;
  const { thread } = useVesselThread();
  const trackVessel = useSensorStore((s) => s.trackVessel);

  return (
    <div
      className="sensor-card"
      style={{
        borderLeft: `3px solid ${edge}`, opacity: gate.offline ? 0.75 : 1,
        ...(thread?.gate?.gate_id === gate.gate_id ? { boxShadow: '0 0 0 2px #12354F' } : {}),
      }}
    >
      <div className="sensor-card-header">
        <span className="sensor-id">{gate.label} · {gate.berth}</span>
        <HelpTip title={`${gate.label} · ${gate.berth}`} align="right">
          {gate.thresholds && (
            <div>하역 중단 기준 — 풍속 {gate.thresholds.stop_wind_ms ?? '없음'} m/s
              {gate.thresholds.stop_wave_m != null ? ` · 파고 ${gate.thresholds.stop_wave_m} m` : ' · 파고 기준 없음'}</div>
          )}
          {sent?.reason_ko && <div>잠금 근거 — {sent.reason_ko}</div>}
          {Array.isArray(gate.vessels) && (gate.vessels.length === 0
            ? <div>접안 선박 없음 — 기상 기준만 적용</div>
            : gate.vessels.map((v) => (
              <div key={v.call_sign}>접안 선박 {v.vessel_name || v.call_sign} · 하역 중 판정 {v.level || '아직 없음'}
                {v.reasons?.[0] ? ` — ${v.reasons[0]}` : ''}</div>
            )))}
          {dv && showDisclosure() && <div>시연 판정 {dv.level}{dv.reason ? ` — ${dv.reason}` : ''} (실측 판정 대신 사용 중)</div>}
          {st.last_result && <div>장치 마지막 보고 — {st.last_result}</div>}
          <div style={{ marginTop: 6, color: COLORS.textSecondary }}>
            잠그는 근거는 부두별 기상 기준과 그 선석 배의 하역 중 판정(부적합·판정불가)입니다. "주의"는 잠그지 않습니다.
            잠긴 동안의 하역 개시 요청은 장치가 거부합니다.
          </div>
        </HelpTip>
      </div>

      {gate.offline ? (
        <div style={{ margin: '12px 0', display: 'flex', gap: '8px', alignItems: 'center', color: COLORS.textSecondary, fontSize: '14px', fontWeight: 700 }}>
          <FaPlug /> 연결 끊김
          <span style={{ fontSize: '12px', fontWeight: 400, color: COLORS.textDim }}>전원 · Wi-Fi · 중계 확인</span>
        </div>
      ) : null}
      {gate.offline && sent?.state && (
        <div style={{ margin: '-6px 0 10px', fontSize: '12.5px', color: sent.state === 'LOCKED' ? COLORS.red : COLORS.textSecondary }}>
          {sent.state === 'LOCKED' ? `잠금 판정 · ${shortReason(sent) || '잠금'}` : '해제 판정'}
        </div>
      )}
      {gate.offline ? null : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', margin: '12px 0 10px' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <Lamp on={st.lamp === 'ON'} color={COLORS.red} label="잠금" />
            <Lamp on={st.ok_lamp === 'ON'} color={COLORS.teal} label="열림" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: wordColor, fontSize: '22px', fontWeight: 800, lineHeight: 1.2 }}>
              {locked ? <FaLock size={18} /> : <FaLockOpen size={18} />} {word}
            </div>
            <div style={{ fontSize: '13px', marginTop: '4px', color: locked ? COLORS.red : COLORS.textSecondary, fontWeight: locked ? 700 : 400 }}>
              {locked ? (reason || '잠금') : `밸브 ${valveOpen ? '열림' : '닫힘'}`}
              {locked && both && <span style={{ fontWeight: 400 }}> 외 1</span>}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {vessel
          ? (
            <button
              type="button" onClick={() => trackVessel({ callsgn: vessel.call_sign, vessel_name: vessel.vessel_name })}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}
            >
              <Chip color={vessel.blocking ? COLORS.red : COLORS.textSecondary}><FaShip size={10} />{vessel.vessel_name || vessel.call_sign} · {vessel.level || '판정 전'}{moreVessels ? ` 외 ${moreVessels}척` : ''}</Chip>
            </button>
          )
          : Array.isArray(gate.vessels) && <Chip color={COLORS.textDim}>접안 선박 없음</Chip>}
        {/* [2026-09-30] 시연 판정 · 모의 장치 표식은 ?disclose=1 일 때만(밝히는 것은 발표 말 · 보고서 · 질의응답) */}
        {dv && showDisclosure() && <Chip color={['부적합', '판정불가'].includes(dv.level) ? COLORS.red : COLORS.yellow} strong>시연 판정 {dv.level}</Chip>}
        {st.simulate && showDisclosure() && <Chip color={COLORS.yellow}>모의 장치</Chip>}
        {/* 판정으로 잠겼는데 그 판정이 시연용 주입 화물에서 나왔을 수 있으면 밝힌다 */}
        {vessel?.blocking && (() => {
          const d = demo.around(vessel.call_sign, gate.berth);
          return d.any ? <DemoChip derived={!d.own.length} entries={[...d.own, ...d.near]} /> : null;
        })()}
      </div>

      {st.denied && !gate.offline && (
        <div style={{ margin: '0 0 10px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(196, 50, 46, 0.10)', border: `1px solid ${COLORS.red}`, color: COLORS.red, fontSize: '13px', fontWeight: 800, display: 'flex', gap: '8px', alignItems: 'center' }}>
          <FaExclamationTriangle /> 요청 거부 — 장치가 열지 않음
        </div>
      )}
      {pending && !st.denied && (
        <div style={{ margin: '0 0 10px', fontSize: '12px', color: COLORS.info }}>
          {pending === 'OPEN' ? '하역 개시 요청' : '하역 중단'} 보냄…
        </div>
      )}
      {error && <div style={{ margin: '0 0 10px', fontSize: '12px', color: COLORS.yellow }}>보내지 못했습니다: {error}</div>}

      {!operator ? (
        <div style={{ fontSize: '12px', color: COLORS.textDim }}>
          조작 권한 · 터미널 운영자
        </div>
      ) : (
      <div style={{ display: 'flex', gap: '8px' }}>
        {/* 잠겨 있어도 누를 수 있다 — 거부는 장치가 한다(그게 시연의 핵심 장면). 끊겼을 때만 막는다. */}
        <button
          onClick={() => send('OPEN')}
          disabled={gate.offline}
          style={{
            flex: 1, padding: '9px', borderRadius: '8px', border: 'none', fontWeight: 'bold',
            cursor: gate.offline ? 'not-allowed' : 'pointer',
            background: gate.offline ? COLORS.card : COLORS.teal, color: gate.offline ? COLORS.textDim : '#FFFFFF',
          }}
        >
          하역 개시 요청
        </button>
        <button
          onClick={() => send('CLOSE')}
          disabled={gate.offline}
          style={{
            flex: 1, padding: '9px', borderRadius: '8px', border: `1px solid ${COLORS.red}`, fontWeight: 'bold',
            cursor: gate.offline ? 'not-allowed' : 'pointer', background: 'transparent', color: COLORS.red,
          }}
        >
          하역 중단
        </button>
      </div>
      )}
    </div>
  );
}

// 시연 입력 — 시연장에서 실제 바람이 16 m/s 가 될 리 없어 값을 넣는다.
// 판정 규칙은 실제와 같고 값만 주입되며, 주입 중이면 배지가 뜬다(심사 질문에 정직하게).
// 시연 판정 보기 — 시스템이 실제로 내는 판정 축(기상·흘수·혼재·근거 부족)에서 골랐다.
// 기상은 위 풍속·파고로 넣으므로 여기엔 없다. 인접 선석 부적합은 산적 호환성 충돌로 든다 —
// IMDG 격리표는 선내 적재 규정이라 부두 간 판정에 쓰지 않는다(rule_engine.compute_imdg_berth_adjacency_floor).
// label 은 화면용 짧은 이름, reason 은 판정 근거로 백엔드에 보내는 문장.
const VERDICT_PRESETS = [
  { key: 'fit', level: '적합', label: '적합', reason: '흘수·혼재 모두 기준 안 — 하역 개시 가능' },
  { key: 'ukc', level: '부적합', label: '부적합 · 흘수 여유 부족', reason: '흘수 여유 부족 — 저조 시 가용수심 < 흘수 + 10%' },
  { key: 'seg', level: '부적합', label: '부적합 · 산적 호환성 충돌', reason: '인접 선석 화물과 반응 위험 조합(산적 호환성 충돌)' },
  { key: 'unk', level: '판정불가', label: '판정불가 · 흘수 미신고', reason: '흘수 미신고 — 판단 근거 없음' },
];

const inputBox = {
  width: '58px', marginLeft: '4px', padding: '5px 6px', borderRadius: '6px',
  border: `1px solid ${COLORS.border}`, background: COLORS.card, color: COLORS.textPrimary,
};
const selectBox = {
  padding: '5px 6px', borderRadius: '6px', border: `1px solid ${COLORS.border}`,
  background: COLORS.card, color: COLORS.textPrimary, fontSize: '12.5px',
};
const primaryBtn = { padding: '6px 12px', borderRadius: '8px', border: 'none', background: COLORS.yellow, color: '#FFFFFF', fontWeight: 700, cursor: 'pointer' };
const ghostBtn = (on) => ({
  padding: '6px 12px', borderRadius: '8px', border: `1px solid ${COLORS.border}`, background: 'transparent',
  color: on ? COLORS.textPrimary : COLORS.textDim, fontWeight: 700, cursor: on ? 'pointer' : 'not-allowed',
});
const rowLabel = { width: '34px', flexShrink: 0, fontSize: '12.5px', fontWeight: 800, color: COLORS.textSecondary };

function DemoControl({ demo, demoVerdict, gates, onApply, onClear, onVerdict, onVerdictClear }) {
  const [wind, setWind] = useState(demo?.wind_ms ?? 16);
  const [wave, setWave] = useState(demo?.wave_m ?? 0.5);
  const [vGate, setVGate] = useState(gates?.[0]?.gate_id ?? 'G01');
  const [vKey, setVKey] = useState('ukc');
  const anyDemo = Boolean(demo) || Boolean(demoVerdict);
  // [2026-09-28] 평소엔 접어 둔다(현우 D10) — 시연 입력 중이면 펼친 채로 연다
  const [open, setOpen] = useState(anyDemo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="sensor-card" style={{ borderLeft: `3px solid ${anyDemo ? COLORS.yellow : COLORS.border}` }}>
      <div className="sensor-card-header">
        <span className="sensor-id" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <FaFlask style={{ marginRight: '6px' }} />시연 입력
          <HelpTip title="시연 입력">
            <div>시연장에서는 날씨와 판정이 바뀌기를 기다릴 수 없어 값을 넣습니다. <strong>잠금 규칙은 실제와 같고</strong>, 넣은 판정은 판정 기록에 남지 않습니다. 해제하면 실측으로 돌아갑니다.</div>
            <div style={{ marginTop: 6 }}>판정 보기</div>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {VERDICT_PRESETS.map((p) => <li key={p.key}>{p.label} — {p.reason}</li>)}
            </ul>
          </HelpTip>
        </span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {anyDemo && (
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#FFFFFF', background: COLORS.yellow, padding: '2px 8px', borderRadius: '999px' }}>
              시연 입력 중
            </span>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            style={{ border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.textSecondary, borderRadius: 6, padding: '2px 8px', fontSize: 11.5, cursor: 'pointer' }}>
            {open ? '접기' : '펼치기'}
          </button>
        </span>
      </div>
      {open && (<>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px' }}>
        <span style={rowLabel}>기상</span>
        <label style={{ fontSize: '12.5px', color: COLORS.textSecondary }}>
          풍속<input type="number" step="1" min="0" max="60" value={wind} onChange={(e) => setWind(Number(e.target.value))} style={inputBox} />
        </label>
        <label style={{ fontSize: '12.5px', color: COLORS.textSecondary }}>
          파고<input type="number" step="0.1" min="0" max="15" value={wave} onChange={(e) => setWave(Number(e.target.value))} style={inputBox} />
        </label>
        <button disabled={busy} onClick={() => run(() => onApply({ wind_ms: wind, wave_m: wave }))} style={primaryBtn}>적용</button>
        <button disabled={busy || !demo} onClick={() => run(onClear)} style={ghostBtn(Boolean(demo))}>해제 (실측으로)</button>
      </div>
      <div style={{ fontSize: '11.5px', color: demo ? COLORS.yellow : COLORS.textDim, margin: '4px 0 0 42px' }}>
        {demo ? `주입 중 — 풍속 ${demo.wind_ms ?? '실측'} · 파고 ${demo.wave_m ?? '실측'}` : '실측 기상'}
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${COLORS.border}` }}>
        <span style={rowLabel}>판정</span>
        <select value={vGate} onChange={(e) => setVGate(e.target.value)} style={selectBox} aria-label="선석">
          {(gates || []).map((g) => <option key={g.gate_id} value={g.gate_id}>{g.label}</option>)}
        </select>
        <select value={vKey} onChange={(e) => setVKey(e.target.value)} style={selectBox} aria-label="판정">
          {VERDICT_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <button disabled={busy} onClick={() => {
          const p = VERDICT_PRESETS.find((x) => x.key === vKey);
          run(() => onVerdict({ gate_id: vGate, level: p.level, reason: p.reason }));
        }} style={primaryBtn}>
          판정 적용
        </button>
        <button disabled={busy || !demoVerdict} onClick={() => run(() => onVerdictClear(null))} style={ghostBtn(Boolean(demoVerdict))}>
          실측 판정으로
        </button>
      </div>
      {error && <div style={{ marginTop: '6px', fontSize: '12px', color: COLORS.red }}>{error}</div>}
      </>)}
    </div>
  );
}

function ConnChip({ ok, warn, label }) {
  const color = ok ? COLORS.teal : warn ? COLORS.yellow : COLORS.red;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />{label}
    </span>
  );
}

export default function HardwarePanel() {
  const {
    snapshot, wsState, sendGateCommand, setDemoWeather, clearDemoWeather, setDemoVerdict, clearDemoVerdict,
  } = useHardwareData();
  const broker = snapshot?.broker;
  const serverOk = wsState === 'open' || wsState === 'polling';
  const operator = isOperator();

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', margin: '24px 0 14px' }}>
        <h3 style={{ fontSize: '16px', margin: 0, color: 'var(--teal)', display: 'inline-flex', alignItems: 'center' }}>
          하역 개시 인터락 — 선석 A·B
          <HelpTip title="하역 개시 인터락">
            <div>선석 A·B 게이트는 실물(라즈베리파이 · 릴레이 · 12V 상시닫힘 밸브)입니다.</div>
            <div style={{ marginTop: 4 }}>관제 서버가 부두별 기상 기준과 그 선석에 붙은 배의 하역 중 판정으로 잠금을 정해 장치에 보냅니다. 잠긴 동안의 하역 개시 요청은 <strong>장치가 거부</strong>하고, 화면은 결과만 보여 줍니다.</div>
            <div style={{ marginTop: 4 }}>판정을 받기 전이나 통신이 끊긴 뒤에는 열지 않으며, 전원이 끊기면 밸브가 닫힙니다.</div>
            <div style={{ marginTop: 6, color: COLORS.textSecondary }}>
              화면 ↔ 관제 서버: {wsState === 'open' ? '연결됨' : wsState === 'polling' ? '연결됨 (1초 조회)' : wsState === 'connecting' ? '연결 중' : '끊김'}
              {broker && <> · 관제 서버 ↔ 장치 중계: {broker.connected ? '연결됨' : '끊김(중계 꺼짐)'}</>}
            </div>
          </HelpTip>
        </h3>
        <ConnChip ok={serverOk} warn={wsState === 'connecting'} label={serverOk ? '서버 연결' : wsState === 'connecting' ? '서버 연결 중' : '서버 끊김'} />
        {broker && <ConnChip ok={broker.connected} label={broker.connected ? '장치 중계 연결' : '장치 중계 끊김'} />}
      </div>

      {!snapshot ? (
        <div className="sensor-card" style={{ color: COLORS.textSecondary, fontSize: '13px' }}>
          {wsState === 'closed'
            ? '관제 서버에 연결할 수 없습니다 — 서버가 켜져 있는지 확인하세요.'
            : '게이트 상태를 기다리는 중…'}
        </div>
      ) : (
        <div className="sensor-grid">
          {snapshot.gates.map((gate) => (
            <GateCard key={gate.gate_id} gate={gate} onCommand={sendGateCommand} operator={operator} />
          ))}
          {operator ? (
            <DemoControl
              demo={snapshot.demo} demoVerdict={snapshot.demo_verdict} gates={snapshot.gates}
              onApply={setDemoWeather} onClear={clearDemoWeather}
              onVerdict={setDemoVerdict} onVerdictClear={clearDemoVerdict}
            />
          ) : (snapshot.demo || snapshot.demo_verdict) && showDisclosure() ? (
            // [2026-09-30] 화면 출처 문구는 ?disclose=1 일 때만(발표 원칙 — 밝히는 것은 보고서·질의응답)
            <div className="sensor-card" style={{ borderLeft: `3px solid ${COLORS.yellow}`, fontSize: '13px', color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.yellow }}>시연 입력 중</strong> — 발표용으로 넣은 값입니다. 잠금 규칙은 실제와 같습니다.
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
