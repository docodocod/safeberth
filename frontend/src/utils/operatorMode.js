// 운영자 화면 여부 — 공개 링크(심사위원용)에서 공용 상태를 바꾸는 단추를 숨긴다 (2026-09-28, 현우 D12).
//
// 배포 서버에는 로그인이 없다. 시연 입력은 모든 사람 화면에 한꺼번에 적용되고, 게이트 명령은
// 파이가 켜져 있으면 실물 밸브까지 간다. 링크를 받은 사람이 누르면 발표 중인 화면의 게이트가 잠긴다.
// 운영자는 주소 뒤에 ?operator=1 을 붙여 한 번 열면 이 브라우저에서 계속 운영자로 본다(?operator=0 으로 해제).
// 로컬(localhost)은 늘 운영자다 — 시연 PC 와 개발용.
// 서버 쪽 보호가 아니라 화면에서 단추를 감추는 것이다. 서버 인증은 발표 뒤 과제로 남긴다.
const KEY = 'safeberth_operator';

export function isOperator() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const q = new URLSearchParams(window.location.search).get('operator');
  try {
    if (q === '1') window.localStorage.setItem(KEY, '1');
    if (q === '0') window.localStorage.removeItem(KEY);
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return q === '1';
  }
}
