import { useMemo } from 'react';
import * as THREE from 'three';
import { Html, Line } from '@react-three/drei';
import useSensorStore from '../../stores/useSensorStore';
import { shipsAt, FAIRWAY_LINE, FAIRWAY_ENTRANCE } from '../../utils/simClock';
import SceneLabel from './SceneLabel';
import Tank from './Tank';
import Ship from './Ship';
import Pipe from './Pipe';
import {
  ONSAN_BERTHS_3D,
  ONSAN_SHORE_PATH,
  ONSAN_KNOC_3D,
  ONSAN_ANCHORAGE_3D,
  TANK_BASE_3D,
  SHORE_N,
  shoreShift,
  bayShift,
  shipScale,
} from '../../utils/geoUtils';

// 두 점을 잇는 계류삭 (얇은 원기둥)
function MooringLine({ from, to }) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const d = b.clone().sub(a);
  const len = d.length();
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    d.clone().normalize()
  );
  const mid = a.clone().add(d.multiplyScalar(0.5));
  return (
    <mesh position={mid} quaternion={quat}>
      <cylinderGeometry args={[0.13, 0.13, len, 6]} />
      <meshStandardMaterial color="#111827" roughness={0.9} />
    </mesh>
  );
}

import { makePath } from './Vehicles';
import { VTSTower, DistillationPlant, Lighthouse, Windsock, RailSiding, FireBoat } from './Facilities';
import { MOOR_HEADING, ONSAN_WEATHER_GROUP } from '../../utils/geoUtils';
import { WEATHER_STATUS_COLORS } from '../../utils/constants';

// 건물 정면(local +z)이 수역(N) 방향을 보도록 하는 회전각
const BUILD_ROT = Math.atan2(SHORE_N[0], SHORE_N[1]);

// 창고 (아치 지붕 물류창고 — 잔교 배후 배치)
function Warehouse({ pos, w = 30, h = 9, d = 18, color = '#475569' }) {
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, BUILD_ROT, 0]}>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      {/* 지붕 */}
      <mesh position={[0, h + 0.6, 0]} castShadow>
        <boxGeometry args={[w + 1.5, 1.2, d + 1.5]} />
        <meshStandardMaterial color="#334155" roughness={0.7} />
      </mesh>
      {/* 대형 출입문 + 위험물 표지 스트라이프 */}
      <mesh position={[0, h * 0.35, d / 2 + 0.06]}>
        <boxGeometry args={[w * 0.35, h * 0.7, 0.1]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
      <mesh position={[0, h * 0.78, d / 2 + 0.06]}>
        <boxGeometry args={[w * 0.8, 0.8, 0.1]} />
        <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={0.3} />
      </mesh>
    </group>
  );
}

// 드럼/IBC 야적장 (컬러 박스 스택)
const STACK_COLORS = ['#0e7490', '#b45309', '#4d7c0f', '#7c3aed'];
function StorageYard({ pos, rows = 2, cols = 5 }) {
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, BUILD_ROT, 0]}>
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[cols * 4 + 5, rows * 4 + 5]} />
        <meshStandardMaterial color="#3a4759" roughness={0.95} />
      </mesh>
      {Array.from({ length: rows * cols }).map((_, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        return (
          <mesh
            key={i}
            position={[(c - (cols - 1) / 2) * 4, 1.4, (r - (rows - 1) / 2) * 4]}
            castShadow
          >
            <boxGeometry args={[3, 2.8, 3]} />
            <meshStandardMaterial color={STACK_COLORS[(r + c * 2) % STACK_COLORS.length]} roughness={0.6} />
          </mesh>
        );
      })}
    </group>
  );
}

// 배후단지 건물 (창문 발광 스트립 포함)
function Building({ pos, w = 22, h = 12, d = 14, color = '#374151' }) {
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, BUILD_ROT, 0]}>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      {[0.35, 0.68].map((f, i) => (
        <mesh key={i} position={[0, h * f, d / 2 + 0.06]}>
          <boxGeometry args={[w * 0.8, 1.1, 0.1]} />
          <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.7} />
        </mesh>
      ))}
      {/* 옥상 설비 */}
      <mesh position={[w * 0.25, h + 1, 0]} castShadow>
        <boxGeometry args={[3, 2, 3]} />
        <meshStandardMaterial color="#6b7280" />
      </mesh>
    </group>
  );
}

// 배후 보조 탱크 클러스터 (장식용, 비인터랙티브)
function DecorTanks({ pos, count = 3, r = 7, h = 9 }) {
  return (
    <group position={[pos[0], 0, pos[1]]} rotation={[0, BUILD_ROT, 0]}>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} position={[(i - (count - 1) / 2) * (r * 2.4), 0, 0]}>
          <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r, r, h, 20]} />
            <meshStandardMaterial color="#d1d5db" roughness={0.55} metalness={0.15} />
          </mesh>
          <mesh position={[0, h + 0.3, 0]}>
            <cylinderGeometry args={[r * 0.98, r * 0.98, 0.6, 20]} />
            <meshStandardMaterial color="#9ca3af" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// 실측 위경도 투영 기반 온산 배치 (geoUtils 3D 블록 참조)
// 해안선은 처용리(북서) → 산암리 → 정일(남동) 대각선, 수역(만)은 북동쪽.
const berthLabelStyle = {
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

function ringShape(points) {
  const s = new THREE.Shape();
  points.forEach(([x, z], i) => (i === 0 ? s.moveTo(x, -z) : s.lineTo(x, -z)));
  s.closePath();
  return s;
}

// 시간축 미리보기 등급 색 — OutlookTimeline.LEVEL_COLOR 와 같은 값(어두운 바탕용)
const OUTLOOK_LEVEL_COLOR = {
  적합: '#10b981', 주의: '#f59e0b', 부적합: '#ef4444', 확인요청: '#a78bfa', 판정불가: '#a78bfa',
};

export default function Port() {
  const { tanks, ships, pipes, selectedObject, setSelectedObject } =
    useSensorStore();
  const berthWeather = useSensorStore((s) => s.berthWeather);
  // "앞으로 72시간" 시간축(OutlookTimeline)이 가리키는 시각의 판정 — 그 선석만 이 값으로 그린다
  const outlookPreview = useSensorStore((s) => s.outlookPreview);
  // [2026-09-30] 시뮬레이션이 돌면 그 시각의 배(계획에 든 배 + 계획 밖 정박지 대기선)를 그린다.
  //   자리는 배마다 매 프레임 시계로 잡고(Ship), 여기서는 시각이 바뀔 때 누가 있고 어떤 단계인지만 다시 센다.
  const simPlans = outlookPreview?.simOn ? outlookPreview.plans : null;
  const drawShips = useMemo(
    () => (simPlans ? shipsAt(simPlans, outlookPreview.at_ms, ships, !outlookPreview.berthId) : ships),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simPlans, outlookPreview?.at_ms, ships],
  );

  // 육지: 해안선 경로에서 내륙(-N) 방향으로 420유닛 확장한 폴리곤
  const landShape = useMemo(() => {
    const back = [...ONSAN_SHORE_PATH].reverse().map((p) => bayShift(p, -420));
    return ringShape([...ONSAN_SHORE_PATH, ...back]);
  }, []);

  // 안벽 에이프런: 해안선 앞쪽(만 방향) 18유닛 포장 스트립
  const apronShape = useMemo(() => {
    const outer = ONSAN_SHORE_PATH.map((p) => bayShift(p, 18));
    return ringShape([...outer, ...[...ONSAN_SHORE_PATH].reverse()]);
  }, []);

  // 해안 도로: 해안선 배후 -6 ~ -16 스트립 + 중앙 점선
  const roadShape = useMemo(() => {
    const inner = ONSAN_SHORE_PATH.map((p) => bayShift(p, -6));
    const outer = [...ONSAN_SHORE_PATH].reverse().map((p) => bayShift(p, -16));
    return ringShape([...inner, ...outer]);
  }, []);
  const roadDashes = useMemo(() => {
    const line = ONSAN_SHORE_PATH.map((p) => bayShift(p, -11));
    return line.slice(0, -1).map((p, i) => {
      const q = line[i + 1];
      return {
        mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
        ang: Math.atan2(q[0] - p[0], q[1] - p[1]),
      };
    });
  }, []);

  const [tbx, tbz] = TANK_BASE_3D;
  const [kx, kz] = ONSAN_KNOC_3D;

  // 배후단지 데코 배치 (선석 실좌표 기준)
  const decor = useMemo(() => {
    const B = ONSAN_BERTHS_3D;
    return {
      buildings: [
        { pos: bayShift(B['CY-UTK'].pos, -78), w: 24, h: 13 },
        { pos: bayShift(shoreShift(B['CY-OTK1'].pos, 16), -85), w: 36, h: 11, color: '#3b4657' },
        { pos: bayShift(B['CY-DHY'].pos, -72), w: 20, h: 10 },
        { pos: bayShift(B['SA-HS'].pos, -78), w: 42, h: 17, color: '#414d61' },
        { pos: bayShift(B['SA-JI1'].pos, -72), w: 22, h: 12 },
        { pos: bayShift(B['SA-JI2'].pos, -90), w: 30, h: 10, color: '#3b4657' },
      ],
      tankClusters: [
        { pos: bayShift(shoreShift(B['CY-OTK2'].pos, 10), -130), count: 3 },
        { pos: bayShift(B['CY-UTK'].pos, -135), count: 3, r: 6, h: 8 },
        { pos: bayShift(shoreShift(B['SA-JI1'].pos, 16), -135), count: 3 },
      ],
      flare: shoreShift([tbx, tbz], 52),
      lightTowers: [2, 6, 10].map((i) => bayShift(ONSAN_SHORE_PATH[i], -20)),
      breakwater: Array.from({ length: 7 }).map((_, i) =>
        bayShift(shoreShift(B['SA-JI2'].pos, 78), 16 + i * 18)),
      // 배후 항만시설: 포장 야드 / 물류창고 / 드럼·IBC 야적장
      yardPads: [
        { pos: bayShift(shoreShift([0, 0], -180), -130), w: 130, d: 100 },
        { pos: bayShift(shoreShift([0, 0], 50), -180), w: 170, d: 120 },
        { pos: bayShift(shoreShift([0, 0], 250), -110), w: 120, d: 90 },
      ],
      warehouses: [
        { pos: bayShift(shoreShift(B['CY-UTK'].pos, 55), -125), w: 34 },
        { pos: bayShift(shoreShift(B['CY-DHY'].pos, 45), -112), w: 26, d: 15 },
        { pos: bayShift(shoreShift(B['SA-HS'].pos, -45), -128), w: 40, h: 11 },
        { pos: bayShift(shoreShift(B['SA-JI2'].pos, 62), -118), w: 28 },
      ],
      storageYards: [
        { pos: bayShift(shoreShift(B['CY-OTK1'].pos, -42), -62) },
        { pos: bayShift(shoreShift(B['SA-SO2'].pos, 72), -72), rows: 3 },
        { pos: bayShift(shoreShift(B['SA-JI1'].pos, -52), -98) },
      ],
      // 실재 시설 모사: VTS 관제탑 / S-Oil 증류탑 플랜트 / 방파제 등대 /
      // 윈드삭(하역 풍속 판단) / 철도 인입선 / 소방정
      vts: bayShift(shoreShift(B['CY-DHY'].pos, -38), -95),
      plant: shoreShift(bayShift(B['SA-SO1'].pos, -185), 45),
      lighthouse: bayShift(shoreShift(B['SA-JI2'].pos, 78), 150),
      windsocks: [
        bayShift(shoreShift(B['CY-OTK1'].pos, 22), -22),
        bayShift(shoreShift(B['SA-SO2'].pos, -20), -22),
        bayShift(shoreShift(B['SA-JI1'].pos, 24), -22),
      ],
      rail: bayShift(shoreShift([0, 0], 40), -155),
      fireboat: bayShift(shoreShift(B['SA-HS'].pos, -32), 32),
    };
  }, [tbx, tbz]);

  // 임항도로 경로 (탱크로리 왕복 운행용)
  const roadPath = useMemo(
    () => makePath(ONSAN_SHORE_PATH.map((p) => bayShift(p, -11))),
    []
  );

  return (
    <group>
      {/* ===== 육지 (실측 해안선 폴리곤) ===== */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
        <shapeGeometry args={[landShape]} />
        <meshStandardMaterial color="#334155" roughness={0.95} />
      </mesh>

      {/* 포장 야드 (배후지 채움) */}
      {decor.yardPads.map((p, i) => (
        <group key={`pad-${i}`} position={[p.pos[0], 0.045, p.pos[1]]} rotation={[0, BUILD_ROT, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[p.w, p.d]} />
            <meshStandardMaterial color="#3a4655" roughness={0.95} />
          </mesh>
        </group>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} receiveShadow>
        <shapeGeometry args={[apronShape]} />
        <meshStandardMaterial color="#3f4a5a" roughness={0.9} />
      </mesh>

      {/* ===== 해안 도로 (배후 임항도로 + 중앙 점선) ===== */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} receiveShadow>
        <shapeGeometry args={[roadShape]} />
        <meshStandardMaterial color="#1f2937" roughness={0.95} />
      </mesh>
      {roadDashes.map(({ mid, ang }, i) => (
        <mesh key={`dash-${i}`} position={[mid[0], 0.12, mid[1]]} rotation={[0, ang, 0]}>
          <boxGeometry args={[0.5, 0.02, 6]} />
          <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.3} />
        </mesh>
      ))}

      {/* ===== 배후단지: 터미널 건물 · 보조 탱크 · 플레어 스택 · 조명타워 · 방파제 ===== */}
      {decor.buildings.map((b, i) => (
        <Building key={`bldg-${i}`} {...b} />
      ))}
      {decor.tankClusters.map((t, i) => (
        <DecorTanks key={`dtank-${i}`} {...t} />
      ))}
      {decor.warehouses.map((w, i) => (
        <Warehouse key={`wh-${i}`} {...w} />
      ))}
      {decor.storageYards.map((s, i) => (
        <StorageYard key={`sy-${i}`} {...s} />
      ))}

      {/* 실재 시설: VTS 관제탑 · 증류탑 플랜트 · 등대 · 윈드삭 · 철도 · 소방정 */}
      <VTSTower pos={decor.vts} />
      <DistillationPlant pos={decor.plant} rot={BUILD_ROT} />
      <Lighthouse pos={decor.lighthouse} />
      {decor.windsocks.map((p, i) => (
        <Windsock key={`ws-${i}`} pos={p} rot={MOOR_HEADING} />
      ))}
      <RailSiding pos={decor.rail} rot={MOOR_HEADING} />
      <FireBoat pos={decor.fireboat} rot={MOOR_HEADING} />

      {/* S-Oil 정유단지 플레어 스택 (상시 연소) */}
      <group position={[decor.flare[0], 0, decor.flare[1]]}>
        <mesh position={[0, 20, 0]} castShadow>
          <cylinderGeometry args={[0.9, 1.4, 40, 10]} />
          <meshStandardMaterial color="#6b7280" metalness={0.6} roughness={0.5} />
        </mesh>
        <mesh position={[0, 41.5, 0]}>
          <coneGeometry args={[1.6, 4, 10]} />
          <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={2.2} />
        </mesh>
        <pointLight position={[0, 44, 0]} distance={130} intensity={1.4} color="#fb923c" />
      </group>

      {/* 야드 조명타워 */}
      {decor.lightTowers.map((p, i) => (
        <group key={`tower-${i}`} position={[p[0], 0, p[1]]}>
          <mesh position={[0, 14, 0]} castShadow>
            <cylinderGeometry args={[0.35, 0.6, 28, 8]} />
            <meshStandardMaterial color="#6b7280" />
          </mesh>
          <mesh position={[0, 28, 0]}>
            <boxGeometry args={[3.4, 1, 1.2]} />
            <meshStandardMaterial color="#fef08a" emissive="#fef08a" emissiveIntensity={1.6} />
          </mesh>
          <pointLight position={[0, 27, 0]} distance={110} intensity={0.7} color="#fef08a" />
        </group>
      ))}

      {/* 방파제 (정일 남동측, 만 방향 돌제) */}
      {decor.breakwater.map((p, i) => (
        <mesh key={`bw-${i}`} position={[p[0], 1, p[1]]} rotation={[0, BUILD_ROT, 0]} castShadow>
          <boxGeometry args={[14, 3.2, 12]} />
          <meshStandardMaterial color="#4b5563" roughness={1} />
        </mesh>
      ))}

      {/* ===== BERTH STRUCTURES (잔교식 액체화물 부두, 해안 접선에 정렬) ===== */}
      {Object.entries(ONSAN_BERTHS_3D).map(([id, berth]) => {
        const [x, z] = berth.pos;
        // 이 선석에 계류 중인 선박 (로딩암 연결 표시용)
        const mooredShip = drawShips.find(
          (s) => s.berth === id && (s.slot || 0) === 0 && ['operating', 'mooring', 'docked'].includes(s.status)
        ) || drawShips.find((s) => s.berth === id && ['operating', 'mooring', 'docked'].includes(s.status));
        // 기상 판정 역연동: 이 선석의 임계군에 대한 최근 판정
        const liveVerdict =
          berthWeather && ONSAN_WEATHER_GROUP[id] === berthWeather.berth_group
            ? berthWeather.status
            : null;
        // 시간축 미리보기(2026-09-27): 이 선석을 가리키면 그 시각의 예보 판정으로 색·라벨을 바꾼다.
        // 등급(적합/주의/부적합)이 색, 머리말(정상/하역중단/흘수 여유 부족…)이 글이다.
        const wide = outlookPreview?.berthLevels?.[id];
        const preview = outlookPreview && outlookPreview.berthId === id ? outlookPreview
          : wide ? { ...wide, offsetH: outlookPreview.offsetH } : null;
        const verdict = preview ? (preview.headline || preview.status || '정상') : liveVerdict;
        const escalated = preview ? Boolean(preview.level) && preview.level !== '적합' : Boolean(verdict) && verdict !== '정상';
        const stripeColor = preview
          ? (OUTLOOK_LEVEL_COLOR[preview.level] || '#94a3b8')
          : escalated ? (WEATHER_STATUS_COLORS[verdict] || '#eab308') : '#eab308';
        // 지목한 선석은 늘 그 시각을 적고, 나머지 선석(preview.wide)은 나빠졌을 때만 한 낱말을 붙인다
        const marked = preview ? (preview.wide ? escalated : true) : escalated;
        const labelSuffix = preview && !preview.wide
          ? ` · ${preview.offsetH === 0 ? '지금' : `+${preview.offsetH}h`} ${verdict}`
          : escalated ? ` · ${verdict}` : '';

        return (
          <group
            key={id}
            position={[x, 0, z]}
            rotation={[0, berth.rotY, 0]}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedObject({
                type: 'Berth',
                id,
                name: berth.name,
                status: mooredShip ? 'active' : 'idle',
                mooredShip: mooredShip ? `${mooredShip.id}${mooredShip.cargoType ? ` (${mooredShip.cargoType})` : ''}` : null,
              });
            }}
          >
            {/* 선석명 라벨 (판정 시 상태 표시) */}
            {/* 온산 전체를 멀리서 볼 때 나빠진 선석의 이름표는 크기를 고정한다 — 거리에 맞춰 줄이면 읽히지 않는다 */}
            <SceneLabel position={[10, 22, 0]} fixed={Boolean(preview?.wide && marked && !outlookPreview?.berthId)}>
              <div style={{
                ...berthLabelStyle,
                ...(marked ? { border: `1px solid ${stripeColor}`, color: stripeColor } : {}),
                // 크기를 고정한 이름표는 이웃 선석과 높이를 엇갈린다(부두군 전체가 막히면 네 개가 나란히 선다)
                ...(preview?.wide && marked && !outlookPreview?.berthId
                  ? { transform: `translateY(${-(Object.keys(ONSAN_BERTHS_3D).indexOf(id) % 3) * 22}px)`, fontSize: '11px', padding: '2px 6px' } : {}),
              }}>
                {preview?.wide && !outlookPreview?.berthId ? berth.name.replace(/\s*부두$/, '').replace(/\s+/g, '') : berth.name}
                {labelSuffix}
              </div>
            </SceneLabel>

            {/* 판정 경보 링: 하역중단/이안/호스분리 시 잔교 주위 발광 링. 시간축 미리보기 중엔 등급 색으로 늘 켠다 */}
            {marked && (
              <mesh position={[5, 0.7, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[38, 40.5, 40]} />
                <meshBasicMaterial color={stripeColor} transparent opacity={0.55} depthWrite={false} />
              </mesh>
            )}

            {/* Main Pier Deck */}
            <mesh position={[20, 2, 0]} receiveShadow>
              <boxGeometry args={[45, 4, 25]} />
              <meshStandardMaterial color="#374151" roughness={0.9} />
            </mesh>

            {/* 안벽 경계선 (기본 노랑, 판정 에스컬레이션 시 판정 색) */}
            <mesh position={[-1.8, 4.05, 0]}>
              <boxGeometry args={[1.2, 0.1, 25]} />
              <meshStandardMaterial
                color={stripeColor}
                emissive={stripeColor}
                emissiveIntensity={marked ? 1.2 : 0.4}
              />
            </mesh>

            {/* 로딩암 연결: 계류 선박이 있으면 MLA 에서 선박 매니폴드까지 */}
            {mooredShip && (
              <group>
                {/* 본체 암: MLA 타워(1,10) → 선박 매니폴드(-11,5) */}
                <mesh
                  position={[-5, 7.5, 0]}
                  rotation={[0, 0, Math.atan2(12, -5)]}
                  castShadow
                >
                  <cylinderGeometry args={[0.35, 0.35, 13, 12]} />
                  <meshStandardMaterial color="#eab308" metalness={0.6} roughness={0.4} />
                </mesh>
                {/* 하역 중이면 이송 라인 발광 표시 */}
                {mooredShip.status === 'operating' && (
                  <mesh
                    position={[-5, 7.9, 0]}
                    rotation={[0, 0, Math.atan2(12, -5)]}
                  >
                    <cylinderGeometry args={[0.14, 0.14, 13, 8]} />
                    <meshStandardMaterial
                      color="#00d4aa"
                      emissive="#00d4aa"
                      emissiveIntensity={2}
                    />
                  </mesh>
                )}
              </group>
            )}

            {/* 계류삭: 선수/선미 → 돌핀, 중앙 브레스트라인 → 안벽 */}
            {mooredShip && (() => {
              const s = shipScale(mooredShip.cargoAmount);
              const side = -15 + 8 * s; // 선박의 안벽측 뱃전 x
              const deckY = 6.2 * s;
              const lines = [
                [[17, 4.5, 35], [side, deckY, 26 * s]],
                [[17, 4.5, -35], [side, deckY, -26 * s]],
                [[-2.5, 4.2, 8], [side, deckY, 8]],
                [[-2.5, 4.2, -8], [side, deckY, -8]],
              ];
              return lines.map(([f, t], i) => (
                <MooringLine key={`ml-${i}`} from={f} to={t} />
              ));
            })()}

            {/* Marine Loading Arms (MLA) — complex structure */}
            <group position={[3, 4.5, 0]}>
              {/* MLA tower */}
              <mesh position={[0, 4, 0]} castShadow>
                <boxGeometry args={[3, 8, 3]} />
                <meshStandardMaterial
                  color="#eab308"
                  roughness={0.5}
                  metalness={0.7}
                />
              </mesh>
              {/* Arm 1 (port side) */}
              <mesh
                position={[-3, 7.5, -4]}
                rotation={[0, 0, Math.PI / 4]}
                castShadow
              >
                <cylinderGeometry args={[0.3, 0.3, 10, 8]} />
                <meshStandardMaterial color="#eab308" />
              </mesh>
              {/* Arm 2 (starboard side) */}
              <mesh
                position={[-3, 7.5, 4]}
                rotation={[0, 0, Math.PI / 4]}
                castShadow
              >
                <cylinderGeometry args={[0.3, 0.3, 10, 8]} />
                <meshStandardMaterial color="#eab308" />
              </mesh>
            </group>

            {/* Trestle (Access Bridge) */}
            <mesh position={[45, 2, 0]} receiveShadow>
              <boxGeometry args={[30, 3, 8]} />
              <meshStandardMaterial color="#4b5563" />
            </mesh>

            {/* Pier Pipeline */}
            <group position={[25, 4.5, -5]}>
              <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry args={[0.4, 0.4, 30, 8]} />
                <meshStandardMaterial
                  color="#9ca3af"
                  metalness={0.8}
                  roughness={0.3}
                />
              </mesh>
              <mesh
                position={[0, 0, 2]}
                rotation={[0, 0, Math.PI / 2]}
                castShadow
              >
                <cylinderGeometry args={[0.6, 0.6, 30, 8]} />
                <meshStandardMaterial
                  color="#9ca3af"
                  metalness={0.8}
                  roughness={0.3}
                />
              </mesh>
            </group>

            {/* Tire Fenders */}
            <group position={[0, 2, 0]}>
              {[-10, 0, 10].map((fz, i) => (
                <mesh
                  key={`fender-${i}`}
                  position={[-2.5, 0, fz]}
                  rotation={[0, 0, Math.PI / 2]}
                  castShadow
                >
                  <cylinderGeometry args={[1, 1, 1, 16]} />
                  <meshStandardMaterial color="#1f2937" roughness={1} />
                </mesh>
              ))}
            </group>

            {/* Light Poles */}
            <group>
              {[-10, 10].map((lz, i) => (
                <group key={`light-${i}`} position={[15, 4, lz]}>
                  {/* Pole */}
                  <mesh position={[0, 10, 0]} castShadow>
                    <cylinderGeometry args={[0.2, 0.4, 20, 8]} />
                    <meshStandardMaterial color="#6b7280" />
                  </mesh>
                  {/* Light fixture */}
                  <mesh position={[0, 20, 0]}>
                    <boxGeometry args={[1, 0.5, 2]} />
                    <meshStandardMaterial
                      color="#eab308"
                      emissive="#eab308"
                      emissiveIntensity={2}
                    />
                  </mesh>
                  <pointLight
                    position={[0, 19, 0]}
                    distance={100}
                    intensity={0.5}
                    color="#fef08a"
                  />
                </group>
              ))}
            </group>

            {/* Mooring Dolphins & Catwalks */}
            <group>
              {[-35, 35].map((dz, i) => (
                <group key={`dolphin-${i}`} position={[20, 2, dz]}>
                  {/* Dolphin concrete base */}
                  <mesh position={[0, 0, 0]} castShadow receiveShadow>
                    <boxGeometry args={[10, 4, 10]} />
                    <meshStandardMaterial color="#4b5563" roughness={0.9} />
                  </mesh>
                  {/* Bollard */}
                  <mesh position={[-3, 2.5, 0]} castShadow>
                    <cylinderGeometry args={[0.5, 0.6, 1.5, 16]} />
                    <meshStandardMaterial color="#1f2937" metalness={0.8} />
                  </mesh>
                  {/* Dolphin fender */}
                  <mesh
                    position={[-5.2, 0, 0]}
                    rotation={[0, 0, Math.PI / 2]}
                    castShadow
                  >
                    <cylinderGeometry args={[2, 2, 0.5, 16]} />
                    <meshStandardMaterial color="#111827" roughness={1} />
                  </mesh>
                  {/* Catwalk connecting to main pier */}
                  <mesh
                    position={[0, 1, dz < 0 ? 15 : -15]}
                    receiveShadow
                  >
                    <boxGeometry args={[4, 0.5, 20]} />
                    <meshStandardMaterial color="#9ca3af" roughness={0.7} />
                  </mesh>
                </group>
              ))}
            </group>
          </group>
        );
      })}

      {/* ===== 항로(페어웨이) 부표: 만 중앙선 따라 녹색=우현측, 적색=좌현측 ===== */}
      <group>
        {[-300, -150, 0, 150, 300].map((s) =>
          [
            { k: 150, color: '#10b981' },
            { k: 195, color: '#ef4444' },
          ].map(({ k, color }) => {
            const [bx, bz] = bayShift(shoreShift([0, 0], s), k);
            return (
              <group key={`buoy-${s}-${k}`} position={[bx, 0, bz]}>
                {/* Buoy base cylinder */}
                <mesh position={[0, 0.5, 0]}>
                  <cylinderGeometry args={[1.5, 1.5, 1, 16]} />
                  <meshStandardMaterial color={color} />
                </mesh>
                {/* Buoy cone top */}
                <mesh position={[0, 2, 0]}>
                  <coneGeometry args={[1.5, 3, 16]} />
                  <meshStandardMaterial color={color} />
                </mesh>
                <pointLight
                  position={[0, 4, 0]}
                  distance={50}
                  intensity={1}
                  color={color}
                />
              </group>
            );
          })
        )}
      </group>

      {/* ===== 석유공사 원유부이 (SPM, 실제는 남동 원해 — 축척 축소 표시) ===== */}
      <group position={[kx, 0, kz]}>
        <mesh position={[0, 1, 0]} castShadow>
          <cylinderGeometry args={[4.5, 5.5, 2.5, 20]} />
          <meshStandardMaterial color="#f97316" roughness={0.6} />
        </mesh>
        <mesh position={[0, 3, 0]} castShadow>
          <sphereGeometry args={[2.2, 20, 16]} />
          <meshStandardMaterial color="#fb923c" />
        </mesh>
        <pointLight position={[0, 6, 0]} distance={60} intensity={1} color="#fdba74" />
        <Html position={[0, 12, 0]} center zIndexRange={[20, 0]} distanceFactor={320}>
          <div style={berthLabelStyle}>석유공사 원유부이 (원해 · 축척 축소)</div>
        </Html>
      </group>

      {/* ===== 묘박지 (앵커리지 존 표시) ===== */}
      {Object.entries(ONSAN_ANCHORAGE_3D).map(([id, a]) => (
        <group key={`anc-${id}`} position={[a.pos[0], 0, a.pos[1]]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]}>
            <ringGeometry args={[a.radius - 1.2, a.radius, 48]} />
            <meshBasicMaterial color="#ffd166" transparent opacity={0.45} depthWrite={false} />
          </mesh>
          <Html position={[0, 14, 0]} center zIndexRange={[20, 0]} distanceFactor={320}>
            <div style={berthLabelStyle}>{a.name}</div>
          </Html>
        </group>
      ))}

      {/* ===== TANK FARM — 방류벽(dike)으로 둘러싼 저장탱크 단지 (S-Oil 배후지) ===== */}
      <group>
        {/* 단지 바닥 패드 */}
        <mesh position={[tbx, 0.15, tbz]} receiveShadow>
          <boxGeometry args={[60, 0.5, 78]} />
          <meshStandardMaterial color="#3f4a5a" roughness={0.95} />
        </mesh>
        {/* 방류벽 4면 (누출 시 확산 방지벽) */}
        <mesh position={[tbx, 1, tbz - 39]} castShadow>
          <boxGeometry args={[62, 2, 1.5]} />
          <meshStandardMaterial color="#4b5563" roughness={0.9} />
        </mesh>
        <mesh position={[tbx, 1, tbz + 39]} castShadow>
          <boxGeometry args={[62, 2, 1.5]} />
          <meshStandardMaterial color="#4b5563" roughness={0.9} />
        </mesh>
        <mesh position={[tbx - 30, 1, tbz]} castShadow>
          <boxGeometry args={[1.5, 2, 78]} />
          <meshStandardMaterial color="#4b5563" roughness={0.9} />
        </mesh>
        <mesh position={[tbx + 30, 1, tbz]} castShadow>
          <boxGeometry args={[1.5, 2, 78]} />
          <meshStandardMaterial color="#4b5563" roughness={0.9} />
        </mesh>
      </group>

      {tanks.map((tank, index) => {
        // 탱크팜 내부 2행 × 3열 정렬 배치
        const row = Math.floor(index / 3);
        const col = index % 3;
        const tankX = tbx - 13 + row * 26;
        const tankZ = tbz - 26 + col * 26;

        return (
          <Tank
            key={tank.id}
            position={[tankX, 0, tankZ]}
            tank={tank}
            onClick={() => setSelectedObject(tank)}
          />
        );
      })}

      {/* ===== 육상 배관 랙: 해안선 경로를 따라 각 잔교 배후 연결 ===== */}
      <group>
        {ONSAN_SHORE_PATH.slice(0, -1).map((p, i) => {
          const q = ONSAN_SHORE_PATH[i + 1];
          const dx = q[0] - p[0];
          const dz = q[1] - p[1];
          const len = Math.hypot(dx, dz);
          if (len < 1) return null;
          const ang = Math.atan2(dx, dz);
          return (
            <group
              key={`rack-${i}`}
              position={[(p[0] + q[0]) / 2, 4, (p[1] + q[1]) / 2]}
              rotation={[0, ang, 0]}
            >
              {[0, 1.6].map((off, j) => (
                <mesh key={j} position={[off, 0, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                  <cylinderGeometry args={[0.5, 0.5, len + 1, 8]} />
                  <meshStandardMaterial color="#9ca3af" metalness={0.8} roughness={0.3} />
                </mesh>
              ))}
            </group>
          );
        })}
        {/* 배관 지지대 (각 해안선 꼭짓점) */}
        {ONSAN_SHORE_PATH.slice(1, -1).map((p, i) => (
          <mesh key={`support-${i}`} position={[p[0] + 0.8, 2, p[1]]} castShadow>
            <boxGeometry args={[3.5, 4, 3.5]} />
            <meshStandardMaterial color="#6b7280" roughness={0.8} />
          </mesh>
        ))}
      </group>

      {/* ===== SHIPS ===== */}
      {/* 시뮬레이션 중에는 배가 다니는 항로를 옅게 그린다 — 배가 어디서 들어와 어디로 나가는지 */}
      {simPlans && (
        <group>
          <Line
            points={FAIRWAY_LINE.map(([x, z]) => [x, 0.9, z])}
            color="#7dd3fc" lineWidth={1.4} dashed dashSize={10} gapSize={9} transparent opacity={0.5}
          />
          <SceneLabel position={[FAIRWAY_ENTRANCE[0], 10, FAIRWAY_ENTRANCE[1]]} fixed>
            <div style={{ ...berthLabelStyle, border: '1px solid rgba(125, 211, 252, 0.5)', color: '#bae6fd', fontSize: '11px' }}>항로 입구</div>
          </SceneLabel>
        </group>
      )}

      {/* 시뮬레이션 중이면 그 시각의 배, 아니면 지금의 배 */}
      {drawShips.map((ship) => (
        <Ship
          key={ship.id}
          ship={ship}
          onClick={() => setSelectedObject(ship)}
        />
      ))}

      {/* [2026-09-28] 움직이는 장식(탱크로리 왕복 · 순찰정 · SPM 원유선)을 뺐다 — 데이터와 무관하게
          돌아다녀 실제 작업처럼 보였다("가상을 실제처럼 꾸미지 않기"). 정적인 건물·시설만 배경으로 남긴다. */}

      {/* ===== PIPES: 탱크팜 → 하역 선석 이송 배관 (flowRate 에 따라 발광 흐름) ===== */}
      {pipes && pipes.map((pipe, i) => {
        const feedBerthIds = ['CY-OTK1', 'SA-SO1', 'SA-JI1'];
        const b = ONSAN_BERTHS_3D[feedBerthIds[i % feedBerthIds.length]];
        const [ex, ez] = bayShift(b.pos, -22);
        return (
          <Pipe
            key={pipe.id}
            pipe={pipe}
            start={[tbx, 3, tbz]}
            end={[ex, 3, ez]}
            onClick={() => setSelectedObject({ ...pipe, feedTo: b.name })}
          />
        );
      })}

      {/* 정보창은 캔버스 밖(DigitalTwinPage)에서 띄운다 — 3D 안에 두면 카메라를 따라 밀렸다(2026-09-30) */}
    </group>
  );
}
