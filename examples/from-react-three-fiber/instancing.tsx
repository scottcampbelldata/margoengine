// The usual React Three Fiber version of this task uses the helper library's instances component: one shared geometry
// and material as children, then many instance children, each with its own position and colour. Margo's Instances and
// Instance come from the optional instances entry and work the same way: one draw per shared geometry, and every
// instance keeps its own ref, colour and pointer handlers.
import { BoxGeometry, Canvas, PbrMaterial } from '@margoengine/react';
import { Instance, Instances } from '@margoengine/react/instances';

const cubes = Array.from({ length: 100 }, (_, i) => ({
  position: [(i % 10) - 4.5, 0.25, Math.floor(i / 10) - 4.5] as const,
  color: i % 2 ? '#ff8040' : '#40c080',
}));

export function CubeGrid() {
  return (
    <Instances limit={cubes.length}>
      <BoxGeometry args={[0.5, 0.5, 0.5]} />
      <PbrMaterial color="#ffffff" roughness={0.7} />
      {cubes.map((cube, i) => (
        <Instance key={i} position={cube.position} color={cube.color} onClick={(event) => console.log(event.object)} />
      ))}
    </Instances>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 8, 10] }}>
      <CubeGrid />
    </Canvas>
  );
}
