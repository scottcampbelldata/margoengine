// Real-GPU harness for React's multi-view, BatchedMesh, Voxels and Sky (scripts/test-extras-browser.js reads pixels).
import React, { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { boxGeometry } from '@margoengine/geometry';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { BlockTextures } from '@margoengine/voxel/render';
import { Sphere } from '@margoengine/react/geometry';
import { Sky } from '@margoengine/react/sky';
import {
  Canvas,
  Mesh,
  BoxGeometry,
  PbrMaterial,
  Scene,
  RenderView,
  useFrame,
} from '@margoengine/react';
import { DevTools } from '@margoengine/react/devtools';
import { Billboard, Bounds, Float } from '@margoengine/react/helpers';
import { Grid } from '@margoengine/react/lines';
import { BatchedMesh, BatchedItem } from '@margoengine/react/materials';
import { Voxels } from '@margoengine/react/voxel';

type Mode = 'views' | 'batched' | 'voxels' | 'sky-metal' | 'sky-metal-off' | 'helpers' | 'hints' | 'hints-webgl2';
// A 4 x 4 x 4 block of one red stone type, textured from raw pixels (no image files).
const blocks = new BlockTypes(),
  stone = blocks.define('stone'),
  world = new VoxelWorld({ blocks }),
  red = new Uint8Array(16 * 16 * 4).map((_, i) => [220, 40, 40, 255][i % 4]),
  textures = new BlockTextures({ images: [{ width: 16, height: 16, data: red }] });
for (let x = -2; x < 2; x++) for (let y = 62; y < 66; y++) for (let z = -2; z < 2; z++) world.setBlock(x, y, z, stone);
const state = { frames: 0, errors: [] as string[] };
const cube = boxGeometry(1.6, 1.6, 1.6);
function Count() {
  useFrame(() => {
    state.frames++;
  });
  return null;
}
function Red() {
  // Not a plain `return <Mesh>`: that is a tail call, and WebKit (which has proper tail calls) drops Red from the owner
  // stack, so the mesh names the next component up. README, "DevTools".
  const mesh = (
    <Mesh>
      <BoxGeometry args={[2.4, 2.4, 2.4]} />
      <PbrMaterial color="#ff2020" roughness={0.6} />
    </Mesh>
  );
  return mesh;
}
function App({ mode }: { mode: Mode }) {
  return (
    <StrictMode>
      <Canvas
        backend={mode === 'hints-webgl2' ? 'webgl2' : 'webgpu'}
        loadFallback={mode === 'hints-webgl2' ? () => import('@margoengine/webgl2-compat/preview') : undefined}
        camera={
          mode === 'voxels' ? { position: [6, 70, 9], target: [0, 64, 0] } : { position: [0, 0, 7], target: [0, 0, 0] }
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
        {/* The box starts far outside the view: only Bounds brings it in. Two grids share the Canvas. */}
        {mode === 'helpers' && (
          <>
            <DevTools />
            <Grid size={4} position={[40, -2, 0]} />
            <Grid size={8} position={[40, -3, 0]} />
            <Bounds fit clip duration={0} margin={1.05} position={[40, 0, 0]}>
              <Float floatingRange={[0, 0.01]} rotationIntensity={0}>
                <Billboard>
                  <Red />
                </Billboard>
              </Float>
            </Bounds>
          </>
        )}
        {mode === 'voxels' && <Voxels world={world} textures={textures} />}
        {/* The two development hints: Vite serves this page and it has no global `process`. */}
        {mode === 'hints' && <mesh />}
        {mode === 'hints-webgl2' && (
          <Mesh onClick={() => {}}>
            <BoxGeometry args={[1, 1, 1]} />
            <PbrMaterial color="#ff2020" />
          </Mesh>
        )}
        {/* A metal sphere whose only light is the Sky; the fallback environment is what lights it. */}
        {(mode === 'sky-metal' || mode === 'sky-metal-off') && (
          <>
            <Sky hours={12} timeScale={0} environment={mode === 'sky-metal'} />
            <Sphere args={[1.6, 48, 24]} color="#ffffff" metalness={1} roughness={0.25} />
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
