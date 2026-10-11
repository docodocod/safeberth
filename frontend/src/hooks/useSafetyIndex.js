import { useEffect, useReducer } from 'react';
import { BACKEND_BASE } from '../api/backendAdapter';

// 다차원 안전 평가 지수 — 사이드바 요약과 자세히 보기(차트)가 같은 값을 쓴다(2026-09-30).
// 첫 계산이 40~60초라 화면마다 따로 부르지 않고 한 번 받아 나눠 쓴다. 서버는 5분 동안 같은 값을 돌려준다.
const POLL_MS = 60_000;
let state = { index: null, error: null };
let inFlight = null;
let timer = null;
const subs = new Set();

async function load() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${BACKEND_BASE}/dashboard/safety-index`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = { index: await res.json(), error: null };
    } catch (e) {
      state = { index: state.index, error: e.message };
    }
    subs.forEach((fn) => fn());
  })();
  try { await inFlight; } finally { inFlight = null; }
  return undefined;
}

export default function useSafetyIndex() {
  const [, force] = useReducer((c) => c + 1, 0);
  useEffect(() => {
    subs.add(force);
    if (subs.size === 1) { load(); timer = setInterval(load, POLL_MS); }
    return () => {
      subs.delete(force);
      if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);

  const { index, error } = state;
  // '데이터 신선도' 축은 지수에서 뺀다(2026-08-21) — 항만이 안전한가가 아니라 시스템이 건강한가라서.
  // 시스템 상태는 헤더의 수집 배지가 맡는다. 축이 빠지므로 종합도 남은 축으로 다시 낸다.
  const axes = (index?.axes ?? []).filter((a) => a.subject !== '데이터 신선도');
  const scored = axes.filter((a) => a.score !== null);
  const overall = scored.length
    ? Math.round((scored.reduce((t, a) => t + a.score, 0) / scored.length) * 10) / 10
    : null;
  return { index, axes, overall, error };
}
