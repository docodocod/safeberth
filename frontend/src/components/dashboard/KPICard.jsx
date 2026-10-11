import { useNavigate } from 'react-router-dom';

// to 가 있으면 타일이 그 화면으로 가는 단추가 된다(2026-09-27). "확인 대기 판정 17건"을 보고도
// 어디서 확인하는지 알 수 없던 문제 — 숫자를 보여 주는 타일은 그 숫자의 자세한 화면으로 이어져야 한다.
// [2026-09-29 밤] onClick — 같은 화면 안의 자세한 자리(선석 현황판)로 갈 때
export default function KPICard({ title, value, unit, icon, change, trend = 'positive', to = null, onClick = null }) {
  const navigate = useNavigate();
  const clickable = Boolean(to || onClick);
  const go = () => (onClick ? onClick() : navigate(to));
  return (
    <div
      className="kpi-card"
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? `${title} 자세히 →` : undefined}
      onClick={clickable ? go : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') go(); } : undefined}
      style={clickable ? { cursor: 'pointer' } : undefined}
    >
      <div className="kpi-icon" style={{
        background: `rgba(${trend === 'positive' ? '0, 212, 170' : trend === 'negative' ? '255, 75, 110' : '58, 134, 255'}, 0.1)`,
        color: `var(--${trend === 'positive' ? 'teal' : trend === 'negative' ? 'red' : 'blue'})`
      }}>
        {icon}
      </div>
      <div className="kpi-content">
        <div className="kpi-label">{title}{clickable && <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>→</span>}</div>
        <div>
          <span className="kpi-value">{value}</span>
          <span className="kpi-unit">{unit}</span>
        </div>
      </div>
      {/* [2026-09-30] 아래 줄은 타일 전체 폭을 쓴다 — 아이콘 옆 좁은 칸에서는 '선종 미확인 293'이 잘렸다 */}
      {change && (
        <div className={`kpi-change ${trend}`}>
          {change}
        </div>
      )}
    </div>
  );
}
