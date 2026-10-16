// Every feature class with a CSP footprint in one page: the core Wasm kernel, gltf-pro worker parsing, the Draco and
// KTX2 decoder workers (Emscripten + Wasm), the BVH module worker, the post stack, DOM overlays (stats, labels, view
// cube, inspector) and the machinery OCCT STEP worker. scripts/csp-check.mjs serves the build with _headers applied.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { loadGLTFInWorker } from '@margoengine/gltf-pro/worker';
import { DracoDecoder, KTX2Decoder } from '@margoengine/decoders';
import { buildAsync } from '@margoengine/bvh';
import { PostStack } from '@margoengine/post/stack';
import { SSAO } from '@margoengine/post/ssao';
import { Bloom } from '@margoengine/post/bloom';
import { FXAA } from '@margoengine/post/fxaa';
import { Stats } from '@margoengine/stats';
import { HTML } from '@margoengine/html';
import { ViewCube } from '@margoengine/viewcube';
import { Inspector } from '@margoengine/inspector';
import { parseCADAsync } from '@margoengine/machinery/cad-async';
import helmetURL from '../../examples/assets/flight-helmet-mobile.glb?url';
import dracoURL from '../../packages/decoders/tests/fixtures/Box.bin?url';
import ktx2URL from '../../packages/decoders/tests/fixtures/AnisotropyBarnLamp_normalbump.ktx2?url';
import stepURL from '../../node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp?url';

const steps = {},
  status = document.querySelector('#status');
const step = async (name, run) => {
  const t0 = performance.now();
  try {
    steps[name] = { ok: true, detail: await run(), ms: Math.round(performance.now() - t0) };
  } catch (error) {
    steps[name] = { ok: false, detail: String(error?.message ?? error) };
  }
  status.textContent = Object.entries(steps)
    .map(([k, v]) => `${v.ok ? 'ok  ' : 'FAIL'} ${k}`)
    .join('\n');
};
const bytes = async (url) => (await fetch(url)).arrayBuffer();

const engine = await Engine.create(document.querySelector('canvas'), {
  camera: { position: [0, 1.5, 4], target: [0, 0.5, 0], fov: 45 },
});
steps.core = { ok: true, detail: 'Engine.create (embedded Wasm kernel)' };
engine
  .createMesh()
  .setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({ color: '#e8b04a', roughness: 0.4 }))
  .position.set(-1.5, 0.5, 0);
engine.start();

await step('gltf-pro worker', async () => {
  await loadGLTFInWorker(engine, helmetURL);
  return 'flight-helmet-mobile.glb';
});
await step('draco worker', async () => {
  const draco = new DracoDecoder({ workerLimit: 1 });
  try {
    return (await draco.decode(await bytes(dracoURL), { attributeIds: { NORMAL: 0, POSITION: 1 } })).vertexCount;
  } finally {
    draco.dispose();
  }
});
await step('ktx2 worker', async () => {
  const ktx2 = new KTX2Decoder({ target: 'rgba8', workerLimit: 1 });
  try {
    const t = await ktx2.transcode(await bytes(ktx2URL));
    return `${t.width}x${t.height} ${t.format}`;
  } finally {
    ktx2.dispose();
  }
});
await step('bvh worker', async () => {
  await buildAsync(box(1, 1, 1));
  return 'built';
});
let stack;
await step('post stack', async () => {
  stack = PostStack.attach(engine, [new SSAO(), new Bloom({ strength: 0.4 }), new FXAA()]);
  return 'SSAO + Bloom + FXAA';
});
await step('overlays', async () => {
  Stats.attach(engine);
  const label = document.createElement('div');
  label.textContent = 'label';
  HTML.attach(engine, { depth: () => stack.depthTexture }).add(label, { position: [0, 1.4, 0] });
  ViewCube.attach(engine);
  Inspector.attach(engine);
  return 'Stats, HTML labels, ViewCube, Inspector';
});
await step('machinery STEP', async () => (await parseCADAsync(engine, await bytes(stepURL), 'step')).meshes.length);
await new Promise((done) => setTimeout(done, 1000));
window.cspCheck = { ok: Object.values(steps).every((s) => s.ok), steps };
