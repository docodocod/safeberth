import { useCallback, useEffect, useRef, useState } from 'react';
import { BACKEND_BASE } from '../api/backendAdapter';

// ─────────────────────────────────────────────────────────────────────────────
// 하역 개시 인터락 게이트(라즈베리파이 실물) 상태 훅.
//
// 백엔드가 MQTT(gate/{id}/status)를 받아 /ws/gate 로 1초마다 상태 한 장을 밀어준다
// (backend app/gate/bridge.py · 계약은 하드웨어/UI연동_전달사항_20260922.md).
// 7월의 mockHardware.js(smartport/gate/… 계약)는 폐기했다 — 화면이 가짜 상태를
// 보여주면 실물이 붙었을 때 "왜 화면과 장치가 다르냐"가 된다.
//
// 요청은 보내기만 한다. "하역 개시 요청"을 눌렀을 때 열어도 되는지는 장치가 정하고,
// 그 결과가 다음 status 의 denied 로 돌아온다 — 화면이 먼저 거부하지 않는다.
//
// [2026-09-25] WebSocket 이 안 되는 배포에서는 1초 폴링으로 같은 상태를 받는다.
//   Vercel(smartport-mas.vercel.app)은 /api 를 백엔드 EC2 로 넘겨주지만 WebSocket 은
//   넘기지 못한다(실측: /ws/gate 업그레이드가 101 이 아니라 200 으로 끝남). 백엔드가
//   도메인·인증서 없이 IP 로만 떠 있어 https 화면에서 ws:// 를 직접 여는 것도 막힌다.
//   그래서 처음부터 폴링으로 시작하고, WebSocket 이 열리면 폴링을 멈춘다. 끊기면 다시
//   폴링한다. GET /gate/state 는 /ws/gate 가 미는 것과 같은 한 장(bridge.snapshot)이다.
// ─────────────────────────────────────────────────────────────────────────────

const WS_PATH = '/ws/gate';
const RECONNECT_MS = 2000;
const POLL_MS = 1000;

async function call(path, body, method = 'POST') {
  const res = await fetch(`${BACKEND_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function useHardwareData() {
  const [snapshot, setSnapshot] = useState(null);
  // 'connecting' | 'open' | 'polling' | 'closed' — 화면 ↔ 백엔드 연결 상태(브로커·장치 상태와 별개)
  //   open    : WebSocket 으로 받는 중
  //   polling : WebSocket 이 없어 1초마다 GET /gate/state 로 받는 중 (연결된 상태다)
  //   closed  : 둘 다 실패 — 백엔드가 응답하지 않는다
  const [wsState, setWsState] = useState('connecting');
  const wsRef = useRef(null);

  useEffect(() => {
    let closed = false;
    let timer = null;
    let pollTimer = null;
    let wsOpen = false;

    const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };
    const poll = async () => {
      if (closed || wsOpen) return;
      try {
        const res = await fetch(`${BACKEND_BASE}/gate/state`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSnapshot(await res.json());
        setWsState((prev) => (prev === 'open' ? prev : 'polling'));
      } catch {
        setWsState((prev) => (prev === 'open' ? prev : 'closed'));
      }
      if (!closed && !wsOpen) pollTimer = setTimeout(poll, POLL_MS);
    };

    // [2026-09-30] 한 번도 열린 적 없이 두 번 실패하면(Vercel 처럼 WebSocket 을 못 넘기는 배포) 다시 시도하지 않고
    //   1초 조회만 쓴다 — 몇 초마다 실패한 연결이 쌓여 콘솔이 오류로 찼다(흐름 점검 9/30).
    let everOpen = false;
    let fails = 0;
    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}${WS_PATH}`);
      wsRef.current = ws;
      ws.onopen = () => { wsOpen = true; everOpen = true; fails = 0; stopPolling(); setWsState('open'); };
      ws.onmessage = (ev) => {
        try { setSnapshot(JSON.parse(ev.data)); } catch { /* 깨진 한 장은 버린다 */ }
      };
      ws.onclose = () => {
        wsOpen = false;
        if (closed) return;
        // WebSocket 이 없어도 화면은 멈추지 않는다 — 폴링으로 이어 받고, WebSocket 은 계속 다시 시도
        if (!pollTimer) poll();
        fails += 1;
        if (!everOpen && fails >= 2) return;
        timer = setTimeout(connect, RECONNECT_MS);
      };
      ws.onerror = () => { /* onclose 가 뒤따른다 */ };
    };

    poll();      // 첫 장은 바로 받는다 — WebSocket 이 열리면 poll 이 스스로 멈춘다
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      stopPolling();
      wsRef.current?.close();
    };
  }, []);

  const sendGateCommand = useCallback(
    (gateId, action) => call(`/gate/${gateId}/cmd`, { action }),
    [],
  );
  const setDemoWeather = useCallback(
    ({ wind_ms = null, wave_m = null }) => call('/gate/demo/weather', { wind_ms, wave_m }),
    [],
  );
  const clearDemoWeather = useCallback(() => call('/gate/demo/weather', null, 'DELETE'), []);
  // 시연 판정 — 그 선석의 하역중 판정 값만 넣는다(잠금 규칙은 실제와 같고, 판정 이력엔 남지 않는다)
  const setDemoVerdict = useCallback(
    ({ gate_id = null, level, reason = '' }) => call('/gate/demo/verdict', { gate_id, level, reason }),
    [],
  );
  const clearDemoVerdict = useCallback(
    (gateId = null) => call(`/gate/demo/verdict${gateId ? `?gate_id=${gateId}` : ''}`, null, 'DELETE'),
    [],
  );

  return {
    snapshot, wsState, sendGateCommand, setDemoWeather, clearDemoWeather, setDemoVerdict, clearDemoVerdict,
  };
}
