// ─────────────────────────────────────────────────────────────────────────────
// 화물쌍 목록 정리 (2026-09-30) — 서버 근거 문장 안의 긴 화물쌍 목록을 떼어 표로 보인다.
//   "같은 선박 화물끼리 혼재 충돌 11쌍(A↔B, C↔D, …) — 격리 적재 확인 필요"
//     → 결론 한 줄 "같은 선박 화물끼리 혼재 충돌 11쌍 — 격리 적재 확인 필요" + 쌍 목록
// 결론 줄과 판단 사유 문장에 같은 11쌍이 두 번 줄글로 나와 읽히지 않았다(현우).
// ─────────────────────────────────────────────────────────────────────────────

// 괄호 안의 괄호(예: 2-Hydroxy-4-(methylthio)butanoic acid)까지 한 덩어리로 찾는다
const PAREN = /\((?:[^()]|\([^()]*\))*\)/g;

/** 문장에서 '↔' 가 든 괄호 목록을 떼어 낸다 → { text, pairs } */
export function stripPairs(sentence) {
  const pairs = [];
  const text = String(sentence || '').replace(PAREN, (m) => {
    if (!m.includes('↔')) return m;
    m.slice(1, -1).split(/,\s+/).forEach((p) => {
      const [a, b] = p.split('↔').map((x) => x.trim());
      if (a && b) pairs.push([a, b]);
    });
    return '';
  }).replace(/\s{2,}/g, ' ').replace(/\s+([—.,])/g, ' $1').replace(/ \./g, '.').trim();
  return { text, pairs };
}

/**
 * 쌍을 화물별로 묶는다 — 가장 많이 걸린 화물부터 한 줄에 상대 화물을 모은다.
 * 11쌍이 보통 서너 줄이 된다. 같은 쌍은 한 번만 나온다.
 */
export function groupPairs(pairs) {
  const left = pairs.map(([a, b]) => [a, b]);
  const rows = [];
  while (left.length) {
    const count = new Map();
    left.forEach(([a, b]) => { count.set(a, (count.get(a) || 0) + 1); count.set(b, (count.get(b) || 0) + 1); });
    const [head] = [...count.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]), 'ko'))[0];
    const partners = [];
    for (let i = left.length - 1; i >= 0; i -= 1) {
      const [a, b] = left[i];
      if (a === head || b === head) { partners.unshift(a === head ? b : a); left.splice(i, 1); }
    }
    rows.push({ cargo: head, partners });
  }
  return rows;
}
