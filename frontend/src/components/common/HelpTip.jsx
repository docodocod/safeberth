import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaQuestionCircle } from 'react-icons/fa';
import { COLORS } from '../../utils/constants';

// 도움말 — 화면에는 핵심 낱말만 두고, 설명·근거·주의는 (?) 를 눌렀을 때만 보여준다.
// 발표·관제 화면에서 긴 문장이 카드마다 붙어 읽히지 않던 문제(2026-09-27 현우 지적)의 공용 해법.
// 창은 body 에 띄운다 — 카드(.sensor-card 등)가 넘치는 내용을 잘라서, 카드 안에 두면 글이 잘렸다.
// 바깥을 누르거나 Esc 로 닫힌다. 스크롤·창 크기가 바뀌면 단추 옆으로 다시 붙는다.
export default function HelpTip({ title, children, align = 'left', width = 320, label = '도움말' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 24);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
      setPos({ left, top: r.bottom + 6, w });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={title ? `${title} ${label}` : label}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle',
          width: 22, height: 22, padding: 0, marginLeft: 6, borderRadius: '50%', flexShrink: 0,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: open ? COLORS.info : COLORS.textDim,
        }}
      >
        <FaQuestionCircle size={15} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          id={id}
          role="dialog"
          aria-label={title || label}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, width: pos.w, zIndex: 5000,
            maxHeight: `calc(100vh - ${Math.round(pos.top)}px - 12px)`, overflowY: 'auto',
            background: COLORS.card, color: COLORS.textPrimary,
            border: `1px solid ${COLORS.border}`, borderRadius: 10,
            boxShadow: '0 10px 28px rgba(16, 35, 43, 0.18)',
            padding: '12px 14px', fontSize: 12.5, fontWeight: 400, lineHeight: 1.65,
            textAlign: 'left', whiteSpace: 'normal', letterSpacing: 0,
          }}
        >
          {title && <strong style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>{title}</strong>}
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
