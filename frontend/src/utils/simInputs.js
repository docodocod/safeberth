// ─────────────────────────────────────────────────────────────────────────────
// 앞으로 72시간 — 시뮬레이션 재료를 한 곳에서 (2026-09-30)
//
// 3D 관제 화면의 72시간 패널(OutlookTimeline)과 경고 벨의 '앞으로' 경고(useForecastAlerts)가 같은 재료 ·
// 같은 계산(berthSim)을 쓴다. 한쪽만 고치면 패널과 경고가 다른 말을 하게 된다.
//   재료  부두군 6곳의 72시간 예보 판정(/twin/outlook) · 입항 예정(PORT-MIS 신고) · 부두별 재항 시간 실측
//         · 선석 점유(/dashboard/berth-assignments — useVesselThread 가 이미 읽는다)
// ─────────────────────────────────────────────────────────────────────────────
import { fetchTwinOutlook, fetchUpcomingArrivals, BACKEND_BASE } from '../api/backendAdapter';
import { ONSAN_BERTHS_3D, ONSAN_WEATHER_GROUP } from './geoUtils';
import { buildPlans, isStopStatus, ukcNeed } from './berthSim';

const H = 3600000;
const CACHE_MS = 5 * 60000;
export const simNorm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
export const berthIdOf = (name) => Object.keys(ONSAN_BERTHS_3D).find((k) => simNorm(ONSAN_BERTHS_3D[k].name) === simNorm(name)) || null;
const ms = (iso) => (iso ? new Date(iso).getTime() : null);

// 시간이 지나도 바뀌지 않는 사유 — 화물 혼재 · 선석 조건
const FIXED_CAUSE = /혼재|호환|격리|반응|취급 화물|선석 길이|DWT|최대 접안/;
const shortWhy = (t) => String(t || '').replace(/^.*?(으나|지만)\s*/, '').split(' — ')[0].split(/(?:이|가) 있어 /)[0]
  .replace(/(이|가) 있습니다$|입니다$|습니다$/, '').trim();
export const fixedOf = (reasons) => { const why = (reasons || []).find((r) => FIXED_CAUSE.test(r)); return why ? shortWhy(why) : null; };

// 부두군(기상 기준이 같은 묶음)마다 대표 선석 하나로 72시간 예보 판정을 읽는다 — 6번
export const GROUP_REP = (() => {
  const m = new Map();
  Object.keys(ONSAN_BERTHS_3D).forEach((id) => { const g = ONSAN_WEATHER_GROUP[id]; if (g && !m.has(g)) m.set(g, id); });
  return m;
})();
let groupCache = { at: 0, map: null, flight: null };
export function loadGroupOutlooks() {
  if (groupCache.map && Date.now() - groupCache.at < CACHE_MS) return Promise.resolve(groupCache.map);
  if (groupCache.flight) return groupCache.flight;
  groupCache.flight = Promise.all([...GROUP_REP].map(async ([g, id]) => {
    try { return [g, await fetchTwinOutlook({ berth: ONSAN_BERTHS_3D[id].name })]; } catch { return [g, null]; }
  })).then((entries) => {
    const map = new Map(entries.filter(([, v]) => v));
    groupCache = { at: map.size ? Date.now() : 0, map: map.size ? map : null, flight: null };
    return map;
  });
  return groupCache.flight;
}

let extraCache = { at: 0, val: null, flight: null };
/** { groups, arrivals, dwell, history } — 5분 동안 다시 쓰지 않는다 */
export function loadSimExtra() {
  if (extraCache.val && Date.now() - extraCache.at < CACHE_MS) return Promise.resolve(extraCache.val);
  if (extraCache.flight) return extraCache.flight;
  extraCache.flight = Promise.all([
    loadGroupOutlooks().catch(() => new Map()),
    fetchUpcomingArrivals({ aheadHours: 72, pastHours: 12 }).catch(() => null),
    fetch(`${BACKEND_BASE}/dashboard/berth-dwell`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`${BACKEND_BASE}/dashboard/history?limit=400`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]).then(([groups, arr, dwell, history]) => {
    const val = { groups, arrivals: arr?.items || [], dwell: Array.isArray(dwell) ? dwell : [], history: Array.isArray(history) ? history : [] };
    extraCache = { at: Date.now(), val, flight: null };
    return val;
  });
  return extraCache.flight;
}

/**
 * buildPlans 에 넣을 값. overrides = { 호출부호: { berthId, level } } — '대체 선석으로 돌려 보기'(가정)
 */
export function makeSimArgs({ t0, berths, extra, overrides = {} }) {
  const defs = Object.entries(ONSAN_BERTHS_3D).map(([id, b]) => {
    const row = berths.find((r) => simNorm(r.wharf_name) === simNorm(b.name));
    const used = (row?.slots || []).filter((x) => x.call_sign).length;
    return { id, name: b.name, group: ONSAN_WEATHER_GROUP[id], capacity: Math.max(row?.max_concurrent_vessels || 0, used, 1) };
  });
  const current = berths.flatMap((r) => {
    const id = berthIdOf(r.wharf_name);
    if (!id) return [];
    return (r.slots || []).filter((x) => x.call_sign).map((x, i) => ({
      callsgn: x.call_sign, name: x.vessel_name || x.call_sign, berthId: id, slot: i + 1,
      arrivedAt: ms(x.actual_arrival_utc), etd: ms(x.departure_scheduled_utc),
      level: x.status || null, fixedWhy: fixedOf(x.reasons), cargo: x.cargo_name || null,
    }));
  });
  const arrivals = extra.arrivals.map((r) => {
    const id = berthIdOf(r.wharf_name || r.facility_name);
    const eta = ms(r.arrival_at_utc);
    if (!id || r.facility_type !== 'BERTH' || !eta || r.stage === '하역중') return null;
    // 입항 예정 시각이 지났는데 아직 항만 안에 없는 배는 언제 올지 모른다 — 세우지 않는다
    if (eta <= t0 && r.stage !== '접안직전') return null;
    const ov = overrides[simNorm(r.call_sign)];
    return {
      callsgn: r.call_sign, name: r.vessel_name || r.call_sign, berthId: ov?.berthId || id, eta, etd: ms(r.departure_sched_utc),
      level: ov ? ov.level : r.assessment?.level || null, fixedWhy: ov ? ov.why || null : fixedOf(r.assessment?.reasons),
      cargo: r.cargos?.[0]?.name || r.cargo_name || null, atAnchor: r.stage === '접안직전',
      draught: Number(r.draught_m) > 0 ? Number(r.draught_m) : null,
      depth: ov ? (ov.depth || null) : Number(r.depth_m) > 0 ? Number(r.depth_m) : null,
      what: ov ? { from: id } : null,
    };
  }).filter(Boolean);
  const dwellH = new Map(extra.dwell.map((d) => [berthIdOf(d.wharf_name), Number(d.median_hours)]).filter(([k, v]) => k && v > 0));
  const dwellP90 = new Map(extra.dwell.map((d) => [berthIdOf(d.wharf_name), Number(d.p90_hours)]).filter(([k, v]) => k && v > 0));
  const stops = new Map();
  const tides = new Map();
  extra.groups.forEach((o, g) => {
    const f = o.forecast || [];
    if (!f.length) return;
    const f0 = ms(f[0].at_utc);
    const at = (i) => f[Math.max(0, Math.floor((t0 + i * H - f0) / H))];
    stops.set(g, Array.from({ length: 72 }, (_, i) => (Math.floor((t0 + i * H - f0) / H) < f.length ? isStopStatus(at(i)?.status) : false)));
    tides.set(g, Array.from({ length: 72 }, (_, i) => {
      const j = Math.floor((t0 + i * H - f0) / H);
      return j < f.length && at(i)?.tide_m != null ? Number(at(i).tide_m) : null;
    }));
  });
  return { now: t0, hours: 72, berths: defs, current, arrivals, dwellH, dwellP90, stops, tides };
}

export const runSim = (opts) => buildPlans(makeSimArgs(opts));

// ── '앞으로' 경고 — 72시간 시뮬레이션에서 미리 알 수 있는 일 ─────────────────
const KST = { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false };
const whenKo = (t) => {
  const p = new Intl.DateTimeFormat('ko-KR', KST).formatToParts(new Date(t));
  const g = (k) => p.find((x) => x.type === k)?.value ?? '';
  return `${g('month')}-${g('day')} ${g('hour')}시`;
};
const shortGroup = (g) => String(g || '').replace(/\(.*\)$/, '');

/**
 * 서버 경고와 같은 꼴로 돌려준다(경고 벨이 그대로 그린다). forecast 필드에 구조화된 값이 있다.
 *   기상 중단  부두군마다 첫 중단 시각 · 그때 하역 중인 배
 *   정박지 대기 입항 예정인데 선석 자리가 없어 기다리는 배
 *   조위 대기  입항 예정인데 저조로 흘수 여유가 모자라 기다리는 배
 * 입항 보류(부적합)는 서버 판정 경고가 이미 있어 다시 만들지 않는다.
 */
export function forecastAlerts(sim, extra, t0) {
  if (!sim) return [];
  const out = [];
  const { plans } = sim;
  // 기상 중단
  extra.groups.forEach((o, g) => {
    const f = o.forecast || [];
    const hits = f.filter((q) => isStopStatus(q?.status) && ms(q.at_utc) >= t0 - H);
    if (!hits.length) return;
    const first = ms(hits[0].at_utc);
    let end = first;
    for (const q of f) { const t = ms(q.at_utc); if (t >= first && isStopStatus(q.status) && t <= end + H) end = t; }
    const ids = Object.keys(ONSAN_BERTHS_3D).filter((id) => ONSAN_WEATHER_GROUP[id] === g);
    const working = plans.filter((p) => ids.includes(p.berthId) && p.halts.some((h) => h.from <= end && h.to >= first));
    const delayed = working.filter((p) => p.delayH >= 1);
    out.push({
      type: 'FORECAST_WEATHER', level: 'WARNING', berth_name: shortGroup(g), callsgns: working.map((p) => p.callsgn),
      message: `앞으로 · ${whenKo(first)} ${shortGroup(g)} ${hits[0].status} 예보 — 하역 중 ${working.length}척 영향`,
      forecast: {
        kind: 'weather', scope: 'berth', at: first, title: shortGroup(g), place: null, stage: `앞으로 · ${whenKo(first)}`,
        why: `${hits[0].status} 예보 ${Math.max(1, Math.round((end - first) / H) + 1)}시간${working.length ? ` · 하역 중 ${working.length}척` : ''}${delayed.length ? ` · 출항 ${delayed.length}척 늦어짐` : ''}`,
        action: '그 전에 하역 종료 또는 개시 연기', recipient: '터미널', open: 'all',
      },
    });
  });
  // 정박지 대기 · 조위 대기
  for (const p of plans) {
    if (p.kind !== 'plan' || p.hold || !p.waitFrom || !(p.waitH >= 1)) continue;
    const tide = p.waitReason === 'tide';
    const berthName = ONSAN_BERTHS_3D[p.berthId]?.name || p.berthName;
    out.push({
      type: tide ? 'FORECAST_TIDE' : 'FORECAST_WAIT', level: 'WARNING', berth_name: berthName, callsgns: [p.callsgn],
      message: `앞으로 · ${whenKo(p.eta)} ${p.name} 입항 — ${tide ? '조위 대기' : '정박지 대기'} ${p.waitH}시간`,
      forecast: {
        kind: tide ? 'tide' : 'wait', scope: 'ship', at: p.eta, title: p.name, place: berthName, stage: `앞으로 · ${whenKo(p.eta)}`,
        why: tide
          ? `저조로 흘수 여유 부족(필요 ${ukcNeed(p.draught || 0).toFixed(1)} m) · 조위 대기 ${p.waitH}시간`
          : `선석 자리 없음 · 정박지 대기 ${p.waitH}시간${p.berthAt ? ` → ${whenKo(p.berthAt)} 접안` : ''}`,
        action: tide ? '입항 시각 조정' : '선석 조정 또는 입항 시각 조정', recipient: tide ? 'VTS' : '선석 운영 주체', open: berthName,
      },
    });
  }
  return out;
}

// ── 검증 — 출항 예정 신고가 없을 때 쓰는 재항 중앙값 추정은 얼마나 맞았나 ─────────────
// 최근 입출항 기록(실제 입항 · 출항)으로, 입항 시각 + 그 부두 재항 중앙값을 실제 출항과 비교한다.
// 재항 통계는 같은 기간을 포함하므로 낙관적일 수 있다(표본 밖 검증 아님).
const HIST_ALIAS = { OTK부두: 'CY-OTK1' };
export function backtestDwell(extra) {
  const med = new Map(extra.dwell.map((d) => [berthIdOf(d.wharf_name), Number(d.median_hours)]).filter(([k, v]) => k && v > 0));
  const p90 = new Map(extra.dwell.map((d) => [berthIdOf(d.wharf_name), Number(d.p90_hours)]).filter(([k, v]) => k && v > 0));
  const errs = [];
  let inRange = 0;
  for (const r of extra.history || []) {
    const id = HIST_ALIAS[simNorm(r.facility_name)] || berthIdOf(r.facility_name);
    const a = ms(r.arrival_at_utc); const d = ms(r.departure_at_utc);
    if (!id || !a || !d || d <= a || !med.get(id)) continue;
    const actualH = (d - a) / H;
    errs.push(Math.abs(actualH - med.get(id)));
    if (actualH <= (p90.get(id) || Infinity)) inRange += 1;
  }
  if (errs.length < 5) return null;
  errs.sort((x, y) => x - y);
  return { n: errs.length, medianErrH: errs[Math.floor(errs.length / 2)], inRangePct: Math.round((inRange / errs.length) * 100) };
}
