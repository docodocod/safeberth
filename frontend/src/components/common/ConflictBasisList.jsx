import { COLORS } from '../../utils/constants';
import { stripPairs } from '../../utils/pairList';

// 등급 근거(verdict_basis) 목록 — 선박 상세 패널·화물 혼재 심사 화면이 같이 쓴다 (2026-09-29).
//   '이웃 화물 충돌: 4부두 1·2선석 질산 — 기준A / 기준B' → '충돌 대상 — 쉬운 말 한 줄' + 작은 근거 줄.
//   백엔드가 이웃 화물당 한 줄로 묶는다(safety.service._verdict_basis). 형식이 다르면 그대로 보인다.
//   규정 원문(46 CFR 150 영문 그룹명 등)은 관제사가 읽을 말이 아니라 근거 줄에 번호만 남긴다(사용자 지적).
//   충돌이 3건을 넘으면 나머지는 접는다 — 10건이 넘는 배(질산 적재선)는 등급 아래가 목록에 묻혔다.
const PREFIX = '이웃 화물 충돌: ';

// 기준 문장들 → (쉬운 말, 짧은 근거)
function plain(reasons) {
  const cfr = reasons.find((r) => r.startsWith('46 CFR 150'));
  const msds = reasons.find((r) => r.startsWith('MSDS'));
  const what = cfr ? '섞이면 발열·가스 발생 등 격렬한 반응 위험'
    : msds ? '서로 피해야 할 물질(MSDS)' : reasons.join(' / ');
  const src = [];
  if (msds) src.push(msds.replace(/^MSDS '(.+)' 혼재금지$/, 'MSDS $1'));
  if (cfr) {
    const g = cfr.match(/\((\d+)\) ↔ .*\((\d+)\)$/);
    src.push(g ? `46 CFR 150 그룹 ${g[1]}↔${g[2]}` : cfr);
  }
  return { what, src: src.join(' · ') };
}

export default function ConflictBasisList({ basis, color, fontSize = '12.5px', showSource = true }) {
  const line = (b) => {
    const m = b.match(/^이웃 화물 충돌: (.+?) — (.+)$/);
    // [2026-09-30] '같은 선박 화물끼리 혼재 충돌 11쌍(A↔B, …)' — 결론 한 줄만. 쌍 목록은 '근거 자세히'의 표로(PairGroups)
    if (!m) return <li key={b}>{stripPairs(b).text}</li>;
    const { what, src } = plain(m[2].split(' / '));
    return (
      <li key={b}>
        <b style={{ color }}>충돌</b> {m[1]} <span style={{ color: COLORS.textSecondary }}>— {what}</span>
        {showSource && src && (
          <div style={{ fontSize: '11px', color: COLORS.textDim }}>근거 · {src}</div>
        )}
      </li>
    );
  };
  const rest = basis.filter((b) => b.startsWith(PREFIX)).slice(3);
  const shown = basis.filter((b) => !rest.includes(b));
  const ulStyle = { margin: '4px 0', paddingLeft: '16px', fontSize, lineHeight: 1.7 };
  return (
    <>
      <ul style={ulStyle}>{shown.map(line)}</ul>
      {rest.length > 0 && (
        <details style={{ marginBottom: '4px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '11.5px', color: COLORS.info, fontWeight: 600 }}>
            이웃 화물 충돌 {rest.length}건 더 보기
          </summary>
          <ul style={ulStyle}>{rest.map(line)}</ul>
        </details>
      )}
    </>
  );
}
