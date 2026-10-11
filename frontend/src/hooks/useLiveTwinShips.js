import { useEffect, useState } from 'react';
import useDashboardData from './useDashboardData';
import useSensorStore from '../stores/useSensorStore';
import { findBerthIdByName, ONSAN_BERTHS_3D } from '../utils/geoUtils';
import { fetchBerthAssignments } from '../api/backendAdapter';

// ─────────────────────────────────────────────────────────────────────────────
// 디지털 트윈 선박을 실데이터로 채운다.
//
// 여태 트윈의 선박 6척은 useSensorStore 에 상태까지 박혀 있는 고정값이었다
// ("HMM GOODWILL 하역 중" 같은). 갱신 경로(updateFromSensor)는 있었지만 부르는
// 곳이 없었다 — 백엔드에 웹소켓이 없어서다.
//
// 그런데 트윈이 필요로 하는 값은 이미 전부 수집돼 있다:
//   위치·침로·속력·항해상태 → AIS (upa_vessel_position)
//   접안 선석·화물          → mart.berth_current_cargo
// 그래서 웹소켓 없이도 대시보드와 같은 폴링 데이터로 트윈을 채울 수 있다.
//
// [상태를 어떻게 정하나]
// AIS 항해상태(nav_status_code)를 그대로 쓰되, 트윈이 아는 어휘로 옮긴다.
// 상태를 지어내지 않는다 — 판단 근거가 없으면 '항해 중'으로 두고, 접안 선석을
// 아는 배만 계류로 본다(선석을 모르면 3D 상에 세울 자리도 없다).
// ─────────────────────────────────────────────────────────────────────────────

// 트윈에 세울 선박 수 상한. 3D 오브젝트가 많아지면 프레임이 떨어진다.
const TWIN_SHIP_LIMIT = 16;

// 트윈이 그리는 범위는 온산 일대뿐이다. 울산 전역의 배를 그대로 투영하면
// 대부분이 화면 밖 먼 곳에 놓여 "배가 하나도 없는" 것처럼 보인다(실측: 신호가
// 살아있는 368척 중 온산 근접은 103척). 이 사각형 밖은 트윈 대상이 아니다.
const ONSAN_BOX = { minLat: 35.40, maxLat: 35.50, minLon: 129.32, maxLon: 129.42 };

function inOnsan(v) {
  return v.latitude != null && v.longitude != null
    && v.latitude >= ONSAN_BOX.minLat && v.latitude <= ONSAN_BOX.maxLat
    && v.longitude >= ONSAN_BOX.minLon && v.longitude <= ONSAN_BOX.maxLon;
}

/** AIS 카테고리 + 접안 선석 유무 → 트윈 상태 어휘 */
function twinStatus(vessel, berthId) {
  const cat = vessel.nav_status_category;
  if (cat === 'MOORED') {
    // 접안까지만 안다. '하역 중'은 유량계·작업 개시 기록이 없어 알 수 없으므로
    // 지어내지 않는다(2026-09-24 — 예전엔 화물 신고만 있으면 전부 '하역 중'으로 떠
    // 14척이 모두 하역 중으로 보였다). 하역 여부는 게이트(센서 데이터)가 말한다.
    return 'mooring';
  }
  if (cat === 'AT_ANCHOR') return 'anchored';
  // 항해상태 필드가 없는 배(Class B 소형 작업선)는 묘박으로 세지 않는다 —
  // 예선·급유선을 정박지 대기로 세면 선석을 기다리는 본선 수가 부풀려진다.
  if (cat === 'UNKNOWN') return 'service';
  // 항해 중인 배는 '입항 중'으로 단정하지 않는다 — 나가는 배일 수도, 지나가는
  // 배일 수도 있다. AIS 항해상태만으로는 방향을 알 수 없으므로 '항해 중'으로 둔다.
  // (예전에는 접안 선석이 확인되면 arriving 으로 단정했는데, 그 배가 이미 항만
  //  안쪽에 떠 있으면 "입항 중인데 부두 안에 있는" 모순으로 보였다.)
  return 'underway';
}

/** 선박위치 행 → 트윈 선박. berthName 이 있으면 그 선석 자리에 세운다. */
function toShip(v, berthName) {
  const berthId = berthName ? findBerthIdByName(berthName) : null;
  return {
    id: v.vessel_name || v.callsgn || `MMSI ${v.mmsi}`,
    type: 'Ship',
    status: twinStatus(v, berthId),
    berth: berthId,
    anchorage: null,
    // 접안한 배는 실좌표 대신 그 선석의 3D 위치에 세운다(부두는 보기 좋게 이격해 그렸다).
    // 항해·묘박 중인 배만 실좌표를 쓴다.
    vessel_lat: berthId ? null : v.latitude,
    vessel_lon: berthId ? null : v.longitude,
    vessel_heading: v.vessel_heading,
    vessel_speed: v.sog,
    cargoType: v.cargo?.name || null,
    cargoAmount: null,
    callsgn: v.callsgn,
    mmsi: v.mmsi,
    is_liquid_cargo_vessel: v.is_liquid_cargo_vessel,
    is_real: true,
    berth_name: berthName,
  };
}

/**
 * 실 AIS + 재항 화물을 트윈 선박 목록으로 바꿔 스토어에 넣는다.
 * 디지털트윈 페이지에서 한 번만 호출한다.
 */
export default function useLiveTwinShips() {
  const { data } = useDashboardData();
  const setShips = useSensorStore((s) => s.setShips);

  // [2026-09-28] 선석에 붙은 배는 접안 선박 목록과 **같은 자료**(선석 점유 · 위치 판정)로 세운다.
  // 실시간 선박 목록(real_traffic)은 신호가 몇 분만 늦어도 빠지고 지도 성능 때문에 200척에서 잘린다.
  // 그래서 목록은 S-Oil 1부두에 럭키오션호가 있다는데 3D 는 공석으로 그렸다(9/28 실측, 현우 지적).
  const [occupancy, setOccupancy] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchBerthAssignments()
      .then((d) => { if (alive) setOccupancy(Array.isArray(d) ? d : null); })
      .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!setShips) return;
    const key = (cs) => (cs || '').trim().toUpperCase();
    const allTraffic = data?.real_traffic ?? [];
    const byCs = new Map(allTraffic.filter((v) => v.callsgn).map((v) => [key(v.callsgn), v]));
    const traffic = allTraffic.filter(inOnsan);
    const berthOf = (v) => v.presence_berth_name || v.berth || null;

    // 1) 3D 에 그린 온산 선석에 붙은 배 — 선석 점유 자료 그대로(없으면 선박위치의 위치 판정으로 대신)
    const slots = (occupancy || []).flatMap((b) => (b.slots || [])
      .filter((sl) => sl.call_sign)
      .map((sl) => ({ ...sl, wharf_name: b.wharf_name, id3d: findBerthIdByName(b.wharf_name) })))
      .filter((sl) => ONSAN_BERTHS_3D[sl.id3d]);
    const berthed = occupancy
      ? slots.map((sl) => {
        const v = byCs.get(key(sl.call_sign));
        return {
          id: sl.vessel_name || v?.vessel_name || sl.call_sign,
          type: 'Ship',
          status: 'mooring',
          berth: sl.id3d,
          // 같은 부두의 몇 번째 배인가 — 둘 이상이면 바깥쪽으로 나란히 세운다(겹쳐 그려지던 것)
          slot: slots.filter((x) => x.id3d === sl.id3d).indexOf(sl),
          anchorage: null,
          vessel_lat: null,
          vessel_lon: null,
          vessel_heading: v?.vessel_heading ?? 0,
          vessel_speed: v?.sog ?? 0,
          cargoType: v?.cargo?.name || sl.cargo_name || (sl.cargo_names || [])[0] || null,
          cargoAmount: null, // 적재량은 수집 소스가 없다 — 지어내지 않고 비운다
          callsgn: sl.call_sign,
          mmsi: v?.mmsi ?? null,
          is_liquid_cargo_vessel: v?.is_liquid_cargo_vessel ?? Boolean(sl.cargo_chem_id),
          is_real: true,
          berth_name: sl.wharf_name,
        };
      })
      : traffic.filter((v) => ONSAN_BERTHS_3D[findBerthIdByName(berthOf(v))]).map((v) => toShip(v, berthOf(v)));
    const berthedCs = new Set(berthed.map((b) => key(b.callsgn)));

    // 2) 선석에 붙지 않은 배 — 정박지 대기 먼저, 화물 신고 있는 배 먼저.
    //    3D 밖 부두(SK·신항 등)에 멈춰 있는 배는 세울 자리가 없어 뺀다. 움직이는 배는 실좌표로 그린다.
    const waiting = traffic
      .filter((v) => !berthedCs.has(key(v.callsgn)))
      .filter((v) => !(berthOf(v) && (v.sog ?? 0) < 1))
      .sort((a, b) => {
        const aA = a.nav_status_category === 'AT_ANCHOR' ? 0 : 1;
        const bA = b.nav_status_category === 'AT_ANCHOR' ? 0 : 1;
        if (aA !== bA) return aA - bA;
        return (b.cargo ? 1 : 0) - (a.cargo ? 1 : 0);
      })
      .slice(0, Math.max(4, TWIN_SHIP_LIMIT - berthed.length))
      .map((v) => toShip(v, null));

    // 온산 범위에 배가 없으면 빈 목록을 그대로 넣는다 — 직전 목록을 남겨 두면
    // 수집이 끊긴 화면이 "배가 있다"고 말하게 된다.
    setShips([...berthed, ...waiting]);
  }, [data, occupancy, setShips]);
}
