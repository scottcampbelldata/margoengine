'use client';
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';

function Cube() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => {
    if (mesh.current) mesh.current.rotation.y += delta;
  });
  return (
    <Mesh ref={mesh}>
      <BoxGeometry />
      <PbrMaterial color="#84d6bd" roughness={0.3} />
    </Mesh>
  );
}

/** The 3D part of the page. Only this file needs 'use client'; the page around it stays a server component. */
export function Scene() {
  return (
    <Canvas style={{ height: '70vh' }} label="Rotating 3D cube">
      <Cube />
    </Canvas>
  );
}
