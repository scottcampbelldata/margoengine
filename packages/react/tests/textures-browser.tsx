import React, { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Scene, RenderView, Mesh, useEngine, useFrame } from '@margoengine/react';
import { PlaneGeometry } from '@margoengine/react/geometry';
import { TextureMaterial, useTexture, useKTX2, useVideoTexture } from '@margoengine/react/textures';
import { useResourceEffect } from '../dist/internal.js';
import { engineRuntime } from '@margoengine/core/extension';
import { Material, PbrMaterial, UnlitMaterial, LambertMaterial, PhongMaterial, ToonMaterial, NormalMaterial, MatcapMaterial, DepthMaterial, DistanceMaterial, createMesh, install } from '@margoengine/materials';
import { planeGeometry } from '@margoengine/geometry';
const image = '/examples/assets/kaykit/dungeon/pieces/dungeon_texture.png';
const classes = [Material, PbrMaterial, UnlitMaterial, LambertMaterial, PhongMaterial, ToonMaterial, NormalMaterial, MatcapMaterial, DepthMaterial, DistanceMaterial];
const state = { ready: [false, false], frames: [0, 0], errors: [] as string[], engines: [] as ReturnType<typeof engineRuntime>[] };
function MaterialBody({ side, mode }: { side: number; mode: string }) {
  const engine = useEngine();
  const source = mode.split(':')[0];
  const texture = source === 'ktx' ? useKTX2('/packages/decoders/tests/fixtures/Dot_C.ktx2') : source === 'video' ? useVideoTexture('/examples/assets/parity-clip.webm', { start: false, unsuspend: 'loadeddata' }) : useTexture({ map: image }).map;
  const Type = classes[Number(mode.split(':')[1]) || 0];
  useFrame(() => state.frames[side]++);
  const material = React.useMemo(() => new Type({ ...(Type === DistanceMaterial ? { nearDistance: 1, farDistance: 8 } : {}), color: '#ffffff', roughness: 0.5, metalness: 0.4, emissive: source === 'video' ? [1, 1, 1] : [0.1, 0.1, 0.1], side: 'double' }), [Type]);
  const props = { material, map: texture, normalMap: texture, emissiveMap: texture, ...(source === 'rough' ? { roughnessMap: texture } : { metalRoughnessMap: texture }), ...(source === 'transmission' ? { transmissionOptions: { factor: 0.4, volume: { thicknessFactor: 0.2 } } } : {}) };
  useResourceEffect(() => {
    const video = source === 'video' ? texture.source as HTMLVideoElement : null;
    const ready = () => { state.ready[side] = true; };
    if (video) { video.addEventListener('seeked', ready, { once: true }); video.currentTime = Math.min(0.25, video.duration / 2); }
    else ready();
    if (side !== 0) return () => { video?.removeEventListener('seeked', ready); material.dispose(); };
    Object.assign(material, { map: texture, normalMap: texture, emissiveMap: texture, metalRoughnessMap: texture });
    if (source === 'rough') { const shader = material.shader.bind(material); material.shader = (code, group) => shader(code, group).replaceAll('mr.b*f.factors.y', 'f.factors.y'); }
    let model: ReturnType<typeof createMesh>;
    const runtime = engineRuntime(engine);
    const world = mode.endsWith(':scene') ? runtime.createScene('native') : runtime;
    world.use({ name: 'native-mapped', setup() { model = createMesh(engine, planeGeometry(2, 2), material); if (source === 'transmission') { model.primitives[0].material.transmission = props.transmissionOptions; install(model); } } });
    world.removePlugin('native-mapped');
    if (mode.endsWith(':scene')) runtime.views = [{ scene: world as ReturnType<typeof runtime.createScene>, camera: runtime.camera, viewport: [0, 0, 1, 1] }];
    return () => { video?.removeEventListener('seeked', ready); model.dispose(); material.dispose(); };
  }, [engine, texture, material, mode, side]);
  if (!side) return null;
  const content = <Mesh><PlaneGeometry args={[2, 2]} /><TextureMaterial {...props} /></Mesh>;
  return mode.endsWith(':scene') ? <><Scene name="mapped">{content}</Scene><RenderView scene="mapped" /></> : content;
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, { texturesProof: {
  state,
  mount(mode: string) {
    state.ready = [false, false]; state.frames = [0, 0]; state.errors = [];
    root.render(<StrictMode><div style={{ display: 'flex' }}>{[0, 1].map((side) => <section key={side} data-side={side}><Canvas key={mode} backend="webgpu" camera={{ position: [0, 0, 4], near: 3, far: 5 }} onCreated={(stage) => { state.engines[side] = engineRuntime(stage.engine); }} onError={(error) => state.errors.push(error instanceof Error ? error.stack ?? error.message : String(error))}><Suspense fallback={null}><MaterialBody side={side} mode={mode} /></Suspense></Canvas></section>)}</div></StrictMode>);
  },
  unmount() { root.unmount(); },
} });
