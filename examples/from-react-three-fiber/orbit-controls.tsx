// The usual React Three Fiber version of this task adds the helper library's orbit controls component next to the
// scene, with damping on, a target point and distance limits. Margo's OrbitControls takes the same kind of props from
// the optional controls entry, and a drag that orbits never fires a mesh click.
import { Canvas, Sun } from '@margoengine/react';
import { OrbitControls } from '@margoengine/react/controls';
import { Box, Plane } from '@margoengine/react/geometry';

export function Orbit() {
  return (
    <>
      <Sun direction={[3, 5, 4]} intensity={3} />
      <Box position={[0, 0.5, 0]} />
      <Plane rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
      <OrbitControls target={[0, 0.5, 0]} enableDamping minDistance={2} maxDistance={20} maxPolarAngle={Math.PI / 2} />
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [3, 2, 5] }}>
      <Orbit />
    </Canvas>
  );
}
