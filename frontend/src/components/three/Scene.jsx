import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls, Stars } from '@react-three/drei';
import BerthFocus from './BerthFocus';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { Suspense, useEffect, useRef } from 'react';

// [2026-09-29] 가벼운 모드 — 느린 PC 에서 3D 가 버벅인다(동안·현우). 처음 3초의 프레임을 재서 30 아래면
// 그림자(장면에서 가장 비싼 패스)를 끄고 해상도를 1배로 내린다. 결과·자료는 그대로고 그림만 단순해진다.
// ?lite=1 로 강제, ?lite=0 으로 끔. 켜지면 화면 왼쪽 아래에 "가벼운 모드" 칩이 뜬다.
function PerfProbe() {
  const setTwinLite = useSensorStore((s) => s.setTwinLite);
  const lite = useSensorStore((s) => s.twinLite);
  const setDpr = useThree((s) => s.setDpr);
  const frames = useRef(0);
  const start = useRef(null);
  const done = useRef(false);
  // 처음 5초는 재지 않는다 — 셰이더 컴파일·자료 적재로 좋은 PC 도 느리다(실측: GPU PC 가 가벼운 모드로 빠졌다).
  const WARMUP = 5;
  const WINDOW = 3;
  useFrame((state) => {
    if (done.current) return;
    if (start.current === null) { start.current = state.clock.elapsedTime; return; }
    const dt = state.clock.elapsedTime - start.current;
    if (dt < WARMUP) return;
    frames.current += 1;
    if (dt >= WARMUP + WINDOW) {
      done.current = true;
      const fps = frames.current / (dt - WARMUP);
      if (fps < 30 && !lite) { setTwinLite(true); setDpr(1); }
    }
  });
  return null;
}
const LITE_PARAM = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lite') : null;
import Port from './Port';
import Water from './Water';
import useSensorStore from '../../stores/useSensorStore';

// WeatherEffects(비 입자 10,000개)는 걷어냈다. store.weather 를 읽는데 그 값을
// 채우는 경로가 없어 useFrame 이 즉시 return 했고, 읽는 필드명(wind_speed·visibility)도
// 실제 계약(wind_speed_ms·visibility_m)과 달라 연결해도 동작하지 않았다.
// 파티클만 만들어 놓고 한 번도 렌더하지 않는 순수 비용이었다.

// 3D 처음 화면 — Canvas 의 첫 카메라 위치 · OrbitControls 첫 목표와 같아야 한다
const HOME_POS = [330, 230, -250];
const HOME_TARGET = [0, 0, 0];
// 72시간을 온산 전체로 볼 때 — 만 쪽에서 더 높이, 입출항 항로와 E2 정박지까지 한 화면에 든다
const WIDE_POS = [528, 450, -254];
const WIDE_TARGET = [173, 0, 29];

/** 처음 화면(조감)으로 카메라를 천천히 되돌린다 — store.requestTwinHome() 이 부른다 */
function CameraHome() {
  const { camera, controls } = useThree();
  const at = useSensorStore((s) => s.twinHomeAt);
  const kind = useSensorStore((s) => s.twinHomeKind);
  const goal = useRef(null);
  useEffect(() => {
    if (!at) return;
    const wide = kind === 'wide';
    goal.current = { pos: new THREE.Vector3(...(wide ? WIDE_POS : HOME_POS)), look: new THREE.Vector3(...(wide ? WIDE_TARGET : HOME_TARGET)) };
  }, [at, kind]);
  useFrame(() => {
    const g = goal.current;
    if (!g) return;
    camera.position.lerp(g.pos, 0.07);
    if (controls) { controls.target.lerp(g.look, 0.07); controls.update(); }
    if (camera.position.distanceTo(g.pos) < 1.5) goal.current = null;
  });
  return null;
}

/** 72시간 패널이 아래를 덮는 만큼 장면을 위로 민다 — 카메라는 그대로 두고 그리는 창만 옮긴다 */
function ViewShift() {
  const { camera, size } = useThree();
  const shift = useSensorStore((s) => s.twinViewShift);
  const cur = useRef(0);
  const last = useRef('');
  useFrame(() => {
    const goal = shift || 0;
    cur.current = Math.abs(goal - cur.current) < 0.6 ? goal : THREE.MathUtils.lerp(cur.current, goal, 0.12);
    const key = `${Math.round(cur.current)}|${size.width}|${size.height}`;
    if (key === last.current) return;
    last.current = key;
    if (Math.round(cur.current) === 0) camera.clearViewOffset();
    else camera.setViewOffset(size.width, size.height, 0, Math.round(cur.current), size.width, size.height);
  });
  useEffect(() => () => { camera.clearViewOffset(); }, [camera]);
  return null;
}

function SimulationEnvironment({ focusBerth, focusRings = true }) {
  const lite = useSensorStore((s) => s.twinLite);

  return (
    <>
      <color attach="background" args={['#0a1628']} />
      <SkyAndLights />

      <Water />
      <Port />
      <BerthFocus berthName={focusBerth} showRings={focusRings} />
      <CameraHome />
      <ViewShift />

      {/* [2026-09-29] 후처리는 매 프레임 화면 전체를 다시 그려 느린 PC 에서 가장 큰 비용이었다(동안·현우 체감).
          장식이라 기본은 끄고, 촬영 때만 ?fx=1 로 켠다. */}
      {LITE_PARAM !== '0' && <PerfProbe />}
      {FX_ON && !lite && (
        <EffectComposer disableNormalPass>
          <Bloom luminanceThreshold={0.55} mipmapBlur intensity={0.8} />
          <Vignette eskil={false} offset={0.15} darkness={0.9} />
        </EffectComposer>
      )}

      <OrbitControls
        makeDefault
        target={HOME_TARGET}
        minPolarAngle={Math.PI / 8}
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={30}
        maxDistance={1100}
        enableDamping
        dampingFactor={0.08}
      />
    </>
  );
}

// 촬영용 — ?hour=14 로 장면의 시각(낮밤)을 고정한다
const HOUR_Q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('hour') : null;
const HOUR_FIXED = HOUR_Q != null && Number(HOUR_Q) >= 0 && Number(HOUR_Q) < 24 ? Number(HOUR_Q) : null;

/** 하늘과 빛 — 지금 시각, 72시간 시뮬레이션 중에는 그 시각의 낮밤을 따른다 */
function SkyAndLights() {
  const predictionOffset = useSensorStore((s) => s.predictionOffset);
  const lite = useSensorStore((s) => s.twinLite);
  // 시뮬레이션 시각은 20분 단위로만 받는다 — 한 시각 안에서 하늘을 여러 번 다시 그릴 까닭이 없다
  const simAt = useSensorStore((s) => (s.outlookPreview?.simOn ? Math.floor(s.outlookPreview.at_ms / 1200000) * 1200000 : null));

  // 기준 시각은 현재 시각이다.
  //
  // 예전엔 store.timestamp 를 읽었는데 그 값을 채우는 코드가 없어(WebSocket 경로
  // 잔해) 항상 폴백인 정오로 고정됐다. 밤 10시에도 부두는 한낮이었고, 같은 화면의
  // CCTV 패널은 실제 시각으로 야간·IR 을 그려서 둘이 어긋났다.
  const now = simAt ? new Date(simAt) : new Date();
  let hour = now.getHours() + now.getMinutes() / 60;
  hour = (hour + (simAt ? 0 : predictionOffset / 60)) % 24;
  if (hour < 0) hour += 24;
  if (HOUR_FIXED != null && !simAt) hour = HOUR_FIXED;

  const sunAngle = ((hour - 6) / 12) * Math.PI;
  const sunX = Math.cos(sunAngle) * 1000;
  const sunY = Math.sin(sunAngle) * 1000;

  const isNight = hour < 6 || hour > 18;
  // [2026-09-28] 밤 최저 밝기를 올렸다 — 18시 뒤 장면이 거의 검어 고장처럼 보였다(현우 D13)
  // 가벼운 모드는 그림자가 없어 어두운 면이 안 생기므로 환경광을 조금 올린다
  const ambientIntensity = (isNight ? 0.42 : 0.5) + (lite ? 0.15 : 0);
  const sunIntensity = isNight ? 0 : Math.max(Math.sin(sunAngle), 0) * 1.8;

  // 해 뜰 녘 · 질 녘 한 시간은 낮과 밤 사이를 잇는다(0 = 밤, 1 = 낮)
  const day = THREE.MathUtils.clamp(Math.min(hour - 5.5, 18.5 - hour), 0, 1);
  // [2026-09-30] 하늘은 늘 어두운 관제 화면 톤 — 낮에는 조금 밝은 남색, 밤에는 별.
  //   drei Sky 는 낮에 화면 위쪽을 밝은 회색 띠로, 해 뜰 녘 · 질 녘에는 갈색 띠로 칠해 어두운 HUD 와 따로 놀았다.
  const skyColor = new THREE.Color('#0a1628').lerp(new THREE.Color('#2b4a6b'), day);
  const fogColor = new THREE.Color('#0a1628').lerp(new THREE.Color('#3d5f82'), day);

  return (
    <>
      <color attach="background" args={[skyColor]} />
      <fog attach="fog" args={[fogColor, 520, 1900]} />

      <ambientLight intensity={ambientIntensity} color="#b0c4de" />
      <hemisphereLight
        skyColor="#4a7aad"
        groundColor="#1a2a3a"
        intensity={isNight ? 0.3 : 0.35}
      />

      {!isNight && (
        <directionalLight
          position={[sunX, sunY, -500]}
          intensity={sunIntensity}
          color="#fff5e6"
          castShadow={!lite}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
      )}
      {isNight && (
        <directionalLight
          position={[-500, 400, 500]}
          intensity={0.7}
          color="#38bdf8"
        />
      )}

      {day < 0.5 && <Stars radius={900} depth={120} count={lite ? 900 : 2200} factor={9} saturation={0} fade speed={0.4} />}
      {/* drei <Environment preset> 은 쓰지 않는다 — 프리셋 HDR 을 GitHub 에서
          실시간으로 내려받는데, 2026-08-17 에 GitHub 가 429 를 돌려주자 이
          컴포넌트가 죽으면서 /twin 전체가 빈 화면이 됐다. 반사광 질감을 조금
          더할 뿐인 장식이 화면 생존을 외부 CDN 에 걸어둘 이유가 없다.
          조명은 위의 태양·반구광·Sky 가 이미 전부 담당한다. */}
    </>
  );
}

const FX_ON = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fx') === '1';

export default function Scene({ focusBerth, focusRings = true }) {
  const lite = useSensorStore((s) => s.twinLite);
  return (
    <Canvas
      key={lite ? 'lite' : 'full'}
      camera={{ position: HOME_POS, fov: 50 }}
      style={{ background: '#0a1628' }}
      shadows={!lite}
      gl={{
        powerPreference: 'high-performance',
        antialias: !lite,
        alpha: false,
      }}
      dpr={lite ? 1 : [1, 1.25]}
      onCreated={(state) => {
        state.gl.setClearColor('#0a1628');
      }}
    >
      <Suspense fallback={null}>
        <SimulationEnvironment focusBerth={focusBerth} focusRings={focusRings} />
      </Suspense>
    </Canvas>
  );
}
