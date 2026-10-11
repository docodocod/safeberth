import { showDisclosure } from '../../utils/disclosure';
import { demoTitle } from '../../utils/demoCargo';

// 시연용 주입 표식 (2026-09-29) — 현장 설비의 "시연 입력 중"과 같은 성격의 정직성 표식이다.
//   시연용 주입     이 화물은 시연을 위해 넣은 것
//   시연 주입 영향  이 판정·잠금은 가까운 선석의 주입 화물에서 나왔을 수 있음
// 밝은 화면과 어두운 HUD 양쪽에서 읽히게 보라 점선 + 옅은 바탕.
export default function DemoChip({ entries = [], derived = false, style }) {
  // [2026-09-29 밤] 시연 화면은 완성된 모습 — 표식은 ?disclose=1 일 때만(utils/disclosure)
  if (!showDisclosure()) return null;
  if (!entries.length) return null;
  return (
    <span
      title={demoTitle(entries, derived)}
      style={{
        display: 'inline-block', fontSize: 10.5, fontWeight: 800, lineHeight: 1.5,
        color: '#5B3E9B', background: '#F1ECFA', border: '1px dashed #8B6FD0',
        borderRadius: 4, padding: '0 6px', whiteSpace: 'nowrap', verticalAlign: 'middle',
        ...style,
      }}
    >
      {derived ? '시연 주입 영향' : '시연용 주입'}
    </span>
  );
}
