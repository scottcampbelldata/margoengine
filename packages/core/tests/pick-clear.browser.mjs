// Regression (KB-FX273, 2026-11-15): in Firefox 157 every engine.pick found mesh 0, even over the empty clear colour.
// The pick pass cleared its r32uint target to 4294967295 for "no mesh", and Firefox clears an integer target through
// float32, which turned that into 0, the first mesh's id (adapter-browser.mjs: "pick finds nothing off the mesh"). Ids
// are now written one up over a clear of 0. The page rounds clear values as Firefox does (tests/support/float32-clears.js),
// so this fails without the fix in any browser.
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/pick-clear.browser.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { float32Clears } from '../../../tests/support/float32-clears.js';

const context = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = context;
try {
  await page.addInitScript(float32Clears);
  await page.reload();
  const result = await page.evaluate(async () => {
    const { box, Engine, PbrMaterial } = await import('/packages/core/dist/index.js');
    const canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'display:block;width:64px;height:64px';
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const first = engine
      .createMesh()
      .setGeometry(box())
      .setMaterial(new PbrMaterial({ color: '#ff2000' }));
    engine
      .createMesh()
      .setGeometry(box(0.2, 0.2, 0.2))
      .setPosition([0.9, 0, 0.6])
      .setMaterial(new PbrMaterial({ color: '#2060ff' }));
    engine.render({ delta: 0 });
    const names = (m) => (m === null ? null : m === first ? 'first' : 'second');
    const out = {
      corner: names(await engine.pick(1, 1)),
      centre: names(await engine.pick(32, 32)),
      edge: names(await engine.pick(62, 32)),
      patched: !!globalThis.GPUCommandEncoder?.prototype.__float32Clears,
      compat: !!globalThis.__margoCompat,
      errors,
    };
    engine.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.ok(result.patched || result.compat, 'the float32 clear stand-in is in place on WebGPU');
  assert.equal(result.corner, null, 'the empty corner picks nothing');
  assert.equal(result.centre, 'first', 'the centre picks the first mesh (id 0)');
  assert.equal(result.edge, null, 'right of both meshes picks nothing');
  console.log('pick-clear: ok');
} finally {
  await context.close();
}
