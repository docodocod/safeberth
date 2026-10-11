import { useEffect, useState } from 'react';
import { FaTimes } from 'react-icons/fa';
import useSafetyIndex from '../../hooks/useSafetyIndex';
import SafetyGraph from '../safety/SafetyGraph';

// ─────────────────────────────────────────────────────────────────────────────
// 항만 안전 지수 — 사이드바 요약 (2026-09-30)
//
// 다차원 안전 평가 지수는 항만 전체 요약이라 어느 화면에서나 보여야 한다. 화물 혼재 심사 화면을 선박 판정에
// 합치며 대시보드 맨 아래로 옮겼더니 찾기 어려웠다(현우). 메뉴 아래 빈 자리에 종합 점수와 다섯 축을 늘 띄우고,
// 누르면 차트와 축별 근거가 열린다.
// ─────────────────────────────────────────────────────────────────────────────

const toneOf = (score) => (score == null ? 'none' : score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad');

export default function SafetyIndexMini({ collapsed }) {
  const { axes, overall, error } = useSafetyIndex();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ready = axes.length > 0;
  return (
    <>
      <button
        type="button"
        className={`si-mini tone-${toneOf(overall)}${collapsed ? ' collapsed' : ''}`}
        onClick={() => setOpen(true)}
        aria-label={`항만 안전 지수 ${overall ?? '계산 중'} — 자세히`}
        title={collapsed ? `항만 안전 지수 ${overall ?? '계산 중'}` : undefined}
      >
        {collapsed ? (
          <span className="si-score">{overall != null ? Math.round(overall) : '…'}</span>
        ) : (
          <>
            <span className="si-head">
              <em>항만 안전 지수</em>
              <span className="si-score">{overall ?? (error ? '—' : '…')}</span>
            </span>
            {ready ? (
              <span className="si-axes">
                {axes.map((a) => (
                  <span key={a.subject} className={`si-axis tone-${toneOf(a.score)}`}>
                    <i>{a.subject}</i>
                    <span className="si-bar"><b style={{ width: `${a.score ?? 0}%` }} /></span>
                    <u>{a.score == null ? '—' : Math.round(a.score)}</u>
                  </span>
                ))}
              </span>
            ) : (
              <span className="si-wait">{error ? '불러오지 못함' : '계산 중'}</span>
            )}
          </>
        )}
      </button>

      {open && (
        <div className="si-modal" role="dialog" aria-modal="true" aria-label="다차원 안전 평가 지수" onClick={() => setOpen(false)}>
          <div className="si-modal-body" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="si-close" onClick={() => setOpen(false)} aria-label="닫기"><FaTimes /></button>
            <SafetyGraph />
          </div>
        </div>
      )}
    </>
  );
}
