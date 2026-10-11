import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import DigitalTwinPage from './pages/DigitalTwinPage';
import DashboardPage from './pages/DashboardPage';
import SensorPage from './pages/SensorPage';
import ArrivalVerificationPage from './pages/ArrivalVerificationPage';
import AgentConsole from './components/dashboard/AgentConsole';

// 첫 화면은 대시보드다.
//
// 한때 3D 화면을 첫 화면에 뒀지만, 1차 시연 범위에서 빠지면서 되돌렸다.
// 관제 업무의 출발점은 "지금 항만이 어떤 상태인가"이고 그게 대시보드다.
export default function App() {
  return (
    <>
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/arrivals" element={<ArrivalVerificationPage />} />
        {/* 선석 현황은 선박 판정 화면 안으로 합쳤다(2026-09-27) — 예전 링크는 그 자리로 보낸다 */}
        <Route path="/berth-assignments" element={<Navigate to="/arrivals#berthed" replace />} />
        <Route path="/twin" element={<DigitalTwinPage />} />
        {/* 화물 혼재 심사는 선박 판정 화면 안으로 합쳤다(2026-09-30) — 예전 링크는 그 자리로 보낸다 */}
        <Route path="/safety" element={<Navigate to="/arrivals" replace />} />
        <Route path="/sensors" element={<SensorPage />} />
        {/* 예전에 트윈이 / 였던 시절 공유된 링크를 살려 둔다 */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    {/* 에이전트 협상 로그(종합 판정·승인)는 전역 고정이다.
        대시보드에만 마운트돼 있던 시절, 배정현황 페이지가 "승인/반려는 우하단
        협상 로그에서 처리하세요"라고 안내하는데 정작 그 페이지에는 콘솔이 없어
        사용자가 대시보드로 되돌아가야 했다(2026-08-22 실발견 — "사용흐름이
        보기 어렵다"는 피드백의 실례). 판정 진입점이 하나라면 어디서든 닿아야 한다.
        3D 관제(/twin)만 제외 — 전체화면 연출 위에 겹치면 HUD 를 가린다. */}
    <AgentConsole mode="qa" />
    </>
  );
}
