// xr.layers on the GPU: both routes ('separate' on XR's own device, 'engine' through the frame graph), on WebGPU and on
// the WebGL2 layer, with a stand-in headset (packages/webgl2-compat/test/xr.html). A core cube and a glTF PBR model sit
// on layer 30; with `xr.layers = 1` both eyes must equal, pixel for pixel, the frame with those two hidden, and differ
// from the unmasked frame. This is how a VRM first-person avatar hides its head in the headset.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = await readFile('packages/webgl2-compat/test/xr.html', 'utf8');
const replace = (s, from, to) => {
  assert.ok(s.includes(from), from);
  return s.replace(from, to);
};
function documentFor(variant) {
  let s = fixture;
  s = replace(
    s,
    'const mode =',
    `import { setRenderLayers } from '/packages/shared/layers.js';
import { loadGLTF } from '/packages/gltf/dist/pbr.js';
const mode =`,
  );
  s = replace(
    s,
    'const xr = await XR.create(engine);',
    `const layered = [...engine.meshes.values()].filter((mesh) => mesh.geometry)[2];
  const model = await loadGLTF(engine, '/examples/assets/khronos/BoxVertexColors/BoxVertexColors.glb');
  model.root.setPosition([1.2, 1.9, 1]).setScale([0.8, 0.8, 0.8]);
  setRenderLayers(layered, 1 << 30);
  setRenderLayers(model.root, 1 << 30);
  ${variant === 'hidden' ? 'layered.visible = false; model.root.visible = false;' : ''}
  const xr = await XR.create(engine${variant === 'masked' ? ', { layers: 1 }' : ''});`,
  );
  return s;
}
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free', compat: false });
const origin = new URL(browser.page.url()).origin,
  results = new Map();
try {
  await browser.page.route('**/packages/webgl2-compat/test/xr.html*', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: documentFor(new URL(route.request().url()).searchParams.get('variant')),
    }),
  );
  for (const backend of ['native', 'compat'])
    for (const route of ['separate', 'engine'])
      for (const variant of ['all', 'masked', 'hidden']) {
        const key = `${backend}/${route}/${variant}`;
        await browser.page.goto(
          `${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=${route}&variant=${variant}`,
        );
        await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
        const result = await browser.page.evaluate(() => window.check);
        assert.deepEqual(result.errors, [], key);
        assert.equal(result.gl, 0, key);
        assert.equal(result.route, route, key);
        results.set(
          key,
          result.eyes.map((eye) => Buffer.from(eye, 'base64')),
        );
      }
  const checks = [];
  for (const backend of ['native', 'compat'])
    for (const route of ['separate', 'engine'])
      for (let eye = 0; eye < 2; eye++) {
        const [all, masked, hidden] = ['all', 'masked', 'hidden'].map(
          (v) => results.get(`${backend}/${route}/${v}`)[eye],
        );
        const differ = (a, b) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4)
            if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
          return n;
        };
        const check = { backend, route, eye, maskedVsHidden: differ(masked, hidden), maskedVsAll: differ(masked, all) };
        checks.push(check);
        assert.equal(check.maskedVsHidden, 0, `masked equals hidden: ${JSON.stringify(check)}`);
        assert.ok(check.maskedVsAll > 500, `the mask hides the cube and the model: ${JSON.stringify(check)}`);
      }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/xr-view-layers-browser.json', JSON.stringify({ checks }, null, 2));
  console.log('XR view layers PASS', JSON.stringify(checks));
} finally {
  await browser.close();
}
