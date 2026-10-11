import { ONSAN_BERTHS, ONSAN_WEATHER_GROUP, findBerthIdByName } from './geoUtils';
import { berthKey } from './verdict';

// 온산 선석 순서 — 지도·3D 와 같은 해안선 순서(처용리 북쪽 → 산암리·원산리 → 해상 부이).
// 백엔드(/dashboard/berth-assignments)는 가나다·등록 순이라 현황판이 지도와 다른 순서로 보였다.
export const ONSAN_ORDER = [
  'UTK부두', 'OTK1부두', 'OTK2부두', '대한유화부두',
  'S-Oil 1부두', 'S-Oil 2부두', 'S-Oil 3부두', 'S-Oil 4부두',
  '효성부두', '정일1부두', '정일2부두', '달포부두',
  'S-Oil부이', 'S-Oil&오일허브 부이', '석유공사부이',
];
const RANK = new Map(ONSAN_ORDER.map((n, i) => [berthKey(n), i]));
export const sortOnsan = (rows) => [...rows].sort(
  (a, b) => (RANK.get(berthKey(a.wharf_name)) ?? 99) - (RANK.get(berthKey(b.wharf_name)) ?? 99),
);

/** 현황판 칸 이름 — '부두'는 뺀다(칸이 좁다) */
export const shortBerth = (name) => String(name || '')
  .replace('S-Oil&오일허브 부이', '오일허브 부이')
  .replace(/부두$/, '');

/** 선석 이름 → 부두 기상 기준군(berth_weather_threshold). 기준이 없는 부이는 null */
export function weatherGroupOf(name) {
  const id = findBerthIdByName(name);
  return id ? ONSAN_WEATHER_GROUP[id] || null : null;
}

/** 선석 이름 → 지도 정본(ONSAN_BERTHS) 항목. 운영사·DWT 가 백엔드에 비어 있을 때 쓴다 */
export function berthMeta(name) {
  const id = findBerthIdByName(name);
  return id ? { id, ...ONSAN_BERTHS[id] } : null;
}

/**
 * PORT-MIS 입출항 신고의 계류시설 표기로 찾는 패턴(ILIKE).
 * 신고는 'OTK부두'(1·2 구분 없음) · 'S-OIL1부두' · '달포부두 01'처럼 적혀 있다(2026-09-29 실측).
 * 대소문자는 서버가 무시하고, 띄어쓰기만 맞춘다.
 */
export function historyPattern(name) {
  const n = String(name || '').replace(/\s+/g, '');
  if (/^OTK\d부두$/i.test(n)) return '%OTK%부두%';
  return `%${n}%`;
}

/** 실물 하역 개시 게이트가 있는 부두 — 현장 설비 화면의 게이트 A·B */
export function gateOfBerth(name) {
  const n = berthKey(name);
  if (n.startsWith('OTK1')) return 'A';
  if (n.startsWith('정일1')) return 'B';
  return null;
}
