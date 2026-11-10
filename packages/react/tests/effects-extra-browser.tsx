import React, { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Scene, RenderView, Mesh, GeometryResource, PbrMaterial, useEngine, useFrame } from '@margoengine/react';
import { Stars, Sparkles, Trail, Edges, Decal } from '@margoengine/react/effects-extra';
import { engineRuntime, type Geometry } from '@margoengine/core/extension';
import { PbrMaterial as NativePbr } from '@margoengine/core';
import { parseGLTF } from '@margoengine/gltf';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { Lines, Line } from '@margoengine/lines';
import { Trail as NativeTrail } from '@margoengine/lines/trail';
import { featureEdges } from '@margoengine/lines/edges';
import { decalGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry';
import { createField } from '../dist/effect-field.js';
// Khronos Cesium Box CC-BY-4.0, existing procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const state = { frames: [0, 0], ready: [false, false], errors: [] as string[], engines: [] as ReturnType<typeof engineRuntime>[] };
function history(trail: NativeTrail, engine: ReturnType<typeof useEngine>) {
  trail.moveTo(-1, -0.5, 0); trail.update(engine, 0.1); trail.moveTo(0, 0.7, 0); trail.update(engine, 0.1); trail.moveTo(1, -0.5, 0); trail.update(engine, 0);
}
function Body({ side, mode }: { side: number; mode: string }) {
  const handle = useEngine(), [source, setSource] = useState<Geometry | null>(null), trail = useRef<NativeTrail>(null), initialized = useRef(false);
  useFrame(() => { state.frames[side]++; if (side && mode === 'trail' && trail.current && !initialized.current) { history(trail.current, handle); initialized.current = true; state.ready[side] = true; } });
  useEffect(() => {
    const engine = engineRuntime(handle), parsed = parseGLTF(handle, bytes), geometry = engine.meshes.get(parsed.meshes[0].id)!.geometry!; parsed.dispose(); setSource(geometry);
    if (side) { if (mode !== 'trail') state.ready[side] = true; return; }
    const world = engine.createScene('native-effects'); engine.views = [{ camera: engine.camera, scene: world, viewport: [0, 0, 1, 1] }];
    if (mode === 'stars' || mode === 'sparkles') {
      const data = createField({ kind: mode, count: 100, seed: 4, radius: 2, depth: 1, scale: 3, size: mode === 'stars' ? 3 : 6, speed: 0 });
      const cloud = new PointCloud({ positions: data.positions, colors: data.colors, sizes: data.sizes, colorComponents: 4, colorFormat: 'float', material: { size: 1, minPixelSize: 0, shape: 'round', transparent: true, depthWrite: false, blending: 'additive', fog: false } });
      const plugin = new PointsPlugin(); plugin.add(cloud); world.use(plugin);
    } else if (mode === 'trail') {
      const native = new NativeTrail({ target: null, lifetime: Infinity, width: 8, color: '#33ff99' }); history(native, handle); const plugin = new Lines(); plugin.add(native); world.use(plugin);
    } else {
      const target = world.createMesh().setGeometry(geometry).setMaterial(new NativePbr({ color: '#4466ff' }));
      if (mode === 'edges') { const line = new Line({ mesh: target, positions: featureEdges(geometry, { angle: 15 }), mode: 'segments', width: 3, color: '#ffffff' }); const plugin = new Lines(); plugin.add(line); world.use(plugin); }
      else {
        const count = geometry.vertices.length / 6, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) { positions.set(geometry.vertices.subarray(i * 6, i * 6 + 3), i * 3); normals.set(geometry.vertices.subarray(i * 6 + 3, i * 6 + 6), i * 3); }
        const data = decalGeometry({ positions, normals, uvs: new Float32Array(count * 2), indices: geometry.indices }, identity, [0, 0, 0.51], [0, 0, 0], [0.8, 0.8, 0.8]);
        world.createMesh(target).setGeometry(toGeometry(data)).setMaterial(new NativePbr({ color: '#ff3333' }));
      }
    }
    state.ready[side] = true; return () => world.dispose();
  }, [handle, side, mode]);
  if (!side) return null;
  if (mode === 'stars') return <Stars count={100} seed={4} radius={2} depth={1} factor={3} speed={0} />;
  if (mode === 'sparkles') return <Sparkles count={100} seed={4} scale={3} speed={0} />;
  if (mode === 'trail') return <Trail ref={trail} target={null} lifetime={Infinity} width={8} color="#33ff99" />;
  return source ? <Mesh><GeometryResource geometry={source} /><PbrMaterial color="#4466ff" />{mode === 'edges' ? <Edges width={3} color="#ffffff" /> : <Decal position={[0, 0, 0.51]} scale={0.8} color="#ff3333" />}</Mesh> : null;
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, { effectsProof: { state, mount(mode: string) {
  state.frames = [0, 0]; state.ready = [false, false]; state.errors = [];
  root.render(<StrictMode>{[0, 1].map(side => <section key={side} data-side={side}><Canvas key={mode} backend="webgpu" camera={{ position: [0, 0, 4] }} onCreated={stage => { state.engines[side] = engineRuntime(stage.engine); }} onError={error => state.errors.push(String(error))}>{side ? <><Scene name="effects"><Body side={side} mode={mode} /></Scene><RenderView scene="effects" /></> : <Body side={side} mode={mode} />}</Canvas></section>)}</StrictMode>);
}, unmount() { root.unmount(); } } });
