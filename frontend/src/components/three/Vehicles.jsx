import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

// ─────────────────────────────────────────────
// 디지털트윈에서 "돌아다니며 작업하는" 요소들:
// 임항도로의 탱크로리, 만 안의 항만 순찰정, SPM 부이에 계류한 원유운반선.
// 모두 장식용(비인터랙티브)이며 데이터와 무관하게 순환 기동한다.
// ─────────────────────────────────────────────

// 폴리라인 경로 샘플러: 누적거리 d → 위치/진행방향
export function makePath(points) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[i + 1];
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.01) continue;
    segs.push({ x1, z1, x2, z2, len, start: total });
    total += len;
  }
  const sample = (d) => {
    const dd = Math.max(0, Math.min(total, d));
    const seg = segs.find((s) => dd <= s.start + s.len) || segs[segs.length - 1];
    const t = (dd - seg.start) / seg.len;
    return {
      x: seg.x1 + (seg.x2 - seg.x1) * t,
      z: seg.z1 + (seg.z2 - seg.z1) * t,
      ang: Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1),
    };
  };
  return { total, sample };
}

// 탱크로리: 임항도로를 왕복 운행 (탱크팜 ↔ 부두 출하 왕복 묘사)
export function TankTruck({ path, offset = 0, speed = 9, tankColor = '#d1d5db' }) {
  const ref = useRef();
  useFrame((state) => {
    if (!ref.current) return;
    const raw = state.clock.elapsedTime * speed + offset;
    const m = raw % (2 * path.total);
    const forward = m <= path.total;
    const d = forward ? m : 2 * path.total - m;
    const { x, z, ang } = path.sample(d);
    ref.current.position.set(x, 0.15, z);
    ref.current.rotation.y = forward ? ang : ang + Math.PI;
  });
  return (
    <group ref={ref}>
      {/* 트랙터 캡 */}
      <mesh position={[0, 1.6, 4.6]} castShadow>
        <boxGeometry args={[2.4, 2.4, 2.6]} />
        <meshStandardMaterial color="#1d4ed8" roughness={0.5} />
      </mesh>
      {/* 탱크 트레일러 (위험물 표지 오렌지 띠) */}
      <mesh position={[0, 2.0, -0.8]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[1.3, 1.3, 7.5, 14]} />
        <meshStandardMaterial color={tankColor} metalness={0.5} roughness={0.35} />
      </mesh>
      <mesh position={[0, 2.0, -0.8]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[1.32, 1.32, 1.2, 14]} />
        <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={0.25} />
      </mesh>
      {/* 섀시 */}
      <mesh position={[0, 0.7, 0]}>
        <boxGeometry args={[2.2, 0.5, 11.5]} />
        <meshStandardMaterial color="#111827" />
      </mesh>
    </group>
  );
}

// 항만 순찰정: 만 안을 타원 궤도로 순찰
export function PatrolBoat({ center, rx = 130, rz = 90, speed = 0.09, phase = 0 }) {
  const ref = useRef();
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime * speed + phase;
    const x = center[0] + Math.sin(t) * rx;
    const z = center[1] + Math.cos(t) * rz;
    const dx = Math.cos(t) * rx;
    const dz = -Math.sin(t) * rz;
    ref.current.position.set(x, Math.sin(state.clock.elapsedTime * 0.9) * 0.12, z);
    ref.current.rotation.y = Math.atan2(dx, dz);
  });
  return (
    <group ref={ref}>
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[3.2, 1.8, 10]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.5} />
      </mesh>
      <mesh position={[0, 2.3, -0.5]} castShadow>
        <boxGeometry args={[2.4, 1.6, 3.5]} />
        <meshStandardMaterial color="#1d4ed8" />
      </mesh>
      {/* 청색 경광등 */}
      <mesh position={[0, 3.4, -0.5]}>
        <boxGeometry args={[0.7, 0.4, 0.7]} />
        <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={2.2} />
      </mesh>
      {/* 항적 */}
      <mesh position={[0, 0.15, -9]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <planeGeometry args={[3.2, 13]} />
        <meshBasicMaterial color="#e8f4f8" transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}

// SPM 부이에 선수 계류한 원유운반선(VLCC): 조류에 따라 부이 주위를 아주 천천히 스윙
export function SPMTanker({ buoy }) {
  const ref = useRef();
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const ang = t * 0.015;
    const R = 55;
    const x = buoy[0] + Math.sin(ang) * R;
    const z = buoy[1] + Math.cos(ang) * R;
    ref.current.position.set(x, Math.sin(t * 0.45) * 0.1, z);
    // SPM 은 선수 계류 — 선수가 항상 부이를 향한다
    ref.current.rotation.y = Math.atan2(buoy[0] - x, buoy[1] - z);
  });
  return (
    <group ref={ref} scale={[0.9, 0.9, 0.9]}>
      {/* 대형 원유운반선 선체 */}
      <mesh position={[0, 3.5, 0]} castShadow>
        <boxGeometry args={[18, 7, 78]} />
        <meshStandardMaterial color="#4c1d1d" metalness={0.55} roughness={0.45} />
      </mesh>
      {/* 선수 */}
      <mesh position={[0, 3.5, 43]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.1, 9, 8, 24]} />
        <meshStandardMaterial color="#4c1d1d" metalness={0.55} roughness={0.45} />
      </mesh>
      {/* 갑판 배관 (원유선 특유의 중앙 파이프라인) */}
      <mesh position={[0, 7.4, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.6, 0.6, 70, 8]} />
        <meshStandardMaterial color="#9ca3af" metalness={0.7} />
      </mesh>
      {/* 선교 (후미) */}
      <mesh position={[0, 10, -30]} castShadow>
        <boxGeometry args={[14, 8, 9]} />
        <meshStandardMaterial color="#f3f4f6" />
      </mesh>
      {/* 계류 호서(hawser): 선수 → 부이 */}
      <mesh position={[0, 2.5, 53]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 22, 6]} />
        <meshStandardMaterial color="#111827" />
      </mesh>
      {/* 하역 호스 (부이→선체, 수면 부유 표현) */}
      <mesh position={[3, 0.6, 50]} rotation={[Math.PI / 2, 0.15, 0]}>
        <cylinderGeometry args={[0.35, 0.35, 20, 8]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
    </group>
  );
}
