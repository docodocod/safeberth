import { COLORS } from '../../utils/constants';

// 화물 종류별 액체 색상 (mock cargoType 기준)
const LIQUID_COLORS = {
  'Crude Oil': '#8a5a2b',
  Gasoline: '#e8c547',
  Chemicals: '#4ecdc4',
  Empty: '#2a3a4a',
};

const liquidColor = (cargoType) => LIQUID_COLORS[cargoType] || '#74c0fc';

/**
 * 가상 저장탱크 모형: 수위가 실제로 차오르고 표면이 출렁이는 SVG.
 * 수위 90% 초과 / 압력 5.5bar 초과 / 온도 40℃ 초과 시 경고 표시.
 */
export function TankModel({ tank }) {
  const level = Math.max(0, Math.min(100, tank.level));
  const color = liquidColor(tank.cargoType);
  const warning = level > 90 || tank.pressure > 5.5 || tank.temperature > 40;
  const active = tank.status === 'active';

  // SVG 내부 좌표: 탱크 본체 y 18~112 (높이 94)
  const liquidTop = 112 - (94 * level) / 100;

  return (
    <div className="sensor-card" style={{ borderLeft: `3px solid ${warning ? COLORS.red : active ? COLORS.teal : COLORS.textDim}` }}>
      <div className="sensor-card-header">
        <span className="sensor-id">{tank.id} · {tank.cargoType}</span>
        <span className={`sensor-status ${active ? 'online' : 'offline'}`}>
          {({ active: '가동', idle: '대기', maintenance: '정비' })[tank.status] || tank.status}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
        <svg width="96" height="130" viewBox="0 0 96 130">
          <defs>
            <clipPath id={`tank-clip-${tank.id}`}>
              <rect x="14" y="18" width="68" height="94" rx="6" />
            </clipPath>
          </defs>

          {/* 탱크 몸체 */}
          <rect x="14" y="18" width="68" height="94" rx="6" fill="#1b2838" stroke="#4a6a82" strokeWidth="1.5" />

          {/* 액체 (수위) + 출렁이는 표면 */}
          <g clipPath={`url(#tank-clip-${tank.id})`}>
            <rect x="14" y={liquidTop} width="68" height={112 - liquidTop + 2} fill={color} opacity="0.75" />
            <path
              d={`M 6 ${liquidTop} q 12 -4 24 0 t 24 0 t 24 0 t 24 0 v 6 h -120 z`}
              fill={color}
              opacity="0.5"
            >
              <animateTransform
                attributeName="transform" type="translate"
                values="0 0; -24 0; 0 0" dur="3.2s" repeatCount="indefinite"
              />
            </path>
          </g>

          {/* 지붕 + 밸브 */}
          <rect x="10" y="12" width="76" height="7" rx="3" fill="#374151" />
          <rect x="42" y="4" width="12" height="9" rx="2" fill="#eab308" />

          {/* 받침 */}
          <rect x="8" y="112" width="80" height="6" rx="2" fill="#374151" />

          {/* 수위 눈금 */}
          {[25, 50, 75].map((g) => (
            <line key={g} x1="82" x2="88" y1={112 - 0.94 * g} y2={112 - 0.94 * g} stroke="#4a6a82" strokeWidth="1" />
          ))}

          {/* 경고 링 */}
          {warning && (
            <circle cx="48" cy="65" r="42" fill="none" stroke={COLORS.red} strokeWidth="2" opacity="0.8">
              <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.2s" repeatCount="indefinite" />
            </circle>
          )}

          {/* 수위 % */}
          <text x="48" y="70" textAnchor="middle" fill="#e8f0f2" fontSize="15" fontWeight="700">
            {level.toFixed(0)}%
          </text>
        </svg>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
          <div>
            <span style={{ color: COLORS.textSecondary }}>온도</span>{' '}
            <strong style={{ color: tank.temperature > 40 ? COLORS.red : COLORS.textPrimary }}>
              {tank.temperature.toFixed(1)}°C
            </strong>
          </div>
          <div>
            <span style={{ color: COLORS.textSecondary }}>압력</span>{' '}
            <strong style={{ color: tank.pressure > 5.5 ? COLORS.red : COLORS.textPrimary }}>
              {tank.pressure.toFixed(2)} bar
            </strong>
          </div>
          {warning && (
            <span style={{ color: COLORS.red, fontSize: '12px', fontWeight: 'bold' }}>⚠ 임계 초과</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 가상 배관 모형: 흐름이 있으면 유체 대시가 흐르는 애니메이션.
 * 유량에 비례해 흐름 속도가 달라진다.
 */
export function PipeModel({ pipe }) {
  const flowing = pipe.flowRate > 0;
  // 유량 1500 t/h → 약 0.8s 주기, 유량 낮을수록 느리게
  const dur = flowing ? Math.max(0.6, 2.4 - (pipe.flowRate / 1500) * 1.8) : 0;

  return (
    <div className="sensor-card" style={{ borderLeft: `3px solid ${flowing ? COLORS.blue : COLORS.textDim}` }}>
      <div className="sensor-card-header">
        <span className="sensor-id">{pipe.id}</span>
        <span className={`sensor-status ${flowing ? 'online' : 'offline'}`}>
          {flowing ? '이송 중' : '대기'}
        </span>
      </div>

      <svg width="100%" height="64" viewBox="0 0 260 64" preserveAspectRatio="xMidYMid meet">
        {/* 플랜지(양끝) */}
        <rect x="6" y="18" width="10" height="28" rx="2" fill="#4b5563" />
        <rect x="244" y="18" width="10" height="28" rx="2" fill="#4b5563" />

        {/* 배관 본체 */}
        <rect x="16" y="24" width="228" height="16" rx="8" fill="#1b2838" stroke="#4a6a82" strokeWidth="1.5" />

        {/* 유체 흐름 대시 */}
        {flowing && (
          <line x1="24" y1="32" x2="236" y2="32" stroke={COLORS.blue} strokeWidth="7"
            strokeLinecap="round" strokeDasharray="14 12">
            <animate attributeName="stroke-dashoffset" values="26;0" dur={`${dur}s`} repeatCount="indefinite" />
          </line>
        )}

        {/* 중앙 밸브 */}
        <circle cx="130" cy="32" r="9" fill={flowing ? '#0d4f6e' : '#243447'} stroke="#4a6a82" strokeWidth="1.5" />
        <rect x="127.5" y="12" width="5" height="12" rx="1.5" fill="#eab308" />

        {/* 흐름 방향 화살표 */}
        <path d="M 220 52 l 14 6 l -14 6 z" transform="translate(0,-26) scale(1)" fill={flowing ? COLORS.blue : '#4a6a82'} opacity={flowing ? 1 : 0.4} />
      </svg>

      <div style={{ display: 'flex', gap: '18px', fontSize: '13px', marginTop: '4px' }}>
        <div>
          <span style={{ color: COLORS.textSecondary }}>유량</span>{' '}
          <strong>{pipe.flowRate.toFixed(0)} t/h</strong>
        </div>
        <div>
          <span style={{ color: COLORS.textSecondary }}>압력</span>{' '}
          <strong>{pipe.pressure.toFixed(2)} bar</strong>
        </div>
      </div>
    </div>
  );
}
