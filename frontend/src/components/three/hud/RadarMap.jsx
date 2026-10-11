import { useEffect, useState } from 'react';
import useSensorStore from '../../../stores/useSensorStore';
import { ONSAN_BERTHS } from '../../../utils/geoUtils';

// ─────────────────────────────────────────────────────────────────────────────
// 온산 근해 레이더 — 실 AIS 좌표를 그대로 찍는다.
//
// 예전에는 블립 위치가 `Math.sin(idx*2)`, `Math.cos(idx*2)` 였다. 배열 순서대로
// 원형에 늘어놓은 것으로, 실제 위치와 아무 관계가 없었다. 스토어에 vessel_lat/lon
// 실좌표가 들어 있는데도 쓰지 않았고, 화면에는 "UPA VTS RADAR"라고 적혀 있었다 —
// 관제 레이더라고 이름 붙인 허구였다.
//
// 지금은 온산 반경을 화면 반지름에 대응시켜 실좌표를 투영한다. 접안한 배는 AIS
// 좌표 대신 그 선석 위치에 찍는다(useLiveTwinShips 와 같은 이유 — 접안선은
// "어느 선석인가"가 이미 확정된 정보라 그쪽이 정확하다).
// ─────────────────────────────────────────────────────────────────────────────

// 레이더 중심(온산 앞바다)과 표시 반경. 이 밖의 배는 테두리에 붙여 방위만 보여준다.
const CENTER = { lat: 35.435, lon: 129.365 };
const RADIUS_KM = 6;

const KM_PER_DEG_LAT = 111.0;
const KM_PER_DEG_LON = 111.0 * Math.cos((CENTER.lat * Math.PI) / 180);

/** 선박 → 레이더 화면 좌표(%) + 범위 밖 여부 */
function blipPosition(ship) {
  let lat = ship.vessel_lat;
  let lon = ship.vessel_lon;
  // 접안선은 AIS 좌표를 비워두고 선석 위치를 쓴다(useLiveTwinShips 참고)
  if ((lat == null || lon == null) && ship.berth) {
    const b = ONSAN_BERTHS[ship.berth];
    if (b?.lat != null && b?.lon != null) { lat = b.lat; lon = b.lon; }
  }
  if (lat == null || lon == null) return null;

  const dxKm = (lon - CENTER.lon) * KM_PER_DEG_LON;
  const dyKm = (lat - CENTER.lat) * KM_PER_DEG_LAT;
  const distKm = Math.hypot(dxKm, dyKm);

  // 화면 반지름 46% 안에 RADIUS_KM 을 담는다(테두리 여백 4%)
  const scale = distKm > RADIUS_KM ? 46 / distKm * RADIUS_KM / RADIUS_KM : 46 / RADIUS_KM;
  const clamped = Math.min(distKm, RADIUS_KM);
  const ratio = distKm === 0 ? 0 : clamped / distKm;

  return {
    left: 50 + dxKm * ratio * (46 / RADIUS_KM),
    top: 50 - dyKm * ratio * (46 / RADIUS_KM), // 화면 y는 아래로 증가 → 북쪽이 위
    outOfRange: distKm > RADIUS_KM,
    distKm,
    _scale: scale,
  };
}

const STATUS_COLOR = {
  operating: '#ff4b6e',  // 하역 중
  mooring: '#ffd166',    // 계류
  anchored: '#4ecdc4',   // 묘박
  underway: '#00d4aa',   // 항해
};

export default function RadarMap() {
  const radarCollapsed = useSensorStore((st) => st.hudRadarCollapsed);
  const lite = useSensorStore((st) => st.twinLite);
  const setRadarCollapsed = useSensorStore((st) => st.setHudRadarCollapsed);
  const ships = useSensorStore((s) => s.ships);
  const [angle, setAngle] = useState(0);

  useEffect(() => {
    let animationFrame;
    const animate = () => {
      setAngle((prev) => (prev + 2) % 360);
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  const blips = ships
    .map((ship) => ({ ship, pos: blipPosition(ship) }))
    .filter((b) => b.pos);

  if (radarCollapsed) {
    return (
      <div style={{ position: 'absolute', bottom: 40, right: 20, zIndex: 1000, display: 'flex', gap: 6, alignItems: 'center' }}>
        {lite && (
          <span className="hud-chip" title="이 PC 에서 3D 가 느려 그림자를 끄고 해상도를 낮췄습니다. 자료와 판정은 그대로입니다." style={{ opacity: 0.8, cursor: 'default' }}>
            가벼운 모드
          </span>
        )}
        <button type="button" className="hud-chip" onClick={() => setRadarCollapsed(false)} title="레이더 펼치기 — 온산 근해 선박위치">
          레이더 {blips.length}척
        </button>
      </div>
    );
  }

  return (
    <>
    <div style={{ position: 'absolute', bottom: 248, right: 20, zIndex: 1001, display: 'flex', gap: 6, alignItems: 'center' }}>
      {lite && (
        <span className="hud-chip" title="이 PC 에서 3D 가 느려 그림자를 끄고 해상도를 낮췄습니다. 자료와 판정은 그대로입니다." style={{ opacity: 0.8, cursor: 'default' }}>
          가벼운 모드
        </span>
      )}
      <button type="button" className="hud-chip" onClick={() => setRadarCollapsed(true)} title="레이더 접기">레이더 접기</button>
    </div>
    <div className="radar-container" style={{
      position: 'absolute', bottom: 40, right: 20, zIndex: 1000,
      width: '200px', height: '200px',
      background: 'rgba(5, 8, 17, 0.8)',
      border: '2px solid #00d4aa',
      borderRadius: '50%',
      overflow: 'hidden',
      boxShadow: '0 0 15px rgba(0, 212, 170, 0.4)',
      pointerEvents: 'none',
    }}>
      {/* Grid Lines */}
      <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: '1px', background: 'rgba(0, 212, 170, 0.3)' }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '1px', background: 'rgba(0, 212, 170, 0.3)' }} />

      {/* Concentric Circles — 각각 2km, 4km 권 */}
      <div style={{ position: 'absolute', top: '25%', left: '25%', right: '25%', bottom: '25%', border: '1px solid rgba(0, 212, 170, 0.3)', borderRadius: '50%' }} />
      <div style={{ position: 'absolute', top: '10%', left: '10%', right: '10%', bottom: '10%', border: '1px solid rgba(0, 212, 170, 0.3)', borderRadius: '50%' }} />

      {/* Sweeper */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        width: '50%', height: '50%',
        background: 'conic-gradient(from 0deg, transparent 70%, rgba(0, 212, 170, 0.8) 100%)',
        transformOrigin: '0 0',
        transform: `rotate(${angle}deg)`,
      }} />

      {/* 실 AIS 블립 — 상태별 색, 범위 밖은 작게 */}
      {blips.map(({ ship, pos }) => (
        <div
          key={ship.id}
          title={`${ship.id} · ${pos.distKm.toFixed(1)}km`}
          style={{
            position: 'absolute',
            top: `${pos.top}%`,
            left: `${pos.left}%`,
            transform: 'translate(-50%, -50%)',
            width: pos.outOfRange ? '4px' : '6px',
            height: pos.outOfRange ? '4px' : '6px',
            background: STATUS_COLOR[ship.status] || '#00d4aa',
            borderRadius: '50%',
            opacity: pos.outOfRange ? 0.5 : 1,
            boxShadow: `0 0 5px ${STATUS_COLOR[ship.status] || '#00d4aa'}`,
          }}
        />
      ))}

      <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, textAlign: 'center', color: '#00d4aa', fontSize: '9.5px', fontFamily: 'monospace', lineHeight: 1.3 }}>
        온산 선박위치 · 반경 {RADIUS_KM}km
        <div style={{ fontSize: '8.5px', opacity: 0.75 }}>{blips.length}척 표시</div>
      </div>
    </div>
    </>
  );
}
