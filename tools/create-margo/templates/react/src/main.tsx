import { StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BoxGeometry, Canvas, Mesh, OrbitControls, PbrMaterial, useFrame, type MeshRef } from 'margoengine/react';

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

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <Canvas style={{ height: '100%' }} label="A rotating cube. Drag to orbit.">
      <Cube />
      <OrbitControls enableDamping />
    </Canvas>
  </StrictMode>,
);
