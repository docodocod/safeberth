// 자료 출처 표식(합성 자료 · 시연용 주입 · 예시값 · 연계 구상 등)을 화면에 보일지 (2026-09-29 밤, 현우).
//
// 시연 화면은 도입 뒤의 완성된 모습을 보인다 — 표식은 기본으로 끈다. 화물이 합성이고 일부를 시연용으로
// 넣었다는 사실, 계측기·카메라가 없다는 사실은 개발보고서 한계 절과 질의응답에서 밝힌다.
// 질의응답에서 "어느 것이 합성인가"를 화면으로 보여야 할 때는 주소 뒤에 ?disclose=1 을 붙여 한 번 열면
// 이 브라우저에서 표식이 다시 보인다(?disclose=0 으로 끔).
const KEY = 'safeberth_disclose';

let cached = null;

export function showDisclosure() {
  if (cached !== null) return cached;
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search).get('disclose');
  try {
    if (q === '1') window.localStorage.setItem(KEY, '1');
    if (q === '0') window.localStorage.removeItem(KEY);
    cached = window.localStorage.getItem(KEY) === '1';
  } catch {
    cached = q === '1';
  }
  return cached;
}
