// Real-GPU harness for React's multi-view, BatchedMesh and SectionPlanes (scripts/test-extras-browser.js reads pixels).
import React, { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { boxGeometry } from '@margoengine/geometry';
import {
  Canvas,
  Mesh,
  BoxGeometry,
  PbrMaterial,
  Scene,
  RenderView,
  BatchedMesh,
  BatchedItem,
  SectionPlanes,
  useFrame,
} from '@margoengine/react';

type Mode = 'views' | 'batched' | 'section';
const state = { frames: 0, errors: [] as string[] };
const cube = boxGeometry(1.6, 1.6, 1.6);
function Count() {
  useFrame(() => {
    state.frames++;
  });
  return null;
}
function Red() {
  return (
    <Mesh>
      <BoxGeometry args={[2.4, 2.4, 2.4]} />
      <PbrMaterial color="#ff2020" roughness={0.6} />
    </Mesh>
  );
}
function App({ mode }: { mode: Mode }) {
  return (
    <StrictMode>
      <Canvas
        backend="webgpu"
        camera={
          mode === 'section' ? { position: [0, 0, 6], target: [0, 0, 0] } : { position: [0, 0, 7], target: [0, 0, 0] }
        }
        onError={(error) => state.errors.push(String(error))}
      >
        <Count />
        {mode === 'views' && (
          <>
            <RenderView viewport={[0, 0, 0.5, 1]} />
            <RenderView viewport={[0.5, 0, 0.5, 1]} scene="hud" order={1} />
            <Red />
            <Scene name="hud" background="#000000">
              <Mesh>
                <BoxGeometry args={[2.4, 2.4, 2.4]} />
                <PbrMaterial color="#20ff20" roughness={0.6} />
              </Mesh>
            </Scene>
          </>
        )}
        {mode === 'batched' && (
          <BatchedMesh maxItems={2} maxVertices={48}>
            <BatchedItem geometry={cube} position={[-2.2, 0, 0]} color="#ff2020" />
            <BatchedItem geometry={cube} position={[2.2, 0, 0]} color="#2020ff" />
          </BatchedMesh>
        )}
        {mode === 'section' && (
          <>
            <Red />
            {/* Points with -x < 0 (the right half) are cut away. */}
            <SectionPlanes planes={[[-1, 0, 0, 0]]} />
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
    root.render(<App mode={mode} />);
  },
  unmount() {
    root?.unmount();
    root = undefined;
  },
};
(window as typeof window & { extras: typeof harness }).extras = harness;
