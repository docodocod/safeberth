import { useMemo, useRef, useLayoutEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import Port from '../Port';
import { ONSAN_BERTHS_3D, bayShift, shoreShift } from '../../../utils/geoUtils';

// ─────────────────────────────────────────────
// 트윈 카메라 — 부두 CCTV 자리에서 본 3D 트윈 (2026-09-28)
//
// 예전 CCTV 창은 SVG 로 그린 가상 부두(늘 같은 그림)였다. 이제는 같은 3D 트윈을
// 그 부두 옆 카메라 위치에서 작은 창으로 한 번 더 렌더링한다 — 실제 선박 위치·선석
// 색·시각 조명이 그대로 보이므로 "지금 그 부두"가 된다. 실제 CCTV 영상은 없다는
// 사실은 창의 라벨("트윈 카메라 · CCTV 영상 없음")이 밝힌다.
//
// 성능: 400×240 · dpr 1 · 그림자 없음 · 후처리 없음. 큰 장면과 같은 Port 를 두 번
// 그리지만 창이 작아 비용은 작다. 야간 톤은 CSS 필터(부모)가 맡는다.
// ─────────────────────────────────────────────

function cameraFor(berthId) {
  const b = ONSAN_BERTHS_3D[berthId];
  if (!b) return { pos: [0, 40, 0], look: [0, 0, 0] };
  // 카메라는 잔교 뒤 육지(만 반대쪽으로 -48)에서 해안을 따라 34 옆, 높이 26 — 부두 조명탑에 단 CCTV 자리.
  // 배가 서는 계류 지점(b.moor)을 비스듬히 내려다본다.
  const base = bayShift(shoreShift(b.pos, 34), -48);
  const look = b.moor;
  return { pos: [base[0], 26, base[1]], look: [look[0], 4, look[1]] };
}

function TwinCamera({ berthId }) {
  const { pos, look } = useMemo(() => cameraFor(berthId), [berthId]);
  const ref = useRef();
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.position.set(...pos);
    ref.current.lookAt(new THREE.Vector3(...look));
    ref.current.updateProjectionMatrix();
  }, [pos, look]);
  return <PerspectiveCamera ref={ref} makeDefault fov={44} near={1} far={1500} position={pos} />;
}

export default function CctvTwinView({ berthId, hour: hourProp }) {
  // 점검용: ?cctv_day=1 이면 낮 조명으로 그린다(밤에 카메라 위치를 확인할 때)
  const forceDay = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('cctv_day');
  const hour = forceDay ? 13 : hourProp;
  const isNight = hour < 6 || hour > 18;
  const sunAngle = ((hour - 6) / 12) * Math.PI;
  const sunIntensity = isNight ? 0 : Math.max(Math.sin(sunAngle), 0) * 1.6;
  return (
    <div className="cctv-twin" style={{ position: 'absolute', inset: 0 }}>
      {/* 큰 장면의 이름표(drei Html)는 화면 크기 고정이라 작은 창에서는 화면을 덮는다 — 이 창에서는 숨긴다 */}
      <style>{`.cctv-twin > div > div > div { display: none !important; }`}</style>
    <Canvas
      dpr={1}
      shadows={false}
      frameloop="always"
      gl={{ antialias: true, alpha: false, powerPreference: 'low-power' }}
      style={{ position: 'absolute', inset: 0, background: '#0a1628' }}
      onCreated={(s) => s.gl.setClearColor('#0a1628')}
    >
      <color attach="background" args={[isNight ? '#0a1628' : '#4b6f93']} />
      <fog attach="fog" args={[isNight ? '#0a1628' : '#4b6f93', 120, 700]} />
      <ambientLight intensity={isNight ? 0.42 : 0.55} color="#b0c4de" />
      <hemisphereLight skyColor="#4a7aad" groundColor="#1a2a3a" intensity={isNight ? 0.15 : 0.4} />
      {!isNight && <directionalLight position={[Math.cos(sunAngle) * 800, Math.sin(sunAngle) * 800, -400]} intensity={sunIntensity} color="#fff5e6" />}
      {isNight && <directionalLight position={[-500, 400, 500]} intensity={0.45} color="#38bdf8" />}
      <TwinCamera berthId={berthId} />
      {/* 바다 — 큰 장면의 셰이더 대신 평면 한 장 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color={isNight ? '#0d2238' : '#1f4d6e'} roughness={0.35} metalness={0.1} />
      </mesh>
      <Port />
    </Canvas>
    </div>
  );
}
