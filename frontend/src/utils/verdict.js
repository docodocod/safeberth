import { COLORS } from './constants';

// 판정 등급 색 — 화면 전체가 같은 등급을 같은 색으로 칠한다(2026-09-29 밤).
// 예전엔 '판정불가'가 콘솔·접안 목록은 노랑, 선박 판정 표는 보라, 추적 띠·경고는 회색이라
// 지도에서 본 색을 다른 화면에서 다시 찾을 수 없었다. 판정불가는 "모르면 통과시키지 않는다"는
// 별도 결론이라 주의(노랑)와도 다른 색이어야 한다.
export const VERDICT_COLOR = {
  적합: COLORS.teal,
  주의: COLORS.yellow,
  부적합: COLORS.red,
  판정불가: COLORS.purple,
};
export const VERDICT_BG = {
  적합: '#E2F1ED',
  주의: '#FBEFD9',
  부적합: '#F8E2E1',
  판정불가: '#ECE6F6',
};
export const VERDICT_RANK = { 부적합: 0, 판정불가: 1, 주의: 2, 적합: 3 };
export const verdictColor = (level) => VERDICT_COLOR[level] || COLORS.textDim;

// 백엔드 선석 이름(OTK1부두)과 화면 선석 이름(OTK 1부두)은 띄어쓰기만 다르다
export const berthKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
