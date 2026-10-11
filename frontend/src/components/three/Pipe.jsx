import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const FlowShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color('#38bdf8') },
    uSpeed: { value: 1.0 },
    uIsActive: { value: 0.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uSpeed;
    uniform float uIsActive;
    varying vec2 vUv;

    void main() {
      if (uIsActive < 0.5) {
        gl_FragColor = vec4(0.2, 0.2, 0.25, 1.0); 
        return;
      }
      float dash = step(0.5, sin((vUv.x * 20.0 - uTime * 5.0 * uSpeed) * 3.14159));
      vec3 finalColor = mix(uColor * 0.3, uColor * 1.5, dash);
      float glow = dash * 0.8; 
      gl_FragColor = vec4(finalColor + vec3(glow), 1.0);
    }
  `
};

export default function Pipe({ start, end, pipe, onClick }) {
  const materialRef = useRef();

  // Safety: if start or end are missing, don't render
  const safeStart = start || [0, 0, 0];
  const safeEnd = end || [10, 0, 10];

  const curve = useMemo(() => {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(safeStart[0], safeStart[1], safeStart[2]),
      new THREE.Vector3(safeStart[0], safeStart[1], safeEnd[2]),
      new THREE.Vector3(safeEnd[0], safeEnd[1], safeEnd[2])
    ]);
  }, [safeStart, safeEnd]);

  const customMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(FlowShader.uniforms),
    vertexShader: FlowShader.vertexShader,
    fragmentShader: FlowShader.fragmentShader,
    transparent: true,
  }), []);

  useFrame((state) => {
    if (materialRef.current && pipe) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      materialRef.current.uniforms.uIsActive.value = (pipe.flowRate || 0) > 0 ? 1.0 : 0.0;
      materialRef.current.uniforms.uSpeed.value = (pipe.flowRate || 0) / 100 + 0.5;
    }
  });

  // If no start/end provided, skip rendering entirely
  if (!start && !end) return null;

  return (
    <mesh onClick={(e) => { e.stopPropagation(); if (onClick) onClick(); }} castShadow>
      <tubeGeometry args={[curve, 64, 0.5, 8, false]} />
      <primitive object={customMaterial} attach="material" ref={materialRef} />
    </mesh>
  );
}

