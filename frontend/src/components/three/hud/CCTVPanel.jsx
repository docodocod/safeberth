import { showDisclosure } from '../../../utils/disclosure';
import { useState, useEffect, useMemo } from 'react';
import useSensorStore from '../../../stores/useSensorStore';
import { ONSAN_BERTHS_3D } from '../../../utils/geoUtils';
import { FaVideo, FaPause, FaPlay, FaChevronUp, FaChevronDown } from 'react-icons/fa';
import CctvTwinView from './CctvTwinView';

const BERTH_IDS = Object.keys(ONSAN_BERTHS_3D);

// 시간대별 화면 톤: 주간(컬러) / 일몰·일출(웜톤) / 야간(IR 그린)
const PALETTES = {
  DAY: {
    label: '주간', sky1: '#39546e', sky2: '#5b7c99', sea1: '#28536e', sea2: '#153048',
    deck: '#3a4a58', deckTop: '#52667a', struct: '#5a7086', hull: '#22303c', hullLine: '#48607a',
    glow: '#eaf4ff', text: '#eaf4ff', sub: '#a8c8e0', noise: 'rgba(220,235,255,0.07)',
  },
  DUSK: {
    label: '일몰', sky1: '#5a3448', sky2: '#8a5a42', sea1: '#4a3450', sea2: '#221830',
    deck: '#3c3040', deckTop: '#5a4456', struct: '#6a4e58', hull: '#241c2c', hullLine: '#584458',
    glow: '#ffd9a8', text: '#ffe9d0', sub: '#d8aa88', noise: 'rgba(255,220,180,0.07)',
  },
  NIGHT: {
    label: '야간·IR', sky1: '#0a1410', sky2: '#12241c', sea1: '#16302a', sea2: '#0a1a16',
    deck: '#1c2e26', deckTop: '#2c443a', struct: '#31503f', hull: '#0e1d18', hullLine: '#28453a',
    glow: '#d8f5c8', text: '#d8f5c8', sub: '#8fd9b8', noise: 'rgba(190,255,220,0.09)',
  },
};

function phaseOf(hour) {
  if (hour >= 7 && hour <= 16) return 'DAY';
  if (hour >= 17 && hour <= 19) return 'DUSK';
  if (hour >= 5 && hour <= 6) return 'DUSK';
  return 'NIGHT';
}

/**
 * 가상 부두 CCTV — 실시간 연동:
 * - 현재 시각에 따라 주간/일몰/야간(IR) 화면 톤이 바뀐다
 * - 표시 부두의 하역 작업(공용 API operations)의 실제 진행률을 오버레이
 * - 3D에서 잔교/선박 클릭 시 해당 부두로 전환, 무선택 시 6초 자동 순찰
 */
export default function CCTVPanel() {
  const [time, setTime] = useState(new Date());
  const [cycleIdx, setCycleIdx] = useState(0);
  const selectedObject = useSensorStore((s) => s.selectedObject);
  const ships = useSensorStore((s) => s.ships);

  // 카메라 선택 — 이영서 요청(2026-08-17): "자동으로 바뀌는 게 맞나요? 선택 기능도"
  //
  // 예전엔 6초 자동 순회만 있고 패널 전체가 pointerEvents:none 이라 아무것도
  // 누를 수 없었다. 보고 싶은 부두가 지나가면 한 바퀴를 기다려야 했다.
  // 이제 세 가지가 된다 — 자동 순회 / 직접 선택 / 3D 클릭 연동.
  const [manualBerthId, setManualBerthId] = useState(null);  // 드롭다운으로 고른 부두
  const [autoRotate, setAutoRotate] = useState(true);
  // 접힘은 스토어에 둔다 — 아래 선박 목록이 이 값을 보고 위치를 올린다
  const collapsed = useSensorStore((st) => st.hudCctvCollapsed);
  const setCollapsed = useSensorStore((st) => st.setHudCctvCollapsed);

  useEffect(() => {
    if (collapsed) return undefined;
    setTime(new Date());
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [collapsed]);

  // 자동 순회는 켜져 있고, 사람이 특정 부두를 지목하지 않았을 때만 돈다.
  // (3D 에서 선석·선박을 클릭한 경우도 '지목'으로 본다)
  const pinned = Boolean(
    manualBerthId
    || selectedObject?.type === 'Berth'
    || (selectedObject?.type === 'Ship' && selectedObject.berth)
  );
  useEffect(() => {
    if (!autoRotate || pinned || collapsed) return undefined;
    const timer = setInterval(() => setCycleIdx((i) => (i + 1) % BERTH_IDS.length), 6000);
    return () => clearInterval(timer);
  }, [autoRotate, pinned, collapsed]);

  const berthId = useMemo(() => {
    // 우선순위: 직접 선택 > 3D 클릭 > 자동 순회
    if (manualBerthId && ONSAN_BERTHS_3D[manualBerthId]) return manualBerthId;
    if (selectedObject?.type === 'Berth' && ONSAN_BERTHS_3D[selectedObject.id]) return selectedObject.id;
    if (selectedObject?.type === 'Ship' && ONSAN_BERTHS_3D[selectedObject.berth]) return selectedObject.berth;
    return BERTH_IDS[cycleIdx];
  }, [manualBerthId, selectedObject, cycleIdx]);

  const berth = ONSAN_BERTHS_3D[berthId];
  const camNo = BERTH_IDS.indexOf(berthId) + 1;
  const P = PALETTES[phaseOf(time.getHours())];
  const hour = time.getHours() + time.getMinutes() / 60;   // 트윈 카메라 조명용
  const lightsOn = P !== PALETTES.DAY;

  const mooredShip = ships.find(
    (s) => s.berth === berthId && ['operating', 'mooring', 'docked'].includes(s.status)
  );
  const loading = mooredShip?.status === 'operating';
  const isManual = pinned;

  // 접었을 때는 헤더 줄만 남긴다 — 3D 화면을 넓게 보려는 용도라 최소 폭으로.
  if (collapsed) {
    return (
      <div className="cctv-collapsed" style={{ position: 'absolute', top: 90, left: 20, zIndex: 1000 }}>
        <button type="button" onClick={() => setCollapsed(false)} className="hud-chip" title="부두 CCTV 펼치기">
          <FaVideo size={11} /> 부두 CCTV
          <FaChevronDown size={9} />
        </button>
      </div>
    );
  }

  // [2026-09-30] 실제 배 이름 옆에 내장 예시 작업("메탄올 38% (4,500/12,000t)")을 붙이지 않는다 — 그 배가 싣지 않은
  //   화물과 없는 진행률이 실선박 정보처럼 보였다(아젤리아 · OTK 1부두). 아는 것만: 배 이름 · 화물 · 접안.
  const footer = mooredShip
    ? `${mooredShip.id}${mooredShip.cargoType ? ` · ${mooredShip.cargoType}` : ''} · 접안`
    : '공석';

  return (
    <div style={{ position: 'absolute', top: 90, left: 20, zIndex: 1000, width: '400px' }}>
      {/* 조작 줄 — 카메라 선택·자동순회·접기.
          패널 본체는 pointerEvents:none 을 유지해 3D 조작을 가리지 않고,
          이 줄에만 pointerEvents:auto 를 준다. */}
      <div className="cctv-controls">
        <FaVideo size={10} style={{ flexShrink: 0, opacity: 0.85 }} />
        <select
          value={manualBerthId ?? ''}
          onChange={(e) => setManualBerthId(e.target.value || null)}
          title="카메라(부두) 선택 — '자동 순회'를 고르면 6초마다 돌아갑니다"
        >
          <option value="">자동 순회</option>
          {BERTH_IDS.map((id) => (
            <option key={id} value={id}>{ONSAN_BERTHS_3D[id]?.name || id}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setAutoRotate((v) => !v)}
          disabled={pinned}
          title={pinned ? '특정 부두를 보는 중이라 순회가 멈춰 있습니다' : (autoRotate ? '순회 일시정지' : '순회 재개')}
          className={autoRotate && !pinned ? 'on' : ''}
        >
          {autoRotate && !pinned ? <FaPause size={9} /> : <FaPlay size={9} />}
        </button>
        <button type="button" onClick={() => setCollapsed(true)} title="접기">
          <FaChevronUp size={10} />
        </button>
      </div>

    <div className="cctv-panel" key={`${berthId}-${P.label}`} style={{
      position: 'relative',
      width: '400px', height: '240px',
      background: P.sky1,
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '4px',
      overflow: 'hidden',
      pointerEvents: 'none',
      fontFamily: 'monospace',
      animation: 'camswitch 0.35s ease-out',
    }}>
      {/* 트윈 카메라 — 같은 3D 장면을 이 부두의 CCTV 자리에서 본다 (2026-09-28, 예전 SVG 가상 장면 대체).
          실제 선박 위치·선석 색이 그대로 보인다. 실제 CCTV 영상은 없으므로 라벨로 밝힌다. */}
      <div style={{ position: 'absolute', inset: 0, filter: P === PALETTES.NIGHT ? 'grayscale(0.6) sepia(0.4) hue-rotate(60deg) brightness(1.15) contrast(1.1)' : P === PALETTES.DUSK ? 'sepia(0.25) saturate(1.1)' : 'none' }}>
        <CctvTwinView berthId={berthId} hour={hour} />
      </div>
      {/* 노이즈 + 스캔라인 */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `radial-gradient(${P.noise} 1px, transparent 1px)`,
        backgroundSize: '3px 3px',
      }} />
      <div className="cctv-scanline" style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '10px',
        background: 'rgba(255,255,255,0.05)',
        boxShadow: '0 0 10px rgba(255,255,255,0.08)',
      }} />

      {/* 오버레이 */}
      <div style={{ position: 'absolute', top: 10, left: 12, color: '#7dd3fc', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 'bold', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
        <div style={{ width: '9px', height: '9px', background: '#38bdf8', borderRadius: '50%', animation: 'pulse 1.2s infinite' }} />
        트윈 카메라
      </div>
      <div style={{ position: 'absolute', top: 10, right: 12, color: P.text, fontSize: '14px', fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
        CAM-{String(camNo).padStart(2, '0')} · {berth?.name}
      </div>
      <div style={{ position: 'absolute', top: 30, right: 12, color: P.sub, fontSize: '12px', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
        {P.label} 모드 {isManual ? '· 수동 선택' : '· 자동 순찰'}{showDisclosure() ? ' · CCTV 영상 없음' : ''}
      </div>
      <div style={{ position: 'absolute', bottom: 10, left: 12, color: P.sub, fontSize: '12.5px', maxWidth: '280px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
        {footer}
      </div>
      <div style={{ position: 'absolute', bottom: 10, right: 12, color: P.text, fontSize: '13px', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
        {time.toLocaleTimeString('ko-KR', { hour12: false })}
      </div>

      <style>{`
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
        .cctv-scanline { animation: scan 4s linear infinite; }
        @keyframes scan { 0% { top: -10%; } 100% { top: 110%; } }
        @keyframes camswitch {
          0% { filter: brightness(3) contrast(0.2); }
          40% { filter: brightness(0.6) contrast(1.6); }
          100% { filter: none; }
        }
      `}</style>
    </div>
    </div>
  );
}
