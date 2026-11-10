import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, GeometryResource, PbrMaterial, useEngine, useFrame } from '@margoengine/react';
import { PlaneGeometry } from '@margoengine/react/geometry';
import { TextureMaterial } from '@margoengine/react/textures';
import { Hud, RenderTexture } from '@margoengine/react/portals';
import { Camera, PbrMaterial as NativePbr } from '@margoengine/core';
import { engineRuntime, type Geometry } from '@margoengine/core/extension';
import { parseGLTF } from '@margoengine/gltf';
import { Texture, UnlitMaterial, createMesh } from '@margoengine/materials';
import { planeGeometry } from '@margoengine/geometry';
// Khronos Cesium Box CC-BY-4.0; existing procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const pose = { position: [0, 0, 4] as [number, number, number] };
const state = { frames: [0, 0], errors: [] as string[], engines: [] as ReturnType<typeof engineRuntime>[] };
function Body({ side, mode }: { side: number; mode: string }) {
  const handle = useEngine(), [geometry, setGeometry] = useState<Geometry | null>(null), [texture, setTexture] = useState<Texture | null>(null);
  useFrame(() => state.frames[side]++);
  useEffect(() => {
    const engine = engineRuntime(handle), parsed = parseGLTF(handle, bytes), source = engine.meshes.get(parsed.meshes[0].id)!.geometry!; parsed.dispose(); setGeometry(source);
    if (side) return;
    const scene = engine.createScene('native-portal'), camera = new Camera(pose), mesh = scene.createMesh().setGeometry(source).setMaterial(new NativePbr({ color: '#ff4433' }));
    const worlds = [scene], materials: UnlitMaterial[] = [];
    let target: GPUTexture | undefined, borrowed: Texture | undefined, model: ReturnType<typeof createMesh> | undefined;
    const view = { camera, scene, viewport: [0, 0, 1, 1] as const };
    if (mode === 'texture') {
      target = engine.gpu!.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: 21 }); borrowed = new Texture(target, { wrapS: 'clamp', wrapT: 'clamp' });
      const material = new UnlitMaterial({ color: '#ffffff', map: borrowed }); materials.push(material); model = createMesh(handle, planeGeometry(2, 2), material);
      scene.background = '#000000'; engine.views = [{ ...view, target: { color: target } }, { camera: engine.camera, viewport: [0, 0, 1, 1] }];
    } else {
      scene.background = null;
      engine.views = [{ camera: engine.camera, viewport: [0, 0, 1, 1] }, { ...view, clear: { color: false, depth: true } }];
      if (mode === 'stacked') {
        const top = engine.createScene('native-top'); worlds.push(top); top.createMesh().setGeometry(source).setScale([0.5, 0.5, 0.5]).setMaterial(new NativePbr({ color: '#33ff66' }));
        engine.views = [...engine.views, { camera, scene: top, viewport: [0, 0, 1, 1], clear: { color: false, depth: true } }];
      }
    }
    return () => { model?.dispose(); materials.forEach(m => m.dispose()); borrowed?.dispose(); target?.destroy(); worlds.forEach(w => w.dispose()); void mesh; };
  }, [handle, side, mode]);
  if (!side || !geometry) return null;
  const cube = <Mesh><GeometryResource geometry={geometry} /><PbrMaterial color="#ff4433" /></Mesh>;
  return mode === 'texture' ? <><RenderTexture width={64} height={64} cameraOptions={pose} onTexture={setTexture}>{cube}</RenderTexture>{texture && <Mesh><PlaneGeometry args={[2, 2]} /><TextureMaterial material={new UnlitMaterial({ color: '#ffffff' })} map={texture} /></Mesh>}</> : <><Hud cameraOptions={pose}>{cube}</Hud>{mode === 'stacked' && <Hud renderPriority={2} cameraOptions={pose}><Mesh scale={[0.5, 0.5, 0.5]}><GeometryResource geometry={geometry} /><PbrMaterial color="#33ff66" /></Mesh></Hud>}</>;
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, { portalsProof: { state, mount(mode: string) {
  state.frames = [0, 0]; state.errors = [];
  root.render(<StrictMode>{[0, 1].map(side => <section key={side} data-side={side}><Canvas key={mode} backend="webgpu" camera={pose} onCreated={stage => { state.engines[side] = engineRuntime(stage.engine); }} onError={error => state.errors.push(String(error))}><Body side={side} mode={mode} /></Canvas></section>)}</StrictMode>);
}, unmount() { root.unmount(); } } });
