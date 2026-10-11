import { useLocation, useNavigate } from 'react-router-dom';
import { FaShip, FaMapMarkerAlt, FaClipboardCheck, FaCube, FaLock, FaLockOpen, FaTimes, FaSearch } from 'react-icons/fa';
import useSensorStore from '../../stores/useSensorStore';
import useVesselThread from '../../hooks/useVesselThread';
import VesselPicker from './VesselPicker';

// ─────────────────────────────────────────────────────────────────────────────
// 선박 추적 띠 (2026-09-29 밤)
//
// 배 한 척을 고르면 그 배가 다섯 화면에서 각각 어떤 상태인지 한 줄로 보인다.
//   위치(대시보드) → 판정(선박 판정 — 선석 · 기상 · 혼재) → 현장(3D 관제) → 게이트(현장 설비)
//   [2026-09-30] 혼재 칸은 판정 칸에 합쳤다(메뉴 넷 = 띠 네 칸). 벗어난 판정은 '주의 · 혼재'처럼 원인 축을 같이 적는다.
// 칸을 누르면 그 화면으로 가서 같은 배를 비춘다. 설명 글이 아니라 자리와 색으로 흐름을 보인다.
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_TEXT = { 입항전: '입항 전', 접안직전: '접안 직전', 하역중: '하역 중' };

const STEPS = [
  { key: 'where', path: '/', label: '위치', icon: FaMapMarkerAlt },
  { key: 'verdict', path: '/arrivals', label: '판정', icon: FaClipboardCheck },
  { key: 'scene', path: '/twin', label: '현장', icon: FaCube },
  { key: 'gate', path: '/sensors', label: '게이트', icon: FaLock },
];

export default function VesselTrail() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tracked = useSensorStore((s) => s.trackedVessel);
  const trackVessel = useSensorStore((s) => s.trackVessel);
  const setSelectedVessel = useSensorStore((s) => s.setSelectedVessel);
  const requestThreadFocus = useSensorStore((s) => s.requestThreadFocus);
  const { thread } = useVesselThread();
  const finding = useSensorStore((s) => s.pickerOpen);
  const setFinding = useSensorStore((s) => s.setPickerOpen);

  const go = (step) => {
    if (step.key !== 'where') setSelectedVessel(null);   // 상세 패널이 다른 화면을 덮지 않게(추적은 그대로)
    if (thread) requestThreadFocus(step.key);
    if (step.key === 'where' && thread?.traffic) setSelectedVessel(thread.traffic);
    if (step.key === 'scene' && thread?.berth) {
      navigate(`/twin?berth=${encodeURIComponent(thread.berth)}`);
      return;
    }
    navigate(step.path);
  };

  // 선박 찾기에서 고르면 추적하고, 대시보드에 있으면 지도가 그 배로 간다
  const pick = (v) => {
    trackVessel(v);
    setFinding(false);
    if (pathname === '/') requestThreadFocus('where');
  };

  return (
    <div className={`vessel-trail${thread ? ' on' : ''}`} role="navigation" aria-label="선박 추적">
      <div className="trail-vessel">
        <span className="trail-ship"><FaShip /></span>
        {thread ? (
          <div className="trail-name">
            <strong title={thread.callsgn}>{thread.name}</strong>
            <span>{[thread.berth, STAGE_TEXT[thread.stage]].filter(Boolean).join(' · ') || thread.callsgn}</span>
          </div>
        ) : null}
        <button
          type="button"
          className={`trail-find${finding ? ' open' : ''}`}
          onClick={() => setFinding(!finding)}
          aria-expanded={finding}
          aria-haspopup="dialog"
        >
          <FaSearch aria-hidden="true" /> {thread ? '다른 선박' : '선박 찾기'}
        </button>
        {thread && (
          <button type="button" className="trail-clear" onClick={() => trackVessel(null)} title="선택 해제" aria-label="선택 해제">
            <FaTimes />
          </button>
        )}
      </div>

      {finding && <VesselPicker current={tracked?.callsgn} onPick={pick} onClose={() => setFinding(false)} />}

      <ol className="trail-steps">
        {STEPS.map((step, i) => {
          const st = thread?.steps[step.key];
          const here = step.path === '/' ? pathname === '/' : pathname.startsWith(step.path);
          const Icon = step.key === 'gate' && st?.value === '해제' ? FaLockOpen : step.icon;
          return (
            <li key={step.key}>
              {i > 0 && <span className="trail-link" aria-hidden="true" />}
              <button
                type="button"
                className={`trail-step tone-${st?.tone || 'none'}${here ? ' here' : ''}`}
                onClick={() => go(step)}
                aria-current={here ? 'step' : undefined}
              >
                <span className="trail-dot"><Icon /></span>
                <span className="trail-text">
                  <em>{step.label}</em>
                  {thread && <strong>{st.value}</strong>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
