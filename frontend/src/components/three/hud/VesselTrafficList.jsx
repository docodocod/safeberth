import { useEffect, useMemo, useRef, useState } from 'react';
import useSensorStore from '../../../stores/useSensorStore';
import { ONSAN_BERTHS } from '../../../utils/geoUtils';
import { FaShip, FaChevronUp, FaChevronDown } from 'react-icons/fa';

// 트윈 상태 어휘 → 화면 표기. status.toUpperCase() 를 그대로 쓰면
// 'UNDERWAY'처럼 영문이 그대로 나가고, 묘박선은 berth 가 null 이라 "null | ANCHORED"
// 로 표시됐다.
const STATUS_LABEL = {
  operating: { text: '하역 중', color: '#39C0A8' },   // 유량 계측 연결 뒤에 쓴다 — 지금은 배정하지 않음
  mooring: { text: '접안 중', color: '#E0A83C' },
  anchored: { text: '정박지 대기', color: '#5FC7DC' },
  underway: { text: '항해 중', color: '#7FB3E8' },
  // AIS 항해상태 필드가 없는 배 — 대부분 Class B 항내 소형 작업선
  service: { text: '항내 소형선', color: '#9AA7AE' },
};

// 상태 필터 — 이영서 요청(2026-08-17):
// "하역 중/묘박 등으로 가를 수 있으면 더 편하지 않을까"
//
// 관제에서 실제로 나누는 기준이 이 넷이다. '하역 중'과 '계류'를 따로 두는 이유는
// 접안해 있어도 화물을 붙였는지 아닌지가 안전 관제상 다른 상황이기 때문이다
// (useLiveTwinShips.twinStatus 가 화물 유무로 이 둘을 가른다).
const FILTERS = [
  { key: 'ALL', label: '전체' },
  { key: 'mooring', label: '접안' },
  { key: 'anchored', label: '대기' },
  { key: 'underway', label: '항해' },
  { key: 'service', label: '소형선' },
];

export default function VesselTrafficList() {
  const ships = useSensorStore((s) => s.ships);
  const setSelectedObject = useSensorStore((s) => s.setSelectedObject);
  const [filter, setFilter] = useState('ALL');
  const [collapsed, setCollapsed] = useState(false);
  const autoFolded = useRef(false);
  const trackedCs = useSensorStore((s) => s.trackedVessel?.callsgn);

  // 필터 칩에 건수를 같이 적는다 — 눌러보기 전에 어느 상태가 몇 척인지 보여야
  // "지금 하역 중인 배가 있나"를 한눈에 판단할 수 있다.
  const counts = useMemo(() => {
    const c = { ALL: ships.length };
    for (const f of FILTERS) if (f.key !== 'ALL') c[f.key] = 0;
    for (const s of ships) if (c[s.status] !== undefined) c[s.status] += 1;
    return c;
  }, [ships]);

  const shown = useMemo(
    () => (filter === 'ALL' ? ships : ships.filter((s) => s.status === filter)),
    [ships, filter]
  );

  // CCTV 패널 아래에 놓는다. CCTV 가 접히면 그만큼 따라 올라간다 —
  // 예전 top:226 은 CCTV 에 조작줄이 붙기 전 값이라 두 패널이 겹쳤다.
  const cctvCollapsed = useSensorStore((s) => s.hudCctvCollapsed);
  const TOP = cctvCollapsed ? 134 : 382;   // 선석 현황 띠(한 줄, 전체 폭) 아래로 46 내렸다(2026-09-30)
  // [2026-09-30] 목록 높이를 줄 단위로 맞춘다 — 스크롤 창 끝에 반쯤 잘린 배가 걸리거나 3D 영역 밖으로 넘쳐
  //   목록이 끊겨 보였다(현우). 3D 영역의 실제 높이를 재서, 머리 · 칩 줄 · 여백을 빼고 남는 만큼 온전한 줄만 넣는다.
  const rootRef = useRef(null);
  const [hostH, setHostH] = useState(780);
  useEffect(() => {
    const host = rootRef.current?.closest('.digital-twin-page');
    if (!host) return undefined;
    const measure = () => setHostH(host.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const ROW = 42;
  const GAP = 6;
  const avail = hostH - TOP - 40 - 38 - 16 - 16;   // 머리 · 칩 줄 · 목록 안 여백 · 바닥 여백
  const rows = Math.max(1, Math.floor((avail + GAP) / (ROW + GAP)));
  const listMax = rows * (ROW + GAP) - GAP + 16;
  // 세 줄도 못 넣는 낮은 화면이면 처음엔 접어 둔다(누르면 펼친다) — 반쯤 잘린 목록을 보이지 않는다
  useEffect(() => {
    if (autoFolded.current || hostH === 780) return;
    autoFolded.current = true;
    if (avail < 3 * (ROW + GAP) - GAP) setCollapsed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostH]);

  if (collapsed) {
    return (
      <div ref={rootRef} style={{ position: 'absolute', top: TOP, left: 20, zIndex: 1000 }}>
        <button type="button" className="hud-chip" onClick={() => setCollapsed(false)} title="선박 목록 펼치기">
          <FaShip size={11} /> 온산 선박 {ships.length}척
          <FaChevronDown size={9} />
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="vessel-traffic-list" style={{
      position: 'absolute', top: TOP, left: 20, zIndex: 1000,
      width: '310px',
      background: 'var(--hud-panel)',
      backdropFilter: 'blur(10px)',
      border: '1px solid var(--hud-border)',
      borderRadius: '8px',
      color: 'var(--hud-text)',
      fontFamily: 'ui-monospace, Consolas, monospace',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '9px 12px', borderBottom: '1px solid var(--hud-border)',
        background: 'rgba(255,255,255,0.05)', fontWeight: 'bold',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
      }}>
        <span style={{ fontSize: '14.5px' }} title="항만공사 선박위치 기준">온산 선박</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12.5px', opacity: 0.8 }}>
            {filter === 'ALL' ? `${ships.length}척` : `${shown.length}/${ships.length}척`}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="접기"
            style={{
              background: 'transparent', border: 'none', color: 'var(--hud-dim)',
              cursor: 'pointer', display: 'flex', padding: 0,
            }}
          >
            <FaChevronUp size={11} />
          </button>
        </span>
      </div>

      {/* 상태 필터 */}
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${FILTERS.length}, minmax(0, 1fr))`, gap: '4px', padding: '8px 10px 4px',
      }}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          const c = STATUS_LABEL[f.key]?.color;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              style={{
                background: on ? 'rgba(255,255,255,0.14)' : 'transparent',
                border: `1px solid ${on ? (c || '#6FD3BE') : 'var(--hud-border)'}`,
                color: on ? (c || 'var(--hud-text)') : 'var(--hud-dim)',
                borderRadius: '999px', padding: '3px 0', whiteSpace: 'nowrap', textAlign: 'center',
                fontSize: '11px', fontWeight: on ? 800 : 600, letterSpacing: '-0.02em',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {f.label} {counts[f.key] ?? 0}
            </button>
          );
        })}
      </div>

      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: `${GAP}px`, maxHeight: listMax, overflowY: 'auto', boxSizing: 'border-box' }}>
        {ships.length === 0 ? (
          <div style={{ color: 'var(--hud-dim)', fontSize: '12px', textAlign: 'center', padding: '12px 4px', lineHeight: 1.6 }}>
            온산 범위 내 선박위치 없음
            <div style={{ fontSize: '11px', opacity: 0.8 }}>수집이 멈췄거나 재항 선박이 없습니다</div>
          </div>
        ) : shown.length === 0 ? (
          <div style={{ color: 'var(--hud-dim)', fontSize: '12px', textAlign: 'center', padding: '12px 4px' }}>
            해당 상태의 선박이 없습니다
          </div>
        ) : (
          shown.map((ship) => {
            const st = STATUS_LABEL[ship.status] || { text: ship.status, color: 'var(--hud-dim)' };
            // 선석은 사람이 읽는 이름으로. 3D 장면에 없는 부두(가스부두·SK2부두 등)에 붙은
            // 배도 실제 선석 이름을 보여준다 — 예전엔 장면에 없으면 '선석 미배정'으로 떠
            // 접안한 배가 미배정으로 보였다. 정말 선석이 없는 배(묘박·항해)만 '선석 없음'.
            const berthName = ship.berth
              ? (ONSAN_BERTHS[ship.berth]?.name || ship.berth)
              : (ship.berth_name || (ship.status === 'anchored' ? '정박지' : '선석 없음'));
            return (
              <div
                key={ship.id}
                onClick={() => setSelectedObject(ship)}
                title="클릭하면 선박 상세가 열립니다"
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
                  height: ROW, boxSizing: 'border-box', padding: '4px 10px', borderRadius: '4px',
                  background: trackedCs && ship.callsgn === trackedCs ? 'rgba(111, 211, 190, 0.18)' : 'rgba(255,255,255,0.04)',
                  outline: trackedCs && ship.callsgn === trackedCs ? '1px solid #6FD3BE' : 'none',
                  borderLeft: `3px solid ${st.color}`, cursor: 'pointer',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    color: 'var(--hud-text)', fontSize: '13.5px', fontWeight: 'bold', lineHeight: '17px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {ship.id}
                  </div>
                  <div style={{ color: 'var(--hud-dim)', fontSize: '11.5px', lineHeight: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{berthName}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                  <div style={{ color: st.color, fontSize: '12px', fontWeight: 700, lineHeight: '17px' }}>{st.text}</div>
                  {/* 적재량은 수집 소스가 없다(cargoAmount=null). 예전엔
                      Math.round(null/1000) = 0 이라 실선박이 전부 "0k t"로 떴다 —
                      빈 배라는 틀린 정보였다. 대신 실제로 아는 값(속력)을 보여준다. */}
                  <div style={{ color: '#6FD3BE', fontSize: '11.5px', lineHeight: '15px' }}>
                    {ship.vessel_speed != null ? `${ship.vessel_speed} kn` : '속력 미상'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
