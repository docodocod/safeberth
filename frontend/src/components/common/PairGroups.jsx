import { COLORS } from '../../utils/constants';
import { groupPairs } from '../../utils/pairList';

/** 혼재 충돌 화물쌍 — 화물별로 묶은 표(한 줄 = 화물 하나와 걸리는 상대 화물들) */
export default function PairGroups({ title, pairs, color = COLORS.red }) {
  if (!pairs?.length) return null;
  const rows = groupPairs(pairs);
  return (
    <div className="pair-groups">
      {title && <div className="pair-groups-title">{title} <span style={{ color }}>{pairs.length}쌍</span></div>}
      <div className="pair-groups-grid">
        {rows.map((r) => (
          <div key={r.cargo} className="pair-groups-row">
            <b>{r.cargo}</b>
            <span className="pair-groups-x" style={{ color }}>↔</span>
            <span className="pair-groups-list">
              {r.partners.map((p) => <span key={p} className="pair-chip">{p}</span>)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
