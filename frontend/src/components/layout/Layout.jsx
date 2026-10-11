import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import PortMisBar from './PortMisBar';
import VesselTrail from './VesselTrail';
import useSensorStore from '../../stores/useSensorStore';
import { useEffect, useRef, useState } from 'react';

// ToastContainer 는 걷어냈다 — useSensorStore.alerts 를 읽는데 그 배열을 채우는
// addAlert/updateSensorData 를 부르는 곳이 코드베이스에 하나도 없어(WebSocket 경로
// 잔해) 토스트가 뜬 적이 없다. 관제 경고는 헤더 알림 벨이 담당한다.
//
// 맨 위 PortMisBar 는 이 시스템이 PORT-MIS 의 한 축으로 들어가는 자리를 보여준다
// (실제 배포는 아니며, 바 우측에 '연계 구상(데모)' 를 항상 띄운다).

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // [2026-09-29] 화면을 옮기면 맨 위부터 — 스크롤 칸이 하나라 앞 화면의 위치가 남아
  // 선박 판정 → 하역 개시 게이트로 가면 게이트 카드가 아니라 아래 탱크부터 보였다.
  const { pathname } = useLocation();
  const contentRef = useRef(null);
  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [pathname]);
  // [2026-09-30] 선박 상세(오른쪽 패널)는 대시보드 것 — 다른 화면으로 가면 닫는다.
  //   예전엔 열어 둔 채 3D 관제 화면으로 가면 그 위에 그대로 떠 있었다(현우). 띠의 '위치' 칸은 대시보드로 가며 여는 것이라 그대로 된다.
  const setSelectedVessel = useSensorStore((s) => s.setSelectedVessel);
  useEffect(() => { if (pathname !== '/') setSelectedVessel(null); }, [pathname, setSelectedVessel]);

  return (
    <div className="app-shell">
      <PortMisBar />
      <div className="app-layout">
        <Sidebar collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />
        <div className="main-area" style={{ marginLeft: sidebarCollapsed ? '72px' : '260px' }}>
          <Header />
          <VesselTrail />
          <main className="page-content" ref={contentRef}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
