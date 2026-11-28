'use client';
import { useEffect, useRef, useState } from 'react';
import { BROWSER_HELP, NO_WEBGPU, hasWebGPU } from './browser';
import type { Mesh as MeshHandle } from '@margoengine/kit-react/core';
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
} from '@margoengine/kit-react';

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
  const [ready, setReady] = useState<'wait' | 'ok' | 'no'>('wait');
  useEffect(() => {
    hasWebGPU()
      .then((ok) => setReady(ok ? 'ok' : 'no'))
      .catch(() => setReady('no'));
  }, []);
  if (ready !== 'ok') {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          alignContent: 'center',
          gap: 12,
          padding: 32,
          background: '#f4f7f8',
          color: '#1c2430',
          textAlign: 'center',
        }}
      >
        <p>{ready === 'wait' ? 'Starting...' : NO_WEBGPU}</p>
        {ready === 'no' ? <a href={BROWSER_HELP}>Browsers that run Margo</a> : null}
      </main>
    );
  }
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
