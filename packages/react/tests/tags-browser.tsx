/** @jsxImportSource @margoengine/react */
// Real-GPU harness for the lowercase tags of @margoengine/react/jsx-runtime (scripts/test-tags-browser.js reads pixels).
// This file is compiled with Margo's JSX runtime, as an app that sets jsxImportSource is.
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Canvas, extend, useFrame } from '@margoengine/react';
import { Box, Plane, SphereGeometry } from '@margoengine/react/geometry';
import { Figure, GameUi, ScatterPlot, Sound, Sprite, SpriteLayer } from '@margoengine/react/ui';
import { HealthBar, Panel } from '@margoengine/ui/react';
import type { Audio } from '@margoengine/audio';

extend({ SphereGeometry });
declare module '@margoengine/react' {
  interface MargoElements {
    sphereGeometry: import('react').ComponentProps<typeof SphereGeometry>;
  }
}
type Mode = 'tags' | 'bubbling' | 'textured' | 'sprites' | 'ui' | 'figure' | 'sound';
// A 2 x 1 atlas, red then green, and 2,000 points on a spiral for the figure.
const atlas = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };
const spiral = (() => {
  const x = new Float32Array(2000),
    y = new Float32Array(2000),
    z = new Float32Array(2000);
  for (let i = 0; i < 2000; i++) {
    const t = i / 100;
    x[i] = Math.cos(t) * t;
    y[i] = Math.sin(t) * t;
    z[i] = t;
  }
  return { x, y, z, color: z };
})();
// Real files: a Khronos sample JPEG and a KayKit PNG (THIRD-PARTY-NOTICES.md), served by the test's Vite server.
const jpeg = '/examples/assets/khronos-samples/CesiumMan.jpg',
  png = '/examples/assets/kaykit/dungeon/pieces/dungeon_texture.png';
const state = { frames: 0, errors: [] as string[], events: [] as string[], sound: null as Audio | null, ready: 0 };
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
        {mode === 'textured' && (
          <>
            <directionalLight position={[0, 0, 5]} intensity={3} />
            <Plane position={[-2, 0, 0]} args={[3.6, 3.6]} map={jpeg} />
            <Box
              position={[2.2, 0, 0]}
              args={[1.8, 1.8, 1.8]}
              map={png}
              onClick={(event) => log(`box click ${event.target === event.currentTarget ? 'self' : 'child'}`)}
            />
          </>
        )}
        {mode === 'sprites' && (
          <SpriteLayer atlas={atlas}>
            <Sprite x={96} y={64} rect={[0, 0, 1, 1]} scaleX={64} scaleY={64} />
            <Sprite x={352} y={64} rect={[1, 0, 1, 1]} scaleX={64} scaleY={64} />
          </SpriteLayer>
        )}
        {mode === 'ui' && (
          <GameUi>
            <Panel anchor="top-left" margin={16} padding={8} background="surface">
              <HealthBar value={100} max={100} width={200} />
            </Panel>
          </GameUi>
        )}
        {mode === 'figure' && (
          <Figure onReady={() => state.ready++}>
            <ScatterPlot data={spiral} options={{ size: 4 }} />
          </Figure>
        )}
        {mode === 'sound' && (
          <mesh>
            <Sound
              src="/packages/cutscene/tests/fixtures/arctic/arctic_a0001.wav"
              ref={(sound) => {
                state.sound = sound;
              }}
            />
          </mesh>
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
