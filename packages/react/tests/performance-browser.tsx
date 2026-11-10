import React, { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, GeometryResource, Mesh, PbrMaterial, RenderView, Scene, useEngine, useFrame, useMargo } from '@margoengine/react';
import { AdaptiveDpr, PerformanceMonitor, usePerformanceMonitor } from '@margoengine/react/performance';
import { parseGLTF } from '@margoengine/gltf';
import { engineRuntime, type Engine, type Geometry } from '@margoengine/core/extension';
import { useScene } from '../dist/internal.js';
// Cesium Box, CC-BY-4.0; existing procedural/test/fixtures/sdf/NOTICE.md.
const bytes = await (await fetch('/packages/procedural/test/fixtures/sdf/Box.glb')).arrayBuffer();
const state = { sample: null as number | null, ready: new Set<Engine>(), clicks: 0, errors: [] as string[], factor: 1,
  rows: [[], []] as number[][][], engines: [] as Engine[], picks: [] as Engine['pick'][], invalidate: [() => {}, () => {}], remove: () => {} };
function MonitorState() { const snapshot = usePerformanceMonitor(); state.factor = snapshot.factor; return null; }
function Shape({side}:{side:number}) {
  const handle = useEngine(), [geometry, setGeometry] = useState<Geometry | null>(null);
  const {world}=useScene();
  useEffect(()=>{
    if(!world)return;
    world.use({name:'performance-proof',setup(){},registerPasses(graph){graph.add({name:'performance-proof',order:100,execute(context){state.rows[side].push([context.width,context.height]);if(state.rows[side].length>100)state.rows[side].shift();}})}});
    return()=>{if(!world.engine.disposed&&world.engine.scenes.has(world))world.removePlugin('performance-proof');};
  },[world,side]);
  useEffect(() => { const engine = engineRuntime(handle), model = parseGLTF(handle, bytes); const value = engine.meshes.get(model.meshes[0].id)!.geometry!; model.dispose(); setGeometry(value); state.ready.add(engine); return () => {state.ready.delete(engine);}; }, [handle]);
  return geometry && <Mesh rotation={[0.23, 0.31, 0]} onClick={() => state.clicks++}><GeometryResource geometry={geometry} /><PbrMaterial color="#ff3366" /></Mesh>;
}
function Content({ side, mode }: { side: number; mode: string }) {
  const [active, setActive] = useState(true), { invalidate } = useMargo(); state.invalidate[side] = invalidate;
  if (side === 1) state.remove = () => setActive(false);
  const content = mode === 'named' ? <><Scene name="model"><Shape side={side} /></Scene><RenderView scene="model" viewport={[0, 0, 1, 1]} /></> : <Shape side={side} />;
  return <>{content}{side === 1 && <PerformanceMonitor ms={20} iterations={2} step={0.5} sample={() => state.sample}><MonitorState />{active && <AdaptiveDpr pixelated={mode === 'pixelated'} />}</PerformanceMonitor>}{mode === 'manual' && <Manual />}</>;
}
function Manual() { useFrame(engine => engine.render(), 1); return null; }
const root = createRoot(document.querySelector('#app')!);
Object.assign(window, { performanceProof: {
  state,
  mount(mode: string) {
    state.sample = null; state.clicks = 0; state.rows = [[], []]; state.errors = []; state.factor = 1;
    root.render(<StrictMode>{[0,1].map(side => <div className="view" key={`${mode}-${side}`}><Canvas backend="webgpu" frameloop={mode === 'demand' ? 'demand' : 'always'} camera={{ position: [0,0,4] }} onCreated={stage => {
      const engine = engineRuntime(stage.engine); state.engines[side] = engine; state.picks[side] = engine.pick;
      engine.use({name:'performance-proof',setup(){},registerPasses(graph){graph.add({name:'performance-proof',order:100,execute(context){state.rows[side].push([context.width,context.height]);if(state.rows[side].length>100)state.rows[side].shift();}})}});
    }} onError={error => state.errors.push(String(error))}><Content side={side} mode={mode} /></Canvas></div>)}</StrictMode>);
  },
  unmount(){root.unmount();},
} });
