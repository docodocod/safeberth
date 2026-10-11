import { useEffect, useRef, useState } from 'react';
import { FaTimes, FaPlay, FaPause } from 'react-icons/fa';
import useSensorStore from '../../stores/useSensorStore';

// ─────────────────────────────────────────────
// Omniverse 정밀 검토 (2026-09-28 · 2026-09-29 밤 다시)
//
// 시연 PC 에서는 Omniverse(Isaac Sim)를 실시간으로 켜지 않는다(고사양 · 발열). 대신 Omniverse 에서
// 녹화한 영상을 재생한다 — public/omniverse/precision_review.mp4 가 있으면 그것을 튼다.
// 영상이 아직 없으면 같은 장면의 두 시점(접안 직전 → 저조)을 시간축으로 이어 재생한다.
// 글은 줄였다: 어느 배 · 어느 선석인지와 그 시각의 판정 · 흘수 여유만 보인다(현우 — 글이 많아 장면이 안 보였다).
// ─────────────────────────────────────────────

const VIDEO_SRC = '/omniverse/precision_review.mp4';

// [2026-09-30] 온산 전체 선석(조감)부터 — 현우: "어떤 선석을 보여주나? 전체 선석을 보여줘야 하지 않나"
//   Omniverse 장면은 온산 선석 11곳 전체를 재현하고, 정밀 검토는 그중 지목한 선석으로 내려가 계류 · 조위 · 흘수 여유를 본다.
//   녹화 전이라 지금은 조감 한 장(9/17 캡처, 선석 판정 색) → OTK1부두 사례 두 시점(9/28 캡처)을 잇는다.
const SCENE = {
  frames: [
    { src: '/omniverse/onsan_overview.jpg', time: '조감', stage: '온산 선석 11곳', caption: '온산 전체 선석 · 선석 판정 색', level: null, margin: null, tone: '#38bdf8' },
    { src: '/omniverse/ginga_scene_1000.jpg', time: '10:00', stage: '접안 직전', caption: 'GINGA MARGAY · OTK1부두', level: '적합', margin: '+1.08 m', tone: '#2dd4bf' },
    { src: '/omniverse/ginga_scene_1640.jpg', time: '16:40', stage: '하역 중 · 저조', caption: 'GINGA MARGAY · OTK1부두', level: '주의', margin: '+0.75 m', tone: '#fbbf24' },
  ],
};
const FRAME_MS = 4200;

function Stills() {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [tick, setTick] = useState(0);   // 0~1, 지금 시점 안에서의 진행
  const started = useRef(performance.now());

  useEffect(() => {
    if (!playing) return undefined;
    started.current = performance.now() - tick * FRAME_MS;
    let raf;
    const loop = (now) => {
      const t = (now - started.current) / FRAME_MS;
      if (t >= 1) {
        started.current = now;
        setTick(0);
        setIdx((i) => (i + 1) % SCENE.frames.length);
      } else {
        setTick(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const cur = SCENE.frames[idx];
  return (
    <>
      <div style={{ position: 'relative', aspectRatio: '1280 / 440', background: '#000', overflow: 'hidden' }}>
        {SCENE.frames.map((f, i) => (
          <img
            key={f.src} src={f.src} alt={`${f.time} ${f.level}`}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
              opacity: i === idx ? 1 : 0, transition: 'opacity 0.9s ease',
            }}
          />
        ))}
        <div style={{
          position: 'absolute', left: 18, top: 16, padding: '4px 12px', borderRadius: 999,
          background: 'rgba(2, 8, 20, 0.66)', color: '#e8f0f2', fontSize: 13, fontWeight: 700,
        }}>{cur.caption}</div>
        <div style={{
          position: 'absolute', left: 18, bottom: 18, display: 'flex', alignItems: 'baseline', gap: 12,
          padding: '10px 18px', borderRadius: 10, background: 'rgba(2, 8, 20, 0.72)', backdropFilter: 'blur(6px)',
        }}>
          <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 26, fontWeight: 700, color: '#e8f0f2' }}>{cur.time}</span>
          <span style={{ fontSize: 13, color: '#cbd5e1' }}>{cur.stage}</span>
          {cur.level && <span style={{ fontSize: 22, fontWeight: 800, color: cur.tone }}>{cur.level}</span>}
          {cur.margin && <span style={{ fontSize: 15, color: '#e8f0f2' }}>흘수 여유 <b style={{ color: cur.tone }}>{cur.margin}</b></span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
        <button
          type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? '멈춤' : '재생'}
          style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid rgba(232,240,242,0.3)', background: 'rgba(232,240,242,0.08)', color: '#e8f0f2', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
        >
          {playing ? <FaPause size={12} /> : <FaPlay size={12} />}
        </button>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${SCENE.frames.length}, 1fr)`, gap: 6 }}>
          {SCENE.frames.map((f, i) => (
            <button
              key={f.time} type="button"
              onClick={() => { setIdx(i); setTick(0); started.current = performance.now(); }}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }}
            >
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(232,240,242,0.16)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${i < idx ? 100 : i === idx ? tick * 100 : 0}%`, background: f.tone }} />
              </div>
              <div style={{ marginTop: 5, fontSize: 12, color: i === idx ? '#e8f0f2' : '#94a3b8', fontWeight: i === idx ? 700 : 500 }}>
                {f.time} · {f.stage}
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export default function OmniversePreview() {
  const open = useSensorStore((s) => s.omniPreviewOpen);
  const setOpen = useSensorStore((s) => s.setOmniPreviewOpen);
  // 'checking' | 'video' | 'stills'
  const [mode, setMode] = useState('checking');

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // 녹화 영상이 배포돼 있는지 — 없으면(404 · SPA 가 html 을 돌려줌) 두 시점 재생으로 간다
  useEffect(() => {
    if (!open || mode !== 'checking') return;
    fetch(VIDEO_SRC, { method: 'HEAD' })
      .then((r) => setMode(r.ok && /video/.test(r.headers.get('content-type') || '') ? 'video' : 'stills'))
      .catch(() => setMode('stills'));
  }, [open, mode]);

  if (!open) return null;

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Omniverse 정밀 검토"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 6000, background: 'rgba(2, 8, 20, 0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1100px, 96vw)', background: '#0f172a', color: '#e8f0f2', borderRadius: 14,
          border: '1px solid rgba(56,189,248,0.4)', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
          <strong style={{ fontSize: 15 }}>정밀 검토</strong>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', border: '1px solid rgba(56,189,248,0.5)', borderRadius: 999, padding: '1px 9px' }}>Omniverse</span>
          <span style={{ fontSize: 13, color: '#cbd5e1' }}>온산 선석 전체 → 지목 선석</span>
          <button
            type="button" onClick={() => setOpen(false)} title="닫기 (Esc)" aria-label="닫기"
            style={{ marginLeft: 'auto', background: 'rgba(232,240,242,0.08)', color: '#e8f0f2', border: '1px solid rgba(232,240,242,0.25)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}
          >
            <FaTimes />
          </button>
        </div>

        {mode === 'video' && (
          <video
            src={VIDEO_SRC} autoPlay loop muted playsInline controls
            onError={() => setMode('stills')}
            style={{ display: 'block', width: '100%', aspectRatio: '16 / 9', background: '#000' }}
          />
        )}
        {mode === 'stills' && <Stills />}
        {mode === 'checking' && <div style={{ aspectRatio: '16 / 9', background: '#000' }} />}
      </div>
    </div>
  );
}
