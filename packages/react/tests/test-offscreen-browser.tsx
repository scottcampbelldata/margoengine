import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTestRenderer, act } from '@margoengine/react/test';
import { Mesh, BoxGeometry, PbrMaterial, useFrame } from '@margoengine/react';
import { OffscreenCanvas } from '@margoengine/react/offscreen';
import { createHeadlessStage } from '@margoengine/headless/stage';
import type { AutoScene } from '@margoengine/worker/auto';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, margoLow: 1 });
const state = { mode: '', errors: [] as string[], frames: 0, clicked: 0, closed: false, stageClosed: false };
let running: AutoScene | undefined;
const stage = await createHeadlessStage({ width: 128, height: 128, camera: { position: [0, 0, 3], target: [0, 0, 0] }, onError: e => state.errors.push(String(e)) });
const mesh = React.createRef<import('@margoengine/core').Mesh>();
function Cube() { useFrame(() => state.frames++); return <Mesh ref={mesh} onClick={() => state.clicked++}><BoxGeometry /><PbrMaterial color="#ff2000" /></Mesh>; }
const renderer = await createTestRenderer(<Cube />, { stage, container: document.querySelector('#test')! });
// The headless stage draws on an OffscreenCanvas; present its exact readback in the helper's DOM canvas.
async function advance() {
  await renderer.advanceFrames(2, 1 / 60);
  const pixels = await stage.readPixels();
  const canvas = document.querySelector<HTMLCanvasElement>('#test canvas')!;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
}
const root = createRoot(document.querySelector('#offscreen')!);
const data = { compat: Boolean((globalThis as { __margoCompat?: boolean }).__margoCompat), color: '#ff2000' };
function App({ mode, sceneData }: { mode: 'worker' | 'page' | 'auto'; sceneData: typeof data }) {
  const [clicks, setClicks] = useState(0);
  return <OffscreenCanvas scene={new URL('./test-offscreen-scene.ts', import.meta.url)} data={sceneData} mode={mode} width={128} height={128}
    style={{ width: '128px', height: '128px' }} onCreated={value => { running = value; state.mode = value.mode; }} onError={e => state.errors.push(String(e))}>
    <button onClick={() => setClicks(n => n + 1)}>React page {clicks}</button>
  </OffscreenCanvas>;
}
Object.assign(window, { testOffscreenProof: { state,
  async mount(mode: 'worker' | 'page' | 'auto') { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.mode = ''; await act(async () => root.render(<StrictMode><App mode={mode} sceneData={{ ...data }} /></StrictMode>)); },
  async test() { await advance(); await renderer.fireEvent(mesh.current, 'pointerdown'); await renderer.fireEvent(mesh.current, 'pointerup'); return { count: renderer.findAll().length, frames: state.frames, clicked: state.clicked }; },
  async unmount() { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await act(async () => root.unmount()); await running?.dispose(); await renderer.unmount(); stage.dispose(); state.closed = Boolean(running?.disposed); state.stageClosed = stage.engine.disposed; },
} });
