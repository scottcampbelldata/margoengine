import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Mesh, GeometryResource, PbrMaterial, useEngine, type MeshRef } from '@margoengine/react';
import { KeyboardControls, useKeyboardControls, ScrollControls, Scroll, useScroll, PresentationControls } from '@margoengine/react/controls-extra';
import { parseGLTF } from '@margoengine/gltf';
import { engineRuntime, type Geometry } from '@margoengine/core/extension';
// Khronos Cesium Box, CC-BY-4.0; existing source and licence in procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const state = { ready: false, errors: [] as string[], keys: () => ({}), scroll: null as ReturnType<typeof useScroll> | null, mesh: null as MeshRef | null, engine: null as ReturnType<typeof engineRuntime> | null };
function Content() {
  const engine = useEngine(), [geometry, setGeometry] = useState<Geometry | null>(null), [, get] = useKeyboardControls(); state.keys = get;
  useEffect(() => { const model = parseGLTF(engine, bytes), runtime = engineRuntime(engine), geometry = runtime.meshes.get(model.meshes[0].id)!.geometry!; model.dispose(); setGeometry(geometry); return () => {}; }, [engine]);
  return <PresentationControls polar={[-0.6, 0.6]} snap><Mesh ref={mesh => { state.mesh = mesh; state.ready = !!mesh; }}>{geometry && <GeometryResource geometry={geometry} />}<PbrMaterial color="#ff4433" /></Mesh></PresentationControls>;
}
function Scroller() { state.scroll = useScroll(); return <Scroll html><h1 style={{marginTop: 600}}>Native content</h1></Scroll>; }
const root = createRoot(document.querySelector('#app')!);
root.render(<StrictMode><KeyboardControls map={[{ name: 'forward', keys: ['KeyW', 'ArrowUp'] }]}><Canvas backend="webgpu" camera={{position: [0, 0, 4]}} onCreated={stage => { state.engine = engineRuntime(stage.engine); }} onError={error => state.errors.push(String(error))}><Content /><ScrollControls pages={3}><Scroller /></ScrollControls></Canvas></KeyboardControls></StrictMode>);
Object.assign(window, { controlsProof: { state, unmount: () => root.unmount() } });
