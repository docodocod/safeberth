import * as THREE from 'three';
import { ONSAN_ANCHORAGE_3D, MOOR_HEADING, SHORE_T, shoreShift, bayShift } from './geoUtils';
import { stateAt, PHASE_TEXT, PHASE_COLOR } from './berthSim';

// 72시간 시뮬레이션의 시계 — 패널(OutlookTimeline)이 돌리고 3D 의 배(Ship)가 매 프레임 읽는다.
// React 상태로 두면 1초에 수십 번 장면 전체가 다시 그려져 느려지므로, 값 하나를 같이 본다.
export const simClock = { active: false, t: 0 };

// 같은 부두에 배가 둘 이상이면 바깥쪽으로 나란히 댄다(3D 는 부두 하나를 잔교 하나로 그린다)
export const slotMoor = (berth, slot) => bayShift(berth.moor, (slot || 0) * 12);
const anchorSpot = (i) => shoreShift(ONSAN_ANCHORAGE_3D.E2.pos, (((i || 0) % 4) - 1.5) * 34);
// 항로 입구 — 만의 남동쪽 끝(외해 쪽). 모든 배가 여기로 들어와 해안과 나란한 항로를 타고 제 선석 앞에서 꺾는다.
//   해안 방향(T) · 만 방향(N) 좌표로 잡는다: 선석은 T -310 ~ +330, 항로는 N 150 안팎.
//   항로는 N 185 — 정일 남동쪽 방파제 끝(T 408 · N 128)과 석유공사 원유부이(T 330 · N 130)를 바깥으로 비켜 간다.
const FAIRWAY_N = 185;
const ENTRANCE = bayShift(shoreShift([0, 0], 520), 215);
const EXIT = bayShift(shoreShift([0, 0], 560), 195);
const alongOf = (p) => p[0] * SHORE_T[0] + p[1] * SHORE_T[1];
/** 3D 에 그리는 항로 선 — 항로 입구에서 북서쪽 끝 선석 앞까지 */
export const FAIRWAY_LINE = [ENTRANCE, bayShift(shoreShift([0, 0], 420), FAIRWAY_N), bayShift(shoreShift([0, 0], -300), FAIRWAY_N)];
export const FAIRWAY_ENTRANCE = ENTRANCE;
const abeam = (p, along) => bayShift(shoreShift([0, 0], alongOf(p) + along), FAIRWAY_N);   // 선석 앞 항로 위의 점

const ease = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };
const bez = (p0, p1, p2, t) => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
};
const tan = (p0, p1, p2, t) => [2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]), 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1])];

/** 그 시각 그 배가 3D 에서 있을 자리 — 입출항 기동은 만 안쪽 항로를 따라가는 정해진 경로다(실제 항적 아님) */
export function simTarget(plan, st, moor, waitIdx) {
  const anchor = anchorSpot(waitIdx);
  const along = (p0, p1, p2, k, dockAtEnd) => {
    const t = ease(k);
    const pos = bez(p0, p1, p2, t);
    const [dx, dz] = tan(p0, p1, p2, Math.min(0.999, Math.max(0.001, t)));
    let heading = Math.atan2(dx, dz);
    if (dockAtEnd) heading = THREE.MathUtils.lerp(heading, MOOR_HEADING, THREE.MathUtils.smoothstep(t, 0.72, 1));
    else heading = THREE.MathUtils.lerp(MOOR_HEADING, heading, THREE.MathUtils.smoothstep(t, 0, 0.3));
    return { pos, heading, moving: true };
  };
  switch (st.phase) {
    // 아직 안 왔거나 이미 떠난 배 — 목록에서 빠지기 전 한두 프레임 동안 선석으로 되돌아오지 않게 항로 끝에 둔다
    case 'absent': return { pos: ENTRANCE, heading: MOOR_HEADING + Math.PI, moving: true };
    case 'gone': return { pos: EXIT, heading: MOOR_HEADING, moving: true };
    case 'inbound': return along(ENTRANCE, abeam(moor, 50), moor, st.k, true);
    case 'toAnchor': return along(ENTRANCE, bayShift(shoreShift(anchor, 120), -40), anchor, st.k, true);
    case 'waiting':
    case 'heldOut': return { pos: anchor, heading: MOOR_HEADING + 0.7, anchored: true };
    case 'shifting': return along(anchor, abeam(moor, 30), moor, st.k, true);
    case 'outbound': return along(moor, abeam(moor, 70), EXIT, st.k, false);
    default: return { pos: moor, heading: MOOR_HEADING, moored: true };
  }
}

const STATUS_OF = {
  inbound: 'arriving', toAnchor: 'arriving', shifting: 'arriving', waiting: 'anchored', heldOut: 'anchored',
  prep: 'mooring', work: 'operating', stopped: 'mooring', finish: 'mooring', berthed: 'mooring', held: 'mooring', outbound: 'departing',
};

/** 그 시각 3D 에 세울 배 목록 — 계획에 든 배 + 계획 밖 정박지 대기선(지금 자리 그대로) */
export function shipsAt(plans, t, liveShips = [], wide = false) {
  const out = [];
  let waitIdx = 0;
  const inPlan = new Set(plans.map((p) => String(p.callsgn || '').trim().toUpperCase()));
  for (const p of plans) {
    const st = stateAt(p, t);
    if (st.phase === 'absent' || st.phase === 'gone') continue;
    const live = liveShips.find((s) => String(s.callsgn || '').trim().toUpperCase() === String(p.callsgn || '').trim().toUpperCase());
    const working = st.progress != null && ['work', 'stopped'].includes(st.phase);
    out.push({
      id: p.name || p.callsgn,
      type: 'Ship',
      status: STATUS_OF[st.phase] || 'mooring',
      berth: p.berthId,
      slot: p.slot,
      plan: p,
      waitIdx: ['waiting', 'heldOut', 'toAnchor', 'shifting'].includes(st.phase) ? waitIdx++ : 0,
      phase: st.phase,
      // 하역 중에는 글 대신 진행 막대를 그린다(Ship 이름표) — 글이 길면 이웃 배 이름표와 겹친다
      simLabel: st.phase === 'work' ? '' : st.phase === 'berthed' ? ''
        : st.phase === 'waiting' && p.waitReason === 'tide' ? '조위 대기'
          : (PHASE_TEXT[st.phase] || '').replace(' · 기상', ''),
      simColor: PHASE_COLOR[st.phase] || '#8ba3b8',
      simProgress: working ? Math.round(st.progress * 100) : null,
      // 온산 전체를 멀리서 볼 때 — 72시간 안에 들어오거나 나가는 배만 이름표를 세우고(크기 고정), 머무는 배는 뺀다
      labelMode: !wide ? 'scaled'
        : (p.kind === 'plan' || p.hold || (p.leaveAt != null && p.leaveAt <= p.appearAt + 72 * 3600000)) ? 'fixed' : 'hidden',
      vessel_lat: null, vessel_lon: null,
      vessel_heading: live?.vessel_heading ?? 0,
      vessel_speed: st.phase === 'inbound' || st.phase === 'outbound' || st.phase === 'shifting' ? 5 : 0,
      cargoType: p.cargo || live?.cargoType || null,
      cargoAmount: null,
      callsgn: p.callsgn,
      mmsi: live?.mmsi ?? null,
      is_liquid_cargo_vessel: true,
      is_real: p.kind === 'now',
      berth_name: p.berthName,
    });
  }
  // 계획에 없는 정박지 대기선 — 어디로 갈지 모르므로 지금 자리에 그대로 둔다
  for (const s of liveShips) {
    if (s.status !== 'anchored') continue;
    if (inPlan.has(String(s.callsgn || '').trim().toUpperCase())) continue;
    out.push(s);
  }
  return out;
}
