// 관제사 표기 — 확인(ACK)·승인·반려 기록에 같은 이름이 남아야 한다.
// 예전엔 화면마다 '함현우 (관제)' / '관제사(함현우)' / '관제사(Oper-01)' 세 가지가
// 섞여 있어, 같은 사람이 한 조치가 다른 사람 것처럼 보였다.
export const OPERATOR_NAME = '관제사 함현우';

// ─────────────────────────────────────────────────────────────────────────────
// 화면 색 — PORT-MIS(울산항만공사 GIS 항만 모니터링) 톤에 맞춘 라이트 팔레트
//
// [왜 바꿨나]
// 이 시스템은 PORT-MIS 안의 한 축(액체화물 안전관제)으로 들어가는 것을 상정한다.
// 그런데 화면이 짙은 남색 계열이라 PORT-MIS 옆에 두면 다른 제품처럼 보였다.
// 관제 화면은 낮에 오래 보는 화면이기도 해서, 밝은 바탕이 실무에도 맞다.
//
// [어디는 어둡게 두는가]
// 디지털 트윈의 HUD(레이더·CCTV·선박목록·선석바)는 3D 씬 위에 뜨는 오버레이라
// 밝게 하면 배경과 붙어 안 읽힌다. PORT-MIS 도 밝은 지도 위에 어두운 툴바를
// 쓴다 — 같은 이유다. 그쪽은 DARK_HUD 를 쓴다.
//
// [의미 색]
// 라이트 배경에서는 형광 계열(#00d4aa·#ffd166)이 흰 바탕에 묻혀 판정 색으로
// 못 쓴다. 명도를 낮춰 흰 배경에서 대비가 서는 값으로 바꿨다.
// ─────────────────────────────────────────────────────────────────────────────
export const COLORS = {
  bg: '#EEF2F5',          // 페이지 바탕 (PORT-MIS 지도 여백 톤)
  panel: '#FFFFFF',       // 헤더·사이드바
  card: '#FFFFFF',        // 카드
  cardHover: '#F4F8FA',
  border: '#DCE4EA',
  borderHover: '#9CC3DE',
  navy: '#12354F',        // PORT-MIS 짙은 남색 (활성 탭·툴바)
  teal: '#0E7C6B',        // 정상·안전
  tealDark: '#0A5F52',
  red: '#C4322E',         // 위험
  yellow: '#B26A00',      // 주의 (라이트 배경용 앰버)
  amber: '#E8A317',       // 강조 버튼 채움 (PORT-MIS 전자해도 버튼 톤)
  info: '#1E6FA8',        // 정보·링크
  blue: '#0B4A8F',        // UPA 기본 파랑
  purple: '#5B3E9B',
  white: '#FFFFFF',
  textPrimary: '#16232B',
  textSecondary: '#4A5A63',
  textDim: '#7A8A92',
  glass: 'rgba(255, 255, 255, 0.92)',
  glassBorder: '#DCE4EA',
};

// 3D 트윈 HUD 전용 — 씬 위에 뜨는 오버레이는 계속 어둡게 간다.
export const DARK_HUD = {
  panel: 'rgba(10, 22, 32, 0.86)',
  border: 'rgba(120, 190, 215, 0.32)',
  textPrimary: '#E8F0F2',
  textSecondary: '#A9BCC6',
  textDim: '#7B8E99',
  accent: '#39C0A8',
};

// ─────────────────────────────────────────────
// 울산항 관제 구역 bbox (2026-07 실측 재조정값, data-pipeline 과 동일)
// ─────────────────────────────────────────────
export const ULSAN_BBOX = {
  minLat: 35.18,
  maxLat: 35.82,
  minLon: 129.22,
  maxLon: 129.76,
};
// react-leaflet Rectangle bounds 형식: [[남서], [북동]]
export const ULSAN_BBOX_BOUNDS = [
  [ULSAN_BBOX.minLat, ULSAN_BBOX.minLon],
  [ULSAN_BBOX.maxLat, ULSAN_BBOX.maxLon],
];
export const MAP_CENTER = [35.47, 129.40];
export const MAP_DEFAULT_ZOOM = 11;

// 선석별 하역 판정 4단계 → 색상 (지도/3D 역연동 하이라이트용)
// 라이트 배경에서 4단계가 서로 구분되도록 명도를 계단식으로 벌렸다.
export const WEATHER_STATUS_COLORS = {
  '정상': '#0E7C6B',
  '하역중단': '#B26A00',
  '이안': '#D2601A',
  '호스분리': '#C4322E',
  '판단불가': '#7A8A92',
};

// AIS 항해 상태 → 한글 라벨/색상
//
// UNKNOWN 은 "AIS 항해상태 필드가 없는 배"다. 대부분 Class B 를 쓰는 항내 소형
// 작업선(예선·급유선·통선·시운전선)이라, '묘박'이나 '정박지 대기'로 세면 선석을
// 기다리는 본선 수가 부풀려진다(backendAdapter.navCategory 주석 참고).
export const NAV_STATUS = {
  UNDER_WAY: { label: '항해 중', color: '#0B4A8F' },
  AT_ANCHOR: { label: '정박지 대기', color: '#B26A00' },
  MOORED: { label: '접안 중', color: '#0E7C6B' },
  UNKNOWN: { label: '항내 소형선', color: '#7A8A92' },
};
