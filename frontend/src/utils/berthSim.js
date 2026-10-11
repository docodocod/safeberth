// ─────────────────────────────────────────────────────────────────────────────
// 앞으로 72시간 시뮬레이션 (2026-09-30)
//
// 현우: "72시간 안의 일정을 나란히 놓는 것이 아니라, 시간이 지남에 따라 배가 작업을 하고 떠나고
//        다른 배가 일정대로 들어오는 시뮬레이션이어야 한다."
//
// 무엇으로 움직이나
//   자료(신고 · 예보)  입항 예정 시각 · 출항 예정 시각 · 사전배정 선석(PORT-MIS 신고), 지금 접안(항만공사 선박위치),
//                     부두별 기상 예보 판정(기상청 단기예보 × 부두 기준), 선석 수(동시 접안 수), 부두별 재항 시간 실측
//   모형(가정)        아래 SIM 상수 — 입출항 기동 시간, 하역 준비 · 마무리 시간. 하역은 그 사이를 일정하게 진행한다고 본다.
// 규칙
//   · 선석이 다 차 있으면 들어오는 배는 정박지에서 기다린다(빈 선석이 나면 접안)
//   · 기상 예보가 하역중단 이상이면 그 시간만큼 하역이 멈추고, 멈춘 만큼 출항이 늦어진다
//   · 출항 예정 신고가 없으면 그 부두의 실측 재항 시간(중앙값)으로 잡고 '추정'으로 표시한다
//   · 부적합 판정을 받은 배는 보류한다 — 판정 규칙(관제 화면 · 게이트)과 같게.
//       입항 예정 선박: 접안하지 않고 정박지에서 기다린다(접안 직전 부적합 → 입항 보류 권고, VTS)
//       접안한 선박  : 하역이 진행되지 않는다(하역 중 부적합 → 게이트 잠김, 터미널)
//     대체 선석이나 화물 조정이 정해져 판정이 바뀌면 시뮬레이션도 달라진다. 언제 풀릴지는 지어내지 않는다.
//   · [고도화] 조위 창 — 흘수 신고가 있는 입항 예정 선박은 조석예보로 접안 시각의 흘수 여유를 본다.
//       필요 여유 max(1.0 m, 흘수×10%)(판정 규칙과 같음)보다 작으면 조위가 오르는 시각까지 정박지에서 '조위 대기'
//   · [고도화] 출항 추정 범위 — 출항 예정 신고가 없어 재항 중앙값으로 잡은 배는 그 부두 재항 시간 90% 까지를 범위로 보인다
// 그리지 않는 것: 실제 항적(도선 · 예선 일정이 없다). 입출항 기동은 만 안쪽 항로를 따라가는 정해진 경로다.
// ─────────────────────────────────────────────────────────────────────────────

const H = 3600000;

export const SIM = {
  APPROACH_H: 1.5,    // 항로 진입 → 접안
  SHIFT_H: 1.0,       // 정박지 → 선석
  PREP_H: 1.5,        // 접안 뒤 세이프티 미팅 · 로딩암 연결 · 압력 시험 → 밸브 개방
  FINISH_H: 1.0,      // 하역 종료 → 로딩암 분리 · 서류
  DEPART_H: 1.0,      // 이안 → 항로
  FALLBACK_STAY_H: 30, // 출항 예정도 재항 통계도 없을 때
};

export const PHASE_TEXT = {
  inbound: '입항 중', toAnchor: '입항 중', waiting: '정박지 대기', shifting: '접안 이동',
  prep: '하역 준비', work: '하역 중', stopped: '하역 중단 · 기상', finish: '하역 종료',
  outbound: '출항 중', berthed: '접안', heldOut: '입항 보류', held: '하역 보류',
};
export const WAIT_TEXT = { full: '정박지 대기', tide: '조위 대기' };
export const ukcNeed = (draught) => Math.max(1.0, draught * 0.1);
export const PHASE_COLOR = {
  inbound: '#60a5fa', toAnchor: '#60a5fa', waiting: '#fbbf24', shifting: '#60a5fa',
  prep: '#a5b4fc', work: '#34d399', stopped: '#f87171', finish: '#a5b4fc', outbound: '#c4b5fd', berthed: '#ffd166',
  heldOut: '#f87171', held: '#f87171',
};
const HOLD_LEVEL = '부적합';
const STOP_STATUS = new Set(['하역중단', '이안', '호스분리']);

const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

/**
 * @param {object} input
 *   now        기준 시각(ms)
 *   hours      시뮬레이션 길이(시간)
 *   berths     [{ id, name, group, capacity }]                   3D 에 그린 선석
 *   current    [{ callsgn, name, berthId, slot, arrivedAt, etd, level, fixedWhy, cargo }]   지금 접안
 *   arrivals   [{ callsgn, name, berthId, eta, etd, level, fixedWhy, cargo, atAnchor }]      입항 예정(신고)
 *   dwellH     Map(berthId → 재항 시간 중앙값, 시간)
 *   dwellP90   Map(berthId → 재항 시간 90%, 시간)                  출항 추정 범위
 *   stops      Map(group → boolean[hours])                       그 시각에 기상으로 하역이 멈추나
 *   tides      Map(group → number[hours])                        그 시각 조위(m, 조석예보) — 조위 창
 * @returns {{ plans: object[], events: object[], t0: number, t1: number }}
 */
export function buildPlans({ now, hours = 72, berths, current, arrivals, dwellH, dwellP90, stops, tides }) {
  const t0 = now;
  const t1 = now + hours * H;
  const byId = new Map(berths.map((b) => [b.id, b]));
  const stopAt = (group, t) => {
    const arr = stops?.get(group);
    if (!arr) return false;
    const i = Math.floor((t - t0) / H);
    return i >= 0 && i < arr.length ? Boolean(arr[i]) : false;
  };
  const tideAt = (group, t) => {
    const arr = tides?.get(group);
    if (!arr) return null;
    const i = Math.floor((t - t0) / H);
    return i >= 0 && i < arr.length && arr[i] != null ? Number(arr[i]) : null;
  };
  // 조위 창 — from 이후 흘수 여유가 필요 여유 이상인 첫 시각. 조위 예보가 없으면 그대로 from
  const tideOk = (group, from, draught, depth) => {
    if (!(draught > 0) || !(depth > 0) || !tides?.get(group)) return { at: from, waitH: 0 };
    const need = ukcNeed(draught);
    for (let t = from; t < t1; t += H / 2) {
      const tide = tideAt(group, t);
      if (tide == null) return { at: t, waitH: Math.round((t - from) / H) };
      if (depth + tide - draught >= need) return { at: t, waitH: Math.round((t - from) / H), ukc: depth + tide - draught };
    }
    return { at: null, waitH: Math.round((t1 - from) / H) };
  };
  // 하역 구간을 한 시간씩 밟아 기상 중단만큼 뒤로 민다. 돌려주는 것: 끝나는 시각과 중단 구간
  const runWork = (group, from, needH) => {
    let t = from;
    let left = Math.max(0.5, needH);
    const halts = [];
    let guard = 0;
    while (left > 1e-6 && guard < 24 * 14) {
      guard += 1;
      const stepEnd = Math.min(t + H, t + left * H);
      if (stopAt(group, t)) {
        const last = halts[halts.length - 1];
        if (last && Math.abs(last.to - t) < 1) last.to = t + H; else halts.push({ from: t, to: t + H });
        t += H;
      } else {
        left -= (stepEnd - t) / H;
        t = stepEnd;
      }
    }
    return { end: t, halts };
  };

  const plans = [];
  const seen = new Set();
  const heldRows = new Map();   // 선석마다 보류된 배의 수 — 일정 줄을 배마다 따로 잡는다
  // 선석마다 자리(slot)가 비는 시각 — 0 이면 비어 있음, Infinity 면 언제 빌지 모름
  const freeAt = new Map(berths.map((b) => [b.id, Array.from({ length: Math.max(1, b.capacity || 1) }, () => 0)]));

  // 1) 지금 접안한 배 — 출항 예정(신고) 또는 재항 통계까지 머문다
  for (const c of current) {
    const b = byId.get(c.berthId);
    if (!b || seen.has(norm(c.callsgn))) continue;
    seen.add(norm(c.callsgn));
    const med = dwellH?.get(c.berthId);
    let schedEnd = c.etd && c.etd > now ? c.etd : null;
    let endBasis = schedEnd ? '신고' : null;
    let estHi = null;
    if (!schedEnd && c.arrivedAt && med) {
      const est = c.arrivedAt + med * H;
      if (est > now + H) {
        schedEnd = est; endBasis = '추정';
        const p90 = dwellP90?.get(c.berthId);
        if (p90 > med) estHi = c.arrivedAt + p90 * H;
      }
    }
    const slots = freeAt.get(b.id);
    let slot = Number.isInteger(c.slot) && c.slot >= 1 && c.slot <= slots.length ? c.slot - 1 : slots.findIndex((x) => x === 0);
    if (slot < 0 || slots[slot] !== 0) slot = slots.findIndex((x) => x === 0);
    if (slot < 0) { slots.push(0); slot = slots.length - 1; }

    const held = c.level === HOLD_LEVEL;
    const plan = {
      key: `c-${c.callsgn}`, callsgn: c.callsgn, name: c.name, berthId: b.id, berthName: b.name, slot,
      kind: 'now', level: c.level || null, fixedWhy: c.fixedWhy || null, cargo: c.cargo || null,
      eta: c.arrivedAt || null, etd: schedEnd, endBasis: held ? null : endBasis,
      appearAt: t0, berthAt: c.arrivedAt && c.arrivedAt < now ? c.arrivedAt : t0, waitFrom: null,
      workStart: null, workEnd: null, leaveAt: null, goneAt: null, halts: [], delayH: 0,
      hold: held ? 'work' : null, estHi,
    };
    if (held) {
      slots[slot] = Infinity;   // 하역 보류 — 언제 풀릴지 모른다. 그 자리는 계속 차 있다
    } else if (schedEnd) {
      const prepEnd = Math.max(now, (c.arrivedAt || now - SIM.PREP_H * H) + SIM.PREP_H * H);
      const need = Math.max(0, (schedEnd - SIM.FINISH_H * H - prepEnd) / H);
      plan.workStart = prepEnd;
      if (need > 0) {
        const r = runWork(b.group, prepEnd, need);
        plan.workEnd = r.end; plan.halts = r.halts;
      } else {
        plan.workEnd = prepEnd;
      }
      plan.leaveAt = plan.workEnd + SIM.FINISH_H * H;
      plan.goneAt = plan.leaveAt + SIM.DEPART_H * H;
      plan.delayH = Math.max(0, Math.round((plan.leaveAt - schedEnd) / H));
      // 전체 하역 길이(진행률 분모) — 입항 시각을 알 때만
      plan.workTotalH = c.arrivedAt ? Math.max(1, (schedEnd - SIM.FINISH_H * H - (c.arrivedAt + SIM.PREP_H * H)) / H) : null;
      slots[slot] = plan.leaveAt;
    } else {
      slots[slot] = Infinity;   // 출항 예정을 모른다 — 72시간 동안 그 자리에 있다고 본다
    }
    plans.push(plan);
  }

  // 2) 입항 예정 — 입항 예정 시각 순으로. 자리가 없으면 정박지에서 기다린다
  const queue = arrivals
    .filter((a) => byId.has(a.berthId) && !seen.has(norm(a.callsgn)) && a.eta && a.eta < t1)
    .sort((x, y) => x.eta - y.eta);
  for (const a of queue) {
    const b = byId.get(a.berthId);
    seen.add(norm(a.callsgn));
    const slots = freeAt.get(b.id);
    const eta = Math.max(a.eta, a.atAnchor ? t0 : t0 + 0);
    if (a.level === HOLD_LEVEL) {
      // 입항 보류 — 접안하지 않고 정박지에서 기다린다. 선석의 자리는 쓰지 않는다
      const row = heldRows.get(b.id) || 0;
      heldRows.set(b.id, row + 1);
      plans.push({
        key: `s-${a.callsgn}-${a.eta}`, callsgn: a.callsgn, name: a.name, berthId: b.id, berthName: b.name, slot: 0,
        lane: 100 + row,
        kind: 'plan', level: a.level, fixedWhy: a.fixedWhy || null, cargo: a.cargo || null,
        eta: a.eta, etd: a.etd || null, endBasis: null,
        appearAt: a.atAnchor ? t0 : Math.max(t0, eta - SIM.APPROACH_H * H),
        waitFrom: eta, berthAt: null, halts: [], delayH: 0, waitH: Math.round((t1 - eta) / H),
        workStart: null, workEnd: null, leaveAt: null, goneAt: null, workTotalH: null,
        hold: 'entry',
      });
      continue;
    }
    // 가장 먼저 비는 자리
    let slot = 0;
    slots.forEach((v, i) => { if (v < slots[slot]) slot = i; });
    const free = slots[slot];
    const slotAt = free === Infinity ? null : Math.max(eta, free ? free + 0.5 * H : 0, a.atAnchor ? t0 + SIM.SHIFT_H * H : 0);
    // 조위 창 — 자리가 나도 흘수 여유가 모자라면 조위가 오를 때까지 기다린다
    const tw = slotAt == null ? { at: null, waitH: 0 } : tideOk(b.group, slotAt, a.draught, a.depth);
    const canAt = tw.at;
    const waits = canAt == null || canAt > eta + 1;
    const waitReason = !waits ? null : (slotAt != null && slotAt <= eta + 1 && tw.waitH > 0) ? 'tide'
      : (slotAt != null && tw.waitH > 0) ? 'full+tide' : 'full';
    const med = dwellH?.get(b.id);
    const stayH = a.etd && a.etd > a.eta ? (a.etd - a.eta) / H : (med || SIM.FALLBACK_STAY_H);
    const endBasis = a.etd && a.etd > a.eta ? '신고' : med ? '추정' : '가정';
    const p90 = dwellP90?.get(b.id);

    const plan = {
      key: `s-${a.callsgn}-${a.eta}`, callsgn: a.callsgn, name: a.name, berthId: b.id, berthName: b.name, slot,
      kind: 'plan', level: a.level || null, fixedWhy: a.fixedWhy || null, cargo: a.cargo || null,
      eta: a.eta, etd: a.etd || null, endBasis,
      appearAt: a.atAnchor ? t0 : Math.max(t0, eta - SIM.APPROACH_H * H),
      waitFrom: waits ? eta : null, berthAt: canAt, halts: [], delayH: 0,
      workStart: null, workEnd: null, leaveAt: null, goneAt: null, workTotalH: null,
      waitReason, tideWaitH: tw.waitH || 0, draught: a.draught || null, depth: a.depth || null, estHi: null,
    };
    if (canAt != null) {
      const need = Math.max(1, stayH - SIM.PREP_H - SIM.FINISH_H);
      plan.workStart = canAt + SIM.PREP_H * H;
      const r = runWork(b.group, plan.workStart, need);
      plan.workEnd = r.end; plan.halts = r.halts; plan.workTotalH = need;
      plan.leaveAt = plan.workEnd + SIM.FINISH_H * H;
      plan.goneAt = plan.leaveAt + SIM.DEPART_H * H;
      const schedLeave = eta + stayH * H;
      plan.delayH = Math.max(0, Math.round((plan.leaveAt - schedLeave) / H));
      plan.waitH = waits ? Math.round((canAt - eta) / H) : 0;
      if (endBasis === '추정' && p90 > med) plan.estHi = plan.leaveAt + (p90 - med) * H;
      slots[slot] = plan.leaveAt;
    } else {
      plan.waitH = Math.round((t1 - eta) / H);
    }
    plans.push(plan);
  }

  // 3) 사건 — 시간축 아래 한 줄씩 읽는다
  const events = [];
  for (const p of plans) {
    if (p.kind === 'plan' && p.eta >= t0 && p.eta < t1) {
      events.push({ at: p.eta, type: p.hold === 'entry' ? 'hold' : p.waitReason === 'tide' ? 'tide' : p.waitFrom ? 'wait' : 'arrive', plan: p });
    }
    if (p.kind === 'plan' && p.waitFrom && p.berthAt && p.berthAt < t1) events.push({ at: p.berthAt, type: 'berth', plan: p });
    for (const h of p.halts) if (h.from < t1) events.push({ at: h.from, to: h.to, type: 'halt', plan: p });
    if (p.leaveAt && p.leaveAt < t1) events.push({ at: p.leaveAt, type: 'leave', plan: p });
  }
  events.sort((x, y) => x.at - y.at);
  return { plans, events, t0, t1 };
}

/** 어느 시각의 그 배 상태 — { phase, k(그 단계 안 진행 0~1), progress(하역 진행률 0~1 또는 null) } */
export function stateAt(p, t) {
  if (t < p.appearAt) return { phase: 'absent' };
  if (p.goneAt && t >= p.goneAt) return { phase: 'gone' };
  if (p.waitFrom != null) {
    const anchorIn = p.waitFrom;
    if (t < anchorIn) return { phase: 'toAnchor', k: (t - p.appearAt) / Math.max(1, anchorIn - p.appearAt) };
    const shiftFrom = p.berthAt != null ? p.berthAt - SIM.SHIFT_H * H : Infinity;
    if (t < shiftFrom) return { phase: p.hold === 'entry' ? 'heldOut' : 'waiting' };
    if (t < p.berthAt) return { phase: 'shifting', k: (t - shiftFrom) / (SIM.SHIFT_H * H) };
  } else if (p.berthAt != null && t < p.berthAt) {
    return { phase: 'inbound', k: (t - p.appearAt) / Math.max(1, p.berthAt - p.appearAt) };
  }
  if (p.berthAt == null) return { phase: p.hold === 'entry' ? 'heldOut' : 'waiting' };
  if (p.hold === 'work') return { phase: 'held', progress: null };
  if (p.workStart == null) return { phase: 'berthed', progress: null };
  if (t < p.workStart) return { phase: 'prep', progress: progressAt(p, t) };
  if (t < p.workEnd) {
    const halted = p.halts.some((h) => t >= h.from && t < h.to);
    return { phase: halted ? 'stopped' : 'work', progress: progressAt(p, t) };
  }
  if (t < p.leaveAt) return { phase: 'finish', progress: 1 };
  return { phase: 'outbound', k: (t - p.leaveAt) / (SIM.DEPART_H * H) };
}

function progressAt(p, t) {
  if (!p.workTotalH || p.workStart == null) return null;
  if (t <= p.workStart && p.kind === 'plan') return 0;
  const haltedMs = p.halts.reduce((s, h) => s + Math.max(0, Math.min(t, h.to) - Math.min(t, h.from)), 0);
  const leftMs = Math.max(0, (p.workEnd - t) - p.halts.reduce((s, h) => s + Math.max(0, h.to - Math.max(t, h.from)), 0));
  const done = p.workTotalH * H - leftMs;
  void haltedMs;
  return Math.max(0, Math.min(1, done / (p.workTotalH * H)));
}

export const isAtBerth = (phase) => ['prep', 'work', 'stopped', 'finish', 'berthed', 'held'].includes(phase);
export const isWaiting = (phase) => phase === 'waiting' || phase === 'heldOut';
export const isStopStatus = (status) => STOP_STATUS.has(status);
