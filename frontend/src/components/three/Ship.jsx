import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import {
  convertLatLonToVector3,
  ONSAN_BERTHS_3D,
  ONSAN_ANCHORAGE_3D,
  MOOR_HEADING,
  shoreShift,
  bayShift,
  shipScale,
} from '../../utils/geoUtils';
import useSensorStore from '../../stores/useSensorStore';
import SceneLabel from './SceneLabel';
import { simClock, simTarget, slotMoor } from '../../utils/simClock';
import { stateAt } from '../../utils/berthSim';

// 선석 미배정 선박의 기본 대기점 (만 중앙)
const DEFAULT_HOLDING = bayShift([0, 0], 170);

const STATUS_META = {
  operating: { label: '하역 중', color: '#00d4aa' },
  mooring: { label: '접안 중', color: '#ffd166' },
  docked: { label: '접안 중', color: '#ffd166' },
  arriving: { label: '입항 중', color: '#3a86ff' },
  approaching: { label: '입항 중', color: '#3a86ff' },
  departing: { label: '출항 중', color: '#8338ec' },
  anchored: { label: '정박지 대기', color: '#ffd166' },  // 화면 전체 용어를 '정박지 대기'로 통일
  // AIS 항해상태로는 들어오는 배인지 나가는 배인지 알 수 없다. 방향을 지어내는
  // 대신 '항해 중'으로 둔다 (실데이터 선박은 대부분 여기에 해당).
  underway: { label: '항해 중', color: '#3a86ff' },
};

const shipLabelStyle = {
  background: 'rgba(13, 27, 42, 0.85)',
  border: '1px solid rgba(78, 205, 196, 0.35)',
  borderRadius: '6px',
  padding: '2px 7px',
  color: '#e8f0f2',
  fontSize: '11px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
};

// 예인선 (입출항 시 선측 호위 — 선박 그룹의 자식으로 함께 이동)
function Tug({ position }) {
  return (
    <group position={position}>
      <mesh position={[0, 1.4, 0]} castShadow>
        <boxGeometry args={[5, 2.8, 11]} />
        <meshStandardMaterial color="#7f1d1d" roughness={0.6} />
      </mesh>
      <mesh position={[0, 3.6, -1]} castShadow>
        <boxGeometry args={[3.4, 2.4, 4.5]} />
        <meshStandardMaterial color="#f3f4f6" />
      </mesh>
      <mesh position={[0, 5.2, -1]}>
        <cylinderGeometry args={[0.3, 0.4, 1.6, 8]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
    </group>
  );
}

const easeInOut = (t) => t * t * (3 - 2 * t);

// 2차 베지어 곡선 위의 점과 접선 방향 (입출항 항로용)
function bezierPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}
function bezierTangent(p0, p1, p2, t) {
  return [
    2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]),
    2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]),
  ];
}

export default function Ship({ ship, onClick }) {
  const shipRef = useRef();
  const predictionOffset = useSensorStore((state) => state.predictionOffset);

  // 선박별 위상차 (파도에 흔들리는 타이밍이 배마다 다르게)
  const bobPhase = useMemo(
    () => [...ship.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 10,
    [ship.id]
  );

  // 계류 지점: 배정된 선석의 안벽 옆(만 방향 15유닛)
  // 선수는 해안 접선(+T, 남동 외해) 방향 = MOOR_HEADING — 출항 대비 계류
  // [2026-09-30] 같은 부두에 둘 이상 접안하면 바깥쪽으로 나란히(slot) — 예전엔 한 자리에 겹쳐 그려졌다
  const moor = useMemo(() => {
    const berth = ONSAN_BERTHS_3D[ship.berth];
    return berth ? slotMoor(berth, ship.slot) : DEFAULT_HOLDING;
  }, [ship.berth, ship.slot]);

  const { targetPos, targetHeading, isMoored, isAnchored, isUnderway } = useMemo(() => {
    // 72시간 시뮬레이션의 배 — 자리는 매 프레임 시계(simClock)로 다시 잡는다(useFrame). 여기는 처음 자리와 표시용
    if (ship.plan) {
      const tg = simTarget(ship.plan, stateAt(ship.plan, simClock.t), moor, ship.waitIdx);
      return {
        targetPos: tg.pos, targetHeading: tg.heading, isMoored: Boolean(tg.moored),
        isAnchored: Boolean(tg.anchored), isUnderway: Boolean(tg.moving),
      };
    }
    // 실시간 AIS 좌표가 있으면 그대로 사용 (라이브 데이터 모드)
    if (ship.vessel_lat) {
      const [x, , z] = convertLatLonToVector3(ship.vessel_lat, ship.vessel_lon);
      const heading = ship.vessel_heading
        ? THREE.MathUtils.degToRad(-ship.vessel_heading)
        : 0;
      const moving = ship.vessel_speed >= 0.5;
      return { targetPos: [x, z], targetHeading: heading, isMoored: !moving, isAnchored: false, isUnderway: moving };
    }

    // 묘박: 배정 묘박지에서 대기 (닻 중심 스윙은 useFrame 에서)
    if (ship.status === 'anchored') {
      const anc = ONSAN_ANCHORAGE_3D[ship.anchorage] || { pos: DEFAULT_HOLDING };
      return {
        targetPos: anc.pos,
        targetHeading: MOOR_HEADING + 0.7,
        isMoored: false,
        isAnchored: true,
        isUnderway: false,
      };
    }

    // 입항 (90분 소요): 남동 외해에서 만 중앙 항로를 따라 들어와 선회 접안.
    // 경로 전체가 만(수역) 안에 있어 육지/부두와 교차하지 않는다.
    if (ship.status === 'arriving' || ship.status === 'approaching') {
      const t = easeInOut(Math.min(1, predictionOffset / 90));
      const P0 = bayShift(shoreShift(moor, 260), 170);
      const P1 = bayShift(moor, 140);
      const P2 = moor;
      const pos = bezierPoint(P0, P1, P2, t);
      const [dx, dz] = bezierTangent(P0, P1, P2, t);
      let heading = Math.atan2(dx, dz);
      // 접안 마지막 구간: 선수를 접선 방향(남동 외해)으로 돌려 계류
      const dockBlend = THREE.MathUtils.smoothstep(t, 0.72, 1);
      heading = THREE.MathUtils.lerp(heading, MOOR_HEADING, dockBlend);
      return { targetPos: pos, targetHeading: heading, isMoored: t >= 1, isAnchored: false, isUnderway: t > 0 && t < 1 };
    }

    // 출항 (60분 소요): 안벽에서 떨어져 만 중앙 항로로 나간 뒤 남동 외해로.
    // 하역 중(operating) 선박도 4시간 뒤부터는 출항 시뮬레이션
    let departT = null;
    if (ship.status === 'departing') departT = Math.min(1, predictionOffset / 60);
    else if (ship.status === 'operating' && predictionOffset > 240) {
      departT = Math.min(1, (predictionOffset - 240) / 60);
    }
    if (departT !== null && departT > 0) {
      const t = easeInOut(departT);
      const P0 = moor;
      const P1 = bayShift(shoreShift(moor, 70), 145);
      const P2 = bayShift(shoreShift(moor, 300), 175);
      const pos = bezierPoint(P0, P1, P2, t);
      const [dx, dz] = bezierTangent(P0, P1, P2, t);
      // 출항 초반에는 아직 안벽과 평행(선수 = 접선), 이후 항로 방향으로 선회
      const turnBlend = THREE.MathUtils.smoothstep(t, 0, 0.3);
      const heading = THREE.MathUtils.lerp(MOOR_HEADING, Math.atan2(dx, dz), turnBlend);
      return { targetPos: pos, targetHeading: heading, isMoored: false, isAnchored: false, isUnderway: t < 1 };
    }

    // 계류/하역 중: 안벽 옆에 고정, 선수는 접선 방향
    return { targetPos: moor, targetHeading: MOOR_HEADING, isMoored: true, isAnchored: false, isUnderway: false };
  }, [ship.status, ship.anchorage, ship.vessel_lat, ship.vessel_lon, ship.vessel_heading, ship.vessel_speed, moor, predictionOffset, ship.plan, ship.waitIdx, ship.phase]);

  useFrame((state, delta) => {
    if (!shipRef.current) return;
    const t = state.clock.elapsedTime;

    // 묘박 중: 닻을 중심으로 아주 느리게 스윙 (조류·바람에 밀리는 표현)
    let tx = targetPos[0];
    let tz = targetPos[1];
    let heading = targetHeading;
    let anchoredNow = isAnchored;
    let mooredNow = isMoored;
    const simOn = Boolean(ship.plan) && simClock.active;
    if (simOn) {
      const tg = simTarget(ship.plan, stateAt(ship.plan, simClock.t), moor, ship.waitIdx);
      [tx, tz] = tg.pos;
      heading = tg.heading;
      anchoredNow = Boolean(tg.anchored);
      mooredNow = Boolean(tg.moored);
    }
    if (anchoredNow) {
      tx += Math.sin(t * 0.05 + bobPhase) * 6;
      tz += Math.cos(t * 0.045 + bobPhase) * 6;
      heading += Math.sin(t * 0.03 + bobPhase) * 0.35;
    }

    // 대형 선박다운 묵직한 이동 (관성 표현). 시뮬레이션은 시간이 빨리 흘러 조금 더 바짝 따라간다
    const lerpFactor = Math.min(1, delta * (simOn ? 3.2 : 0.8));
    shipRef.current.position.x = THREE.MathUtils.lerp(
      shipRef.current.position.x, tx, lerpFactor
    );
    shipRef.current.position.z = THREE.MathUtils.lerp(
      shipRef.current.position.z, tz, lerpFactor
    );

    // 상하 요동: 계류 중엔 잔잔하게, 항해 중엔 조금 더 크게
    const bobAmp = mooredNow ? 0.05 : 0.14;
    shipRef.current.position.y = Math.sin(t * 0.6 + bobPhase) * bobAmp;

    // 좌우 롤·앞뒤 피치까지 넣어 파도에 실린 느낌
    const roll = Math.sin(t * 0.5 + bobPhase) * (mooredNow ? 0.006 : 0.018);
    const pitch = Math.sin(t * 0.42 + bobPhase * 1.7) * (mooredNow ? 0.003 : 0.010);
    const targetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitch, heading, roll)
    );
    shipRef.current.quaternion.slerp(targetQuat, Math.min(1, delta * (simOn ? 3 : 1.2)));
  });

  // Hull colors: operating = dark maroon, docked/arriving = dark navy
  const hullColor = ship.status === 'operating' ? '#5c1a1a' : '#1a2d5c';
  const deckColor = '#374151';
  // 재화중량에 비례한 선체 크기 (출항 공선은 작게 보임)
  const scl = shipScale(ship.cargoAmount);
  const berthOdd = Math.max(0, Object.keys(ONSAN_BERTHS_3D).indexOf(ship.berth)) % 2;
  const labelStep = berthOdd + (ship.slot || 0) * 2;
  const meta = ship.plan
    ? { label: ship.simLabel || '', color: ship.simColor || '#8ba3b8' }
    : STATUS_META[ship.status] || { label: ship.status, color: '#8ba3b8' };
  // 접안해 있는 배는 점 색만으로 충분하다 — '접안 중' 글을 배마다 붙이면 이웃 배 이름표와 겹친다
  const labelText = !ship.plan && (ship.status === 'mooring' || ship.status === 'docked') ? '' : meta.label;

  return (
    <group
      ref={shipRef}
      position={[targetPos[0], 0, targetPos[1]]}
      rotation={[0, targetHeading, 0]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      scale={[scl, scl, scl]}
    >
      {/* 선명 + 상태 라벨 */}
      {/* 같은 부두의 둘째 배는 이름표를 한 칸 위로 — 나란히 댄 배의 이름표가 겹쳤다 */}
      {ship.labelMode !== 'hidden' && (
      <SceneLabel position={[0, 30 + (ship.slot || 0) * 22 + (ship.labelMode === 'fixed' ? 0 : berthOdd * 16), 0]} fixed={ship.labelMode === 'fixed'}>
        <div style={{
          ...shipLabelStyle,
          // 멀리서 크기를 고정한 이름표는 이웃 선석 · 같은 부두의 둘째 배와 겹치지 않게 높이를 엇갈린다
          ...(ship.labelMode === 'fixed' ? { transform: `translateY(${-(labelStep * 24)}px)` } : {}),
        }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: meta.color, display: 'inline-block',
          }} />
          {ship.id}
          {labelText && <span style={{ color: meta.color, fontWeight: 600 }}>{labelText}</span>}
          {ship.simProgress != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '34px', height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.18)', overflow: 'hidden', display: 'inline-block' }}>
                <span style={{ display: 'block', width: `${ship.simProgress}%`, height: '100%', background: meta.color }} />
              </span>
              <span style={{ color: meta.color, fontWeight: 700, fontFamily: 'ui-monospace, Consolas, monospace' }}>{ship.simProgress}%</span>
            </span>
          )}
        </div>
      </SceneLabel>
      )}

      {/* 항적 (항해 중에만): 선미 뒤로 퍼지는 물거품 */}
      {isUnderway && (
        <group>
          <mesh position={[0, 0.5, -62]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={[13, 60]} />
            <meshBasicMaterial color="#c8dce8" transparent opacity={0.10} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0.55, -48]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={[5.5, 34]} />
            <meshBasicMaterial color="#e8f4f8" transparent opacity={0.20} depthWrite={false} />
          </mesh>
          {/* 선수파 */}
          <mesh position={[0, 0.55, 38]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={[9, 9]} />
            <meshBasicMaterial color="#e8f4f8" transparent opacity={0.16} depthWrite={false} />
          </mesh>
        </group>
      )}

      {/* 예인선 호위 (입출항 기동 중에만) */}
      {isUnderway && (ship.status === 'arriving' || ship.status === 'departing') && (
        <group>
          <Tug position={[13, 0, 10]} />
          <Tug position={[-13, 0, -12]} />
        </group>
      )}

      {/* Hull (Main Body) */}
      <mesh position={[0, 3, 0]} castShadow receiveShadow>
        <boxGeometry args={[16, 6, 60]} />
        <meshStandardMaterial
          color={hullColor}
          metalness={0.6}
          roughness={0.4}
        />
      </mesh>

      {/* Bow (Front Curve) */}
      <mesh
        position={[0, 3, 34]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
        receiveShadow
      >
        <cylinderGeometry args={[0.1, 8, 6, 32]} />
        <meshStandardMaterial
          color={hullColor}
          metalness={0.6}
          roughness={0.4}
        />
      </mesh>

      {/* Main Deck */}
      <mesh position={[0, 6.1, 0]} receiveShadow>
        <boxGeometry args={[15.8, 0.2, 58]} />
        <meshStandardMaterial color={deckColor} roughness={0.8} />
      </mesh>

      {/* Bridge Superstructure (Back) */}
      <group position={[0, 6.2, -22]}>
        {/* Lower bridge block */}
        <mesh castShadow>
          <boxGeometry args={[14, 4, 10]} />
          <meshStandardMaterial
            color="#f3f4f6"
            roughness={0.3}
            metalness={0.1}
          />
        </mesh>
        {/* Upper bridge block */}
        <mesh position={[0, 4, 0]} castShadow>
          <boxGeometry args={[10, 3, 8]} />
          <meshStandardMaterial color="#f3f4f6" />
        </mesh>
        {/* Bridge Windows */}
        <mesh position={[0, 4.5, 4.1]}>
          <boxGeometry args={[9, 1.5, 0.1]} />
          <meshStandardMaterial
            color="#111827"
            metalness={0.9}
            roughness={0.1}
          />
        </mesh>
        {/* Funnel / Exhaust Stack */}
        <mesh position={[0, 7, -2]} castShadow>
          <cylinderGeometry args={[0.3, 0.5, 6]} />
          <meshStandardMaterial color="#9ca3af" />
        </mesh>
      </group>

      {/* Piping Manifolds (Middle) */}
      <group position={[0, 6.2, 5]}>
        {Array.from({ length: 6 }).map((_, i) => (
          <group key={i} position={[0, 0, (i - 2.5) * 4]}>
            {/* Port side pipe */}
            <mesh
              position={[-4, 1, 0]}
              rotation={[0, 0, Math.PI / 2]}
              castShadow
            >
              <cylinderGeometry args={[0.4, 0.4, 6]} />
              <meshStandardMaterial color="#9ca3af" metalness={0.7} />
            </mesh>
            {/* Starboard side pipe */}
            <mesh
              position={[4, 1, 0]}
              rotation={[0, 0, Math.PI / 2]}
              castShadow
            >
              <cylinderGeometry args={[0.4, 0.4, 6]} />
              <meshStandardMaterial color="#9ca3af" metalness={0.7} />
            </mesh>
            {/* Manifold valve box */}
            <mesh position={[0, 1.5, 0]} castShadow>
              <boxGeometry args={[2, 2, 2]} />
              <meshStandardMaterial color="#fbbf24" />
            </mesh>
          </group>
        ))}
      </group>

      {/* Helipad (Front) */}
      <mesh
        position={[0, 6.2, 22]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <circleGeometry args={[4, 32]} />
        <meshStandardMaterial color="#10b981" />
      </mesh>
      {/* Helipad ring marking */}
      <mesh position={[0, 6.21, 22]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[3, 3.2, 32]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  );
}
