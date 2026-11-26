// The usual React Three Fiber version of this task nests the helper library's HTML component inside a mesh, so a DOM
// element follows a point above the mesh on screen, optionally shrinking with distance and hiding behind other
// geometry. Margo's Html does the same from the optional html entry: nested in a Mesh, its position is a local offset.
import { BoxGeometry, Canvas, Mesh, PbrMaterial, Sun } from '@margoengine/react';
import { Html } from '@margoengine/react/html';

export function Labelled() {
  return (
    <>
      <Sun direction={[3, 5, 4]} intensity={3} />
      <Mesh position={[0, 0.5, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" />
        <Html position={[0, 0.8, 0]} anchor={[0.5, 1]} distanceScale={{ reference: 5, min: 0.5, max: 2 }} occlude>
          <div style={{ background: 'white', padding: '2px 6px', borderRadius: 4 }}>Crate</div>
        </Html>
      </Mesh>
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 2, 5] }}>
      <Labelled />
    </Canvas>
  );
}
