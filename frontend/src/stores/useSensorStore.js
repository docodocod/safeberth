import { create } from 'zustand';
import { OPERATOR_NAME } from '../utils/constants';

// 탱크·배관은 계측기 미도입으로 수집 소스가 없다 — 센서 데이터 탭과 3D 트윈이
// 화면에서 "데모 값"이라고 밝히고 쓴다.
const initialTanks = [
  { id: 'T-101', type: 'Tank', status: 'active', level: 85, temperature: 22.5, pressure: 1.2, cargoType: 'Crude Oil' },
  { id: 'T-102', type: 'Tank', status: 'active', level: 45, temperature: 21.0, pressure: 1.0, cargoType: 'Gasoline' },
  { id: 'T-103', type: 'Tank', status: 'idle', level: 10, temperature: 18.5, pressure: 0.9, cargoType: 'Chemicals' },
  { id: 'T-104', type: 'Tank', status: 'maintenance', level: 0, temperature: 15.0, pressure: 0.0, cargoType: 'Empty' },
  { id: 'T-105', type: 'Tank', status: 'active', level: 92, temperature: 25.1, pressure: 1.5, cargoType: 'Crude Oil' },
  { id: 'T-106', type: 'Tank', status: 'active', level: 60, temperature: 20.0, pressure: 1.1, cargoType: 'Gasoline' },
];

// 트윈 선박은 useLiveTwinShips 가 실 AIS(upa_vessel_position + 재항 화물)로 채운다.
//
// 예전에는 여기에 'HMM GOODWILL 에탄올 32,000t' 같은 6척이 박혀 있었다. 초기값이자
// 사실상의 폴백이어서, 백엔드가 죽거나 온산 범위에 실선박이 0척이면 트윈·레이더·
// 교통목록·선석바가 전부 이 가짜 6척을 실선박처럼 계속 표시했다. 화면 어디에도
// "지금 폴백 중"이라는 표시가 없어 구분할 방법이 없었다.
//
// 빈 배열로 시작한다 — 실데이터가 없으면 각 화면이 "신호 없음"이라고 말한다.
const initialShips = [];

const initialPipes = [
  { id: 'P-01', type: 'Pipe', flowRate: 1500, pressure: 4.5, status: 'active' },
  { id: 'P-02', type: 'Pipe', flowRate: 0, pressure: 1.0, status: 'idle' },
  { id: 'P-03', type: 'Pipe', flowRate: 800, pressure: 3.2, status: 'active' },
];

const initialSystemStatus = {
  activeShips: 6,
  safetyScore: 98,
  safetyGrade: 'A',
};

const initialLogs = [
  { agent: '하역 스케줄링 AI', action: '일정 최적화 완료', details: 'S-BlueWhale 접안 시간 15분 단축 (예상)', timestamp: Date.now() - 50000 },
  { agent: '안전 감시 AI', action: '가스 농도 정상 확인', details: 'B-1 선석 주변 가스 농도 0.0ppm 유지', timestamp: Date.now() - 120000 },
  { agent: '유체 제어 AI', action: '밸브 자동 조절', details: 'T-101 탱크 유입 속도 5% 감소 (과압 방지)', timestamp: Date.now() - 300000 },
];

const useSensorStore = create((set, get) => ({
  tanks: initialTanks,
  ships: initialShips,
  pipes: initialPipes,
  systemStatus: initialSystemStatus,
  aiLogs: initialLogs,
  connected: false,
  selectedObject: null,
  alerts: [],
  predictionOffset: 0, // Time offset in hours for prediction

  setPredictionOffset: (valOrFn) => set((state) => ({
    predictionOffset: typeof valOrFn === 'function' ? valOrFn(state.predictionOffset) : valOrFn
  })),

  setConnected: (val) => set({ connected: val }),

  // 디지털 트윈 선박을 실데이터로 교체한다(useLiveTwinShips).
  //
  // 빈 배열도 그대로 반영한다. 예전에는 빈 배열을 무시했는데, 그러면 수집이 끊겨
  // 실선박이 0척이 된 상황에서 직전 목록이 화면에 그대로 남아 "배가 있다"고
  // 말하게 된다. 없으면 없다고 말하는 편이 맞다 — 각 HUD 가 "신호 없음"을
  // 표시하도록 되어 있다.
  setShips: (ships) => set(Array.isArray(ships) ? { ships } : {}),

  // 3D 에서 배를 고르면 그 배를 추적한다(선박 추적 띠)
  setSelectedObject: (obj) => set(() => ({
    selectedObject: obj,
    ...(obj?.type === 'Ship' && obj.callsgn ? { trackedVessel: { callsgn: String(obj.callsgn).trim(), vessel_name: obj.id || null } } : {}),
  })),

  // [2026-09-29] 추적 선박 — 어느 화면에서든 배를 고르면 여기 담기고, 선박 추적 띠·메뉴·각 화면이 같은 배를 비춘다.
  //   threadFocus: 띠·경고에서 넘어와 그 화면이 그 배 자리로 가야 할 때({ target, at })
  trackedVessel: null,
  trackVessel: (v) => set(() => {
    const cs = v && String(v.callsgn || v.call_sign || '').trim();
    return { trackedVessel: cs ? { callsgn: cs, vessel_name: v.vessel_name || v.name || null } : null };
  }),
  threadFocus: null,
  requestThreadFocus: (target) => set({ threadFocus: { target, at: Date.now() } }),

  // 온산 MVP 에이전트 패널 상태 (/api/v1/*)
  berthGroups: [],
  berthWeather: null,
  gateAssessment: null,
  orchestration: null,
  selectedBerthGroup: null, // 지도에서 선석 클릭 시 기상 판정 패널과 연동
  setSelectedBerthGroup: (v) => set({ selectedBerthGroup: v }),
  // [2026-09-29 밤] 선석 상세 서랍 — 지도의 선석 원·선석 현황판에서 연다(선석 이름).
  //   접안 선박 · 부두 기상 · 최근 접안 · 재항 시간을 한 서랍에서 본다. 선박 상세와 같은 자리라 서로 닫는다.
  selectedBerth: null,
  // [2026-09-30] 선박 찾기 창(선석 현황 포함) — 추적 띠 단추와 대시보드 '온산 선석 점유' 타일이 연다
  pickerOpen: false,
  setPickerOpen: (v) => set({ pickerOpen: Boolean(v) }),
  setSelectedBerth: (name) => set(() => (name ? { selectedBerth: name, selectedVessel: null } : { selectedBerth: null })),

  // 트윈 HUD 접기 상태 — CCTV 를 접으면 그 아래 선박 목록이 따라 올라가야 한다.
  // 두 패널이 각자 접힘을 들고 있으면 위치가 어긋나므로 여기서 공유한다.
  // [2026-09-28] CCTV·레이더는 접힌 상태가 기본 — 펼쳐 두면 3D 장면의 절반을 덮었다(현우 D11)
  // [2026-09-29] 다시 펼친 채 시작(현우) — 실제 관제실이 늘 띄워 두는 감시 화면이라 흐름의 첫 장면이다.
  hudCctvCollapsed: false,
  setHudCctvCollapsed: (v) => set({ hudCctvCollapsed: Boolean(v) }),
  // 3D 가벼운 모드(그림자 끔 · 해상도 1배) — Scene 의 PerfProbe 가 켜거나 ?lite=1
  twinLite: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('lite') === '1',
  setTwinLite: (v) => set({ twinLite: Boolean(v) }),
  hudRadarCollapsed: false,
  setHudRadarCollapsed: (v) => set({ hudRadarCollapsed: Boolean(v) }),

  // 선박 상세 패널 (지도 마커/입항 목록 클릭 → 선박 여정 뷰)
  selectedVessel: null,
  setSelectedVessel: (v) => set(() => ({
    selectedVessel: v,
    ...(v ? { selectedBerth: null } : {}),
    ...(v?.callsgn ? { trackedVessel: { callsgn: String(v.callsgn).trim(), vessel_name: v.vessel_name || null } } : {}),
  })),
  // 다른 화면(배정현황 등)에서 "이 배를 협상 콘솔에서 처리해 달라"는 요청.
  // 콘솔이 소비하면 clear 한다 — 값이 남아 있으면 라우팅 때마다 다시 열린다.
  consoleRequest: null,
  // [2026-09-28] 판단 과정 서랍(선박 판정 화면)이 열려 있나 · 지금 근거를 보는 배 · 판정 요청 중인 배
  reasoningOpen: false,
  setReasoningOpen: (v) => set({ reasoningOpen: Boolean(v) }),
  reasoningFocus: null,          // { callsgn, loading }
  setReasoningFocus: (f) => set({ reasoningFocus: f }),
  judgeBusy: {},                 // { [call_sign]: true }
  setJudgeBusy: (cs, on) => set((s) => {
    const n = { ...s.judgeBusy };
    if (on) n[cs] = true; else delete n[cs];
    return { judgeBusy: n };
  }),
  // cargo: 배정현황 행이 들고 있는 '그 배정이 실제로 쓴 화물'({chem_id, name}).
  // 없이 호출부호만 넘기면 콘솔이 제 나름대로 화물을 고르는데, 한 배가 후보 선석마다
  // 다른 화물 행을 갖고 있어(mart.berth_current_cargo 는 선석별로 만들어진다)
  // 화면에 보이는 화물과 판정에 들어간 화물이 어긋난다(2026-08-24 실측: 승인 대기
  // 5건 중 4건). 판정 입력은 화면이 보여준 것과 같아야 한다.
  // [2026-09-28] extra = { subject, record } — subject 는 판정에 쓴 선석·흘수·화물(표의 행 그대로),
  // record 는 이력에 남은 판정. 판단 과정 창은 이 둘로 '근거'를 보여준다(실행 버튼 없음).
  requestConsole: (callsgn, cargo = null, extra = {}) =>
    set({
      consoleRequest: { callsgn, cargo, ...extra, at: Date.now() },
      ...(callsgn ? { trackedVessel: { callsgn: String(callsgn).trim(), vessel_name: extra?.subject?.vessel_name || null } } : {}),
    }),
  clearConsoleRequest: () => set({ consoleRequest: null }),

  // 3D 관제 화면 → 정밀 검토(Omniverse) 지목. 3D 정보창(캔버스 안)에서 누르고,
  // 스트림을 여닫는 건 DigitalTwinPage 라 여기를 거친다. at 이 바뀌면 새 요청이다.
  // { berth: 마스터 표기 선석명, call_sign, vessel_name } — 셋 다 없으면 지목 해제.
  // Omniverse 정밀 검토 미리보기(캡처 비교) — 시연 PC 에서는 스트림 대신 이것을 연다 (2026-09-28)
  omniPreviewOpen: false,
  setOmniPreviewOpen: (v) => set({ omniPreviewOpen: Boolean(v) }),
  omniverseRequest: null,
  requestOmniverse: (focus) => set({ omniverseRequest: { ...(focus || {}), at: Date.now() } }),
  // 트윈 화면이 요청을 처리하면 비운다 — 남겨 두면 다음에 화면을 열 때마다 같은 지목을 다시 보낸다
  clearOmniverseRequest: () => set({ omniverseRequest: null }),

  // 3D 관제 화면 안 "앞으로 72시간" 판정 흐름(2026-09-27) — 정보창·연결 바가 요청한다.
  // Omniverse 지목과 같은 모양({berth, berthId, call_sign, vessel_name})이지만 Kit 없이 이 화면이 그린다.
  outlookRequest: null,
  requestOutlook: (focus) => set({ outlookRequest: { ...(focus || {}), at: Date.now() } }),
  clearOutlookRequest: () => set({ outlookRequest: null }),
  // 시간축 커서가 가리키는 시각의 판정 — Port 가 그 선석의 색·라벨을 이 값으로 바꾼다.
  outlookPreview: null,
  setOutlookPreview: (v) => set({ outlookPreview: v }),
  // [2026-09-30] 3D 처음 화면(조감)으로 — 72시간을 닫으면 카메라가 첫 위치로 돌아간다(현우)
  // 72시간 패널이 3D 아래쪽을 덮는 만큼 장면을 위로 미는 픽셀 수(Scene ViewShift)
  twinViewShift: 0,
  setTwinViewShift: (v) => set({ twinViewShift: Math.max(0, Number(v) || 0) }),
  twinHomeAt: 0,
  twinHomeKind: 'home',   // 'home' = 처음 화면(조감) · 'wide' = 항로와 정박지까지(72시간 온산 전체)
  requestTwinHome: (kind) => set({ twinHomeAt: Date.now(), twinHomeKind: kind === 'wide' ? 'wide' : 'home' }),

  // 경고 → 안전 심사 연결. 경고 카드에서 선석을 고르면 그 경고의 내용이 여기 담기고,
  // 안전 심사 폼(SafetyGatesPanel)이 받아서 폼을 채운다.
  //
  // 이게 없으면 경고가 막다른 길이 된다 — "가스부두 혼재 위험"을 보고도 그 선석을
  // 심사하려면 화면을 옮겨 선석을 손으로 다시 고르고 화물을 찾아 넣어야 했다.
  //
  // chem_ids 까지 받는 이유: 선석 이름만 넘기면 폼이 그 선석의 '첫 번째' 화물을
  // 집어넣는다. 경고는 "가솔린 ↔ 부탄"인데 심사는 케로젠으로 도는 일이 실제로
  // 생겼다. 경고가 지목한 두 물질을 그대로 넘겨 같은 판정을 재현하게 한다.
  // { berth_name, chem_ids, at } — at 은 같은 선석을 다시 눌러도 반응하게 하는 값.
  safetyPrefill: null,
  setSafetyPrefill: (berthNameOrPayload) => set(() => {
    if (!berthNameOrPayload) return { safetyPrefill: null };
    const payload = typeof berthNameOrPayload === 'string'
      ? { berth_name: berthNameOrPayload }
      : berthNameOrPayload;
    if (!payload.berth_name) return { safetyPrefill: null };
    return { safetyPrefill: { chem_ids: [], ...payload, at: Date.now() } };
  }),

  // 경고 확인(acknowledge) 이력 — { alertId: { by, at } }
  alertAcks: {},
  ackAlert: (id) => set((s) => ({
    alertAcks: { ...s.alertAcks, [id]: { by: OPERATOR_NAME, at: new Date().toISOString() } },
  })),
  setBerthGroups: (v) => set({ berthGroups: v }),
  setBerthWeather: (v) => set({ berthWeather: v }),
  setGateAssessment: (v) => set({ gateAssessment: v }),
  setOrchestration: (v) => set({ orchestration: v }),
  
  addAlert: (alert) => set((state) => ({
    alerts: [{ id: Date.now(), timestamp: Date.now(), ...alert }, ...state.alerts].slice(0, 20)
  })),

  getActiveAlerts: () => get().alerts,

  // WebSocket data updater
  updateSensorData: (data) => set((state) => {
    if (!data || !data.data) return { ...state };
    const payload = data.data;

    const newShips = [];
    if (payload.berths) {
      Object.keys(payload.berths).forEach(berthId => {
        const b = payload.berths[berthId];
        if (b.vessel_name) {
          newShips.push({
            id: b.vessel_name,
            type: 'Ship',
            status: b.phase, // 'approaching', 'mooring', 'operating', 'departing'
            berth: berthId,
            cargoAmount: b.progress ? b.progress * 1000 : 0, // Mock cargo
            vessel_lat: b.vessel_lat,
            vessel_lon: b.vessel_lon,
            vessel_heading: b.vessel_heading,
            vessel_speed: b.vessel_speed,
          });
        }
      });
    }

    let newAlerts = [];
    const newTanks = state.tanks.map(tank => {
      if (payload.tanks && payload.tanks[tank.id]) {
        const tData = payload.tanks[tank.id];
        const newLevel = tData.level !== undefined ? tData.level : tank.level;
        
        // Generate Alert for High Level
        if (newLevel > 90 && tank.level <= 90) {
          newAlerts.push({ message: `${tank.id} 탱크 수위 위험 (90% 초과)`, type: 'danger' });
        }
        
        return {
          ...tank,
          level: newLevel,
          flowRate: tData.flow_rate !== undefined ? tData.flow_rate : tank.flowRate,
          status: tData.state !== undefined ? tData.state : tank.status,
        };
      }
      return tank;
    });

    if (payload.weather) {
      if (payload.weather.wind_speed > 15) {
        // Prevent spamming the same alert
        const recentWindAlert = state.alerts.find(a => a.message.includes('풍속') && Date.now() - a.timestamp < 10000);
        if (!recentWindAlert) {
          newAlerts.push({ message: `강풍 경보: 풍속 ${payload.weather.wind_speed.toFixed(1)}m/s`, type: 'warning' });
        }
      }
    }

    const updatedAlerts = [...state.alerts];
    newAlerts.forEach(a => {
      updatedAlerts.unshift({ id: Date.now() + Math.random(), timestamp: Date.now(), ...a });
    });

    return { 
      ...state, 
      ships: newShips.length > 0 ? newShips : state.ships,
      tanks: newTanks,
      weather: payload.weather || state.weather,
      timestamp: payload.timestamp || state.timestamp,
      alerts: updatedAlerts.slice(0, 20)
    }; 
  })
}));

export default useSensorStore;
