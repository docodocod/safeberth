import { useEffect, useMemo, useReducer } from 'react';
import { BACKEND_BASE, fetchUpcomingArrivals, fetchBerthAssignments } from '../api/backendAdapter';
import useDashboardData from './useDashboardData';
import useSensorStore from '../stores/useSensorStore';

// ─────────────────────────────────────────────────────────────────────────────
// 선박 한 척의 흐름 (2026-09-29 밤)
//
// 같은 배가 화면마다 따로 나와 "대시보드에서 본 배가 선박 판정에서는 어느 줄인가"를 알 수 없었다(현우).
// 고른 배 한 척을 위치 → 판정 → 혼재 → 현장 → 게이트 다섯 단계로 묶어, 어느 화면에서든 같은 띠로 보인다.
// 자료는 각 화면이 이미 쓰는 것 그대로다 — 입항 신고·판정(/arrivals/upcoming), 선석 점유(/dashboard/berth-assignments),
// 게이트(/gate/state), 선박위치(대시보드 공용 자료). 새 판정을 만들지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 30_000;
export const normKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

let shared = { arrivals: [], berths: [], gates: [], loadedAt: 0 };
let inFlight = null;
let timer = null;
const subscribers = new Set();

async function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [a, b, g] = await Promise.allSettled([
      fetchUpcomingArrivals(),
      fetchBerthAssignments(),
      fetch(`${BACKEND_BASE}/gate/state`).then((r) => (r.ok ? r.json() : null)),
    ]);
    shared = {
      arrivals: a.status === 'fulfilled' ? (a.value?.items || []) : shared.arrivals,
      berths: b.status === 'fulfilled' ? (b.value || []) : shared.berths,
      gates: g.status === 'fulfilled' && g.value ? (g.value.gates || []) : shared.gates,
      loadedAt: Date.now(),
    };
    subscribers.forEach((fn) => fn());
  })();
  try { await inFlight; } finally { inFlight = null; }
  return undefined;
}

const LEVEL_TONE = { 적합: 'ok', 주의: 'warn', 부적합: 'bad', 판정불가: 'unknown' };
const LEVEL_RANK = { 부적합: 0, 판정불가: 1, 주의: 2, 적합: 3 };

/** 판정 이유 문장에서 혼재 단계의 결과만 뽑는다.
 *  [2026-09-29 밤] '같은 선박 화물끼리 혼재 충돌 — 격리 적재 확인'은 혼재 심사가 '주의'로 낸다(선내 적부 확인).
 *  이유 문장에 '충돌'이 있다고 늘 빨강 '충돌'로 적으면 혼재 심사 화면(주의)과 띠가 다른 말을 했다. */
function cargoStep(reasons, level) {
  const text = (reasons || []).join(' ');
  if (!text) return null;
  if (/혼재 충돌/.test(text)) {
    return level === '부적합' && !/같은 선박 화물끼리/.test(text)
      ? { value: '충돌', tone: 'bad' }
      : { value: '주의', tone: 'warn' };
  }
  if (/혼재 등급이 '주의'/.test(text)) return { value: '주의', tone: 'warn' };
  const m = text.match(/혼재 판정:([^.]*)/);
  if (m) {
    if (/배정불가/.test(m[1])) return { value: '충돌', tone: 'bad' };
    if (/위험|주의/.test(m[1])) return { value: '주의', tone: 'warn' };
    return { value: '안전', tone: 'ok' };
  }
  return null;
}

function causeIn(text) {
  if (/혼재|호환성|격리/.test(text)) return '혼재';
  if (/풍속|파고|기상|강수/.test(text)) return '기상';
  if (/흘수 ?여유|여유 -|수심이|흘수가/.test(text)) return '흘수';
  if (/화물을 식별|화물 미확인/.test(text)) return '화물 미확인';
  if (/흘수 없음|흘수 미신고|흘수를 알 수/.test(text)) return '흘수 없음';
  return null;
}

// 판정 원인이 아닌 줄 — 정상인 기상 관측, 참고값, 제안·신고 안내
const NOT_CAUSE = /- 정상|참고값|대체 선석|PORT-MIS 신고/;

/** 벗어난 판정의 원인 축 — 선석 · 기상 · 혼재 · 흘수 (판정 이유 문장에서)
 *  백엔드는 판정을 낸 원인을 첫 줄에 둔다. 나머지 줄은 정상인 기상 관측까지 늘 들어 있어
 *  한데 묶어 찾으면 흘수로 걸린 배도 '기상'이 된다 — 첫 줄을 먼저 보고, 못 찾을 때만 원인 줄을 본다. */
function causeOf(reasons, level) {
  if (!level || level === '적합') return null;
  const [head = '', ...rest] = reasons || [];
  return causeIn(head) || causeIn(rest.filter((r) => !NOT_CAUSE.test(r)).join(' '));
}

function slotsOf(berths) {
  return berths.flatMap((b) => (b.slots || [])
    .filter((s) => s.call_sign)
    .map((s) => ({ ...s, wharf_name: b.wharf_name, port_name: b.port_name })));
}

/** 호출부호 한 척의 다섯 단계 */
export function threadOf(callsgn, data, traffic) {
  const cs = normKey(callsgn);
  if (!cs) return null;
  const slot = slotsOf(data.berths).find((s) => normKey(s.call_sign) === cs) || null;
  const arr = data.arrivals.find((r) => normKey(r.call_sign) === cs) || null;
  const tv = (traffic || []).find((v) => normKey(v.callsgn) === cs) || null;

  const name = slot?.vessel_name || arr?.vessel_name || tv?.vessel_name || callsgn;
  const berth = slot?.wharf_name || tv?.berth || arr?.wharf_name || arr?.facility_name || null;
  const stage = slot ? '하역중' : (arr?.stage || null);
  const level = slot?.status || arr?.assessment?.level || null;
  const reasons = slot?.reasons || arr?.assessment?.reasons || [];
  const action = slot?.action || arr?.assessment?.action || null;
  const recipient = slot?.recipient || arr?.assessment?.recipient || null;
  const gate = berth ? data.gates.find((g) => normKey(g.berth) === normKey(berth)) || null : null;
  const gateLocked = gate ? gate.interlock?.state === 'LOCKED' : null;

  const where = slot ? berth
    : tv?.presence_zone === 'ANCHORAGE' ? (tv.presence_anchorage_name || '정박지')
      : tv?.presence_zone === 'BERTH' ? (tv.berth || '접안')
        : arr ? '입항 예정' : tv ? '항내' : null;

  return {
    callsgn: callsgn.trim(), name, berth, stage, level, reasons, action, recipient,
    traffic: tv, arrival: arr, slot, gate,
    cargos: arr?.cargos?.map((c) => c.name) || slot?.cargo_names || [],
    steps: {
      where: { value: where || '—', tone: where ? 'info' : 'none' },
      verdict: {
        value: level ? [level, causeOf(reasons, level)].filter(Boolean).join(' · ') : '판정 전',
        short: level || null,
        tone: LEVEL_TONE[level] || 'none',
      },
      cargo: cargoStep(reasons, level) || { value: '—', tone: 'none' },
      scene: { value: berth || '—', tone: berth ? 'info' : 'none' },
      gate: gate
        ? { value: gateLocked ? '잠김' : '해제', tone: gateLocked ? 'bad' : 'ok' }
        : { value: '—', tone: 'none' },
    },
  };
}

/** 호출부호 → 지금 판정 { level, stage } — 접안 중이면 선석 판정, 아니면 입항 판정.
 *  지도 표식 고리·선석 현황판·선박 찾기가 같은 판정을 같은 색으로 칠하려고 한곳에서 만든다. */
function verdictIndex(data) {
  const m = new Map();
  for (const r of data.arrivals) {
    const k = normKey(r.call_sign);
    if (k && r.assessment?.level) m.set(k, { level: r.assessment.level, stage: r.stage });
  }
  for (const s of slotsOf(data.berths)) {
    const k = normKey(s.call_sign);
    if (k && s.status) m.set(k, { level: s.status, stage: s.stage || '하역중' });
  }
  return m;
}

/** 고를 수 있는 선박 — 벗어난 판정이 위로 */
function candidates(data) {
  const m = new Map();
  for (const s of slotsOf(data.berths)) {
    m.set(normKey(s.call_sign), { callsgn: s.call_sign, name: s.vessel_name || s.call_sign, berth: s.wharf_name, level: s.status || null });
  }
  for (const r of data.arrivals) {
    const k = normKey(r.call_sign);
    if (!k || m.has(k)) continue;
    m.set(k, { callsgn: r.call_sign, name: r.vessel_name || r.call_sign, berth: r.wharf_name || r.facility_name, level: r.assessment?.level || null });
  }
  return [...m.values()].sort((a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || String(a.name).localeCompare(String(b.name), 'ko'));
}

export default function useVesselThread() {
  const [, force] = useReducer((c) => c + 1, 0);
  useEffect(() => {
    subscribers.add(force);
    if (subscribers.size === 1) {
      refresh();
      timer = setInterval(refresh, POLL_MS);
    }
    return () => {
      subscribers.delete(force);
      if (subscribers.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);

  const { data: dash } = useDashboardData();
  const tracked = useSensorStore((s) => s.trackedVessel);
  const traffic = dash?.real_traffic;
  const loadedAt = shared.loadedAt;
  const thread = useMemo(
    () => (tracked?.callsgn ? threadOf(tracked.callsgn, shared, traffic) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracked?.callsgn, loadedAt, traffic],
  );
  const options = useMemo(() => candidates(shared), [loadedAt]);   // eslint-disable-line react-hooks/exhaustive-deps
  const verdicts = useMemo(() => verdictIndex(shared), [loadedAt]);   // eslint-disable-line react-hooks/exhaustive-deps
  return {
    thread, options, verdicts, refresh,
    gates: shared.gates, berths: shared.berths, arrivals: shared.arrivals, loaded: loadedAt > 0,
  };
}
