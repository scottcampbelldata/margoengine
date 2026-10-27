'use client';
import { useRef } from 'react';
import type { Mesh as MeshHandle } from 'margoengine';
import {
  Bloom,
  Box,
  Canvas,
  ContactShadows,
  EffectComposer,
  OrbitControls,
  Shadows,
  Sky,
  Sphere,
  Tonemap,
  useFrame,
} from 'margoengine/react';

/** Three shapes in afternoon sun: a spinning gold cube, a jade sphere and a coral ball, with soft shadows and bloom. */
function Shapes() {
  const cube = useRef<MeshHandle>(null);
  useFrame((_, delta) => {
    if (cube.current) cube.current.rotation.y += delta * 0.6;
  });
  return (
    <>
      <Box ref={cube} position={[0, 0.75, 0]} args={[1, 1, 1]} color="#e8b04a" roughness={0.3} castShadow />
      <Sphere position={[-1.8, 0.6, 0.4]} args={[0.6, 64, 32]} color="#84d6bd" roughness={0.35} castShadow />
      <Sphere position={[1.7, 0.45, -0.3]} args={[0.45, 64, 32]} color="#e86a5a" roughness={0.15} castShadow />
    </>
  );
}

export default function Page() {
  return (
    <main style={{ height: '100vh' }}>
      <Canvas style={{ height: '100%' }} label="Three shapes in the sun. Drag to orbit, scroll to zoom.">
        <Shadows />
      <Sky hours={16.4} timeScale={0} lighting={{ intensity: 6 }} />
        <Shapes />
        <ContactShadows />
        <EffectComposer>
          <Bloom strength={0.25} />
          <Tonemap />
        </EffectComposer>
        <OrbitControls enableDamping autoRotate autoRotateSpeed={0.5} />
      </Canvas>
    </main>
  );
}
