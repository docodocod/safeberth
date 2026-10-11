// ─────────────────────────────────────────────
// GET /api/dashboard 응답 mock (CLAUDE.md API 계약과 동일한 형태)
// 백엔드 완성 전까지 이 데이터로 UI 를 개발하고,
// API 가 나오면 useDashboardData 훅의 USE_MOCK 만 끄면 된다.
//
// cargo 필드는 계약에 없는 UI 확장 필드 — 위험물선 팝업 표시용.
// 화물 종류는 실제 울산항 하역 기록(upa_cargo_manifest_sample) 기반.
// ─────────────────────────────────────────────

export const mockDashboard = {
  vessels: [
    {
      port_call_id: 'D7ABC_2026_001',
      callsgn: 'D7ABC',
      vessel_name: 'HMM GOODWILL',
      mmsi: 440559000,
      is_liquid_cargo_vessel: true,
      latitude: 35.45661,
      longitude: 129.35119,
      sog: 0.1,
      nav_status_category: 'MOORED',
      arrival_at_utc: '2026-07-18T22:40:00Z',
      cargo: { name: '에탄올', un_no: 'UN1170' },
      berth: 'OTK 1부두',
    },
    {
      port_call_id: 'D8XYZ_2026_014',
      callsgn: 'D8XYZ',
      vessel_name: 'WOOYANG CHEMI',
      mmsi: 440112000,
      is_liquid_cargo_vessel: true,
      latitude: 35.43778,
      longitude: 129.36694,
      sog: 0.0,
      nav_status_category: 'MOORED',
      arrival_at_utc: '2026-07-19T01:10:00Z',
      cargo: { name: '자일렌', un_no: 'UN1307' },
      berth: '정일 1부두',
    },
    {
      port_call_id: 'V7GAS_2026_007',
      callsgn: 'V7GAS',
      vessel_name: 'GAS UTOPIA',
      mmsi: 538007123,
      is_liquid_cargo_vessel: true,
      latitude: 35.36,
      longitude: 129.52,
      sog: 11.4,
      nav_status_category: 'UNDER_WAY',
      arrival_at_utc: '2026-07-19T09:30:00Z',
      cargo: { name: '부타디엔', un_no: 'UN1010' },
      berth: 'OTK 2부두',
    },
    {
      port_call_id: 'SUNVN_2026_003',
      callsgn: '3FQP8',
      vessel_name: 'SUN VENUS',
      mmsi: 371234000,
      is_liquid_cargo_vessel: true,
      latitude: 35.43,
      longitude: 129.44,
      sog: 0.2,
      nav_status_category: 'AT_ANCHOR',
      arrival_at_utc: '2026-07-18T15:00:00Z',
      cargo: { name: '톨루엔', un_no: 'UN1294' },
      berth: null,
      anchorage: 'E2',
    },
    {
      port_call_id: 'ULPIO_2026_021',
      callsgn: 'D9PIO',
      vessel_name: 'ULSAN PIONEER',
      mmsi: 440778000,
      is_liquid_cargo_vessel: true,
      latitude: 35.47,
      longitude: 129.42,
      sog: 8.6,
      nav_status_category: 'UNDER_WAY',
      arrival_at_utc: '2026-07-17T20:00:00Z',
      cargo: { name: '가솔린', un_no: 'UN1203' },
      berth: 'S-Oil 2부두',
    },
    {
      port_call_id: 'PGLRY_2026_009',
      callsgn: '9VPG7',
      vessel_name: 'PACIFIC GLORY',
      mmsi: 563556000,
      is_liquid_cargo_vessel: true,
      latitude: 35.45100,
      longitude: 129.35600,
      sog: 0.0,
      nav_status_category: 'MOORED',
      arrival_at_utc: '2026-07-18T06:20:00Z',
      cargo: { name: '등유', un_no: 'UN1223' },
      berth: 'S-Oil 1부두',
    },
    {
      port_call_id: 'KRSTU_2026_030',
      callsgn: '9WKR3',
      vessel_name: 'KOTA RESTU',
      mmsi: 533445000,
      is_liquid_cargo_vessel: false,
      latitude: 35.31,
      longitude: 129.48,
      sog: 13.8,
      nav_status_category: 'UNDER_WAY',
      arrival_at_utc: '2026-07-19T11:00:00Z',
      cargo: null,
    },
    {
      port_call_id: 'SVSTR_2026_012',
      callsgn: 'HLSV2',
      vessel_name: 'SILVER STAR',
      mmsi: 440334000,
      is_liquid_cargo_vessel: false,
      latitude: 35.40,
      longitude: 129.47,
      sog: 0.3,
      nav_status_category: 'AT_ANCHOR',
      arrival_at_utc: '2026-07-18T10:45:00Z',
      cargo: null,
    },
    {
      port_call_id: 'MCALM_2026_018',
      callsgn: 'DSMC8',
      vessel_name: 'MORNING CALM',
      mmsi: 440990000,
      is_liquid_cargo_vessel: false,
      latitude: 35.62,
      longitude: 129.55,
      sog: 10.2,
      nav_status_category: 'UNDER_WAY',
      arrival_at_utc: '2026-07-19T14:00:00Z',
      cargo: null,
    },
  ],

  weather: {
    wind_speed_ms: 6.2,
    wind_dir_deg: 335,
    wave_height_sig_m: 0.8,
    tide_level_cm: 120,
    visibility_m: 19.8,
    observed_at_utc: '2026-07-19T02:00:00Z',
  },

  alerts: [
    {
      level: 'DANGER',
      type: 'SEGREGATION',
      message: '3번 선석: 메탄올-황산 혼재금지 (IMDG 격리 위반)',
      port_call_id: 'D7ABC_2026_001',
      created_at_utc: '2026-07-19T01:55:00Z',
    },
    {
      level: 'WARNING',
      type: 'WEATHER',
      message: '풍속 상승 추세 (현재 6.2m/s, 임계 14m/s)',
      port_call_id: null,
      created_at_utc: '2026-07-19T02:00:00Z',
    },
  ],

  // 하역 작업 (오프라인 폴백 — 서버 연결 시 실데이터 접안 이력이 추가됨)
  operations: [
    {
      job_id: 'OP-2026-101', vessel_name: 'HMM GOODWILL', berth: 'OTK 1부두',
      cargo: '에탄올', un_no: 'UN1170', planned_tons: 12000, done_tons: 4500,
      progress_pct: 37.5, status: 'IN_PROGRESS',
      begin_utc: '2026-07-24T10:00:00Z', end_utc: '2026-07-24T18:00:00Z',
      is_real_record: false,
    },
    {
      job_id: 'OP-2026-102', vessel_name: 'WOOYANG CHEMI', berth: '정일 1부두',
      cargo: '자일렌', un_no: 'UN1307', planned_tons: 7500, done_tons: 1900,
      progress_pct: 25.0, status: 'IN_PROGRESS',
      begin_utc: '2026-07-24T11:30:00Z', end_utc: '2026-07-24T17:30:00Z',
      is_real_record: false,
    },
    {
      job_id: 'OP-2026-103', vessel_name: 'PACIFIC GLORY', berth: 'S-Oil 1부두',
      cargo: '등유', un_no: 'UN1223', planned_tons: 9800, done_tons: 0,
      progress_pct: 0, status: 'PLANNED',
      begin_utc: '2026-07-24T15:00:00Z', end_utc: '2026-07-24T22:00:00Z',
      is_real_record: false,
    },
  ],
  stats: null,
  data_source: { weather: 'MOCK', history: 'NONE', stats: 'NONE' },
};

/**
 * mock 모드에서 폴링할 때마다 항해 중(UNDER_WAY) 선박을 조금씩
 * 항만 쪽으로 이동시켜 지도가 살아있는 것처럼 보이게 한다.
 * (실제 API 로 바꾸면 이 함수는 쓰지 않는다)
 */
export function advanceMockVessels(dashboard) {
  return {
    ...dashboard,
    vessels: dashboard.vessels.map((v) => {
      if (v.nav_status_category !== 'UNDER_WAY') return v;
      // 온산항(35.455, 129.355) 방향으로 소폭 이동
      const dLat = 35.455 - v.latitude;
      const dLon = 129.355 - v.longitude;
      const dist = Math.sqrt(dLat * dLat + dLon * dLon) || 1;
      const step = 0.004; // 폴링 1회당 약 400m
      return {
        ...v,
        latitude: +(v.latitude + (dLat / dist) * step).toFixed(5),
        longitude: +(v.longitude + (dLon / dist) * step).toFixed(5),
      };
    }),
  };
}
