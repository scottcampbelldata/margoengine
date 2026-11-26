// The usual React Three Fiber version of this task wraps bloom and an antialiasing pass in the postprocessing
// library's effect composer and gives a mesh a bright emissive colour so it glows. Margo's EffectComposer and its
// effects come from the optional post entry; each effect is a child component, as there. An emissive colour (like any
// texture map) is a mapped material in Margo, so it uses MappedPbrMaterial from the textures entry.
import { BoxGeometry, Canvas, Mesh, Sun } from '@margoengine/react';
import { Bloom, EffectComposer, SMAA } from '@margoengine/react/post';
import { MappedPbrMaterial } from '@margoengine/react/textures';

export function Glow() {
  return (
    <>
      <Sun direction={[3, 5, 4]} intensity={2} />
      <Mesh position={[0, 1, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <MappedPbrMaterial color="#202020" emissive="#ff7a30" emissiveIntensity={4} />
      </Mesh>
      <EffectComposer>
        <Bloom strength={0.8} threshold={1} radius={0.5} />
        <SMAA />
      </EffectComposer>
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 2, 5] }}>
      <Glow />
    </Canvas>
  );
}
