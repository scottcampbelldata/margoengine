import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, GeometryResource, Mesh, PbrMaterial, useEngine, useFrame, useMargo } from '@margoengine/react';
import { parseGLTF } from '@margoengine/gltf';
import { engineRuntime, type Geometry } from '@margoengine/core/extension';
// Standard Cesium Box, CC-BY-4.0, existing notice in procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const state = { draws: 0, trace: [] as string[], rows: [] as { trace: string[]; draws: number }[], ready: false, errors: [] as string[], invalidate: () => {}, takeover: (_: boolean) => {}, engine: null as ReturnType<typeof engineRuntime> | null };
function Owner({ mode }: { mode: string }) {
  useFrame((engine) => { state.trace.push('main'); if (!mode.includes('empty') && mode !== 'restore') engine.render(); }, 1);
  return mode === 'multi' ? <Overlay /> : null;
}
function Overlay() { useFrame((engine) => { state.trace.push('hud'); engine.render(); }, 2); return null; }
function Content({ mode }: { mode: string }) {
  const handle = useEngine(), [geometry, setGeometry] = useState<Geometry | null>(null), [owner, setOwner] = useState(!mode.endsWith('auto'));
  const { invalidate } = useMargo();
  state.invalidate = invalidate; state.takeover = setOwner;
  const previous = React.useRef<number | null>(null);
  useFrame(() => {
    if (previous.current !== null) state.rows.push({ trace: state.trace, draws: state.draws - previous.current });
    previous.current = state.draws; state.trace = [];
  }, -1000);
  useFrame(() => state.trace.push('zero-a'));
  useFrame(() => state.trace.push('negative'), -2);
  useFrame(() => state.trace.push('zero-b'));
  useEffect(() => {
    const model = parseGLTF(handle, bytes), engine = engineRuntime(handle), source = engine.meshes.get(model.meshes[0].id)!.geometry!;
    model.dispose(); setGeometry(source); state.ready = true;
    return () => { state.ready = false; };
  }, [handle]);
  return <>{owner && <Owner mode={mode} />}{geometry && <Mesh><GeometryResource geometry={geometry} /><PbrMaterial color="#ff3366" /></Mesh>}</>;
}
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, { priorityProof: {
  state,
  mount(mode: string) {
    state.draws = 0; state.rows = []; state.trace = []; state.ready = false; state.errors = [];
    root.render(<StrictMode><Canvas key={mode} backend="webgpu" frameloop={mode.startsWith('demand') ? 'demand' : 'always'} camera={{ position: [0, 0, 4] }} onCreated={(stage) => {
      const engine = engineRuntime(stage.engine); state.engine = engine;
      engine.use({ name: 'priority-proof', setup() {}, registerPasses(graph) { graph.add({ name: 'priority-proof', order: 100, execute() { state.draws++; } }); } });
    }} onError={(error) => state.errors.push(String(error))}><Content mode={mode} /></Canvas></StrictMode>);
  },
  unmount() { root.unmount(); },
} });
