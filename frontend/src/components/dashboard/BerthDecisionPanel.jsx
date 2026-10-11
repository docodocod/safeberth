import useSensorStore from '../../stores/useSensorStore';
import { COLORS } from '../../utils/constants';
import AgentChip from '../../utils/AgentChip';
import { FaRoute, FaAnchor, FaShip, FaCheck, FaHourglassHalf } from 'react-icons/fa';

// 전용 → 대체 → 정박지대기 판단 경로 시각화 (오케스트레이터 berth_decision.trace)
const STATUS_STYLE = {
  APPROVED: { color: COLORS.teal, label: '적합 — 배정 선석 유지' },
  WAITING_ANCHORAGE: { color: COLORS.yellow, label: '정박지 대기' },
  REJECTED: { color: COLORS.red, label: '반려' },
  PENDING: { color: COLORS.info, label: '대기' },
};

const PATH_LABEL = { '전용': '전용 선석 배정', '대체': '같은 운영사 대체 배정', '정박지대기': '정박지 대기' };

export default function BerthDecisionPanel() {
  const result = useSensorStore((s) => s.orchestration);
  const style = STATUS_STYLE[result?.status] || { color: COLORS.textDim, label: result?.status };
  const decision = result?.berth_decision;

  return (
    <div className="glass-card">
      <div className="glass-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="glass-card-title">
          <FaRoute style={{ marginRight: '8px', color: COLORS.teal }} />선석 배정 시뮬레이션 — 전용 → 대체 → 정박지 대기<AgentChip agent="orchestrator" />
        </h3>

      </div>

      {/* 판정 진입점은 우하단 '에이전트 협상 로그' 콘솔 하나로 통일했다.
          (같은 판단을 세 패널에서 각각 실행하던 중복 버튼 제거 — 2026-07-27)
          이 패널은 그 결과 중 '선석 배정 경로'만 자세히 보여준다. */}
      {!result && (
        <div style={{
          padding: '14px 16px', background: COLORS.card, borderRadius: '10px',
          fontSize: '13px', color: COLORS.textSecondary, lineHeight: 1.7, marginBottom: '12px',
        }}>
          우하단 <strong style={{ color: COLORS.teal }}>에이전트 판단 과정</strong>에서 선박을 고르고
          <strong style={{ color: COLORS.teal }}> 종합 판정</strong>을 실행하면
          선석 → 기상 → 혼재 판단 결과가 여기에 표시됩니다.
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* 결과 카드 */}
          <div style={{
            minWidth: '230px', padding: '20px 22px', background: COLORS.card,
            border: `2px solid ${style.color}`, borderRadius: '12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '28px', fontWeight: 800, color: style.color, lineHeight: 1.2 }}>{style.label}</div>
            <div style={{ fontSize: '13px', color: COLORS.textPrimary, marginTop: '6px', display: 'flex', justifyContent: 'center', gap: '6px', alignItems: 'center' }}>
              {result.berth_assigned
                ? <><FaShip color={COLORS.teal} /> {result.berth_assigned}</>
                : result.anchorage
                  ? <><FaAnchor color={COLORS.yellow} /> {result.anchorage}</>
                  : null}
            </div>
            {decision?.path && (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '4px' }}>
                경로: {PATH_LABEL[decision.path] || decision.path}
              </div>
            )}
            {result.risk_level && (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '2px' }}>
                안전등급 {result.risk_level} · 기상 {result.weather_grade}
              </div>
            )}
            {!result.risk_level && result.weather_grade && (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, marginTop: '2px' }}>기상 {result.weather_grade}</div>
            )}
          </div>

          {/* 판단 경로 타임라인 */}
          <div style={{ flex: 1, minWidth: '280px' }}>
            {decision?.trace?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {decision.trace.map((step, i) => {
                  const last = i === decision.trace.length - 1;
                  return (
                    <div key={i} style={{ display: 'flex', gap: '12px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{
                          width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0,
                          background: COLORS.card, border: `2px solid ${last ? style.color : COLORS.info}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: last ? style.color : COLORS.info, fontSize: '11px',
                        }}>
                          {last ? <FaCheck /> : <FaHourglassHalf />}
                        </div>
                        {!last && <div style={{ width: '2px', flex: 1, minHeight: '14px', background: COLORS.border }} />}
                      </div>
                      <div style={{ fontSize: '14px', color: COLORS.textPrimary, paddingBottom: '14px', lineHeight: 1.6 }}>
                        <span style={{ color: COLORS.textDim, marginRight: '8px' }}>{i + 1}단계</span>
                        {step}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              // 오케스트레이터 응답 필드는 summary 다(reason 은 존재한 적 없다) —
              // trace 가 비면 빈 칸만 남던 자리
              <div style={{ fontSize: '13px', color: COLORS.textSecondary, lineHeight: 1.7 }}>
                {result.summary || '판단 경로가 반환되지 않았습니다.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
