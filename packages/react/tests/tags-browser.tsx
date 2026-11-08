/** @jsxImportSource @margoengine/react */
// Real-GPU harness for the lowercase tags of @margoengine/react/jsx-runtime (scripts/test-tags-browser.js reads pixels).
// This file is compiled with Margo's JSX runtime, as an app that sets jsxImportSource is.
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Canvas, extend, useFrame } from '@margoengine/react';
import { SphereGeometry } from '@margoengine/react/geometry';

extend({ SphereGeometry });
declare module '@margoengine/react' {
  interface MargoElements {
    sphereGeometry: import('react').ComponentProps<typeof SphereGeometry>;
  }
}
type Mode = 'tags' | 'bubbling';
const state = { frames: 0, errors: [] as string[], events: [] as string[] };
const log = (entry: string) => state.events.push(entry);
function Count() {
  useFrame(() => {
    state.frames++;
  });
  return null;
}
function App({ mode }: { mode: Mode }) {
  return (
    <StrictMode>
      <Canvas
        backend="webgpu"
        camera={{ position: [0, 0, 7], target: [0, 0, 0] }}
        onError={(error) => state.errors.push(String(error))}
        onPointerMissed={(event) => log(`canvas missed ${event.type}`)}
      >
        <Count />
        {mode === 'tags' && (
          <>
            <directionalLight position={[0, 0, 5]} intensity={3} />
            <group position={[0, 0, 0]}>
              <mesh position={[-2.2, 0, 0]}>
                <boxGeometry args={[1.8, 1.8, 1.8]} />
                <meshStandardMaterial color="#ff2020" roughness={0.6} />
              </mesh>
              <mesh position={[2.2, 0, 0]}>
                <sphereGeometry args={[1, 32, 16]} />
                <meshStandardMaterial color="#2040ff" roughness={0.6} />
              </mesh>
            </group>
          </>
        )}
        {mode === 'bubbling' && (
          <>
            <directionalLight position={[0, 0, 5]} intensity={3} />
            <group
              onClick={(event) => log(`group click on ${event.target === event.currentTarget ? 'group' : 'child'}`)}
              onPointerOver={() => log('group over')}
              onPointerEnter={() => log('group enter')}
              onPointerMissed={(event) => log(`group missed ${event.type}`)}
            >
              <mesh
                position={[-2.2, 0, 0]}
                onClick={(event) => log(`box click ${event.target === event.currentTarget}`)}
                onPointerOver={() => log('box over')}
                onPointerEnter={() => log('box enter')}
              >
                <boxGeometry args={[1.8, 1.8, 1.8]} />
                <meshStandardMaterial color="#ff2020" roughness={0.6} />
              </mesh>
              <mesh
                position={[2.2, 0, 0]}
                onClick={(event) => {
                  log('sphere click');
                  event.stopPropagation();
                }}
              >
                <sphereGeometry args={[1, 32, 16]} />
                <meshStandardMaterial color="#2040ff" roughness={0.6} />
              </mesh>
            </group>
          </>
        )}
      </Canvas>
    </StrictMode>
  );
}
let root: Root | undefined;
const harness = {
  state,
  mount(mode: Mode) {
    root?.unmount();
    root = createRoot(document.querySelector('#app')!);
    state.frames = 0;
    state.events.length = 0;
    root.render(<App mode={mode} />);
  },
  unmount() {
    root?.unmount();
    root = undefined;
  },
};
(window as typeof window & { tags: typeof harness }).tags = harness;
