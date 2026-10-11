import useSensorStore from '../../../stores/useSensorStore';
import useVesselThread from '../../../hooks/useVesselThread';
import { ONSAN_BERTHS_3D, ONSAN_WEATHER_GROUP } from '../../../utils/geoUtils';
import { COLORS, WEATHER_STATUS_COLORS } from '../../../utils/constants';
import { VERDICT_RANK, berthKey } from '../../../utils/verdict';
import { stateAt, isAtBerth } from '../../../utils/berthSim';

// 칸이 좁아 기상 판정은 짧게 적는다(전체 글은 마우스를 올리면)
const SHORT_WX = { 하역중단: '중단', 이안: '이안', 호스분리: '분리' };

// 어두운 3D 바탕용 판정 색 — 관제 화면(utils/verdict)과 뜻은 같고 밝기만 다르다(OutlookTimeline LEVEL_COLOR 와 같음)
const DOT = { 적합: '#10b981', 주의: '#f59e0b', 부적합: '#ef4444', 판정불가: '#a78bfa' };

/**
 * 선석 현황 띠 (관제용 HUD)
 * 잔교 11기의 접안 선박 수와 판정 색, 부두 기상 판정을 보여준다. 누르면 그 선석 정보창(→ 앞으로 72시간).
 * [2026-09-30] 11곳이 한 줄에 다 보이게 3D 화면 전체 폭을 쓴다(CCTV · 머리 단추는 이 띠 아래로) — 예전엔
 *   CCTV 와 머리 단추 사이 좁은 자리라 가로 스크롤에 잘리거나 두 줄로 꺾였다(현우).
 *   칸은 폭을 똑같이 나눠 갖는다(한 칸만 아래로 떨어지지 않게). 점 색 = 그 선석 접안 선박의 판정 색.
 */
export default function BerthStatusBar() {
  const berthWeather = useSensorStore((s) => s.berthWeather);
  const setSelectedObject = useSensorStore((s) => s.setSelectedObject);
  const { berths } = useVesselThread();
  // [2026-09-30] 72시간 시뮬레이션이 돌면 그 시각의 점유를 보인다 — 3D 의 배와 같은 계획(plans)을 읽는다
  const preview = useSensorStore((s) => s.outlookPreview);
  const simOn = Boolean(preview?.simOn);

  return (
    <div style={{
      position: 'absolute', top: 46, left: 20, right: 20,
      zIndex: 1000, display: 'grid', gridTemplateColumns: `auto repeat(${Object.keys(ONSAN_BERTHS_3D).length}, minmax(0, 1fr))`,
      gap: '4px', alignItems: 'center',
      background: 'rgba(13, 27, 42, 0.8)', backdropFilter: 'blur(8px)',
      border: `1px solid ${COLORS.glassBorder}`, borderRadius: '10px',
      padding: '5px 10px',
    }}>
      <span style={{ fontSize: '11px', fontWeight: 800, color: simOn ? '#38bdf8' : '#AFC2CC', whiteSpace: 'nowrap', marginRight: '4px', minWidth: 52 }}>
        {simOn ? `+${preview.offsetH}시간` : '선석 현황'}
      </span>
      {Object.entries(ONSAN_BERTHS_3D).map(([id, b]) => {
        const row = berths.find((r) => berthKey(r.wharf_name) === berthKey(b.name));
        const ships = simOn
          ? preview.plans.filter((p) => p.berthId === id && isAtBerth(stateAt(p, preview.at_ms).phase))
            .map((p) => ({ call_sign: p.callsgn, vessel_name: p.name, status: p.level }))
          : (row?.slots || []).filter((s) => s.call_sign);
        const cap = Math.max(row?.max_concurrent_vessels || 0, (row?.slots || []).length, ships.length, 1);
        const worst = ships.map((s) => s.status).filter(Boolean)
          .sort((x, y) => (VERDICT_RANK[x] ?? 9) - (VERDICT_RANK[y] ?? 9))[0];
        const simWx = simOn ? (preview.berthId === id ? preview.status : preview.berthLevels?.[id]?.status) : null;
        const verdict = simOn
          ? simWx || null
          : berthWeather && ONSAN_WEATHER_GROUP[id] === berthWeather.berth_group
            ? berthWeather.status
            : null;
        const escalated = verdict && verdict !== '정상';
        const dotColor = worst ? DOT[worst] : ships.length ? '#8FA3B0' : 'transparent';
        const names = ships.map((s) => `${s.vessel_name || s.call_sign}${s.status ? ` ${s.status}` : ''}`).join(', ');
        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedObject({
              type: 'Berth', id, name: b.name, status: ships.length ? 'active' : 'idle',
              mooredShip: ships.length ? names : null,
            })}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
            title={`${b.name} — ${names || '공석'}${verdict ? ` · 부두 기상 ${verdict}` : ''}`}
            style={{
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden',
              padding: '3px 4px', borderRadius: '6px', fontSize: '11.5px', letterSpacing: '-0.02em',
              // 어두운 HUD 위라 라이트 화면용 글자색(COLORS.textPrimary, 짙은 남색)을 쓰면 점유 선석 이름이 사라졌다
              color: ships.length ? '#E8F0F2' : '#8FA3B0',
              border: `1px solid ${escalated ? WEATHER_STATUS_COLORS[verdict] : 'rgba(255,255,255,0.08)'}`,
              background: escalated ? '#0d1b2a' : 'rgba(255,255,255,0.03)',
            }}
          >
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
              background: dotColor, border: ships.length ? 'none' : '1px solid #5B6B76',
              boxShadow: worst ? `0 0 6px ${dotColor}` : 'none',
            }} />
            {b.name.replace(/\s*부두$/, '').replace('터미널', '').replace(/\s+/g, '')}
            {/* 기상으로 막힌 선석은 척수 대신 판정을 적는다 — 둘 다 적으면 칸을 넘쳐 옆 칸을 덮었다 */}
            {ships.length > 0 && !escalated && <span style={{ fontSize: '10px', color: '#8FA3B0', fontFamily: 'ui-monospace, Consolas, monospace' }}>{ships.length}/{cap}</span>}
            {escalated && (
              <span style={{ color: WEATHER_STATUS_COLORS[verdict], fontWeight: 800 }}>{SHORT_WX[verdict] || verdict}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
