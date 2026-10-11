import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Rectangle, Tooltip, Polyline, Polygon } from 'react-leaflet';
import useVesselSafety from '../../hooks/useVesselSafety';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import useSensorStore from '../../stores/useSensorStore';
import useDashboardData from '../../hooks/useDashboardData';
import useVesselThread, { normKey } from '../../hooks/useVesselThread';
import { VERDICT_COLOR, berthKey, verdictColor } from '../../utils/verdict';
import { ONSAN_BERTHS, ONSAN_ADJACENCY, ONSAN_WEATHER_GROUP, onsanDisplayPos, findBerthIdByName } from '../../utils/geoUtils';
import {
  COLORS,
  ULSAN_BBOX_BOUNDS,
  MAP_CENTER,
  MAP_DEFAULT_ZOOM,
  NAV_STATUS,
  WEATHER_STATUS_COLORS,
} from '../../utils/constants';

const SHIP_SVG_PATH =
  'M20 21c-1.39 0-2.78-.47-4-1.32-2.44 1.71-5.56 1.71-8 0C6.78 20.53 5.39 21 4 21H2v2h2c1.38 0 2.74-.35 4-.99 2.52 1.29 5.48 1.29 8 0 1.26.65 2.62.99 4 .99h2v-2h-2zM3.95 19H4c1.6 0 3.02-.88 4-2 .98 1.12 2.4 2 4 2s3.02-.88 4-2c.98 1.12 2.4 2 4 2h.05l1.89-6.68c.08-.26.06-.54-.06-.78s-.34-.42-.6-.5L20 10.62V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.62l-1.29.42c-.26.08-.48.26-.6.5s-.15.52-.06.78L3.95 19zM6 6h12v3.73l-6-1.94-6 1.94V6z';

// 기호는 배 모양 하나로 통일한다(2026-08-17).
// [2026-09-29 밤] 색 규칙을 다시 잡았다(현우: "빨간 배는 다 실데이터 액체화물선인가?").
//   배 색 = 선종 — 남색은 PORT-MIS 선종이 액체화물선인 배(실데이터), 회색은 그 밖의 배.
//   고리 색 = 판정 — 선박 판정·선석 현황판·추적 띠와 같은 색(부적합 빨강 · 주의 주황 · 판정불가 보라 · 적합 초록).
// 예전엔 빨강 = 액체화물선, 큰 배 + 고리 = '화물 확인'이었는데, 화물 행은 선종 기반으로 채운 값이라
// 크기·고리 구분이 뜻이 없었고, 빨강이 위험처럼 읽혔다. 지도는 이제 판정을 직접 보인다.
const OTHER_SHIP = '#8A99A6';
const createVesselIcon = (vessel, level, isTracked) => {
  const liquid = Boolean(vessel.is_liquid_cargo_vessel || vessel.cargo);
  const size = isTracked ? 36 : liquid ? 26 : 16;
  const cls = [
    'vessel-marker',
    liquid ? 'vessel-marker--liquid' : 'vessel-marker--lite',
    level ? 'vessel-marker--ring' : '',
    level === '부적합' ? 'vessel-marker--alarm' : '',
    isTracked ? 'vessel-marker--tracked' : '',
  ].filter(Boolean).join(' ');
  const html = `
    <div class="${cls}" style="width:${size}px;height:${size}px;${level ? `--ring:${verdictColor(level)};` : ''}">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"
           fill="${liquid ? COLORS.navy : OTHER_SHIP}">
        <path d="${SHIP_SVG_PATH}"/>
      </svg>
    </div>`;

  return L.divIcon({
    html,
    className: 'vessel-divicon', // leaflet 기본 흰 배경 제거용
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

// 선석 이름표 — 누를 수 있는 표식(마커). 배 표식보다 위(zIndexOffset), 추적 중인 배보다는 아래.
// [2026-09-30] 예전 이름표는 원에 붙은 툴팁이라 원 가운데를 배 표식이 덮으면 선석을 누를 수 없었고,
//   툴팁을 누를 수 있게 해도 Leaflet 이 누르는 순간 포인터를 놓쳐 click 이 나지 않았다.
const berthTagIcon = (text, tone) => L.divIcon({
  className: 'berth-tag-icon',
  html: `<div class="berth-tag"${tone ? ` style="border-color:${tone};color:${tone}"` : ''}>${text}</div>`,
  iconSize: [0, 0],
  iconAnchor: [0, 0],
});

const formatKST = (utcString) => {
  if (!utcString) return '-';
  return new Date(utcString).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  });
};

// 지도에 겹치는 두 레이어를 범례에서 구분한다 — 둘 다 실 AIS 지만 아는 정보가 다르다.
//   배 아이콘 : 위치 + 재항 화물까지 확인된 배 (클릭 -> 상세·안전판정)
//   점       : 위치만 확인된 배
// 화면에 실제로 그려지는 것만 적는다. 범례에 있는데 화면에 없거나 그 반대면
// 사용자가 지도를 못 믿게 된다.
//
// 점(AIS 레이어)은 체크박스를 켰을 때만 그려지므로 범례도 그때만 보여준다 —
// 꺼 놓고 보면 "● 항해 중" 같은 항목이 화면 어디에도 없다.
// 범례는 "색 — 뜻" 만 적는다. 예전 문구는 '큰 배+링', '작은 배'처럼 기호의
// 생김새를 설명했는데, 색 점이 이미 옆에 찍혀 있으니 생김새 묘사는 소음이었다
// (2026-08-17 피드백). 크기 차이는 화면에서 저절로 보인다 — 화물까지 확인된
// 배가 크게, 위치만 수신된 배가 작게 그려진다는 규칙은 빨강 항목 하나에만 적는다.
// 범례는 한 단어씩만 — 문장 설명은 뺐다(2026-08-21 피드백: "구분만 확실하면
// 된다"). 색·모양의 뜻은 hover 툴팁(title)이 보조한다.
const LEGEND_RINGS = ['부적합', '주의', '판정불가', '적합'];

// 온산 2클러스터(처용리/산암리) 뷰.
//
// 예전엔 center/zoom 을 손으로 박아 뒀는데, 줌을 한 단계 올리자(부두 이름표가
// 서로 겹쳐서) 북쪽 OTK·S-Oil 무리가 화면 위로 잘려 나갔다. 눈으로 맞춘 중심은
// 줌이 바뀔 때마다 다시 틀어진다.
//
// 그래서 좌표를 고정하지 않고, 실제 선석 14개가 다 들어오는 범위에 맞춘다.
// 선석이 추가·이동돼도 화면이 알아서 따라온다.
//
// 단, 기본 뷰는 '부두'에만 맞춘다. 석유공사 원유부이는 같은 온산 시설이지만
// 해상 계류점이라 부두에서 4 km 넘게 떨어져 있다. 부이까지 한 화면에 넣으면
// 정작 부두 무리가 다시 뭉쳐 이름표가 겹친다. 부이는 아래 '온산 전체' 버튼으로 본다.
// [2026-09-30] 선석 원은 서버 선석 좌표(위치 판정이 쓰는 좌표)로 그린다 — 아래 컴포넌트의 posOf.
//   화면 정본(ONSAN_BERTHS)의 대표 좌표는 서버 좌표와 100 m ~ 1.2 km 어긋나, 선석 현황판이 'OTK1 아젤리아'라고
//   하는데 지도에서는 그 배가 UTK 원 옆에 그려졌다(9/30 실측: 아젤리아 · 우황 · 아르페지오 · 수성7).
//   서버 좌표가 없는 곳(석유공사부이)만 대표 좌표를 쓴다. 이 상수는 서버 자료가 오기 전 첫 화면용이다.
const ONSAN_WHARF_BOUNDS = Object.values(ONSAN_BERTHS)
  .filter((b) => b.waterway !== '부이(해상)')
  .map((b) => onsanDisplayPos(b));
const ONSAN_FIT = { padding: [48, 48], maxZoom: 15 };
const ONSAN_CENTER = [35.435, 129.365];   // 첫 렌더용 근사값 (곧 fitBounds 가 덮어쓴다)
const ONSAN_ZOOM = 14;

export default function PortMap() {
  const setSelectedObject = useSensorStore((s) => s.setSelectedObject);
  const setSelectedVessel = useSensorStore((s) => s.setSelectedVessel);
  const setSelectedBerth = useSensorStore((s) => s.setSelectedBerth);
  const selectedBerth = useSensorStore((s) => s.selectedBerth);
  const tracked = useSensorStore((s) => s.trackedVessel);
  const threadFocus = useSensorStore((s) => s.threadFocus);
  const berthWeather = useSensorStore((s) => s.berthWeather);
  const { data } = useDashboardData();
  // 판정 고리 — 선박 판정·선석 현황판과 같은 자료(접안 중이면 선석 판정, 아니면 입항 판정)
  const mapRef = useRef(null);
  const { verdicts, berths: berthRows } = useVesselThread();
  // 선석 원 좌표 — 서버 선석 좌표가 있으면 그것(배의 접안 판정과 같은 기준), 없으면 대표 좌표
  const serverPos = useMemo(() => {
    const m = new Map();
    for (const b of berthRows) {
      if (b.latitude != null && b.longitude != null) m.set(berthKey(b.wharf_name), [Number(b.latitude), Number(b.longitude)]);
    }
    return m;
  }, [berthRows]);
  const posOf = (b) => serverPos.get(berthKey(b.name)) || onsanDisplayPos(b);
  const wharfBounds = useMemo(
    () => Object.values(ONSAN_BERTHS).filter((b) => b.waterway !== '부이(해상)').map(posOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverPos]
  );
  // 서버 좌표가 처음 도착하면 한 번 다시 맞춘다(UTK 가 대표 좌표보다 북쪽이라 첫 화면에서 잘렸다)
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || serverPos.size === 0 || !mapRef.current) return;
    fitted.current = true;
    mapRef.current.fitBounds(wharfBounds, ONSAN_FIT);
  }, [serverPos, wharfBounds]);
  const levelOf = (v) => verdicts.get(normKey(v.callsgn))?.level || null;
  const isTracked = (v) => Boolean(tracked?.callsgn) && normKey(v.callsgn) === normKey(tracked.callsgn);
  // 기타 선박(액체화물선이 아닌 배) 보이기 — 켜자마자 지도가 KPI("관제 선박 N척")와 맞아 보이도록 기본 켬.
  const [showAis, setShowAis] = useState(true);
  // 액체화물선 — PORT-MIS 선종이 액체화물선이거나 재항 위험물 신고가 있는 배. 늘 그린다.
  // 폴백 없음 — 실데이터가 없으면 아무것도 그리지 않는 편이 정직하다.
  const vessels = useMemo(
    () => (data?.real_traffic ?? []).filter((v) => v.is_liquid_cargo_vessel || v.cargo),
    [data]
  );
  // 기타 선박 — 같은 배가 두 번 찍히지 않게 위 목록을 뺀다.
  const realTraffic = useMemo(() => {
    const shown = new Set(vessels.map((v) => v.callsgn).filter(Boolean));
    return (data?.real_traffic ?? []).filter((v) => !shown.has(v.callsgn));
  }, [data, vessels]);
  // 지도는 성능 때문에 상한(MAP_VESSEL_LIMIT)까지만 그린다. 그 상한에 걸렸을 때
  // 범례에 "표시/전체"를 같이 적어, 숫자가 멈춘 이유를 화면에서 알 수 있게 한다.
  const otherTotal = Math.max(realTraffic.length, (data?.real_traffic_total ?? 0) - (data?.real_traffic_liquid_total ?? vessels.length));

  // 선박 추적 띠의 '위치'를 누르면 지도가 그 배로 간다
  useEffect(() => {
    if (threadFocus?.target !== 'where' || !tracked?.callsgn) return;
    const v = (data?.real_traffic ?? []).find((t) => normKey(t.callsgn) === normKey(tracked.callsgn));
    const map = mapRef.current;
    if (map && v?.latitude != null && v?.longitude != null) {
      map.flyTo([v.latitude, v.longitude], Math.max(map.getZoom(), 15), { duration: 0.8 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadFocus?.at]);
  const judgedCount = useMemo(() => vessels.filter((v) => levelOf(v)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vessels, verdicts]);

  // 실선석 점유 현황 (백엔드 /dashboard/berths — upa_port_call 실측)
  // 백엔드는 'OTK1부두', 화면은 'OTK 1부두'처럼 띄어쓰기가 달라 공백 제거 후 대조한다.
  const occupancyByBerth = useMemo(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const m = new Map();
    (data?.berth_occupancy ?? []).forEach((b) => m.set(norm(b.wharf_name), b));
    return m;
  }, [data]);
  // 이 지도는 온산 선석만 그린다. 점유 수도 온산 기준으로 세야 KPI("온산 선석 점유")와
  // 같은 숫자가 된다 — 예전엔 여기서 울산 전 항만 69개 선석을 세고, 판정 기준도
  // occupancy_status 가 아니라 current_vessel_names 유무로 달라서 한 화면에 서로
  // 다른 점유 수가 떴다.
  const onsanBerths = useMemo(
    () => (data?.berth_occupancy ?? []).filter((b) => b.port_name === '온산항'),
    [data]
  );
  const occupiedCount = useMemo(
    () => onsanBerths.filter((b) => b.occupancy_status === '점유').length,
    [onsanBerths]
  );
  const anchorWaiting = useMemo(
    () => (data?.anchorage_status ?? []).reduce((s, a) => s + (a.current_occupants || 0), 0),
    [data]
  );
  const berthOcc = (name) => occupancyByBerth.get(String(name || '').replace(/\s+/g, ''));

  // 증기운 확산 예상 구역 (8월 시나리오 S3 — 가우시안 원뿔 근사)
  // 선택 선박에 혼재금지·IMDG 격리 충돌이 잡히면 접안 선석 풍하측에 표시
  const selectedVessel = useSensorStore((s) => s.selectedVessel);
  const { assessment: safety } = useVesselSafety(selectedVessel);
  const vaporCone = useMemo(() => {
    const v = selectedVessel;
    if (!v?.is_liquid_cargo_vessel || !v.berth) return null;
    // 인접 선석과 혼재/격리 충돌이 실제로 잡힌 선박만 증기운을 그린다
    // (백엔드 안전 에이전트가 낸 MSDS/IMDG 게이트 히트 기준)
    if (!safety?.gates_hit?.some((g) => g.rule.startsWith('MSDS') || g.rule.startsWith('IMDG'))) return null;
    const berthId = findBerthIdByName(v.berth);
    if (!berthId) return null;
    const [lat, lon] = posOf(ONSAN_BERTHS[berthId]);
    const w = data?.weather;
    const windDir = w?.wind_dir_deg ?? 0;
    const windMs = w?.wind_speed_ms ?? 5;
    const dir = ((windDir + 180) % 360) * (Math.PI / 180); // 풍하측 방위
    const L = 250 + 55 * windMs;                            // 확산 길이 [m] 근사
    const half = (22 * Math.PI) / 180;                      // 반개방각
    const pt = (dist, ang) => [
      lat + (dist * Math.cos(ang)) / 111320,
      lon + (dist * Math.sin(ang)) / (111320 * Math.cos((lat * Math.PI) / 180)),
    ];
    return {
      positions: [[lat, lon], pt(L, dir - half), pt(L * 1.1, dir), pt(L, dir + half)],
      cargo: v.cargo?.name, windMs, windDir, lengthM: Math.round(L * 1.1),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVessel, data, safety, serverPos]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', borderRadius: '16px', overflow: 'hidden' }}>
      <style>{`
        .vessel-divicon { background: none; border: none; }
        .vessel-marker { position: relative; display: flex; align-items: center; justify-content: center;
          filter: drop-shadow(0 0 3px rgba(0,0,0,0.45)); }
        .vessel-marker--ring::after {
          content: ''; position: absolute; inset: -5px; border-radius: 50%; z-index: -1;
          border: 3px solid var(--ring); background: rgba(255,255,255,0.7);
        }
        .vessel-marker--alarm::before {
          content: ''; position: absolute; inset: -6px; border-radius: 50%;
          border: 2px solid var(--ring); animation: vessel-pulse 1.6s ease-out infinite;
        }
        .vessel-marker--lite { opacity: 0.72; filter: drop-shadow(0 0 2px rgba(0,0,0,0.35)); }
        .vessel-marker--tracked { filter: drop-shadow(0 0 7px rgba(18,53,79,0.85)); }
        .vessel-marker--tracked.vessel-marker--ring::after { inset: -7px; border-width: 4px; }
        .vessel-marker--tracked:not(.vessel-marker--ring)::after {
          content: ''; position: absolute; inset: -7px; border-radius: 50%; z-index: -1;
          border: 2px dashed ${COLORS.navy}; background: rgba(255,255,255,0.75);
        }
        @keyframes vessel-pulse {
          0% { transform: scale(0.8); opacity: 0.9; }
          100% { transform: scale(1.6); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) { .vessel-marker--alarm::before { animation: none; } }
      `}</style>

      <MapContainer
        ref={mapRef}
        center={ONSAN_CENTER}
        zoom={ONSAN_ZOOM}
        style={{ height: '100%', width: '100%', background: COLORS.bg }}
        attributionControl={false}
        // [2026-09-30] Leaflet 키보드 조작을 끈다 — 켜 두면 지도를 처음 누를 때 지도 틀에 초점을 주며 페이지가
        //   스크롤돼, 누른 자리와 뗀 자리가 달라져 선석 · 배 클릭이 씹혔다(지도 아래쪽에서 늘 재현).
        keyboard={false}
        whenReady={() => {
          // 컨테이너 크기가 정해진 뒤에 맞춰야 한다 — 렌더 직후엔 높이가 0 이라
          // fitBounds 가 엉뚱한 줌으로 잡힌다.
          requestAnimationFrame(() => mapRef.current?.fitBounds(ONSAN_WHARF_BOUNDS, ONSAN_FIT));
        }}
      >
        {/* PORT-MIS 톤(라이트)에 맞춘 베이스맵. 예전 dark_all 은 화면 전체가 밝아진 뒤에도
            지도만 검게 남아 따로 놀았다.
            2026-09-18 — CARTO voyager 는 이제 API 키 없이는 "API KEY REQUIRED" 회색 타일만
            돌려준다(실측: 타일 응답 200이지만 내용이 안내문). OpenStreetMap 표준 타일은
            키가 없고 해안선·부두 윤곽이 있어 관제 지도로 충분하다. */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />

        {/* 울산항 관제 구역 bbox */}
        <Rectangle
          bounds={ULSAN_BBOX_BOUNDS}
          pathOptions={{
            color: COLORS.info,
            weight: 1.5,
            dashArray: '8 6',
            fillColor: COLORS.info,
            fillOpacity: 0.03,
          }}
        >
          <Tooltip sticky>울산항 관제 구역 (lat 35.18~35.82 / lon 129.22~129.76)</Tooltip>
        </Rectangle>

        {/* ADJACENT_TO 인접(혼재/근접 위험 감시) 연결선 */}
        {ONSAN_ADJACENCY.map(({ a, b, distanceM }) => {
          const ba = ONSAN_BERTHS[a];
          const bb = ONSAN_BERTHS[b];
          if (!ba || !bb) return null;
          return (
            <Polyline
              key={`${a}-${b}`}
              positions={[posOf(ba), posOf(bb)]}
              pathOptions={{ color: COLORS.yellow, weight: 2, dashArray: '4 6', opacity: 0.7 }}
            >
              <Tooltip sticky>
                ADJACENT_TO · {ba.name} ↔ {bb.name} ({distanceM}m) — 혼재/근접 위험 감시
              </Tooltip>
            </Polyline>
          );
        })}

        {/* 온산 액체화물 선석 (온산 MVP 스코프, 실측 좌표)
            — 최근 기상 판정이 이 선석의 임계군이면 판정 색으로 역연동 강조 */}
        {Object.entries(ONSAN_BERTHS).map(([id, b]) => {
          const verdict =
            berthWeather && ONSAN_WEATHER_GROUP[id] === berthWeather.berth_group
              ? berthWeather.status
              : null;
          const vColor = verdict ? WEATHER_STATUS_COLORS[verdict] || COLORS.info : COLORS.info;
          const escalated = verdict && verdict !== '정상';
          const selected = selectedBerth && berthKey(selectedBerth) === berthKey(b.name);
          return (
          <Circle
            key={id}
            center={posOf(b)}
            // 선석 원이 배 아이콘보다 작아 화면에서 묻혔다. 선석은 판정 단위이자 클릭 대상이라 배보다 눈에 먼저 들어와야 한다.
            // 서버 좌표로 옮기면서 실제 간격(S-Oil 2↔4 약 250 m)에 맞춰 줄였다
            radius={b.waterway === '부이(해상)' ? 300 : 150}
            pathOptions={{
              color: selected ? COLORS.navy : vColor,
              fillColor: vColor,
              fillOpacity: escalated ? 0.5 : selected ? 0.32 : 0.22,
              weight: selected ? 5 : escalated ? 4 : 3,
            }}
            // [2026-09-29 밤] 누르면 선석 상세 서랍(접안 · 부두 기상 · 최근 접안 · 재항 시간)이 열린다.
            //   예전엔 작은 팝업 + 대시보드 가운데 부두 기상 판정 패널로 스크롤했다.
            eventHandlers={{ click: () => setSelectedBerth(b.name) }}
          >
            {/* 부두 이름을 항상 띄운다 — 한 레이어에 Tooltip 을 두 개 달면 앞의 permanent 옵션에 뒤 문구가
                덮어써진다(Leaflet bindTooltip). 이름(+기상 판정)만 둔다. */}
          </Circle>
          );
        })}

        {Object.entries(ONSAN_BERTHS).map(([id, b]) => {
          const verdict = berthWeather && ONSAN_WEATHER_GROUP[id] === berthWeather.berth_group ? berthWeather.status : null;
          const escalated = verdict && verdict !== '정상';
          const text = `${b.name.replace(/부두$/, '')}${escalated ? ` · ${verdict}` : ''}`;
          return (
            <Marker
              key={`tag-${id}`}
              position={posOf(b)}
              icon={berthTagIcon(text, escalated ? WEATHER_STATUS_COLORS[verdict] : null)}
              zIndexOffset={2500}
              keyboard={false}
              eventHandlers={{ click: () => setSelectedBerth(b.name) }}
            />
          );
        })}

        {/* 증기운 확산 예상 구역 (R13 히트 선박 선택 시, 풍하측 원뿔 근사) */}
        {vaporCone && (
          <Polygon
            positions={vaporCone.positions}
            pathOptions={{ color: '#D2601A', weight: 2, dashArray: '6 5', fillColor: '#D2601A', fillOpacity: 0.22 }}
          >
            <Tooltip sticky>
              {vaporCone.cargo} 증기 확산 예상 구역 — 풍향 {vaporCone.windDir}° · 풍속 {vaporCone.windMs}m/s 기준 약 {vaporCone.lengthM}m (가우시안 원뿔 근사 · 실측 아님)
            </Tooltip>
          </Polygon>
        )}

        {/* 기타 선박 — 작게, 회색으로. 누르면 선박 상세가 열린다(화물·흘수가 없으면 패널이 그 사유를 말한다). */}
        {showAis && realTraffic.map((v) => {
          const lv = levelOf(v);
          const me = isTracked(v);
          return (
            <Marker
              key={v.port_call_id}
              position={[v.latitude, v.longitude]}
              icon={createVesselIcon(v, lv, me)}
              zIndexOffset={me ? 3000 : 0}
              eventHandlers={{ click: () => setSelectedVessel(v) }}
            >
              <Tooltip>
                <strong>{v.vessel_name || v.callsgn}</strong> · {(NAV_STATUS[v.nav_status_category] || NAV_STATUS.UNKNOWN).label}
                {' '}· {v.sog ?? '-'} kn{lv ? ` · ${lv}` : ''}
                <br />수신 {formatKST(v.received_at_utc)}
              </Tooltip>
            </Marker>
          );
        })}

        {/* 액체화물선 — 남색, 판정이 있으면 판정 색 고리. 추적 중인 배는 크게. */}
        {vessels.map((vessel) => {
          if (vessel.latitude == null || vessel.longitude == null) return null;
          const lv = levelOf(vessel);
          const me = isTracked(vessel);
          return (
            <Marker
              key={vessel.port_call_id}
              position={[vessel.latitude, vessel.longitude]}
              icon={createVesselIcon(vessel, lv, me)}
              zIndexOffset={me ? 3000 : lv === '부적합' ? 2000 : 1000}
              eventHandlers={{
                click: () => {
                  setSelectedObject(vessel);
                  setSelectedVessel(vessel); // 선박 상세 패널 열기(추적도 이 배로)
                },
              }}
            >
              <Tooltip>
                <strong>{vessel.vessel_name || vessel.callsgn}</strong>
                {vessel.berth ? ` · ${vessel.berth}` : ''}
                {' '}· <span style={{ color: lv ? verdictColor(lv) : COLORS.textDim, fontWeight: 700 }}>{lv || '판정 전'}</span>
                <br />{(NAV_STATUS[vessel.nav_status_category] || NAV_STATUS.UNKNOWN).label} · {vessel.sog ?? '-'} kn · 수신 {formatKST(vessel.received_at_utc)}
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>

      {/* 지도 옵션 박스 — 페이지 상단의 [Omniverse/3D View] 버튼(≈top 50~88px)에
          가려지지 않도록 그 아래(top 70 = 페이지 기준 약 100px)에 세로 박스로 배치 */}
      <div style={{
        position: 'absolute', top: 14, right: 14, zIndex: 1000,
        background: COLORS.glass, border: `1px solid ${COLORS.glassBorder}`,
        backdropFilter: 'blur(8px)', borderRadius: '10px',
        padding: '10px 12px',
        // 고정 폭(168px)이라 선박 수가 세 자리가 되자 라벨이 잘렸다.
        // 내용에 맞춰 늘리되 지도를 가리지 않게 상한만 둔다.
        width: 'max-content', minWidth: '168px', maxWidth: '260px',
        display: 'flex', flexDirection: 'column', gap: '6px',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: COLORS.textDim, letterSpacing: '1px' }}>
          지도 옵션
        </div>
        {[
          { label: '온산 부두', bounds: wharfBounds },
          // '온산 전체(원유부이 포함)' 버튼은 뺐다(2026-08-21) — 온산 부두 뷰와
          // 차이가 석유공사부이 하나뿐이라 선택지 값을 못 했다. 부이는 '울산항
          // 전체'에서 보인다.
          { label: '울산항 전체', center: MAP_CENTER, zoom: MAP_DEFAULT_ZOOM },
        ].map((v) => (
          <button
            key={v.label}
            onClick={() => (v.bounds
              ? mapRef.current?.flyToBounds(v.bounds, { ...ONSAN_FIT, duration: 0.8 })
              : mapRef.current?.flyTo(v.center, v.zoom, { duration: 0.8 }))}
            style={{
              background: 'rgba(255,255,255,0.06)', border: `1px solid ${COLORS.glassBorder}`,
              color: COLORS.textPrimary, borderRadius: '7px', padding: '7px 10px',
              fontSize: '12px', fontWeight: 600, cursor: 'pointer', textAlign: 'left',
            }}
          >
            {v.label}
          </button>
        ))}
        {realTraffic.length > 0 && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer',
            background: showAis ? 'rgba(56,189,248,0.18)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${showAis ? COLORS.blue : COLORS.glassBorder}`,
            borderRadius: '7px', padding: '7px 10px',
            fontSize: '12px', fontWeight: 600, color: COLORS.textPrimary,
            // "· 액체 33"이 줄바꿈돼 잘려 보이던 문제 — 라벨을 한 줄로 고정한다
            whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            <input
              type="checkbox"
              checked={showAis}
              onChange={() => setShowAis((s) => !s)}
              style={{ accentColor: COLORS.blue, cursor: 'pointer', flexShrink: 0 }}
            />
            {/* 라벨은 짧게 — 상한(200척)에 걸렸을 때만 "표시/전체"를 함께 보여준다. */}
            <span style={{ whiteSpace: 'nowrap' }}>
              기타 선박 {realTraffic.length}
              {otherTotal > realTraffic.length && (
                <span style={{ color: COLORS.textDim }}>/{otherTotal}</span>
              )}
            </span>
          </label>
        )}
      </div>

      {/* 범례 — 배 색은 선종, 고리 색은 판정. 글 설명 없이 색 견본과 한 단어만 둔다. */}
      <div style={{
        position: 'absolute', bottom: 14, left: 14, zIndex: 1000,
        background: COLORS.glass, border: `1px solid ${COLORS.glassBorder}`,
        backdropFilter: 'blur(8px)', borderRadius: '10px',
        padding: '10px 14px', color: COLORS.textPrimary, fontSize: '12px',
        display: 'grid', gap: 6,
      }}>
        <div style={{ fontWeight: 'bold' }}>
          액체화물선 <span style={{ color: COLORS.navy }}>{vessels.length}척</span>
          {judgedCount > 0 && <span style={{ color: COLORS.textSecondary, fontWeight: 600 }}> · 판정 {judgedCount}척</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center' }}>
          {[{ label: '액체화물선', color: COLORS.navy }, ...(showAis ? [{ label: '기타 선박', color: OTHER_SHIP }] : [])].map((it) => (
            <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill={it.color} aria-hidden="true"><path d={SHIP_SVG_PATH} /></svg>
              {it.label}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', display: 'inline-block', background: `${COLORS.info}40`, border: `2px solid ${COLORS.info}` }} />
            온산 선석
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center' }}>
          {LEGEND_RINGS.map((lv) => (
            <span key={lv} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', display: 'inline-block', background: '#fff', border: `3px solid ${VERDICT_COLOR[lv]}` }} />
              {lv}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
