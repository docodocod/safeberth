import { useEffect, useState } from 'react';
import { COLORS } from '../../utils/constants';
import ReasoningGraph from './ReasoningGraph';
import ConflictNetworkGraph from './ConflictNetworkGraph';
import DemoChip from '../common/DemoChip';
import { useDemoCargo } from '../../utils/demoCargo';
import ConflictBasisList from '../common/ConflictBasisList';
import PairGroups from '../common/PairGroups';
import { stripPairs } from '../../utils/pairList';
import { FaCheckCircle, FaTimesCircle, FaQuestionCircle } from 'react-icons/fa';

// ─────────────────────────────────────────────────────────────────────────────
// 혼재 심사 결과 (2026-09-30) — 예전 화물 혼재 심사 화면(SafetyGatesPanel)의 결과 부분을 그대로 떼어 냈다.
// 입력(어느 배 · 어느 선석 · 어느 이웃 화물)은 부르는 쪽(ShipCargoPanel)이 정하고, 여기는 결과만 그린다.
// ─────────────────────────────────────────────────────────────────────────────

// risk_level 4등급 (결정론: 같은 입력 = 같은 등급)
export const RISK_STYLE = {
  '안전': { color: COLORS.teal },
  '주의': { color: COLORS.yellow },
  '위험': { color: '#D2601A' },
  '배정불가': { color: COLORS.red },
};

// 판단 사유의 첫 문장 — 결론 옆에는 이것만 둔다
function firstSentence(text) {
  const t = (text || '').trim();
  if (!t) return '';
  const m = t.match(/^.*?(?:다\.|\.)(?=\s|$)/);
  const head = m ? m[0] : t;
  return head.length > 140 ? `${head.slice(0, 138)}…` : head;
}

// 충돌 카드용 — 같은 이웃 화물(chem_id)을 선석이 달라도 한 장으로. 선석은 '3부두 1·2선석'처럼 묶는다
// (백엔드 safety.service._join_berths 와 같은 표기).
function groupHitsByCargo(hits) {
  const groups = new Map();
  for (const g of hits) {
    const key = g.detail?.msds || g.detail?.bulk ? `${g.detail.adjacentCargoName}` : g.rule;
    if (!groups.has(key)) groups.set(key, { g, berths: [] });
    if (g.detail?.adjacentBerth) groups.get(key).berths.push(g.detail.adjacentBerth);
  }
  return [...groups.values()].map(({ g, berths }) => {
    const byWharf = new Map();
    for (const b of new Set(berths)) {
      const m = b.match(/^(.+?)-(\d+)선석$/);
      const w = m ? m[1] : b;
      if (!byWharf.has(w)) byWharf.set(w, []);
      if (m) byWharf.get(w).push(Number(m[2]));
    }
    const label = [...byWharf].map(([w, nos]) => (nos.length ? `${w} ${nos.sort((a, b) => a - b).join('·')}선석` : w)).join(', ');
    return { g, berths: label };
  });
}

// 왜 위험한가 — 규정 이름 대신 일어나는 일로 말한다
function plainReason(d) {
  if (d?.bulk?.hit) return '섞이면 발열·가스 발생 등 격렬한 반응이 날 수 있는 조합입니다.';
  if (d?.msds?.hit) return `물질안전보건자료(MSDS)에서 서로 피해야 할 물질('${d.msds.category}')로 분류돼 있습니다.`;
  return '같이 두어도 되는지 확인이 필요합니다.';
}

// 근거 한 줄 — 심사위원이 출처를 확인할 수 있을 만큼만
function shortBasis(d) {
  const parts = [];
  if (d?.msds?.hit) parts.push(`MSDS '${d.msds.category}' 혼재금지`);
  if (d?.bulk?.hit) parts.push(`46 CFR 150 호환성 그룹 ${d.bulk.targetGroup}↔${d.bulk.adjacentGroup}`);
  return parts.join(' · ') || '-';
}

export default function SafetyResult({ result, narrativeLoading = false, berthName, cargoName, heading = null, compact = false }) {
  const demo = useDemoCargo();
  const [showAllGates, setShowAllGates] = useState(false);
  const style = RISK_STYLE[result?.risk_level] || { color: COLORS.textDim };
  const hits = (result?.gates || []).filter((g) => g.hit);
  const passes = (result?.gates || []).filter((g) => !g.hit);

  // 추론 그래프 펼침 상태 — 결과가 바뀔 때마다 초기화한다. 히트가 하나뿐이면 바로 펼쳐 둔다.
  const [expandedGraphs, setExpandedGraphs] = useState(() => new Set());
  useEffect(() => {
    const graphable = (result?.gates || []).filter((g) => g.hit && g.detail);
    setExpandedGraphs(graphable.length === 1 ? new Set([graphable[0].rule]) : new Set());
  }, [result]);
  const toggleGraph = (rule) => setExpandedGraphs((prev) => {
    const next = new Set(prev);
    if (next.has(rule)) next.delete(rule); else next.add(rule);
    return next;
  });

  if (!result) return null;
  // [2026-09-30] 근거 문장 안의 긴 화물쌍 목록을 떼어 '근거 자세히'의 표로 — 결론 줄과 판단 사유에 같은 쌍이 두 번 줄글로 나왔다(현우)
  const basisPairs = (result.explanation?.basis || []).map((b) => stripPairs(b)).filter((x) => x.pairs.length);
  // 판단 사유는 문장별 항목으로 — 앞의 '[혼재 판정 X]' 꼬리표는 배지가 이미 보여 주고, 같은 선박 쌍 문장은 아래 표 제목이 대신한다
  const summaryLines = stripPairs(result.explanation?.summary || '').text
    .replace(/^\[[^\]]*\]\s*/, '')
    .split(/(?<=[.。])\s+(?=[가-힣A-Za-z(])/)
    .map((s) => s.trim())
    .filter((s) => s && !(basisPairs.length && /같은 선박 화물/.test(s)));
  return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {heading && <div className="sr-heading">{heading}</div>}
          {/* [2026-09-29] 등급 배지 위, 근거 글은 그 아래 전체 너비로 — 배지 오른쪽에 좁게 붙으면 충돌 줄이
              여러 번 꺾여 읽히지 않았다(사용자 지적). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
            {/* [2026-09-30] compact: 대체 선석 검토처럼 머리글에 등급이 이미 있으면 큰 배지를 다시 안 보인다 */}
            {!compact && (
              <div style={{
                padding: '10px 22px', borderRadius: '10px', border: `2px solid ${style.color}`,
                color: style.color, fontSize: '22px', fontWeight: 800, background: COLORS.card,
              }}>
                {result.risk_level}
              </div>
            )}
            {/* [2026-08-23] "혼재 룰엔진 하한 OO · 인화성 OO" 줄을 뺐다.
                · 하한: 등급을 규칙엔진이 확정하게 바뀌면서(risk_level ==
                  rule_engine_floor) 왼쪽 뱃지와 항상 같은 값이 됐다. 예전엔
                  LLM이 하한 위로 올릴 수 있어 둘을 나란히 보여줄 이유가 있었다.
                · 인화성: key_hazards에서 '인화'가 든 문장을 뽑아 앞에 "인화성"을
                  또 붙이는 구조라 "인화성 인화성 가스 폭발 위험"으로 찍혔다.
                  등급값(고인화성 등)이 오던 자리에 문장이 들어오면서 깨진 것.
                · IMDG 격리코드: 부두 간 판정 근거가 아니라 참고 정보라 제거됨. */}
            {/* [2026-09-29] 등급의 근거(코드)는 1단계(/safety/verdict)부터 바로 보인다. LLM 서술은
                화물 특성 1~2문장으로 줄였다 — 등급 설명을 맡겼더니 원인을 유해성으로 잘못 댔다.
                새 필드가 없는 응답(스냅샷)만 옛 서술을 보여준다. */}
            <div style={{ fontSize: '12px', color: COLORS.textSecondary, lineHeight: 1.6, width: '100%' }}>
              {result.explanation?.basis?.length > 0 ? (
                <>
                  {/* [2026-09-29] 이웃 충돌은 아래 카드가 같은 내용을 더 잘 보여준다(사용자 지적) — 카드가 있으면
                      여기선 뺀다. 같은 선박 충돌·근거 부족처럼 카드에 없는 줄만 남는다. */}
                  <ConflictBasisList
                    basis={hits.length ? result.explanation.basis.filter((b) => !b.startsWith('이웃 화물 충돌: ')) : result.explanation.basis}
                    color={style.color} fontSize="12.5px" showSource={false}
                  />
                  {result.explanation.needs_check?.length > 0 && (
                    <div style={{ marginTop: '4px' }}>
                      <span style={{ fontWeight: 700, color: COLORS.yellow }}>확인 필요</span>
                      {result.explanation.needs_check.map((c) => <div key={c}>· {c}</div>)}
                    </div>
                  )}
                  {result.explanation.profile && (
                    <div style={{ marginTop: '4px' }}>
                      <span style={{ fontWeight: 700 }}>화물 특성</span> · {result.explanation.profile}
                    </div>
                  )}
                </>
              ) : firstSentence(result.explanation?.summary)}
            </div>
          </div>

          {/* 등급은 확정됐고 LLM 서술만 오는 중 — 뱃지 바로 아래에 둬야
              "무엇이 끝났고 무엇이 남았는지"가 순서대로 읽힌다. */}
          {narrativeLoading && (
            <div style={{ fontSize: '12px', color: COLORS.info }}>
              위험등급은 규칙엔진으로 확정됐습니다. LLM 근거(체크리스트·판단 사유)를 생성하는 중입니다…
            </div>
          )}

          {/* [2026-09-29] 충돌 카드는 관제사·심사위원이 읽는 말로 — 예전엔 '[MSDS-1+BULK-3x30] … 동시 위반 BLOCK'
              과 규정 원문·IMDG 참고가 한 줄에 섞였다(사용자 지적). 같은 이웃 화물은 선석이 달라도 한 장으로
              묶고, 규정 코드는 맨 아래 '근거' 한 줄로만 남긴다. IMDG(판정 미반영)는 추론 그래프에서 본다. */}
          {hits.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {groupHitsByCargo(hits).map(({ g, berths }) => (
                <div key={g.rule} style={{
                  display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px',
                  background: 'rgba(255, 75, 110, 0.08)', border: '1px solid rgba(255, 75, 110, 0.3)', borderRadius: '8px',
                }}>
                  <FaTimesCircle color={COLORS.red} style={{ marginTop: '2px', flexShrink: 0 }} />
                  <div style={{ fontSize: '13px', color: COLORS.textPrimary }}>
                    <b>이웃 화물 {g.detail?.adjacentCargoName} <span style={{ fontWeight: 500, color: COLORS.textSecondary }}>({berths})</span></b>
                    <span style={{
                      marginLeft: '8px', fontSize: '11px', color: COLORS.red,
                      border: `1px solid ${COLORS.red}`, borderRadius: '4px', padding: '1px 6px',
                    }}>{g.severity === 'BLOCK' ? '같이 두면 안 됨' : '확인 필요'}</span>
                    {demo.isInjectedAt(g.detail?.adjacentCargoName, berths) && (
                      <DemoChip
                        style={{ marginLeft: 6 }}
                        entries={demo.list.filter((e) => e.cargo_name === g.detail?.adjacentCargoName)}
                      />
                    )}
                    <div style={{ color: COLORS.textSecondary, marginTop: '3px' }}>{plainReason(g.detail)}</div>
                    <div style={{ color: COLORS.textDim, fontSize: '11px', marginTop: '3px' }}>근거 · {shortBasis(g.detail)}</div>
                  </div>
                </div>
              ))}
              {/* [2026-09-29] 추론 그래프는 카드마다가 아니라 한 장으로 — 여러 이웃이 같은 호환성 그룹으로 얽힌 게
                  보이도록(사용자 지적). 쌍 단위 그래프는 '근거 자세히'의 전체 규칙 목록에 남아 있다. */}
              <details>
                <summary style={{ cursor: 'pointer', color: COLORS.info, fontSize: '12.5px', fontWeight: 700 }}>
                  추론 그래프 보기 — 이웃 화물 {groupHitsByCargo(hits).length}종이 얽힌 경로
                </summary>
                <ConflictNetworkGraph
                  targetBerth={berthName}
                  targetCargo={result.target_cargo_name || cargoName}
                  hits={hits}
                />
              </details>
            </div>
          )}

          {/* [2026-09-29] 주요 위험성 — 백엔드가 MSDS GHS 분류로 만든 줄(여러 화물이면 항목별 물질명).
              배지 옆에 펼쳐 두면 화물 5종에 12줄이 돼 화면이 늘어났다(사용자 지적) — 길면 접어 '근거 자세히'
              위에 둔다(에이전트 콘솔과 같은 규칙: 2줄 이하는 펼침). */}
          {result.explanation?.reasoning?.length > 0 && (() => {
            const lines = result.explanation.reasoning;
            const list = (
              <div style={{ fontSize: '12px', color: COLORS.textSecondary, lineHeight: 1.65, marginTop: '4px' }}>
                {lines.map((h) => <div key={h}>· {h}</div>)}
              </div>
            );
            return lines.length <= 2 ? (
              <div>
                <span style={{ fontSize: '12.5px', fontWeight: 700, color: COLORS.textSecondary }}>주요 위험성</span>
                {list}
              </div>
            ) : (
              <details>
                <summary style={{ cursor: 'pointer', color: COLORS.info, fontSize: '12.5px', fontWeight: 700 }}>
                  주요 위험성 {lines.length}건 보기
                </summary>
                {list}
              </details>
            );
          })()}

          {/* [2026-09-28] 판단 사유 전문 · 통과 규칙 · MSDS 체크리스트는 접어 둔다(현우: 설명이 과하다) */}
          <details>
          <summary style={{ cursor: 'pointer', color: COLORS.info, fontSize: '12.5px', fontWeight: 700 }}>
            근거 자세히 — 판단 사유 · 통과 규칙 {passes.length}개{result.explanation?.checklist?.length ? ` · MSDS 체크리스트 ${result.explanation.checklist.length}` : ''}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
          {summaryLines.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: COLORS.textSecondary, lineHeight: 1.65 }}>
              {summaryLines.map((s) => <li key={s}>{s}</li>)}
            </ul>
          )}
          {basisPairs.map((x) => (
            <PairGroups key={x.text} title={x.text.split(' — ')[0].replace(/\s*\d+쌍$/, '')} pairs={x.pairs} color={style.color} />
          ))}
          <button onClick={() => setShowAllGates((v) => !v)} style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', color: COLORS.info,
            cursor: 'pointer', fontSize: '12px', padding: 0,
          }}>
            {showAllGates ? '▲ 통과한 규칙 접기' : `▼ 통과한 규칙 ${passes.length}개 보기`}
          </button>
          {showAllGates && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {passes.map((g) => (
                <div key={g.rule} style={{ fontSize: '12px', color: COLORS.textSecondary, display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                  {g.severity === 'UNKNOWN'
                    ? <FaQuestionCircle color={COLORS.yellow} style={{ marginTop: '2px', flexShrink: 0 }} />
                    : <FaCheckCircle color={COLORS.teal} style={{ marginTop: '2px', flexShrink: 0, opacity: 0.6 }} />}
                  <div style={{ flex: 1 }}>
                    <span><b>{g.rule}</b> {g.name} — {g.reason}</span>
                    {g.detail && (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleGraph(g.rule)}
                          style={{
                            display: 'block', background: 'none', border: 'none', color: COLORS.info,
                            cursor: 'pointer', fontSize: '11.5px', fontWeight: 600, padding: '6px 0 0', fontFamily: 'inherit',
                          }}
                        >
                          {expandedGraphs.has(g.rule) ? '▲ 추론 그래프 접기' : '▼ 추론 그래프 보기'}
                        </button>
                        {expandedGraphs.has(g.rule) && (
                          <ReasoningGraph
                            targetBerth={berthName}
                            targetCargo={result.target_cargo_name || cargoName}
                            gate={g}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.explanation?.checklist?.length > 0 && (
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '6px' }}>
                MSDS 안전 체크리스트
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: COLORS.textSecondary, lineHeight: 1.8 }}>
                {result.explanation.checklist.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          </div>
          </details>
        </div>
  );
}
