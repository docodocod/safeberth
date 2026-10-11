import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ONSAN_BERTHS_3D, SHORE_N, SHORE_T, findBerthIdByName, onsanAdjacentBerthNames } from '../../utils/geoUtils';

// ─────────────────────────────────────────────────────────────────────────────
// 특정 선석으로 카메라를 옮기고, 그 선석과 인접 선석을 링으로 표시한다.
//
// 왜 필요한가:
//   안전/환경 관제는 "S-Oil 2부두 혼재금지 위험" 까지 알려주지만, 그 판정의 근거인
//   '인접 선석'이 현장에서 어떤 배치인지는 목록만 봐서는 알 수 없다. 3D 화면을 열어도
//   항상 같은 전체 뷰라 위험 선석을 사용자가 직접 찾아 돌려야 했다.
//   여기가 두 화면을 잇는 지점이다 — 안전 관제가 "어디가 위험한가"에 답하고,
//   3D 가 "그 위험이 현장에서 어떤 배치인가"에 답한다. 역할이 겹치지 않는다.
//
// 좌표계: ONSAN_BERTHS_3D 의 pos 는 Three.js 씬 좌표([x, z])다.
// ─────────────────────────────────────────────────────────────────────────────

const FOCUS_HEIGHT = 105;     // 카메라 높이 — 부두를 비스듬히 내려다보는 각
const FOCUS_BACK = 150;       // 선석에서 물러나는 거리
const EASE = 0.06;            // 카메라 이동 감쇠 (1에 가까울수록 즉시)
const SNAP_DIST = 1.2;        // 이만큼 가까워지면 이동을 끝낸다

// showRings=false: 카메라만 옮긴다 — '앞으로 72시간'은 Port 가 선석 자체를 등급 색으로 칠하므로 링이 겹치면 두 색이 싸운다.
export default function BerthFocus({ berthName, showRings = true }) {
  const { camera, controls } = useThree();
  const target = useRef(null);      // { camPos: Vector3, lookAt: Vector3 }
  const rings = useRef([]);

  useEffect(() => {
    if (!berthName) { target.current = null; rings.current = []; return; }

    // 실DB 선석명('S-Oil 2부두')을 3D 키('SA-SO2')로 맞춘다.
    // ONSAN_BERTHS_3D 의 이름은 'S-Oil 2부두' 처럼 띄어쓰기가 다를 수 있어
    // findBerthIdByName 의 정규화(공백 제거)를 그대로 쓴다.
    const id = findBerthIdByName(berthName);
    const self = id && ONSAN_BERTHS_3D[id];
    if (!self) { target.current = null; rings.current = []; return; }

    const [bx, bz] = self.pos;
    const focus = new THREE.Vector3(bx, 0, bz);

    // 인접 선석도 함께 표시한다 — 혼재 판정의 입력이 바로 이 관계다.
    const adjacent = onsanAdjacentBerthNames(berthName)
      .map((n) => ONSAN_BERTHS_3D[findBerthIdByName(n)])
      .filter(Boolean);

    rings.current = [
      { pos: self.pos, color: '#ff4b6e', radius: 26, self: true },
      ...adjacent.map((b) => ({ pos: b.pos, color: '#f59e0b', radius: 20, self: false })),
    ];

    // 만(바다) 쪽에서 부두를 본다 — 해안선에 수직인 방향으로 물러나고, 배가 들어오는 남동쪽으로 조금 비킨다.
    // [2026-09-30] 예전엔 원점 반대편으로 물러났는데, 끝 쪽 선석(UTK · 정일)은 그 방향이 해안선과 나란해
    //   잔교를 옆에서 길게 보게 됐다.
    const away = new THREE.Vector3(SHORE_N[0] + SHORE_T[0] * 0.25, 0, SHORE_N[1] + SHORE_T[1] * 0.25).normalize();
    target.current = {
      camPos: focus.clone().add(away.multiplyScalar(FOCUS_BACK)).setY(FOCUS_HEIGHT),
      lookAt: focus,
    };
  }, [berthName]);

  useFrame(() => {
    const t = target.current;
    if (!t) return;
    camera.position.lerp(t.camPos, EASE);
    if (controls) {
      controls.target.lerp(t.lookAt, EASE);
      controls.update();
    }
    // 다 왔으면 멈춘다. 계속 lerp 하면 사용자가 화면을 돌려도 되돌아온다.
    if (camera.position.distanceTo(t.camPos) < SNAP_DIST) target.current = null;
  });

  if (!berthName || !showRings || rings.current.length === 0) return null;

  return (
    <group>
      {rings.current.map((r, i) => (
        <mesh
          key={`${r.pos[0]}-${r.pos[1]}-${i}`}
          position={[r.pos[0], 1.5, r.pos[1]]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[r.radius, r.radius + (r.self ? 3.5 : 2.2), 48]} />
          <meshBasicMaterial
            color={r.color}
            transparent
            opacity={r.self ? 0.95 : 0.6}
            side={THREE.DoubleSide}
            depthTest={false}
          />
        </mesh>
      ))}
    </group>
  );
}
