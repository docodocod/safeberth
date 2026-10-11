import { COLORS } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// 에이전트 배지 — "이 패널의 판정은 어느 에이전트가 낸 것인가"를 화면에 밝힌다.
//
// 협상 로그에는 네 에이전트가 이름·색으로 구분돼 나오는데, 정작 각 패널에는
// 그 표시가 없어서 "선석별 하역 판정이 기상 에이전트 결과"라는 연결을 화면만
// 봐서는 알 수 없었다(2026-08-17 피드백). 색은 AgentConsole 의 AGENTS 와 동일.
// ─────────────────────────────────────────────────────────────────────────────
export const AGENT_BADGE = {
  weather: { label: '기상 에이전트', color: '#1E6FA8' },
  scheduling: { label: '선석 검증 에이전트', color: '#5B3E9B' },
  safety: { label: '안전 에이전트', color: '#B26A00' },
  orchestrator: { label: '종합 오케스트레이터', color: COLORS.teal },
};

export default function AgentChip({ agent }) {
  const a = AGENT_BADGE[agent];
  if (!a) return null;
  return (
    <span
      title={`이 판정은 ${a.label}가 냅니다 — 판단 과정 로그의 같은 색 단계와 동일한 판단`}
      style={{
        fontSize: '10.5px', fontWeight: 800, color: a.color,
        border: `1px solid ${a.color}`, borderRadius: '20px',
        padding: '1px 8px', marginLeft: '8px', whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      }}
    >
      {a.label}
    </span>
  );
}
