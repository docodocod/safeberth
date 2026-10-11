import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

// 3D 장면 위의 이름표(배 · 선석).
// 멀리서는 거리에 맞춰 줄이고(조감에서 이름표끼리 덜 겹친다), 가까이에서는 제 크기에서 멈춘다.
// 예전엔 거리에 반비례해 끝없이 커져서, 선석 하나로 다가가면 이름표가 화면을 덮었다(2026-09-30).
const FACTOR = 320;

export default function SceneLabel({ position, fixed = false, children }) {
  const ref = useRef();
  const [near, setNear] = useState(false);
  const nearRef = useRef(false);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    if (!ref.current || fixed) return;
    ref.current.getWorldPosition(v);
    // drei Html 의 배율 = FACTOR / (2·tan(fov/2)·거리) — 배율이 1 을 넘는 거리부터는 크기를 고정한다
    const unit = FACTOR / (2 * Math.tan(((camera.fov || 50) * Math.PI) / 360));
    const n = camera.position.distanceTo(v) < unit;
    if (n !== nearRef.current) { nearRef.current = n; setNear(n); }
  });
  return (
    <group ref={ref} position={position}>
      {/* 크기 방식이 바뀌면 새로 세운다 — drei Html 은 화면 위 자리가 바뀔 때만 배율을 다시 적어서,
          카메라가 멈춰 있는 동안 방식만 바뀌면 예전 배율이 남았다 */}
      <Html key={fixed || near ? 'fixed' : 'scaled'} center zIndexRange={[20, 0]} distanceFactor={fixed || near ? undefined : FACTOR}>
        {children}
      </Html>
    </group>
  );
}
