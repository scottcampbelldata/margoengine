// useFBO on a real GPU, WebGPU or the WebGL2 compatibility layer (scripts/test-fbo-browser.mjs): the right canvas
// draws a scene into a useFBO target through a RenderView and shows it on an unlit plane; the left canvas does the same
// with core views and a texture made by hand. Their screenshots must match exactly.
import React, { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, GeometryResource, PbrMaterial, RenderView, Scene, useEngine, useFrame } from '@margoengine/react';
import { PlaneGeometry } from '@margoengine/react/geometry';
import { TextureMaterial } from '@margoengine/react/textures';
import { useFBO } from '@margoengine/react/portals';
import { Camera, PbrMaterial as NativePbr } from '@margoengine/core';
import { engineRuntime, type Geometry } from '@margoengine/core/extension';
import { parseGLTF } from '@margoengine/gltf';
import { Texture, UnlitMaterial, createMesh } from '@margoengine/materials';
import { planeGeometry } from '@margoengine/geometry';
// Khronos Cesium Box CC-BY-4.0; existing procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const pose = { position: [0, 0, 4] as [number, number, number] };
const state = {
  frames: [0, 0],
  errors: [] as string[],
  engines: [] as ReturnType<typeof engineRuntime>[],
  sizes: [] as number[][],
  depth: [] as string[],
};
// mode: 'fixed' (64 by 64), 'canvas' (the drawing buffer's size) or 'depth' (64 by 64 with a depth texture).
function Native({ mode }: { mode: string }) {
  const handle = useEngine(),
    [canvas, setCanvas] = useState<[number, number] | null>(null);
  useFrame(() => {
    state.frames[0]++;
    const { width, height } = engineRuntime(handle).canvas;
    if (canvas?.[0] !== width || canvas?.[1] !== height) setCanvas([width, height]);
  });
  useEffect(() => {
    if (!canvas) return;
    const engine = engineRuntime(handle),
      parsed = parseGLTF(handle, bytes),
      source = engine.meshes.get(parsed.meshes[0].id)!.geometry!;
    parsed.dispose();
    const scene = engine.createScene('native-inside'),
      camera = new Camera(pose);
    scene.createMesh().setGeometry(source).setMaterial(new NativePbr({ color: '#ff4433' }));
    scene.background = '#000000';
    const [w, h] = mode === 'canvas' ? canvas : [64, 64];
    state.sizes[0] = [w, h];
    const target = engine.gpu!.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 21 }),
      borrowed = new Texture(target, { wrapS: 'clamp', wrapT: 'clamp' }),
      material = new UnlitMaterial({ color: '#ffffff', map: borrowed }),
      model = createMesh(handle, planeGeometry(2, 2), material);
    engine.views = [
      { camera, scene, viewport: [0, 0, 1, 1], target: { color: target } },
      { camera: engine.camera, viewport: [0, 0, 1, 1] },
    ];
    return () => {
      model.dispose();
      material.dispose();
      borrowed.dispose();
      target.destroy();
      scene.dispose();
    };
  }, [handle, mode, mode === 'canvas' ? canvas?.join() : canvas !== null]);
  return null;
}
function Bound({ mode }: { mode: string }) {
  const handle = useEngine(),
    [geometry, setGeometry] = useState<Geometry | null>(null),
    camera = useMemo(() => new Camera(pose), []),
    size = mode === 'canvas' ? undefined : 64,
    fbo = useFBO(size, size, { depth: mode === 'depth' });
  useFrame(() => state.frames[1]++);
  useEffect(() => {
    const parsed = parseGLTF(handle, bytes);
    setGeometry(engineRuntime(handle).meshes.get(parsed.meshes[0].id)!.geometry!);
    parsed.dispose();
  }, [handle]);
  useEffect(() => {
    if (!fbo) return;
    state.sizes[1] = [fbo.width, fbo.height];
    state.depth[1] = fbo.target.depth ? `${fbo.target.depth.format}x${fbo.target.depth.sampleCount}` : '';
  }, [fbo]);
  if (!geometry) return null;
  return (
    <>
      <Scene name="inside" background="#000000">
        <Mesh>
          <GeometryResource geometry={geometry} />
          <PbrMaterial color="#ff4433" />
        </Mesh>
      </Scene>
      {fbo && <RenderView scene="inside" camera={camera} target={fbo.target} order={-1} />}
      <RenderView />
      <Mesh>
        <PlaneGeometry args={[2, 2]} />
        <TextureMaterial material={new UnlitMaterial({ color: '#ffffff' })} map={fbo?.texture ?? null} />
      </Mesh>
    </>
  );
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, {
  fboProof: {
    state,
    mount(mode: string) {
      state.frames = [0, 0];
      state.errors = [];
      state.sizes = [];
      state.depth = [];
      root.render(
        <StrictMode>
          {[0, 1].map((side) => (
            <section key={side} data-side={side}>
              <Canvas
                key={mode}
                backend="webgpu"
                camera={pose}
                onCreated={(stage) => {
                  state.engines[side] = engineRuntime(stage.engine);
                }}
                onError={(error) => state.errors.push(String(error))}
              >
                {side ? <Bound mode={mode} /> : <Native mode={mode} />}
              </Canvas>
            </section>
          ))}
        </StrictMode>,
      );
    },
    unmount() {
      root.unmount();
    },
  },
});
