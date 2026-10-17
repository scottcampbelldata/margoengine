import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

// Parallel worktrees use MARGO_GPU_LOCK to serialize access to the physical adapter.
const release = await acquire({ owner: 'material-wireframe-gpu-check' }),
  output = 'test-results/material-wireframe',
  report = { checks: [], failures: [], captures: [], shadows: [] };
let browser,
  samples = 4;
function check(name, actual, expected) {
  report.checks.push({ name, samples, actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    report.failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/material-wireframe.html', port: 5221 });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const page = browser.page,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.wireframeFixture);
  async function read(label, state) {
    const { png, ...image } = await page.evaluate(() => window.wireframeFixture.read());
    const path = `${output}/${samples}x-${label}.png`;
    await writeFile(path, Buffer.from(png, 'base64'));
    report.captures.push({ label, samples, state, image, path });
    return { state, image };
  }
  async function render(label, options = {}) {
    const state = await page.evaluate((options) => window.wireframeFixture.render(options), options);
    check(label + ' actual samples', state.sampleCount, samples);
    return read(label, state);
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.evaluate(() => window.wireframeFixture.dispose());
      await page.goto('http://127.0.0.1:5221/tests/material-wireframe.html?samples=1');
      await page.waitForFunction(() => window.wireframeFixture);
    }
    const reference = await render('explicit-lines', { reference: true }),
      wire = await render('material-wireframe');
    check('public wireframe equals independent explicit per-triangle line-list', wire.image.hash, reference.image.hash);
    check('wireframe leaves triangle interiors empty', wire.image.interior.count, 0);
    check('wireframe draws outer edges', wire.image.edge.count > 0, true);
    check('wireframe draws the triangulation diagonal', wire.image.diagonal.count > 0, true);
    check('wireframe retains original triangle indices', wire.state.indices, [[0, 1, 2, 0, 2, 3]]);
    check('wireframe retains query triangle counts', wire.state.pickingCounts, [6]);
    check('public material exposes enabled wireframe', wire.state.properties, [true]);
    check(
      'line width remains one pixel at 1x and sample coverage at 4x',
      wire.image.row.count <= (samples === 1 ? 1 : 2),
      true,
    );
    for (const [label, options] of [
      ['native', { native: true }],
      ['nonindexed', { nonindexed: true }],
      ['mirrored', { mirror: true }],
      ['instanced-mirrors', { instances: true }],
      ['material-groups', { groups: true }],
      ['color-map', { map: 'color' }],
      ['alpha-mask', { map: 'alpha' }],
      ['deformed-buffer', { deformation: true }],
      ['transparent', { material: { transparent: true, opacity: 0.5, depthWrite: false } }],
      ['physical-tint', { material: { transmission: 0.8, thickness: 0.2, attenuationColor: [0.3, 0.6, 0.8] } }],
    ]) {
      const expected = await render(label + '-explicit', { ...options, reference: true }),
        actual = await render(label + '-wireframe', options);
      check(label + ' matches independent explicit line-list pixels', actual.image.hash, expected.image.hash);
      check(label + ' actually draws visible lines', actual.image.whole.count > 0, true);
    }
    const transparent = { material: { transparent: true, opacity: 0.5, depthWrite: false } },
      duplicate = await render('transparent-shared-edge-reference', { ...transparent, reference: true }),
      unique = await render('transparent-deduplicated-control', {
        ...transparent,
        reference: true,
        deduplicated: true,
      });
    check(
      'duplicate shared edge visibly accumulates alpha against deduplicated control',
      duplicate.image.diagonal.sum > unique.image.diagonal.sum,
      true,
    );
    const nativeReference = await render('native-live-explicit', { native: true, reference: true }),
      filled = await render('native-off', { native: true, wireframe: false }),
      enabledState = await page.evaluate(() => window.wireframeFixture.toggle(true)),
      enabled = await read('native-live-on', enabledState);
    check('native live on switches filled triangles to expected lines', enabled.image.hash, nativeReference.image.hash);
    check('native live on preserves original indices', enabled.state.indices, [[0, 1, 2, 0, 2, 3]]);
    for (const value of [false, true, false]) {
      const state = await page.evaluate((value) => window.wireframeFixture.toggle(value), value),
        actual = await read('native-live-' + value + '-' + report.captures.length, state);
      check(
        'native live off/on/off pixels ' + value,
        actual.image.hash,
        value ? nativeReference.image.hash : filled.image.hash,
      );
      for (const resource of ['textures', 'samplers', 'buffers', 'groups', 'pipelines'])
        check('warmed native toggle reuses ' + resource, state.allocations[resource], 0);
    }
    for (const kind of ['directional', 'local', 'integrated', 'contact'])
      for (const options of [{ native: true }, { groups: true }, { instances: true, deformation: true }]) {
        const result = await page.evaluate(({ kind, options }) => window.wireframeFixture.shadows(kind, options), {
          kind,
          options,
        });
        report.shadows.push({ kind, options, samples, ...result });
        check(
          kind + ' actual caster matches explicit independent edge indices ' + JSON.stringify(options),
          result.actual.hash,
          result.reference.hash,
        );
        check(kind + ' explicit reference writes shadow pixels', result.reference.pixels > 0, true);
        check(kind + ' original caster restores reference depth', result.restored.hash, result.reference.hash);
        if (options.native) {
          check(
            kind + ' native off changes cached line shadow to a filled shadow',
            result.off.hash !== result.actual.hash,
            true,
          );
          check(kind + ' native on restores the cached edge shadow', result.on.hash, result.actual.hash);
          check(
            kind + ' line caster leaves more clear pixels than filled triangles',
            result.actual.pixels < result.off.pixels,
            true,
          );
        }
      }
    check('GPU validation and engine errors', await page.evaluate(() => window.wireframeFixture.errors), []);
  }
  check('page errors', errors, []);
  assert.deepEqual(report.failures, [], 'Material wireframe GPU comparisons failed');
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(output + '/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        hardware: report.hardware?.webgpu,
        checks: report.checks.length,
        captures: report.captures.length,
        failures: report.failures,
        error: report.error,
        report: output + '/gpu.json',
      },
      null,
      2,
    ),
  );
  await browser?.page.evaluate(() => window.wireframeFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
