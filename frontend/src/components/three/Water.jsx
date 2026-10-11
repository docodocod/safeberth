import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import useDashboardData from '../../hooks/useDashboardData';
import useSensorStore from '../../stores/useSensorStore';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Production-quality Ulsan Port harbor ocean shader
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uWaveHeight;

  varying vec2 vUv;
  varying float vElevation;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  //
  // Simplex 2D noise — no function overloading (WebGL 1.0 safe)
  //
  vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(
       0.211324865405187,
       0.366025403784439,
      -0.577350269189626,
       0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289_2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                             + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                            dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x_ = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x_) - 0.5;
    vec3 ox = floor(x_ + 0.5);
    vec3 a0 = x_ - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    float t = uTime;

    // --- Layer 1: large slow swells (open-water background) ---
    float swell = sin(worldPos.x * 0.012 + t * 0.4) * 0.35
                + sin(worldPos.z * 0.015 + t * 0.3) * 0.25
                + sin((worldPos.x + worldPos.z) * 0.008 + t * 0.25) * 0.2;

    // --- Layer 2: medium waves ---
    float medium = snoise(vec2(worldPos.x * 0.04, worldPos.z * 0.04 + t * 0.6)) * 0.18
                 + snoise(vec2(worldPos.x * 0.06 + t * 0.3, worldPos.z * 0.05)) * 0.12;

    // --- Layer 3: small choppy detail ---
    float chop = snoise(vec2(worldPos.x * 0.15 + t * 1.2, worldPos.z * 0.12 + t * 0.8)) * 0.06
               + snoise(vec2(worldPos.x * 0.25 - t * 0.9, worldPos.z * 0.22 + t * 1.0)) * 0.04;

    float elevation = (swell + medium + chop) * uWaveHeight;

    worldPos.y += elevation;
    vElevation = elevation;
    vWorldPos  = worldPos.xyz;

    // Approximate analytical normal via partial derivatives of the noise field
    float eps = 0.5;
    float eR = (sin((worldPos.x + eps) * 0.012 + t * 0.4) * 0.35
              + snoise(vec2((worldPos.x + eps) * 0.04, worldPos.z * 0.04 + t * 0.6)) * 0.18) * uWaveHeight;
    float eL = (sin((worldPos.x - eps) * 0.012 + t * 0.4) * 0.35
              + snoise(vec2((worldPos.x - eps) * 0.04, worldPos.z * 0.04 + t * 0.6)) * 0.18) * uWaveHeight;
    float eF = (sin(worldPos.x * 0.012 + t * 0.4) * 0.35
              + snoise(vec2(worldPos.x * 0.04, (worldPos.z + eps) * 0.04 + t * 0.6)) * 0.18) * uWaveHeight;
    float eB = (sin(worldPos.x * 0.012 + t * 0.4) * 0.35
              + snoise(vec2(worldPos.x * 0.04, (worldPos.z - eps) * 0.04 + t * 0.6)) * 0.18) * uWaveHeight;
    vec3 wNormal = normalize(vec3(eL - eR, 2.0 * eps, eB - eF));
    vNormal = wNormal;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeepColor;     // deep water
  uniform vec3 uShallowColor;  // wave crests / teal tint
  uniform vec3 uFoamColor;     // specular foam
  uniform vec3 uSkyColor;      // reflected sky color
  uniform vec3 uSunDir;        // sun direction for specular
  uniform float uSunIntensity;

  varying vec2 vUv;
  varying float vElevation;
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);

    // ---- Base colour: deep navy → teal-green by elevation ----
    float elevMix = smoothstep(-0.3, 0.5, vElevation);
    vec3 baseColor = mix(uDeepColor, uShallowColor, elevMix);

    // ---- Fresnel rim (view-dependent brightening) ----
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - max(dot(V, N), 0.0), 3.0);
    baseColor = mix(baseColor, uSkyColor, fresnel * 0.35);

    // ---- Sun specular highlight (Blinn-Phong) ----
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 256.0);
    vec3 specular = uFoamColor * spec * 2.5 * uSunIntensity;

    // ---- Foam on wave crests ----
    float foam = smoothstep(0.28, 0.55, vElevation);
    baseColor = mix(baseColor, uFoamColor, foam * 0.25);

    // ---- Subsurface-scatter hint: lighten from below ----
    float sss = smoothstep(-0.1, 0.4, vElevation) * 0.08;
    baseColor += vec3(0.02, 0.08, 0.10) * sss;

    // ---- Combine ----
    vec3 finalColor = baseColor + specular;

    // Subtle distance fade (pseudo-aerial perspective)
    float dist = length(vWorldPos.xz);
    float atmosphereMix = smoothstep(200.0, 1400.0, dist);
    finalColor = mix(finalColor, uSkyColor * 0.4, atmosphereMix * 0.3);

    gl_FragColor = vec4(finalColor, 0.92);
  }
`;

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export default function Water() {
  const meshRef = useRef();

  const uniforms = useMemo(() => ({
    uTime:         { value: 0 },
    uWaveHeight:   { value: 1.0 },
    uDeepColor:    { value: new THREE.Color('#0d3d6b') },   // deep sea blue
    uShallowColor: { value: new THREE.Color('#15678a') },   // teal-green crests
    uFoamColor:    { value: new THREE.Color('#c8dce8') },   // white-ish foam
    uSkyColor:     { value: new THREE.Color('#27506e') },   // reflected sky
    uSunDir:       { value: new THREE.Vector3(0.4, 0.8, -0.3).normalize() },
    uSunIntensity: { value: 1.0 },
  }), []);

  // [2026-09-28] 물결 크기를 실측 유의파고에 잇는다(예전엔 늘 1.0 고정). 72시간 흐름을 재생 중이면
  // 그 시각의 예보 파고. 파고 H 의 진폭은 H/2 — 셰이더 기본 진폭(약 1.2 유닛)에 맞춰 H×0.45 로 두고,
  // 너무 잔잔해 보이지 않게 아래·위를 막는다. 자료가 없으면 예전 값(1.0)을 쓴다.
  const { data } = useDashboardData();
  const outlookWave = useSensorStore((s) => s.outlookPreview?.wave_m);
  const obsWave = Number(data?.weather?.wave_height_sig_m);
  const H = outlookWave != null ? Number(outlookWave) : obsWave;
  const target = Number.isFinite(H) && H > 0 ? THREE.MathUtils.clamp(H * 0.45, 0.12, 3.0) : 1.0;

  useFrame((state) => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material;
    mat.uniforms.uTime.value = state.clock.elapsedTime * 0.7;
    mat.uniforms.uWaveHeight.value += (target - mat.uniforms.uWaveHeight.value) * 0.05;
  });

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -1, 0]}
      receiveShadow
    >
      <planeGeometry args={[3000, 3000, 256, 256]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        side={THREE.FrontSide}
      />
    </mesh>
  );
}
