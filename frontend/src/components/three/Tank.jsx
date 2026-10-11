import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import useSensorStore from '../../stores/useSensorStore';

export default function Tank({ position, tank, onClick }) {
  const liquidRef = useRef();
  const predictionOffset = useSensorStore(state => state.predictionOffset);

  // Compute predicted level based on flow rate and prediction offset
  const targetLevel = useMemo(() => {
    let rate = tank.flowRate || 0;
    if (tank.status === 'loading') rate = 5;
    if (tank.status === 'unloading') rate = -5;

    // predictionOffset is in minutes, divide by 60 for hours
    let level = (tank.level || 0) + rate * (predictionOffset / 60) * 2;
    return Math.min(100, Math.max(0, level));
  }, [tank.level, tank.flowRate, tank.status, predictionOffset]);

  // Whether to show warning ring (level > 85)
  const showWarning =
    targetLevel > 85 ||
    tank.pressure > 5.5 ||
    tank.temperature > 40;

  useFrame(() => {
    if (!liquidRef.current) return;

    const targetScaleY = Math.max(targetLevel / 100, 0.01);
    liquidRef.current.scale.y = THREE.MathUtils.lerp(
      liquidRef.current.scale.y,
      targetScaleY,
      0.1
    );
    // Position liquid so it rises from the bottom of the tank
    // Tank inner height is 12, centered at Y=0 local, so bottom is -6
    // Scale Y stretches from center, so we offset to keep bottom anchored
    liquidRef.current.position.y = (12 * liquidRef.current.scale.y) / 2;
  });

  // Liquid color by cargo type
  const getLiquidColor = (cargoType) => {
    if (!cargoType) return '#1a3a5c';
    if (cargoType.includes('Crude')) return '#2d1810'; // dark brown
    if (cargoType.includes('Gasoline')) return '#c9a227'; // golden yellow
    if (cargoType.includes('Chemical')) return '#1a6b54'; // dark green
    return '#1a3a5c'; // dark blue default
  };

  const liquidColor = getLiquidColor(tank.cargoType);

  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {/* Concrete Base */}
      <mesh position={[0, 0.5, 0]} receiveShadow>
        <cylinderGeometry args={[5.5, 5.5, 1, 32]} />
        <meshStandardMaterial color="#374151" roughness={0.95} />
      </mesh>

      {/* Outer Shell — opaque white-grey, NOT wireframe */}
      <mesh position={[0, 7, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[5, 5, 12, 32]} />
        <meshStandardMaterial
          color="#d1d5db"
          transparent
          opacity={0.85}
          roughness={0.5}
          metalness={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Inner Liquid */}
      <mesh ref={liquidRef} position={[0, 0, 0]}>
        <cylinderGeometry args={[4.8, 4.8, 12, 32]} />
        <meshStandardMaterial
          color={liquidColor}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>

      {/* Roof Cap */}
      <mesh position={[0, 13.1, 0]} castShadow>
        <cylinderGeometry args={[5, 5, 0.2, 32]} />
        <meshStandardMaterial
          color="#374151"
          metalness={0.6}
          roughness={0.5}
        />
      </mesh>

      {/* Valve Manifold Box on Roof */}
      <mesh position={[0, 13.5, 0]} castShadow>
        <boxGeometry args={[2, 0.8, 2]} />
        <meshStandardMaterial color="#eab308" metalness={0.9} />
      </mesh>

      {/* Safety Railing on top */}
      <mesh position={[0, 13.6, 0]}>
        <cylinderGeometry args={[4.8, 4.8, 0.8, 32, 1, true]} />
        <meshStandardMaterial color="#9ca3af" wireframe />
      </mesh>

      {/* Warning Ring — red torus when level > 85% */}
      {showWarning && (
        <mesh position={[0, 13.3, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[5.2, 0.15, 8, 32]} />
          <meshStandardMaterial
            color="#ef4444"
            emissive="#ef4444"
            emissiveIntensity={1.5}
          />
        </mesh>
      )}
    </group>
  );
}
