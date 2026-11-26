// The usual React Three Fiber version of this task turns shadows on with a canvas flag, adds a directional light that
// casts shadows, marks the box as a caster and the floor as a receiver, and loads an HDR image through the helper
// library's environment component for image-based light and a background. In Margo shadows are turned on by mounting
// the Shadows component from the optional shadows entry; the light is the Sun, and casting and receiving stay per mesh.
import { Suspense } from 'react';
import { Canvas, Sun } from '@margoengine/react';
import { Environment } from '@margoengine/react/environment';
import { Box, Plane } from '@margoengine/react/geometry';
import { ContactShadows, Shadows } from '@margoengine/react/shadows';

export function LitScene() {
  return (
    <>
      <Shadows />
      <Sun direction={[3, 5, 4]} intensity={3} />
      <Suspense fallback={null}>
        <Environment src="/hdr/studio.hdr" exposure={1} background blur={0.2} />
      </Suspense>
      <Box castShadow position={[0, 0.5, 0]} />
      <Plane receiveShadow rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
      <ContactShadows position={[2, 0.01, 0]} width={2} height={2} opacity={0.6} />
    </>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [3, 2, 5] }}>
      <LitScene />
    </Canvas>
  );
}
