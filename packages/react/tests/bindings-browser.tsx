import React, { StrictMode, Suspense, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, useEngine } from '@margoengine/react';
import { Line } from '@margoengine/react/lines';
import { Points } from '@margoengine/react/points';
import { Outline } from '@margoengine/react/selection';
import { Detailed } from '@margoengine/react/lod';
import { Splat } from '@margoengine/react/splats';
import { GizmoHelper } from '@margoengine/react/viewcube';
import { OrthographicCamera } from '@margoengine/react/cameras';
import { Lines, Line as NativeLine } from '@margoengine/lines';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { Splats, parseSplat } from '@margoengine/splats';
import { transformSplats } from '@margoengine/splats/data';
import { CameraProjection } from '@margoengine/cameras';
import { engineRuntime } from '@margoengine/core/extension';
import type { LOD } from '@margoengine/lod';
import type { ViewCube } from '@margoengine/viewcube';

// Real Niantic capture excerpt. Source and MIT licence: packages/splats/test/fixtures/NOTICE.md.
const raw = parseSplat(await (await fetch('/packages/splats/test/fixtures/raccoon-v2.splat')).arrayBuffer());
const min = [Infinity, Infinity, Infinity],
  max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < raw.positions.length; i++) {
  const k = i % 3;
  min[k] = Math.min(min[k], raw.positions[i]);
  max[k] = Math.max(max[k], raw.positions[i]);
}
const scale = 3 / Math.max(...max.map((v, k) => v - min[k]));
const data = transformSplats(raw, [
  scale,
  0,
  0,
  0,
  0,
  scale,
  0,
  0,
  0,
  0,
  scale,
  0,
  ...min.map((v, k) => (-(v + max[k]) * scale) / 2),
  1,
]);
const linePoints = data.positions.slice(0, 90),
  material = { size: 4, color: '#60c0ff' };
const root = createRoot(document.querySelector('#app')!);
const state = { frames: [0, 0], errors: [] as string[], mode: '', engines: [] as ReturnType<typeof engineRuntime>[] };
const refs = {
  line: createRef<NativeLine>(),
  points: createRef<PointCloud>(),
  splat: createRef<Splats>(),
  lod: createRef<LOD>(),
  cube: createRef<ViewCube>(),
};
function Count({ side }: { side: number }) {
  useFrame(() => state.frames[side]++);
  return null;
}
function Cube({ color = '#ff3030' }: { color?: string }) {
  return (
    <Mesh>
      <BoxGeometry />
      <PbrMaterial color={color} />
    </Mesh>
  );
}
function Far() {
  const engine = useEngine();
  useFrame(() => {
    engine.camera.position = [0, 0, 15];
  });
  return null;
}
function App({ mode }: { mode: string }) {
  return (
    <StrictMode>
      {[0, 1].map((side) => (
        <section key={side} data-side={side}>
          <Canvas
            key={mode}
            backend="webgpu"
            camera={{ position: [0, 0, 5] }}
            onError={(error) => state.errors.push(String(error))}
            onCreated={(stage) => {
              const engine = engineRuntime(stage.engine);
              state.engines[side] = engine;
              if (side === 0) {
                if (mode === 'lines') {
                  const p = new Lines();
                  p.add(new NativeLine({ positions: linePoints, width: 5, color: '#60c0ff' }));
                  engine.use(p);
                }
                if (mode === 'points') {
                  const p = new PointsPlugin();
                  p.add(new PointCloud({ positions: data.positions, material }));
                  engine.use(p);
                }
                if (mode === 'splats') Splats.attach(stage.engine, data);
                if (mode === 'cameras') CameraProjection.attach(stage.engine, { height: 4 });
                if (mode === 'parent') {
                  const parent = engine.createMesh().setPosition([1, 0, 0]);
                  const lines = new Lines();
                  lines.add(new NativeLine({ positions: linePoints, width: 5, color: '#60c0ff', mesh: parent }));
                  engine.use(lines);
                  const points = new PointsPlugin();
                  points.add(new PointCloud({ positions: data.positions, material }).attach(parent));
                  engine.use(points);
                }
              }
            }}
          >
            <Count side={side} />
            {side === 1 && mode === 'lines' && (
              <Line ref={refs.line} points={linePoints} lineWidth={5} color="#60c0ff" />
            )}
            {side === 1 && mode === 'points' && (
              <Points ref={refs.points} positions={data.positions} material={material} />
            )}
            {side === 1 && mode === 'splats' && <Splat ref={refs.splat} data={data} />}
            {side === 1 && mode === 'parent' && (
              <Mesh position={[1, 0, 0]}>
                <Line points={linePoints} lineWidth={5} color="#60c0ff" />
                <Points positions={data.positions} material={material} />
              </Mesh>
            )}
            {mode === 'cameras' && (
              <>
                <Cube />
                {side === 1 && <OrthographicCamera makeDefault height={4} position={[0, 0, 5]} />}
              </>
            )}
            {mode === 'lod' && side === 1 && (
              <>
                <Far />
                <Detailed ref={refs.lod} distances={[0, 10]}>
                  <Cube />
                  <Cube color="#30ff30" />
                </Detailed>
              </>
            )}
            {mode === 'outline' && side === 1 && (
              <Mesh>
                <BoxGeometry />
                <PbrMaterial color="#ff3030" />
                <Outline color={[0, 1, 0]} width={6} />
              </Mesh>
            )}
            {mode === 'viewcube' && side === 1 && (
              <>
                <Cube />
                <GizmoHelper ref={refs.cube} duration={0} corner="bottom-right" />
              </>
            )}
            {mode === 'url' && side === 1 && (
              <Suspense fallback={null}>
                <Splat src="/packages/splats/test/fixtures/raccoon-v2.splat" />
              </Suspense>
            )}
          </Canvas>
        </section>
      ))}
    </StrictMode>
  );
}
Object.assign(window, {
  bindingProof: {
    state,
    refs,
    mount(mode: string) {
      state.mode = mode;
      state.frames = [0, 0];
      state.errors = [];
      root.render(<App mode={mode} />);
    },
    unmount() {
      root.unmount();
    },
  },
});
