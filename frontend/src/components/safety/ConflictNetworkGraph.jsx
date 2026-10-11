import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FaSearchPlus } from 'react-icons/fa';
import { COLORS } from '../../utils/constants';

// 통합 추론 그래프 (2026-09-29) — 이웃 화물 충돌을 한 장에.
//
// 예전 ReasoningGraph 는 (우리 화물 ↔ 이웃 화물 하나) 쌍마다 따로 그려서, 여러 이웃이 같은 이유로
// 얽혀 있다는 게 보이지 않았다(사용자 지적). 지식그래프가 실제로 밟는 경로 그대로 그린다:
//   우리 화물 ─IN_COMPATIBILITY_GROUP→ 우리 그룹 ─INCOMPATIBLE_WITH_GROUP→ 상대 그룹 ←─ 이웃 화물들
// 호환성 그룹 없이 MSDS 로만 걸린 이웃은 'MSDS 상극' 노드로 묶어 우리 화물에서 바로 잇는다.
// 새로 계산하지 않는다 — useOnsanApi.mapSafety() 가 옮겨 둔 gate.detail(msds/bulk)만 그린다.
// IMDG 는 부두 간 판정에 쓰지 않는 참고값이라 그리지 않는다.

// 46 CFR 150 Table I 그룹 — 영문 그룹명 대신 쓸 우리말(없으면 영문 그대로)
const GROUP_KO = {
  1: '비산화성 무기산', 2: '황산', 3: '질산', 4: '유기산', 5: '가성 알칼리', 6: '암모니아',
  7: '지방족 아민', 8: '알칸올아민', 9: '방향족 아민', 10: '아미드', 11: '유기 무수물',
  12: '이소시아네이트', 13: '비닐 아세테이트', 14: '아크릴레이트', 15: '치환 알릴',
  16: '알킬렌 옥사이드', 17: '에피클로로히드린', 18: '케톤', 19: '알데히드', 20: '알코올·글리콜',
  21: '페놀·크레졸', 22: '카프로락탐 용액', 30: '올레핀', 31: '파라핀', 32: '방향족 탄화수소',
  33: '탄화수소 혼합물', 34: '에스테르', 35: '비닐 할라이드', 36: '할로겐화 탄화수소', 37: '니트릴',
  38: '이황화탄소', 39: '설포란', 40: '글리콜 에테르', 41: '에테르', 42: '니트로 화합물', 43: '기타 수용액',
};
const groupLabel = (no, name) => `그룹 ${no} · ${GROUP_KO[Number(no)] || name || ''}`;

function joinBerths(berths) {
  const byWharf = new Map();
  for (const b of new Set(berths)) {
    const m = b.match(/^(.+?)-(\d+)선석$/);
    const w = m ? m[1] : b;
    if (!byWharf.has(w)) byWharf.set(w, []);
    if (m) byWharf.get(w).push(Number(m[2]));
  }
  return [...byWharf].map(([w, nos]) => (nos.length ? `${w} ${nos.sort((a, b) => a - b).join('·')}선석` : w)).join(', ');
}

// hit gate 들 → { targetGroups, clusters: [{ key, label, fromTargetGroup, neighbors: [{name, berths, msds}] }] }
function buildModel(hits) {
  const neighbors = new Map();   // 이웃 화물명 → {name, berths[], msds, bulk}
  for (const g of hits) {
    const d = g.detail;
    if (!d) continue;
    if (!neighbors.has(d.adjacentCargoName)) {
      neighbors.set(d.adjacentCargoName, { name: d.adjacentCargoName, berths: [], msds: null, bulk: null });
    }
    const n = neighbors.get(d.adjacentCargoName);
    n.berths.push(d.adjacentBerth);
    if (d.msds?.hit) n.msds = d.msds;
    if (d.bulk?.hit) n.bulk = d.bulk;
  }
  const targetGroups = new Map();
  const clusters = new Map();
  for (const n of neighbors.values()) {
    const node = { name: n.name, berths: joinBerths(n.berths), msds: Boolean(n.msds) };
    if (n.bulk) {
      const tg = n.bulk.targetGroup;
      targetGroups.set(tg, groupLabel(tg, n.bulk.targetGroupName));
      const key = `g${n.bulk.adjacentGroup}`;
      if (!clusters.has(key)) {
        clusters.set(key, { key, label: groupLabel(n.bulk.adjacentGroup, n.bulk.adjacentGroupName), from: tg, edge: '불호환', neighbors: [] });
      }
      clusters.get(key).neighbors.push(node);
    } else if (n.msds) {
      const key = `m${n.msds.category}`;
      if (!clusters.has(key)) {
        clusters.set(key, { key, label: `MSDS 상극 · ${n.msds.category}`, from: null, edge: 'MSDS 상극', neighbors: [] });
      }
      clusters.get(key).neighbors.push({ ...node, msds: false });
    }
  }
  return { targetGroups: [...targetGroups], clusters: [...clusters.values()] };
}

export default function ConflictNetworkGraph({ targetBerth, targetCargo, hits }) {
  const [zoomed, setZoomed] = useState(false);
  const { targetGroups, clusters } = buildModel(hits);
  if (!clusters.length) return null;

  // 좌표 — 4열: 우리 화물 | 우리 그룹 | 상대 그룹(또는 MSDS 상극) | 이웃 화물
  const colX = [16, 232, 448, 664], boxW = 190, boxH = 46, rowGap = 12, clusterGap = 18, top = 30;
  let y = top;
  const placed = clusters.map((c) => {
    const rows = c.neighbors.map((n) => { const r = { ...n, y }; y += boxH + rowGap; return r; });
    const cy = (rows[0].y + rows[rows.length - 1].y) / 2;
    y += clusterGap - rowGap;
    return { ...c, rows, y: cy };
  });
  const viewW = 870, viewH = Math.max(y, top + boxH * 2) + 10;
  const midY = (top + viewH - 10 - boxH) / 2;
  const tgY = new Map(targetGroups.map(([no], i) => [no, midY + (i - (targetGroups.length - 1) / 2) * (boxH + rowGap)]));

  const font = { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif' };
  const Box = ({ x, yy, caption, value, color, fill = COLORS.card, tag }) => (
    <g style={font}>
      <rect x={x} y={yy} width={boxW} height={boxH} rx="9" fill={fill} stroke={color} strokeWidth="1.5" />
      <text x={x + 11} y={yy + 17} fontSize="9.5" fontWeight="700" fill={color}>{caption}</text>
      <text x={x + 11} y={yy + 35} fontSize="12" fontWeight="700" fill={COLORS.textPrimary}>
        {value.length > 17 ? `${value.slice(0, 16)}…` : value}
      </text>
      {tag && <text x={x + boxW - 8} y={yy + 17} textAnchor="end" fontSize="9" fontWeight="700" fill={COLORS.red}>{tag}</text>}
    </g>
  );
  const edge = (x1, y1, x2, y2, color, dash, label, id) => {
    const mx = (x1 + x2) / 2;
    return (
      <g key={id}>
        <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} stroke={color} strokeWidth="1.7"
          strokeDasharray={dash ? '5 4' : undefined} fill="none" />
        {label && <text x={mx} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="10" fontWeight="700" fill={color} style={font}>{label}</text>}
      </g>
    );
  };

  const cargoY = midY;
  const n = placed.reduce((s, c) => s + c.rows.length, 0);
  const aria = `${targetBerth}의 ${targetCargo}이(가) 이웃 화물 ${n}종과 충돌 — ${placed.map((c) => `${c.label}: ${c.rows.map((r) => r.name).join(', ')}`).join(' / ')}`;

  const Diagram = () => (
    <svg viewBox={`0 0 ${viewW} ${viewH}`} role="img" aria-label={aria} style={{ display: 'block', width: '100%', height: 'auto' }}>
      {['우리 화물', '호환성 그룹', '상대 그룹', '이웃 화물 (선석)'].map((t, i) => (
        <text key={t} x={colX[i] + boxW / 2} y={16} textAnchor="middle" fontSize="10" fontWeight="700" fill={COLORS.textDim} style={font}>{t}</text>
      ))}
      {/* 우리 화물 → 우리 그룹 */}
      {targetGroups.map(([no]) => edge(colX[0] + boxW, cargoY + boxH / 2, colX[1], tgY.get(no) + boxH / 2, COLORS.info, false, '소속', `tg${no}`))}
      {/* 우리 그룹 → 상대 그룹(불호환) / 우리 화물 → MSDS 상극 */}
      {placed.map((c) => (c.from != null
        ? edge(colX[1] + boxW, tgY.get(c.from) + boxH / 2, colX[2], c.y + boxH / 2, COLORS.red, true, c.edge, `x${c.key}`)
        : edge(colX[0] + boxW, cargoY + boxH / 2, colX[2], c.y + boxH / 2, COLORS.red, true, c.edge, `x${c.key}`)))}
      {/* 상대 그룹 ← 이웃 화물 */}
      {placed.flatMap((c) => c.rows.map((r) => edge(colX[2] + boxW, c.y + boxH / 2, colX[3], r.y + boxH / 2, COLORS.textDim, false, null, `n${c.key}${r.name}`)))}

      <Box x={colX[0]} yy={cargoY} caption={targetBerth || '대상 선석'} value={targetCargo || '대상 화물'} color={COLORS.navy} />
      {targetGroups.map(([no, label]) => <Box key={no} x={colX[1]} yy={tgY.get(no)} caption="46 CFR 150" value={label} color={COLORS.purple} />)}
      {placed.map((c) => (
        <Box key={c.key} x={colX[2]} yy={c.y} caption={c.from != null ? '46 CFR 150 · 불호환' : 'MSDS'} value={c.label}
          color={COLORS.red} fill="rgba(196, 50, 46, 0.05)" />
      ))}
      {placed.flatMap((c) => c.rows.map((r) => (
        <Box key={`${c.key}${r.name}`} x={colX[3]} yy={r.y} caption={r.berths} value={r.name} color={COLORS.navy}
          tag={r.msds ? 'MSDS 상극도' : null} />
      )))}
    </svg>
  );

  return (
    <figure style={{ margin: '4px 0 0' }}>
      <div style={{ position: 'relative' }}>
        <Diagram />
        <button type="button" onClick={() => setZoomed(true)} title="크게 보기" aria-label="추론 그래프 크게 보기"
          style={{
            position: 'absolute', top: 0, right: 0, width: 24, height: 24, borderRadius: '50%',
            border: `1px solid ${COLORS.border}`, background: COLORS.card, color: COLORS.textSecondary,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-in', padding: 0,
          }}>
          <FaSearchPlus size={10} />
        </button>
      </div>
      <figcaption style={{ marginTop: '6px', fontSize: '11.5px', color: COLORS.textDim, lineHeight: 1.5 }}>
        Neo4j 지식그래프 경로 — 화물이 속한 호환성 그룹끼리 불호환이면, 그 그룹의 이웃 화물이 모두 걸립니다.
      </figcaption>
      {zoomed && createPortal(
        <div role="dialog" aria-modal="true" aria-label="추론 그래프 크게 보기" onClick={() => setZoomed(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(18, 53, 79, 0.55)', zIndex: 3000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px',
          }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            position: 'relative', background: COLORS.card, borderRadius: '16px', padding: '28px 32px 20px',
            width: '100%', maxWidth: 'min(1200px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
            boxShadow: '0 24px 64px rgba(18, 53, 79, 0.35)',
          }}>
            <button type="button" onClick={() => setZoomed(false)} aria-label="닫기" style={{
              position: 'absolute', top: 14, right: 14, background: 'none', border: 'none',
              fontSize: '18px', color: COLORS.textDim, cursor: 'pointer', lineHeight: 1, padding: 4,
            }}>✕</button>
            <div style={{ fontSize: '13px', fontWeight: 700, color: COLORS.textPrimary, marginBottom: '14px' }}>
              {targetCargo} — 이웃 화물 {n}종 충돌 추론 그래프
            </div>
            <Diagram />
          </div>
        </div>,
        document.body,
      )}
    </figure>
  );
}
