import { showDisclosure } from '../../utils/disclosure';
import { FaShip, FaChevronDown } from 'react-icons/fa';

// ─────────────────────────────────────────────────────────────────────────────
// PORT-MIS 연계 상단 바
//
// 이 시스템은 독립 제품이 아니라 **울산항만공사 PORT-MIS 의 한 축**(액체화물
// 안전관제)으로 들어가는 것을 상정한다. 그런데 화면만 보면 별개 사이트처럼
// 보여서, 심사·시연에서 "이게 PORT-MIS 랑 무슨 관계냐"는 질문이 먼저 나왔다.
//
// 그래서 PORT-MIS 의 실제 상단 구조(좌측 기관 로고 → 활성 서비스 pill →
// 중앙 메뉴 → 우측 로그인)를 같은 자리에 두고, 그 pill 자리에 우리 시스템을
// 놓았다. 옆의 회색 메뉴는 PORT-MIS 가 이미 제공하는 다른 축이다.
//
// [정직성]
// 실제로 PORT-MIS 에 배포된 것은 아니다. 그래서
//   · 회색 메뉴는 클릭해도 아무 동작이 없고(커서도 default),
//   · 바 우측에 '연계 구상(데모)' 를 항상 띄운다.
// 통합된 척하지 않으면서 "여기 들어갈 자리"만 보여주는 것이 목적이다.
// ─────────────────────────────────────────────────────────────────────────────

// PORT-MIS 가 이미 제공하는 축들 — 우리 시스템의 위치를 보여주기 위한 맥락.
// 동작하지 않는다(실제 PORT-MIS 로 나가는 링크가 아니다).
const PORTMIS_MENUS = [
  'GIS 기반 항만 모니터링',
  '항만 업무 지원',
  '참여 게시판',
  '관심 선박 등록 관리',
];

export default function PortMisBar() {
  return (
    <div className="portmis-bar">
      <div className="portmis-brand">
        <span className="portmis-mark" aria-hidden="true">U</span>
        <span className="portmis-brand-text">
          울산항만공사
          <em>ULSAN PORT AUTHORITY</em>
        </span>
      </div>

      {/* 활성 서비스 — 이 자리가 우리 시스템이다 */}
      <div className="portmis-active" title="현재 보고 있는 서비스">
        <FaShip />
        액체화물 안전관제
        <FaChevronDown size={10} style={{ opacity: 0.7 }} />
      </div>

      <nav className="portmis-menus" aria-label="PORT-MIS 다른 서비스 (연계 구상)">
        {PORTMIS_MENUS.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </nav>

      <div className="portmis-right">
        {/* 통합된 척하지 않는다 — 구상임을 화면에 늘 적어 둔다 */}
        {showDisclosure() && <span className="portmis-demo">연계 구상 (데모)</span>}
      </div>
    </div>
  );
}
