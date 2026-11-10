import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Scene, RenderView, useEngine, useFrame, Group } from '@margoengine/react';
import { Instances, Instance } from '@margoengine/react/instances';
import { parseGLTF } from '@margoengine/gltf';
import { engineRuntime, PbrMaterial, type Geometry } from '@margoengine/core/extension';

// Unmodified standard data: Cesium Box, CC-BY-4.0, notice in procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const state = {
  engines: [] as ReturnType<typeof engineRuntime>[],
  frames: [0, 0],
  errors: [] as string[],
  clicks: [] as number[],
  refs: [] as number[],
};
const positions = [
  [-0.8, 0, 0],
  [0.8, 0, 0],
] as const;
function Content({ side, mode }: { side: number; mode: string }) {
  const handle = useEngine(),
    engine = engineRuntime(handle),
    [geometry, setGeometry] = useState<Geometry | null>(null);
  useFrame(() => state.frames[side]++);
  useEffect(() => {
    const loaded = parseGLTF(handle, bytes),
      source = engine.meshes.get(loaded.meshes[0].id)!.geometry!;
    loaded.dispose();
    setGeometry(source);
    const native = [] as ReturnType<typeof engine.createMesh>[];
    if (side === 0) {
      const world = mode === 'scene' ? engine.createScene('native') : engine;
      if (mode === 'scene') engine.views = [{ scene: world, camera: engine.camera, viewport: [0, 0, 1, 1] }];
      for (let i = 0; i < (mode === 'range' ? 1 : 2); i++) {
        const mesh = world
          .createMesh()
          .setGeometry(source)
          .setMaterial(new PbrMaterial({ color: i ? '#00ff00' : '#ff0000', roughness: 0.7 }));
        mesh.setPosition(positions[i]).setRotation([0.1, 0.2, 0]).setScale([0.7, 0.8, 0.7]);
        native.push(mesh);
      }
    }
    return () => {
      for (const mesh of native) mesh.dispose();
    };
  }, [engine, mode, side]);
  if (side === 0 || !geometry) return null;
  const batch = (
    <Instances
      geometry={geometry}
      range={mode === 'range' ? 1 : 2}
      material={new PbrMaterial({ color: '#ffffff', roughness: 0.7 })}
    >
      {positions.map((p, i) => (
        <Group key={i} position={p}>
          <Instance
            ref={(mesh) => {
              if (mesh) state.refs[i] = mesh.id;
            }}
            color={i ? '#00ff00' : '#ff0000'}
            rotation={[0.1, 0.2, 0]}
            scale={[0.7, 0.8, 0.7]}
            onClick={(e) => state.clicks.push(e.object.id)}
          />
        </Group>
      ))}
    </Instances>
  );
  return mode === 'scene' ? (
    <>
      <Scene name="wrapped">{batch}</Scene>
      <RenderView scene="wrapped" />
    </>
  ) : (
    batch
  );
}
const root = createRoot(document.querySelector('#app')!);
const proof = {
  state,
  mount(mode: string) {
    state.frames = [0, 0];
    state.errors = [];
    state.clicks = [];
    state.refs = [];
    root.render(
      <StrictMode>
        <div style={{ display: 'flex' }}>
          {[0, 1].map((side) => (
            <section key={side} data-side={side}>
              <Canvas
                key={mode}
                backend="webgpu"
                camera={{ position: [0, 0, 5] }}
                onCreated={(stage) => {
                  state.engines[side] = engineRuntime(stage.engine);
                }}
                onError={(error) => state.errors.push(String(error))}
              >
                <Content side={side} mode={mode} />
              </Canvas>
            </section>
          ))}
        </div>
      </StrictMode>,
    );
  },
  snapshot() {
    return state.engines.map((engine) => ({
      ...([...engine.meshes.values()].find((mesh) => mesh.geometry)?.scene.stats ?? engine.stats),
    }));
  },
  unmount() {
    root.unmount();
  },
};
Object.assign(window, { instancesProof: proof });
