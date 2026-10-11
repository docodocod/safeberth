import { NavLink } from 'react-router-dom';
import { FaCube, FaChartPie, FaWaveSquare, FaChevronLeft, FaChevronRight, FaClipboardCheck } from 'react-icons/fa';
import useVesselThread from '../../hooks/useVesselThread';
import SafetyIndexMini from './SafetyIndexMini';

// 지금 전체(대시보드) → 배 한 척의 판정(선박 판정, 화물 혼재 포함) → 현장 배치(3D) → 설비 순.
// [2026-09-30] 화물 혼재 심사는 선박 판정 안으로 합쳐 메뉴가 넷이다 — 혼재는 판정의 세 축(선석 · 기상 · 혼재) 중 하나다.
// 실제 흐름(입항 신고 → 사전배정 → 입항 전·접안 직전·하역 중 판정 → 게이트)을 따른다.
// [2026-09-29] 순서가 눈에 보이게 메뉴를 세로줄로 잇고 번호를 붙였다. 배를 고르면 그 배의 상태가
// 메뉴마다 점으로 찍힌다(위 선박 추적 띠와 같은 값) — 어느 화면에 볼 것이 있는지 메뉴에서 보인다.
const MENUS = [
  { to: '/', end: true, key: 'where', label: '대시보드', icon: FaChartPie },
  { to: '/arrivals', key: 'verdict', label: '선박 판정', icon: FaClipboardCheck },
  { to: '/twin', key: 'scene', label: '3D 관제 화면', icon: FaCube },
  { to: '/sensors', key: 'gate', label: '현장 설비', icon: FaWaveSquare },
];

export default function Sidebar({ collapsed, setCollapsed }) {
  const { thread } = useVesselThread();
  // top 은 PORT-MIS 연계 바 높이만큼 내린다 — 0 이면 사이드바가 그 바를 덮는다
  return (
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
      style={{ position: 'fixed', left: 0, top: 'var(--portmis-bar)', bottom: 0 }}
    >
      <div className="sidebar-logo">
        <div className="logo-icon"><FaWaveSquare /></div>
        {/* [2026-09-30] 시스템 이름은 SafeBerth 로고로(현우) — 배경을 뺀 PNG, 접으면 아이콘만 남는다 */}
        <div className="logo-text logo-img" title="SafeBerth — 울산항 온산 액체화물 하역 안전 관제">
          <img src="/safeberth-logo.png" alt="SafeBerth" />
        </div>
      </div>

      <nav className="sidebar-nav nav-rail">
        {MENUS.map((m, i) => {
          const Icon = m.icon;
          const st = thread?.steps[m.key];
          const lit = st && ['bad', 'warn', 'unknown', 'ok'].includes(st.tone) && (m.key === 'verdict' || m.key === 'gate');
          return (
            <NavLink key={m.to} to={m.to} end={m.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <div className="nav-icon">
                <Icon />
                <span className="nav-step" aria-hidden="true">{i + 1}</span>
              </div>
              <div className="nav-label">{m.label}</div>
              {lit && <span className={`nav-state tone-${st.tone}`} title={`${thread.name} · ${st.value}`}>{collapsed ? '' : (st.short || st.value)}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* 메뉴 아래 빈 자리 — 항만 안전 지수(어느 화면에서나 보인다) */}
      <div className="sidebar-fill">
        <SafetyIndexMini collapsed={collapsed} />
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <FaChevronRight /> : <><FaChevronLeft /> <span className="sidebar-footer-text">사이드바 축소</span></>}
        </button>
      </div>
    </aside>
  );
}
