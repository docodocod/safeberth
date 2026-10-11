import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaSearchPlus } from 'react-icons/fa';
import { COLORS } from '../../utils/constants';
import { onsanAdjacencyDistanceM } from '../../utils/geoUtils';

const normalize = (s) => (s || '').replace(/\s+/g, '');

// 인접 화물쌍(선석+화물) 하나에 대해, MSDS(INCOMPATIBLE_WITH)·IMDG(SEGREGATE)·
// 벌크 호환성그룹(INCOMPATIBLE_WITH_GROUP, 2026-08-21 추가) 세 그래프 신호를
// 한 그림에서 같이 보여준다. 새 데이터를 계산하지 않는다 —
// useOnsanApi.mapSafety() 가 백엔드 conflicts[]/imdg_conflicts[]/
// bulk_compatibility_conflicts[] 원본 필드를 gate.detail.msds/imdg/bulk 에
// 그대로 옮겨 둔 것만 그리므로, 이 그림의 근거는 항상 옆에 있는 reason 문장과 같다.
//
// 레이아웃: 선석(ADJACENT_TO/동일 선석) → 화물(재항 중) → [MSDS 신호 행 → IMDG
// 신호 행 → 벌크그룹 신호 행](조회된 것만 순서대로 이어그림 — 실제로는 서로
// 독립 조회지만, 같은 화물에 대해 여러 그래프를 차례로 훑었다는 걸 하나의
// 추론 흐름으로 보여주기 위함) →
// 최종 판정. 각 신호 행은 세 상태 중 하나로 그린다: 충돌(빨강, 좌우 두 분류 박스 +
// 점선) / 관계없음 확정(초록, IMDG는 두 화물의 실제 Class를 좌우 박스로, MSDS는
// 화물별 분류를 몰라 가운데 박스 하나로) / 판정 근거 부족(호박, 가운데 박스 하나 —
// 그래프에 필요한 정보 자체가 없어 "안전"이라 단정하지 않는 상태). 인화점 같은
// MSDS 물성 수치는 프론트가 갖고 있지 않아 그리지 않는다 — 없는 자릿수를 지어내면
// 오히려 신뢰를 깎는다.
export default function ReasoningGraph({ targetBerth, targetCargo, gate }) {
  const uid = useId();
  const [zoomed, setZoomed] = useState(false);
  const d = gate.detail;
  if (!d) return null;

  const sameBerth = normalize(targetBerth) === normalize(d.adjacentBerth);
  const distanceM = !sameBerth ? onsanAdjacencyDistanceM(targetBerth, d.adjacentBerth) : null;
  const hasAdjacencyEdge = !sameBerth && distanceM != null;
  const berthEdgeLabel = sameBerth
    ? '동일 선석'
    : hasAdjacencyEdge
      ? (distanceM > 0 ? `인접 · 실측 ${distanceM}m` : '인접 · 동일 부두군')
      : '근접 작업 중';
  const berthEdgeColor = sameBerth || !hasAdjacencyEdge ? COLORS.textDim : COLORS.yellow;

  // 조회된 신호만 행으로 그린다 — MSDS/IMDG 둘 다 조회됐으면 두 행, 하나만
  // 알고 있으면(예: 예전 응답 형태) 한 행만 그린다.
  //
  // 신호마다 상태가 셋이다:
  //   'hit'    — 충돌 확인(빨강, 좌우 두 박스 + 점선)
  //   'safe'   — 조회했고 관계 없음이 확정됨(초록, MSDS는 박스 하나로 뭉뚱그림 —
  //              화물별 개별 분류를 프론트가 모름. IMDG는 화물마다 자기 Class가
  //              둘 다 확인됐으므로 좌우 두 박스로 실제 값을 보여줌)
  //   'unknown'— 조회는 했지만 판정 근거가 부족(호박, 박스 하나) — IMDG는 두
  //              화물 중 하나라도 그래프에 Class 자체가 없으면 "관계 없음"이
  //              공인 규정상 X인지 이 Class 조합이 안 실린 건지 구분이 안 되므로,
  //              안전하다고 단정하지 않고 이 상태로 따로 보여준다
  //              (imdg_segregation_loader.py가 9x9 전체가 아니라 실제 등재된
  //              화물의 Class만 SEGREGATE로 적재하기 때문에 생기는 간극).
  const tiers = [];
  if (d.msds) {
    const status = d.msds.hit ? 'hit' : 'safe';
    tiers.push({
      kind: 'msds', status, label: 'MSDS 반응성', classifyEdgeLabel: 'MSDS 조회',
      layout: status === 'hit' ? 'two' : 'one',
      crossLabel: status === 'hit' ? `${d.msds.category} 충돌` : '반응성 충돌 없음',
      target: status === 'hit' ? d.msds.category : null,
      adjacent: status === 'hit' ? d.msds.category : null,
      centerValue: '반응성 충돌 없음 (MSDS 확인)',
    });
  }
  // [2026-08-23] IMDG 행은 **참고**로 내렸다(status: 'ref').
  // IMDG Ch.7.2는 단일 선박 내 적부 규정이라 부두 간 배치에는 적용 대상이 아니고,
  // 백엔드도 이 맥락에서는 판정에 쓰지 않는다(compute_imdg_berth_adjacency_floor는
  // 항상 SAFE). 그런데 이 그림은 IMDG 행을 다른 축과 똑같이 그려 판정 노드로
  // 화살표를 이어, 등급이 IMDG 때문에 나온 것처럼 읽혔다(실측: 프로페인+크실렌
  // 조합의 '주의'는 실제로 "크실렌 MSDS에 기피 정보 없음"이 이유인데 화면은
  // IMDG 격리코드 2를 사유로 보여줬다).
  if (d.imdg) {
    const hit = Boolean(d.imdg.hit);
    tiers.push({
      kind: 'imdg', status: 'ref', label: 'IMDG 등급 (참고)', classifyEdgeLabel: 'IMDG 매핑',
      layout: hit ? 'two' : 'one',
      crossLabel: hit ? `격리코드 ${d.imdg.segregationCode} — 선내 적부 기준` : undefined,
      target: hit ? (d.imdg.targetClass || '분류 없음') : null,
      adjacent: hit ? (d.imdg.adjacentClass || '분류 없음') : null,
      centerValue: hit ? undefined : '부두 간 판정에는 적용되지 않는 참고 정보',
    });
  }
  // 판정 근거 부족(unassessed) — 이게 실제로 등급을 올린 축이라 그림에도 넣는다.
  if (d.unassessed) {
    tiers.push({
      kind: 'unassessed', status: 'unknown', label: '판정 가능성', classifyEdgeLabel: '근거 확인',
      layout: 'one',
      centerValue: `판정 근거 부족 — ${d.unassessed.reason}`,
    });
  }
  // 2026-08-21 추가 — 벌크 액체화학물질 호환성그룹 참고축(MSDS·IMDG와 근거가
  // 다른 세 번째 신호, backend/app/agents/safety/bulk_compatibility.py 참고).
  // 이 축만 단독으로 걸리는 조합(예: 이소시아네이트류-알코올류)이 있어 빠뜨리면
  // 위험한 조합이 이 그래프에서만 "안전"처럼 보일 수 있었다.
  if (d.bulk) {
    const status = d.bulk.hit ? 'hit' : 'safe';
    tiers.push({
      kind: 'bulk', status, label: '호환성그룹', classifyEdgeLabel: '벌크그룹 매핑',
      layout: status === 'hit' ? 'two' : 'one',
      crossLabel: status === 'hit' ? '46 CFR 150 불호환 그룹' : '호환성그룹 충돌 없음',
      target: status === 'hit' ? `${d.bulk.targetGroupName}(그룹${d.bulk.targetGroup})` : null,
      adjacent: status === 'hit' ? `${d.bulk.adjacentGroupName}(그룹${d.bulk.adjacentGroup})` : null,
      centerValue: '호환성그룹 충돌 없음(참고용)',
    });
  }
  // 'ref'(참고) 행은 판정 색에 기여하지 않는다 — 판정 근거가 아니기 때문.
  const anyHit = tiers.some((t) => t.status === 'hit');
  const anyUnknown = !anyHit && tiers.some((t) => t.status === 'unknown');
  const verdictColor = anyHit ? COLORS.red : anyUnknown ? COLORS.yellow : COLORS.teal;
  const statusColor = { hit: COLORS.red, safe: COLORS.teal, unknown: COLORS.yellow, ref: COLORS.textDim };
  const boxColor = { hit: COLORS.purple, safe: COLORS.teal, unknown: COLORS.yellow, ref: COLORS.textDim };

  // 카드 폭(width:100%, 위 주석 참고)은 그대로 두고 내부 좌표계만 줄인다 —
  // 같은 물리적 너비라도 좌표 단위당 픽셀이 늘어나 텍스트·선이 더 커 보인다
  // ("그래프 이미지 좀 키워줘" 요청, 2026-08-20). 폰트 크기·선 굵기는 그대로
  // 둬서(아래 SCALE 미적용) 상자 대비 글자가 상대적으로 더 커지는 효과도 겸한다.
  const SCALE = 0.8;
  const leftX = 70 * SCALE, rightX = 650 * SCALE, boxW = 200 * SCALE;
  const leftCx = leftX + boxW / 2;
  const rightCx = rightX + boxW / 2;
  const midX = (leftCx + rightCx) / 2;
  const centerBoxW = boxW * 1.4;
  const centerX = midX - centerBoxW / 2;

  const row1Y = 26 * SCALE, row2Y = 126 * SCALE, tierStartY = 226 * SCALE, rowStep = 100 * SCALE, boxH = 48 * SCALE;
  const tierYs = tiers.map((_, i) => tierStartY + i * rowStep);
  const verdictY = tierStartY + tiers.length * rowStep;
  const verdictH = 40 * SCALE;
  const verdictW = 260 * SCALE;
  const viewW = 920 * SCALE;
  const viewH = verdictY + verdictH + 30 * SCALE;

  const textStyle = { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif' };

  const Node = ({ x, y, caption, value, color }) => (
    <g style={textStyle}>
      <rect x={x} y={y} width={boxW} height={boxH} rx="10" fill={COLORS.card} stroke={color} strokeWidth="1.5" />
      <text x={x + 14 * SCALE} y={y + 18 * SCALE} fontSize="9.5" fontWeight="700" letterSpacing="0.4" fill={color}>{caption}</text>
      <text x={x + 14 * SCALE} y={y + 36 * SCALE} fontSize="12" fontWeight="700" fill={COLORS.textPrimary}>{value}</text>
    </g>
  );

  // 신호 행 하나의 상/하단 연결점 — 좌우 두 박스 행(hit/safe-IMDG)은 각각
  // leftCx/rightCx, 박스 하나짜리 행(safe-MSDS/unknown)은 가운데 midX로 수렴시킨다.
  const anchorX = (tier) => (tier.layout === 'two' ? { l: leftCx, r: rightCx } : { l: midX, r: midX });

  const tierSummary = tiers
    .map((t) => `${t.label} ${t.status === 'hit' ? `${t.target} / ${t.adjacent}로 분류되어 ${t.crossLabel}`
      : t.status === 'safe' ? `조회 결과 ${t.crossLabel}` : t.centerValue}`)
    .join(', ');
  const ariaLabel = `${targetBerth}의 ${targetCargo}과(와) ${d.adjacentBerth}의 ${d.adjacentCargoName} — ${tierSummary}. 두 선석은 ${berthEdgeLabel} 관계라 ${gate.rule} ${gate.name} 판정이 나왔다`;

  // idSuffix 로 markerId 를 나눈다 — 인라인용/확대 모달용 두 벌을 같은 페이지에
  // 동시에 그릴 수 있어서, 같은 id 를 두 번 쓰면 marker-end 참조가 꼬인다.
  const Diagram = ({ idSuffix }) => {
    const arrow = `rg-arrow-${uid}${idSuffix}`;
    const arrowRed = `rg-arrow-red-${uid}${idSuffix}`;
    const arrowDim = `rg-arrow-dim-${uid}${idSuffix}`;
    const arrowGreen = `rg-arrow-green-${uid}${idSuffix}`;
    const arrowYellow = `rg-arrow-yellow-${uid}${idSuffix}`;
    return (
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        role="img"
        aria-label={ariaLabel}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.info} />
          </marker>
          <marker id={arrowRed} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.red} />
          </marker>
          <marker id={arrowDim} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.textDim} />
          </marker>
          <marker id={arrowGreen} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.teal} />
          </marker>
          <marker id={arrowYellow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.yellow} />
          </marker>
        </defs>

        {/* 선석 관계 (ADJACENT_TO / 동일 선석) */}
        <path
          d={`M${leftX + boxW},${row1Y + boxH / 2} L${rightX},${row1Y + boxH / 2}`}
          stroke={berthEdgeColor} strokeWidth="1.8" strokeDasharray={sameBerth ? undefined : '5 5'} fill="none"
        />
        <text x={midX} y={row1Y + boxH / 2 - 16 * SCALE} textAnchor="middle" fontSize="10.5" fontWeight="600" fill={berthEdgeColor} style={textStyle}>
          {berthEdgeLabel}
        </text>

        {/* 선석 → 화물 */}
        <path d={`M${leftCx},${row1Y + boxH} L${leftCx},${row2Y - 8 * SCALE}`} stroke={COLORS.textDim} strokeWidth="1.6" fill="none" markerEnd={`url(#${arrowDim})`} />
        <path d={`M${rightCx},${row1Y + boxH} L${rightCx},${row2Y - 8 * SCALE}`} stroke={COLORS.textDim} strokeWidth="1.6" fill="none" markerEnd={`url(#${arrowDim})`} />
        <text x={leftCx + 34 * SCALE} y={(row1Y + boxH + row2Y) / 2} fontSize="10.5" fontWeight="600" fill={COLORS.textSecondary} style={textStyle}>재항 중</text>
        <text x={rightCx + 34 * SCALE} y={(row1Y + boxH + row2Y) / 2} fontSize="10.5" fontWeight="600" fill={COLORS.textSecondary} style={textStyle}>재항 중</text>

        {/* 노드: 선석·화물 */}
        <Node x={leftX} y={row1Y} caption="선석 · 대상" value={targetBerth} color={COLORS.info} />
        <Node x={rightX} y={row1Y} caption={sameBerth ? '선석 · 동일' : '선석 · 인접'} value={d.adjacentBerth} color={COLORS.info} />
        <Node x={leftX} y={row2Y} caption="화물" value={targetCargo} color={COLORS.navy} />
        <Node x={rightX} y={row2Y} caption="화물" value={d.adjacentCargoName} color={COLORS.navy} />

        {/* 신호 행들 — MSDS 조회 · IMDG 조회를 순서대로 이어그린다 */}
        {tiers.map((tier, i) => {
          const y = tierYs[i];
          const prevAnchor = i === 0 ? { l: leftCx, r: rightCx } : anchorX(tiers[i - 1]);
          const prevBottomY = i === 0 ? row2Y + boxH : tierYs[i - 1] + boxH;
          const cur = anchorX(tier);
          const edgeColor = tier.status === 'hit' ? COLORS.info : statusColor[tier.status];
          const marker = tier.status === 'hit' ? arrow : tier.status === 'safe' ? arrowGreen : arrowYellow;
          return (
            <g key={tier.kind}>
              {/* 이전 행 → 이 신호 행 */}
              <path d={`M${prevAnchor.l},${prevBottomY} L${cur.l},${y - 8 * SCALE}`} stroke={edgeColor} strokeWidth="1.6" fill="none" markerEnd={`url(#${marker})`} />
              <path d={`M${prevAnchor.r},${prevBottomY} L${cur.r},${y - 8 * SCALE}`} stroke={edgeColor} strokeWidth="1.6" fill="none" markerEnd={`url(#${marker})`} />
              <text x={leftCx + 46 * SCALE} y={(prevBottomY + y) / 2} fontSize="10.5" fontWeight="600" fill={edgeColor} style={textStyle}>{tier.classifyEdgeLabel}</text>

              {tier.layout === 'two' ? (
                <>
                  <path
                    d={`M${leftX + boxW},${y + boxH / 2} L${rightX},${y + boxH / 2}`}
                    stroke={statusColor[tier.status]} strokeWidth="2" strokeDasharray={tier.status === 'hit' ? '4 4' : undefined} fill="none"
                  />
                  <text x={midX} y={y + boxH / 2 - 16 * SCALE} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={statusColor[tier.status]} style={textStyle}>{tier.crossLabel}</text>
                  <Node x={leftX} y={y} caption={tier.label} value={tier.target} color={boxColor[tier.status]} />
                  <Node x={rightX} y={y} caption={tier.label} value={tier.adjacent} color={boxColor[tier.status]} />
                </>
              ) : (
                <>
                  <rect x={centerX} y={y} width={centerBoxW} height={boxH} rx="10" fill={COLORS.card} stroke={statusColor[tier.status]} strokeWidth="1.5" />
                  <text x={midX} y={y + 18 * SCALE} textAnchor="middle" fontSize="9.5" fontWeight="700" letterSpacing="0.4" fill={statusColor[tier.status]} style={textStyle}>{tier.label} · 그래프 조회</text>
                  <text x={midX} y={y + 36 * SCALE} textAnchor="middle" fontSize="12" fontWeight="700" fill={COLORS.textPrimary} style={textStyle}>{tier.status === 'safe' ? tier.crossLabel : tier.centerValue}</text>
                </>
              )}
            </g>
          );
        })}

        {/* 마지막 신호 행 → 최종 판정 */}
        <path
          d={`M${midX},${tierYs[tierYs.length - 1] + boxH} L${midX},${verdictY - 8 * SCALE}`}
          stroke={verdictColor} strokeWidth="2" strokeDasharray={verdictColor === COLORS.teal ? undefined : '4 4'} fill="none"
          markerEnd={`url(#${anyHit ? arrowRed : anyUnknown ? arrowYellow : arrowGreen})`}
        />

        {/* 판정 노드 */}
        <rect
          x={midX - verdictW / 2} y={verdictY} width={verdictW} height={verdictH} rx="9"
          fill={anyHit ? 'rgba(196, 50, 46, 0.06)' : anyUnknown ? 'rgba(178, 106, 0, 0.06)' : 'rgba(14, 124, 107, 0.06)'}
          stroke={verdictColor} strokeWidth="1.8"
        />
        {/* [2026-08-23] 판정 노드를 한 줄로 줄였다.
            예전에는 "[PASS-1] 인접 화물 혼재 검사 통과" + "INFO — 사유는 위 카드
            문구와 같음" 두 줄이었는데, 규칙 코드([PASS-1])는 내부 식별자라
            관제사에게 의미가 없고 둘째 줄은 바로 위 카드를 가리키는 안내라
            그림 안에서 읽을 이유가 없었다. 판정 이름만 남긴다. */}
        <text x={midX} y={verdictY + verdictH / 2 + 4 * SCALE} textAnchor="middle" style={textStyle} fontSize="11.5" fontWeight="700" fill={verdictColor}>
          {gate.name}
        </text>
      </svg>
    );
  };

  return (
    <figure style={{ margin: '10px 0 0' }}>
      {/* 카드 폭에 맞춰 그리면 작아서, 고정폭으로 키우는 대신(그리드 레이아웃이
          밀려나는 부작용이 있었다) 클릭하면 커지는 모달로 뺀다 — 레이아웃 트리
          밖(document.body)에 그리므로 페이지 폭에 영향을 줄 일이 없다. */}
      <div style={{ position: 'relative' }}>
        <Diagram idSuffix="" />
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title="크게 보기"
          aria-label="추론 그래프 크게 보기"
          style={{
            position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: '50%',
            border: `1px solid ${COLORS.border}`, background: COLORS.card, color: COLORS.textSecondary,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-in', padding: 0,
          }}
        >
          <FaSearchPlus size={10} />
        </button>
      </div>
      <figcaption style={{ marginTop: '8px', fontSize: '11.5px', color: COLORS.textDim, lineHeight: 1.5 }}>
        Neo4j 지식그래프 조회 결과입니다 — 옆의 사유 문장과 같은 근거를 관계로 풀어 보여줍니다.
      </figcaption>

      {zoomed && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${gate.rule} 추론 그래프 크게 보기`}
          onClick={() => setZoomed(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(18, 53, 79, 0.55)', zIndex: 3000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative', background: COLORS.card, borderRadius: '16px', padding: '28px 32px 20px',
              width: '100%', maxWidth: 'min(1100px, 92vw)', boxShadow: '0 24px 64px rgba(18, 53, 79, 0.35)',
            }}
          >
            <button
              type="button"
              onClick={() => setZoomed(false)}
              aria-label="닫기"
              style={{
                position: 'absolute', top: 14, right: 14, background: 'none', border: 'none',
                fontSize: '18px', color: COLORS.textDim, cursor: 'pointer', lineHeight: 1, padding: 4,
              }}
            >
              ✕
            </button>
            <div style={{ fontSize: '13px', fontWeight: 700, color: COLORS.textPrimary, marginBottom: '14px' }}>
              [{gate.rule}] {gate.name} — 추론 그래프
            </div>
            <Diagram idSuffix="-zoom" />
            <div style={{ marginTop: '12px', fontSize: '12px', color: COLORS.textDim }}>{gate.reason}</div>
          </div>
        </div>,
        document.body
      )}
    </figure>
  );
}
