import { useEffect, useState } from 'react';
import KPICard from '../components/dashboard/KPICard';
import WeatherPanel from '../components/dashboard/WeatherPanel';
import PortMap from '../components/dashboard/PortMap';
import PortCallTable from '../components/dashboard/PortCallTable';
import VesselDetailPanel from '../components/dashboard/VesselDetailPanel';
import BerthDetailPanel from '../components/dashboard/BerthDetailPanel';
import useDashboardData from '../hooks/useDashboardData';
import useSensorStore from '../stores/useSensorStore';
import { fetchPendingApprovals, fetchBerthAssignments } from '../api/backendAdapter';
import { FaShip, FaWarehouse, FaAnchor, FaShieldAlt } from 'react-icons/fa';

export default function DashboardPage() {
  const { data } = useDashboardData();

  // 확인 대기 판정 — 판정 감시가 기록한 이력 중 관제사가 아직 보지 않은 것(/approvals/pending).
  // 예전 4번째 타일은 안전 관제 탭에서 수동 심사를 돌리기 전엔 늘 "심사 전"이라 빈 칸이었다.
  const [pending, setPending] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchPendingApprovals().then((rows) => { if (alive) setPending(rows); }).catch(() => { if (alive) setPending(null); });
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // [2026-09-28] 기록 건수가 아니라 선박 수로 센다. 판정 이력은 시점(입항 전·접안 직전·하역 중)마다
  // 한 줄씩 쌓이므로, 같은 선박이 3건으로 세어지고 확인하지 않은 며칠 전 기록도 남는다
  // (9/28 실측: 44건 = 선박 기준으로는 훨씬 적음). 선박마다 가장 최근 판정 하나만 센다.
  const latestByVessel = (() => {
    const m = new Map();
    for (const r of pending ?? []) {
      const key = (r.call_sign || r.vessel_name || String(r.id)).trim().toUpperCase();
      const cur = m.get(key);
      if (!cur || String(r.assessed_at_utc) > String(cur.assessed_at_utc)) m.set(key, r);
    }
    return [...m.values()];
  })();
  const countLevel = (lv) => latestByVessel.filter((r) => r.level === lv).length;
  const unfitCount = countLevel('부적합');
  const unknownCount2 = countLevel('판정불가');
  const cautionCount = countLevel('주의');
  // 판정불가는 "모르면 통과시키지 않는다"의 결과다 — 왜 모르는지를 나눠 보인다.
  const unknownWhy = latestByVessel.filter((r) => r.level === '판정불가').reduce((acc, r) => {
    const t = (r.reasons || []).join(' ');
    const k = /마스터 미등록|찾을 수 없습니다/.test(t) ? '선석자료 없음'
      : /화물을 식별할 수 없습니다/.test(t) ? '화물 미식별'
        : /항해상태/.test(t) ? '항해상태'
          : /관측|기상/.test(t) ? '기상 관측 없음' : '기타';
    acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  const unknownWhyText = Object.entries(unknownWhy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');

  // KPI는 실AIS(+실화물 조인) 기준으로 센다 — data.vessels는 데모 시나리오 선박이라
  // 실제 재항 척수와 무관하다.
  //
  // 지도는 성능 때문에 200척만 그리지만(MAP_VESSEL_LIMIT) KPI 는 전체를 센다.
  // 상한이 KPI 까지 잘라버리면 "관제 선박이 항상 200척"으로 보여 사실과 어긋난다.
  const vessels = data?.real_traffic ?? [];
  const vesselTotal = data?.real_traffic_total ?? vessels.length;
  const liquidCount = data?.real_traffic_liquid_total
    ?? vessels.filter((v) => v.is_liquid_cargo_vessel).length;
  // "액체화물선 66척"의 나머지를 일반화물선으로 읽으면 안 된다 — 대부분은 PORT-MIS
  // 대조가 안 돼 선종을 모르는 배다. 그 수를 KPI 부제에 같이 적어 오해를 막는다.
  const unknownCount = data?.real_traffic_unknown_total ?? 0;
  // 접안 중·정박지 대기 = UPA 위치 판정(mart.vessel_presence). 온산 선석 점유 카드와
  // 지도 범례가 쓰는 /berths·/anchorages 와 같은 기준이라 한 화면의 숫자가 어긋나지 않는다.
  // 판정이 없을 때만(구버전 백엔드) 예전처럼 자기신고 항해상태로 센다 — 그때도
  // 항해상태 코드가 없는 배(Class B 소형 작업선)는 대기로 세지 않는다(backendAdapter 주석).
  const mooredCount = data?.real_traffic_berthed_total
    ?? vessels.filter((v) => v.nav_status_category === 'MOORED').length;
  const anchorCount = data?.real_traffic_anchored_total
    ?? vessels.filter((v) => v.nav_status_category === 'AT_ANCHOR').length;
  const unknownNavCount = vessels.filter((v) => v.nav_status_category === 'UNKNOWN').length;

  // 온산 선석 점유 — 선박 판정 화면의 선석 점유(/dashboard/berth-assignments)와 같은 출처로 센다.
  // [2026-09-27] 예전엔 /dashboard/berths(계류시설 20곳)로 세어 "9/20"이었고 선석 화면은 "7/12"라
  // 같은 시각에 두 숫자가 보였다(9/26 캡처). 한 시스템이 같은 질문에 두 숫자를 내면 어느 쪽도 못 믿는다.
  // (예전 "가동 탱크" 타일은 하드코딩 탱크 4기를 세던 값이라 걷어냈다.)
  const [berthRows, setBerthRows] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchBerthAssignments().then((rows) => { if (alive) setBerthRows(rows); }).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const onsanBerthRows = (berthRows ?? []).filter((b) => b.port_name === '온산항');
  // [2026-09-30] 선석 현황판은 추적 띠의 '선박 찾기' 창 안으로 옮겼다(현우) — 타일이 그 창을 연다
  const setPickerOpen = useSensorStore((s) => s.setPickerOpen);
  const showBerthBoard = () => setPickerOpen(true);
  const occupiedBerths = onsanBerthRows.filter((b) => (b.slots || []).some((s) => s.call_sign)).length;

  return (
    <div className="dashboard-page">
      <div className="kpi-grid">
        {/* 자료가 오기 전에는 0 이 아니라 '—' — 0척으로 보이면 항만이 빈 것처럼 읽힌다 */}
        <KPICard title="관제 선박" value={data ? vesselTotal : '—'} unit={data ? '척' : ''} icon={<FaShip />} change={data ? `액체화물선 ${liquidCount} · 선종 미확인 ${unknownCount}` : '불러오는 중'} trend={liquidCount > 0 ? 'negative' : 'neutral'} />
        <KPICard title="접안 중" value={data ? mooredCount : '—'} unit={data ? '척' : ''} icon={<FaAnchor />} change={data ? `정박지 대기 ${anchorCount} · 소형선 ${unknownNavCount}` : '불러오는 중'} trend="neutral" />
        <KPICard
          title="온산 선석 점유"
          value={berthRows ? occupiedBerths : '—'}
          unit={berthRows ? '개' : ''}
          icon={<FaWarehouse />}
          change={berthRows ? `온산 부두 ${onsanBerthRows.length}곳 중` : '불러오지 못함'}
          trend="neutral"
          onClick={showBerthBoard}
        />
        <KPICard
          title="확인 대기 판정"
          value={pending ? latestByVessel.length : '—'}
          unit={pending ? '척' : ''}
          icon={<FaShieldAlt />}
          change={pending
            ? `부적합 ${unfitCount}${cautionCount ? ` · 주의 ${cautionCount}` : ''} · 판정불가 ${unknownCount2}`
            : '불러오지 못함'}
          trend={!pending ? 'neutral' : unfitCount > 0 ? 'negative' : 'positive'}
          to="/arrivals?view=pending"
        />
      </div>

      {/* 경고 센터는 헤더 알림 벨(AlertBell)로 옮겼다 — 재항 전수 판정으로 경고가
          36건까지 늘면서 첫 화면을 통째로 덮어, 지도·기상·선석 판정이 스크롤 아래로
          밀렸기 때문. 미확인 건수는 벨 배지에 항상 떠 있어 놓치지 않는다. */}

      {/* 온산 관제 지도 — 첫 화면에서 "어디에 어떤 배가, 어떤 판정으로" 보인다(배 색 = 선종, 고리 = 판정).
          [2026-09-29 밤] 선석 점유 타일은 선석 현황판으로, 확인 대기 판정 타일은 선박 판정의 확인 대기로 간다 —
          예전엔 둘 다 선박 판정 화면으로 가서 두 타일의 차이가 보이지 않았다(현우).
          [2026-09-30] 선석 현황판은 '선박 찾기' 창 안으로 옮기고 지도를 넓혔다(현우). 부두 기상 · 최근 접안 ·
          재항 시간은 선석 상세 서랍(지도의 선석 원 · 이름표, 선석 현황판의 부두 이름)에서 본다. */}
      <div className="dash-section glass-card">
        <div className="glass-card-header">
          <h3 className="glass-card-title">온산항 관제 지도</h3>
        </div>
        <div style={{ height: 'clamp(520px, 72vh, 900px)' }}>
          <PortMap />
        </div>
      </div>

      {/* 기상 패널 (Full Width) */}
      <div className="dash-section">
        <WeatherPanel />
      </div>

      {/* 입항 선박 목록 (Full Width) */}
      <div className="dash-section">
        <PortCallTable />
      </div>

      {/* 다차원 안전 평가 지수는 사이드바로 옮겼다(2026-09-30) — 맨 아래 두면 찾기 어려웠다. 누르면 차트와 축별 근거 */}

      {/* 화면에서 내린 것들 —
          · 탱크 저장 현황: 센서 데이터 탭의 탱크 센서와 같은 값을 두 번 그리고 있었다.
          · 시간대별 처리량/안전지수 차트: chartData가 코드에 박힌 고정 배열이었다.
            유량계가 없어 처리량 실측 소스가 없는데 그럴듯한 곡선을 그리면,
            실데이터로 채운 나머지 화면까지 같이 의심받는다.
          · 협상 로그(NegotiationChat): 하드코딩 대화 — 우하단 AgentConsole로 대체. */}

      {/* 선박 상세 패널 (지도 마커/입항 목록/경고 벨에서 선박 클릭 시) */}
      <VesselDetailPanel />
      {/* 선석 상세 서랍 (선석 현황판 칸 · 지도 선석 원) */}
      <BerthDetailPanel />

      {/* 협상 콘솔은 App 전역 마운트로 올렸다(2026-08-22) — 배정현황·안전 탭에서도
          승인·판정에 닿아야 해서. 여기서 또 그리면 두 개가 겹친다. */}
    </div>
  );
}
