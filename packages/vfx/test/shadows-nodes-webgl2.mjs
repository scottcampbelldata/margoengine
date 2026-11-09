// Shadows, update nodes, and a plain particle on the WebGL2 compatibility layer.
// The layer is installed by scripts/browser.js when MARGO_COMPAT=1, before the page's first requestAdapter.
// Same numbers as packages/vfx/test/features-check.mjs (checkShadows, checkNodes) plus checkPlain.
// Run from the repository root, under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/vfx/test/shadows-nodes-webgl2.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

process.env.MARGO_COMPAT = '1';
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = '1';

const { openBrowser } = await import('../../../scripts/browser.js');
const context = await openBrowser({
  startPath: '/packages/vfx/test/features-check.html',
  port: 'free',
});
const { page, hardware } = context;
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});
const clean = (result, name) => {
  assert.equal(result.error, null, `${name}: ${result.error ?? ''}`);
  assert.deepEqual(result.errors, [], name);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const compat = await page.evaluate(() => globalThis.__margoCompat === true);
  assert.equal(compat, true, 'the page is not on the WebGL2 compatibility layer');

  const plain = await page.evaluate(() => window.checkPlain());
  clean(plain, 'plain');
  assert.deepEqual(plain.mismatches, [], JSON.stringify(plain));
  console.log(
    `ok plain webgl2: at ${plain.got.at.map((v) => v.toFixed(5)).join(',')} v ${plain.got.v.map((v) => v.toFixed(5)).join(',')}`,
  );

  const shadows = await page.evaluate(() => window.checkShadows());
  clean(shadows, 'shadows');
  assert.deepEqual(
    shadows.header.map((v) => Math.round(v * 1e6) / 1e6),
    [2, 5, 3],
    'shadows',
  );
  assert.deepEqual(shadows.lights[0].position, [1, 2, 3], 'shadows');
  assert.deepEqual(shadows.lights[0].color, [1, 0, 0], 'shadows');
  assert.equal(shadows.lights[0].range, 5, 'shadows');
  assert.equal(shadows.lights[0].intensity, 3, 'shadows');
  assert.deepEqual(shadows.lights[1].position, [4, 5, 6], 'shadows');
  assert.deepEqual(shadows.lights[1].color, [0, 0, 1], 'shadows');
  assert.equal(shadows.lights[1].range, 5, 'shadows');
  assert.equal(shadows.lights[1].intensity, 3, 'shadows');
  assert.notDeepEqual(shadows.lights[2].position, [7, 8, 9], 'shadows');
  assert.equal(shadows.published?.length, 2, 'shadows');
  assert.equal(shadows.published[0].decay, 2, 'shadows');
  assert.deepEqual(shadows.published[0].position, [1, 2, 3], 'shadows');
  assert.deepEqual(shadows.published[1].position, [4, 5, 6], 'shadows');
  assert.deepEqual(shadows.published[1].color, [0, 0, 1], 'shadows');
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(shadows.depthGot[i] - shadows.depthWant[i]) < 1e-4,
      `shadows sample ${i}: got ${shadows.depthGot[i]} want ${shadows.depthWant[i]}`,
    );
  console.log(
    `ok shadows webgl2: lights ${shadows.header.join(',')} depth ${shadows.depthGot.map((v) => v.toFixed(5)).join(' ')}`,
  );

  const far = await page.evaluate(() => window.checkShadowFar());
  clean(far, 'shadow far');
  for (const sample of far.samples) {
    assert.equal(sample.error, null, 'shadow far');
    assert.ok(
      Math.abs(sample.got - sample.want) < 1e-4,
      `shadow far centre ${sample.center}: got ${sample.got} want ${sample.want}`,
    );
  }
  console.log(
    `ok shadow far webgl2: ${far.samples.map((sample) => `${sample.center} ${sample.got.toFixed(5)}`).join(' ')}`,
  );

  const release = await page.evaluate(() => window.checkShadowRelease());
  clean(release, 'shadow release');
  assert.deepEqual(release.rejected, [], 'shadow release');
  console.log('ok shadow release webgl2');

  const nodes = await page.evaluate(() => window.checkNodes());
  clean(nodes, 'nodes');
  assert.deepEqual(nodes.mismatches, [], JSON.stringify(nodes));
  console.log(
    `ok nodes webgl2: at ${nodes.got.at.map((v) => v.toFixed(5)).join(',')} v ${nodes.got.v.map((v) => v.toFixed(5)).join(',')}`,
  );

  assert.deepEqual(pageErrors, []);
  const report = {
    hardware,
    compat: true,
    plain: plain.got,
    shadows: { header: shadows.header, depthGot: shadows.depthGot, depthWant: shadows.depthWant },
    nodes: nodes.got,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/vfx-shadows-nodes-webgl2.json', JSON.stringify(report, null, 1));
} finally {
  await context.close();
}
