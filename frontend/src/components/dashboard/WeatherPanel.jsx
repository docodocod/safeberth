import useDashboardData from '../../hooks/useDashboardData';
import { COLORS } from '../../utils/constants';
import { FaWind, FaWater, FaArrowsAltV, FaEye, FaLocationArrow } from 'react-icons/fa';

// ─────────────────────────────────────────────────────────────────────────────
// 색 판정 기준 = 온산 선석 중 "가장 먼저 걸리는" 하역중단 임계
//
// 예전에는 여기에 일반 참고값(풍속 14 / 파고 2.0)이 따로 박혀 있었다. 그런데 바로
// 아래 선석별 판정 패널은 DB 임계표(berth_weather_threshold, 터미널 입항정보
// 실측)를 쓴다. 그래서 파고 1.2 m 인 날 이 패널은 초록(2.0 미만)인데 정일 선석은
// "하역중단"(임계 1.0)이 떴다 — 한 화면에서 기상이 안전하다고도 위험하다고도
// 말한 셈이다.
//
// 판정 권위는 선석별 판정 하나뿐이므로, 이 패널은 DB 임계표 8행의 최솟값을 쓴다:
//   중단 풍속 최솟값 12 m/s — 한국석유공사원유부이 (부이 계류라 부두보다 낮다)
//   중단 파고 최솟값 1.0 m  — 정일1/2부두(산암리)
// 여기가 노랑/빨강이면 "어느 선석 하나는 이미 중단 조건 근처/도달"이라는 뜻이다.
const ONSAN_MIN_STOP = { wind: 12, wave: 1.0 };

const THRESHOLDS = {
  // warn = 중단 임계의 80% 지점(접근 중), danger = 중단 임계 도달
  wind: { warn: ONSAN_MIN_STOP.wind * 0.8, danger: ONSAN_MIN_STOP.wind },
  wave: { warn: ONSAN_MIN_STOP.wave * 0.8, danger: ONSAN_MIN_STOP.wave },
  visibility: { warnBelow: 5, dangerBelow: 1 }, // km — 도선 관행 기준(선석 임계표에 없음)
};

const statusColor = (value, { warn, danger, warnBelow, dangerBelow }) => {
  // 관측값이 없으면 색을 칠하지 않는다.
  //
  // 예전엔 null 을 그대로 비교해서 결측이 양쪽으로 거짓말을 했다 —
  //   시정 null → (null <= 1) 이 참 → 값이 빈 칸인데 빨간 "시정" 타일
  //   파고 null → 어떤 조건도 안 걸림  → 초록(정상)
  // 같은 "모름"이 하나는 위험, 하나는 안전으로 보였다.
  if (value == null || Number.isNaN(value)) return COLORS.textDim;
  if (danger != null && value >= danger) return COLORS.red;
  if (warn != null && value >= warn) return COLORS.yellow;
  if (dangerBelow != null && value <= dangerBelow) return COLORS.red;
  if (warnBelow != null && value <= warnBelow) return COLORS.yellow;
  return COLORS.teal;
};

/** 결측이면 "—" 로 적는다(0 으로 적으면 관측된 0 과 구분이 안 된다) */
const fmt = (v, digits = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(digits));

function WeatherTile({ icon, label, value, unit, color, sub }) {
  return (
    <div style={{
      flex: '1 1 200px', minWidth: '200px', background: COLORS.card,
      border: `1px solid ${color === COLORS.teal ? COLORS.border : color}`,
      borderRadius: '14px', padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', color: COLORS.textSecondary, fontSize: '14px', fontWeight: 600 }}>
        <span style={{ color, fontSize: '16px', display: 'flex' }}>{icon}</span> {label}
      </div>
      <div style={{ fontSize: '36px', fontWeight: 800, color, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        <span style={{ fontSize: '16px', fontWeight: 500, color: COLORS.textSecondary, marginLeft: '5px' }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: '12.5px', color: COLORS.textDim, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

export default function WeatherPanel() {
  const { data } = useDashboardData();
  const w = data?.weather;
  if (!w) return null;

  const windColor = statusColor(w.wind_speed_ms, THRESHOLDS.wind);
  const waveColor = statusColor(w.wave_height_sig_m, THRESHOLDS.wave);
  // 계약 필드명은 visibility_m 이지만 값 스케일(19.8)상 km 단위로 표시
  const visColor = statusColor(w.visibility_m, THRESHOLDS.visibility);

  const observed = w.observed_at_utc
    ? new Date(w.observed_at_utc).toLocaleString('ko-KR', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hour12: false, timeZone: 'Asia/Seoul',
      })
    : '-';

  return (
    <div className="glass-card">
      <div className="glass-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
        <h3 className="glass-card-title">항만 기상 현황</h3>
        <span style={{ fontSize: '12px', color: COLORS.textDim }}>
          관측 {observed} (KST)
        </span>
      </div>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <WeatherTile
          icon={<FaWind />}
          label="풍속"
          value={fmt(w.wind_speed_ms)}
          unit="m/s"
          color={windColor}
          sub={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              {w.wind_dir_deg != null && (
                <FaLocationArrow style={{
                  // FaLocationArrow 기본 방향(북동 45°) 보정 후 풍향 적용
                  transform: `rotate(${w.wind_dir_deg - 45}deg)`,
                  color: COLORS.textSecondary,
                }} />
              )}
              풍향 {w.wind_dir_deg != null ? `${w.wind_dir_deg}°` : '관측 없음'} · 중단 임계 {ONSAN_MIN_STOP.wind}m/s~ (석유공사부이 최저)
            </span>
          }
        />
        <WeatherTile
          icon={<FaWater />}
          label="유의파고"
          value={fmt(w.wave_height_sig_m)}
          unit="m"
          color={waveColor}
          sub={`중단 임계 ${ONSAN_MIN_STOP.wave}m~ (정일1/2 최저)`}
        />
        <WeatherTile
          icon={<FaArrowsAltV />}
          label="조위"
          value={w.tide_level_cm ?? '—'}
          unit="cm"
          color={w.tide_level_cm == null ? COLORS.textDim : COLORS.info}
          sub="울산 조위관측소"
        />
        <WeatherTile
          icon={<FaEye />}
          label="시정"
          value={fmt(w.visibility_m)}
          unit="km"
          color={visColor}
          sub={w.visibility_m == null
            ? '관측 없음 — 판정에 쓰지 않음'
            : `경고 ${THRESHOLDS.visibility.warnBelow}km 미만 (도선 관행)`}
        />
      </div>
    </div>
  );
}
