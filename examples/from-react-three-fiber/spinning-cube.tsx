// The usual React Three Fiber version of this task puts a mesh with a box geometry and a standard material inside the
// canvas, keeps a ref to the mesh, adds the frame delta to its Y rotation in the per-frame hook, and toggles a scale on
// click. In Margo the tags are capitalised components, the per-frame hook receives the engine and the delta in seconds,
// and the ref is the engine mesh itself.
import { useRef, useState } from 'react';
import { BoxGeometry, Canvas, Mesh, type MeshRef, PbrMaterial, Sun, useFrame } from '@margoengine/react';

export function SpinningCube() {
  const cube = useRef<MeshRef>(null);
  const [big, setBig] = useState(false);
  // Write the ref, not React state: no React render per frame.
  useFrame((_engine, delta) => {
    if (cube.current) cube.current.rotation.y += delta;
  });
  return (
    <>
      <Sun direction={[3, 5, 4]} intensity={3} />
      <Mesh ref={cube} scale={big ? [1.5, 1.5, 1.5] : [1, 1, 1]} onClick={() => setBig((value) => !value)}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" roughness={0.5} />
      </Mesh>
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 2, 5] }}>
      <SpinningCube />
    </Canvas>
  );
}
