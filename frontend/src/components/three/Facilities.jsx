import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';

// ─────────────────────────────────────────────
// 온산항 실재 시설 모사: VTS 관제탑(회전 레이더), 정유 플랜트(증류탑),
// 방파제 등대(점멸), 윈드삭, 철도 인입선(탱크화차), 소방정.
// 모두 장식용(비인터랙티브).
// ─────────────────────────────────────────────

const labelStyle = {
  background: 'rgba(13, 27, 42, 0.85)',
  border: '1px solid rgba(78, 205, 196, 0.35)',
  borderRadius: '6px',
  padding: '3px 8px',
  color: '#e8f0f2',
  fontSize: '12px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

// 항공장애등 (점멸 적색등 — 굴뚝·증류탑·관제탑 상부)
export function Blinker({ position, color = '#ef4444', period = 1.4, phase = 0 }) {
  const ref = useRef();
  useFrame((state) => {
    if (!ref.current) return;
    const on = ((state.clock.elapsedTime + phase) % period) < period * 0.5;
    ref.current.material.emissiveIntensity = on ? 3 : 0.1;
  });
  return (
    <mesh ref={ref} position={position}>
      <sphereGeometry args={[0.55, 8, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={3} />
    </mesh>
  );
}

// VTS 관제센터: 타워 + 유리 전망층 + 회전 레이더
export function VTSTower({ pos }) {
  const radarRef = useRef();
  useFrame((_, delta) => {
    if (radarRef.current) radarRef.current.rotation.y += delta * 1.3;
  });
  return (
    <group position={[pos[0], 0, pos[1]]}>
      {/* 타워 기둥 */}
      <mesh position={[0, 16, 0]} castShadow>
        <cylinderGeometry args={[2.4, 3.4, 32, 12]} />
        <meshStandardMaterial color="#cbd5e1" roughness={0.5} />
      </mesh>
      {/* 전망 관제층 (유리 발광 밴드) */}
      <mesh position={[0, 33.5, 0]} castShadow>
        <cylinderGeometry args={[6, 5, 5, 12]} />
        <meshStandardMaterial color="#334155" roughness={0.4} />
      </mesh>
      <mesh position={[0, 34, 0]}>
        <cylinderGeometry args={[6.05, 6.05, 2, 12, 1, true]} />
        <meshStandardMaterial color="#7dd3fc" emissive="#7dd3fc" emissiveIntensity={0.9} />
      </mesh>
      {/* 지붕 + 회전 레이더 바 */}
      <mesh position={[0, 36.5, 0]}>
        <cylinderGeometry args={[6.2, 6.2, 0.8, 12]} />
        <meshStandardMaterial color="#e2e8f0" />
      </mesh>
      <group ref={radarRef} position={[0, 38.5, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.25, 0.25, 1.8, 6]} />
          <meshStandardMaterial color="#6b7280" />
        </mesh>
        <mesh position={[0, 0.9, 0]}>
          <boxGeometry args={[7.5, 0.5, 0.9]} />
          <meshStandardMaterial color="#f8fafc" metalness={0.4} />
        </mesh>
      </group>
      <Blinker position={[0, 41, 0]} />
      <Html position={[0, 47, 0]} center zIndexRange={[20, 0]} distanceFactor={320}>
        <div style={labelStyle}>온산 VTS 관제센터</div>
      </Html>
    </group>
  );
}

// 정유 플랜트: 높이가 다른 증류탑 군 + 연결 배관 + 굴뚝
const COLUMN_SPECS = [
  { x: -16, h: 24, r: 2.0 },
  { x: -8, h: 32, r: 2.4 },
  { x: 0, h: 18, r: 1.6 },
  { x: 8, h: 28, r: 2.2 },
  { x: 16, h: 14, r: 1.5 },
];
export function DistillationPlant({ pos, rot = 0 }) {
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, rot, 0]}>
      {/* 플랜트 바닥 패드 */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[56, 34]} />
        <meshStandardMaterial color="#3a4655" roughness={0.95} />
      </mesh>
      {/* 증류탑 군 */}
      {COLUMN_SPECS.map(({ x, h, r }, i) => (
        <group key={i} position={[x, 0, 0]}>
          <mesh position={[0, h / 2, 0]} castShadow>
            <cylinderGeometry args={[r, r, h, 14]} />
            <meshStandardMaterial color="#c0c8d2" metalness={0.6} roughness={0.35} />
          </mesh>
          {/* 탑 상부 캡 + 측면 사다리 표현 */}
          <mesh position={[0, h + 0.5, 0]} castShadow>
            <cylinderGeometry args={[r * 0.7, r, 1.2, 14]} />
            <meshStandardMaterial color="#8d99a8" />
          </mesh>
          <mesh position={[r + 0.15, h / 2, 0]}>
            <boxGeometry args={[0.25, h * 0.9, 0.8]} />
            <meshStandardMaterial color="#6b7280" />
          </mesh>
        </group>
      ))}
      {/* 탑 사이 연결 배관 (상부 브리지) */}
      <mesh position={[0, 12, 1.8]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.35, 0.35, 34, 8]} />
        <meshStandardMaterial color="#9ca3af" metalness={0.7} />
      </mesh>
      <mesh position={[-4, 20, -1.5]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.3, 0.3, 26, 8]} />
        <meshStandardMaterial color="#9ca3af" metalness={0.7} />
      </mesh>
      {/* 굴뚝 (백색 상단 띠) */}
      <mesh position={[24, 15, -6]} castShadow>
        <cylinderGeometry args={[1.1, 1.6, 30, 10]} />
        <meshStandardMaterial color="#8d99a8" roughness={0.5} />
      </mesh>
      <mesh position={[24, 28.5, -6]}>
        <cylinderGeometry args={[1.12, 1.12, 3, 10]} />
        <meshStandardMaterial color="#e2e8f0" />
      </mesh>
      {/* 항공장애등: 최고탑 + 굴뚝 */}
      <Blinker position={[-8, 33.5, 0]} phase={0} />
      <Blinker position={[24, 31, -6]} phase={0.7} />
    </group>
  );
}

// 방파제 등대 (점멸 백색광)
export function Lighthouse({ pos }) {
  const lightRef = useRef();
  useFrame((state) => {
    if (!lightRef.current) return;
    const on = (state.clock.elapsedTime % 2.4) < 0.5;
    lightRef.current.intensity = on ? 3.2 : 0.2;
  });
  return (
    <group position={[pos[0], 0, pos[1]]}>
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[3.4, 3.8, 2.4, 12]} />
        <meshStandardMaterial color="#4b5563" roughness={0.9} />
      </mesh>
      <mesh position={[0, 7, 0]} castShadow>
        <cylinderGeometry args={[1.5, 2.1, 10, 12]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.5} />
      </mesh>
      <mesh position={[0, 12.6, 0]} castShadow>
        <cylinderGeometry args={[1.1, 1.3, 1.6, 10]} />
        <meshStandardMaterial color="#dc2626" />
      </mesh>
      <mesh position={[0, 12.6, 0]}>
        <sphereGeometry args={[0.8, 10, 10]} />
        <meshStandardMaterial color="#fef9c3" emissive="#fef9c3" emissiveIntensity={2} />
      </mesh>
      <pointLight ref={lightRef} position={[0, 13, 0]} distance={160} intensity={3} color="#fef9c3" />
    </group>
  );
}

// 윈드삭 (풍향 표시 — 하역 가능 풍속 판단의 상징물)
export function Windsock({ pos, rot = 0 }) {
  const sockRef = useRef();
  useFrame((state) => {
    if (!sockRef.current) return;
    // 바람에 펄럭이는 상하 흔들림
    sockRef.current.rotation.z = -0.28 + Math.sin(state.clock.elapsedTime * 2.2) * 0.1;
  });
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, rot, 0]}>
      <mesh position={[0, 5, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.2, 10, 8]} />
        <meshStandardMaterial color="#e2e8f0" />
      </mesh>
      <group ref={sockRef} position={[0, 9.6, 0]}>
        <mesh position={[0, 0, 2.6]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.85, 5.2, 10, 1, true]} />
          <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={0.35} side={2} />
        </mesh>
      </group>
    </group>
  );
}

// 철도 인입선 + 정차 중인 탱크화차 (온산선 화물 인입선 모사)
export function RailSiding({ pos, rot = 0, length = 240, wagons = 5 }) {
  return (
    <group position={[pos[0], 0.1, pos[1]]} rotation={[0, rot, 0]}>
      {/* 자갈 도상 */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[7, length]} />
        <meshStandardMaterial color="#2b3646" roughness={1} />
      </mesh>
      {/* 레일 2줄 */}
      {[-1.1, 1.1].map((x) => (
        <mesh key={x} position={[x, 0.18, 0]}>
          <boxGeometry args={[0.28, 0.22, length]} />
          <meshStandardMaterial color="#94a3b8" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      {/* 탱크화차 (정차) */}
      {Array.from({ length: wagons }).map((_, i) => {
        const z = (i - (wagons - 1) / 2) * 17;
        return (
          <group key={i} position={[0, 0, z]}>
            <mesh position={[0, 0.9, 0]}>
              <boxGeometry args={[2.6, 0.5, 15]} />
              <meshStandardMaterial color="#111827" />
            </mesh>
            <mesh position={[0, 2.4, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[1.5, 1.5, 13.5, 14]} />
              <meshStandardMaterial color={i % 2 ? '#374151' : '#4c1d1d'} metalness={0.5} roughness={0.4} />
            </mesh>
            {/* 상부 해치 */}
            <mesh position={[0, 4.05, 0]}>
              <cylinderGeometry args={[0.5, 0.5, 0.5, 10]} />
              <meshStandardMaterial color="#eab308" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// 소방정 (액체화물 부두 상비 — 계류 상태)
export function FireBoat({ pos, rot = 0 }) {
  const ref = useRef();
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.position.y = Math.sin(state.clock.elapsedTime * 0.7 + 2) * 0.08;
  });
  return (
    <group ref={ref} position={[pos[0], 0, pos[1]]} rotation={[0, rot, 0]}>
      <mesh position={[0, 1, 0]} castShadow>
        <boxGeometry args={[4.2, 2, 14]} />
        <meshStandardMaterial color="#b91c1c" roughness={0.55} />
      </mesh>
      <mesh position={[0, 2.6, -1.5]} castShadow>
        <boxGeometry args={[3.2, 1.8, 5]} />
        <meshStandardMaterial color="#f3f4f6" />
      </mesh>
      {/* 소화 모니터(물대포) 마스트 */}
      <mesh position={[0, 4.2, 1.5]} castShadow>
        <cylinderGeometry args={[0.18, 0.25, 2.4, 8]} />
        <meshStandardMaterial color="#6b7280" />
      </mesh>
      <mesh position={[0, 5.3, 2]} rotation={[Math.PI / 4, 0, 0]}>
        <cylinderGeometry args={[0.14, 0.2, 1.6, 8]} />
        <meshStandardMaterial color="#dc2626" />
      </mesh>
      <Blinker position={[0, 3.9, -1.5]} color="#ef4444" period={1.0} />
    </group>
  );
}
