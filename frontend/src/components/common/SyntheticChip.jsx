import useDashboardData from '../../hooks/useDashboardData';
import HelpTip from './HelpTip';
import { showDisclosure } from '../../utils/disclosure';

// 화물 자료가 합성이라는 표식 (2026-09-29).
//
// 화물 신고 원문은 공공데이터로 공개되지 않는다. 그래서 화물은 PORT-MIS 의 실제 선종을 기준으로
// 규칙에 따라 만든 값이다(전 행 is_synthetic). 2026-08-23 에는 "표식은 화면에 두지 않고 보고서
// 한계점 절이 맡는다"고 정했는데, 9월 들어 화면이 실제 배·실제 선석을 그대로 쓰게 되면서 화물만
// 만든 값이라는 사실이 화면에서 보이지 않게 됐다. 칩 하나로 밝히고 설명은 (?)에 둔다.
// 서버가 내려준 화물이 전부 합성일 때만 뜬다 — 실제 신고가 연결되면 저절로 사라진다.
export default function SyntheticChip({ align = 'left' }) {
  const { data } = useDashboardData();
  if (!showDisclosure() || !data?.cargo_all_synthetic) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 6, verticalAlign: 'middle' }}>
      <span style={{
        fontSize: 10.5, fontWeight: 800, lineHeight: 1.5, color: '#5F6F78',
        border: '1px dashed #9AA8B0', borderRadius: 4, padding: '0 6px', whiteSpace: 'nowrap',
      }}
      >
        합성 자료
      </span>
      <HelpTip title="화물은 합성 자료입니다" align={align}>
        <div>화물 신고 원문은 공개되지 않습니다. 화면의 화물은 PORT-MIS 의 실제 선종을 기준으로 규칙에 따라 만든 값이며, 실제 적재 화물과 다를 수 있습니다.</div>
        <div style={{ marginTop: 4 }}>선박 · 위치 · 선석 · 입출항 신고 · 기상 · 조위는 실제 자료입니다. 화물 신고가 연결되면 이 표식은 사라집니다.</div>
      </HelpTip>
    </span>
  );
}
