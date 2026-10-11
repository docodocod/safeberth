// [2026-09-25] 한 입항 건에 화물이 여러 종 실린다(합성 manifest v4, 입항 건당 1~8종).
// 화면마다 첫 화물 1종만 찍으면 여러 화물을 실은 배가 단일 화물선처럼 읽혀서,
// 화물 표기를 이 한 곳에서 만든다.

/** 이름 목록(중복·빈 값 제거, 가나다순). 입력은 문자열 또는 { name } 객체 배열.
 *
 * [2026-09-29] 정렬한다. 화면마다 화물이 오는 순서(입항 건·재항 뷰·판정 요청)가 달라, 같은 배가
 * 표에서는 "가솔린, 케로젠, 아스팔트 외 1종", 콘솔 헤더에서는 "아스팔트, 가솔린 외 2종"으로 보였다.
 */
export function cargoNames(list) {
  const out = [];
  for (const c of list || []) {
    const name = typeof c === 'string' ? c : c?.name;
    if (name && !out.includes(name)) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 칸 폭에 맞는 요약 — 이름을 3 · 2 · 1개로 줄여 가며 maxChars 안에 드는 첫 표기를 고른다.
 *  [2026-09-30] 'A, B 외 2종'이 칸을 넘겨 '…'로 잘리던 것을 막는다(현우: 잘리는 글자). 전체 목록은 title 로 준다. */
export function cargoFit(list, maxChars = 16) {
  const names = cargoNames(list);
  for (const max of [3, 2, 1]) {
    const t = names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} 외 ${names.length - max}종`;
    if (t.length <= maxChars) return t;
  }
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}종`;
}

/** 'A' · 'A, B' · 'A, B 외 3종' — 좁은 칸용 요약. 전체 목록은 title 로 준다. */
export function cargoSummary(list, max = 2) {
  const names = cargoNames(list);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} 외 ${names.length - max}종`;
}
