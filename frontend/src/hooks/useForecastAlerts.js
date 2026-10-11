import { useEffect, useState } from 'react';
import useVesselThread from './useVesselThread';
import { loadSimExtra, runSim, forecastAlerts } from '../utils/simInputs';

// ─────────────────────────────────────────────────────────────────────────────
// '앞으로' 경고 (2026-09-30) — 72시간 시뮬레이션에서 미리 알 수 있는 일을 경고 벨에 올린다.
//   기상 중단 예보 · 선석 자리가 없어 정박지 대기 · 저조로 조위 대기.
// 예전엔 72시간 패널을 열어야만 보였다. 계산은 패널과 같은 것(utils/simInputs → berthSim)을 쓴다.
// 여러 화면이 불러도 10분에 한 번만 계산한다.
// ─────────────────────────────────────────────────────────────────────────────
const EVERY_MS = 10 * 60000;
let shared = { at: 0, alerts: [], flight: null };
const subs = new Set();

async function refresh(berths) {
  if (shared.flight) return shared.flight;
  shared.flight = (async () => {
    try {
      const extra = await loadSimExtra();
      const t0 = Date.now();
      const sim = runSim({ t0, berths, extra });
      shared = { at: Date.now(), alerts: forecastAlerts(sim, extra, t0), flight: null };
    } catch {
      shared = { ...shared, at: Date.now(), flight: null };
    }
    subs.forEach((f) => f(shared.alerts));
    return shared.alerts;
  })();
  return shared.flight;
}

export default function useForecastAlerts() {
  const { berths, loaded } = useVesselThread();
  const [alerts, setAlerts] = useState(shared.alerts);
  useEffect(() => {
    subs.add(setAlerts);
    return () => { subs.delete(setAlerts); };
  }, []);
  useEffect(() => {
    if (!loaded || !berths.length) return undefined;
    if (Date.now() - shared.at > EVERY_MS) refresh(berths);
    const id = setInterval(() => refresh(berths), EVERY_MS);
    return () => clearInterval(id);
  }, [loaded, berths]);
  return alerts;
}
