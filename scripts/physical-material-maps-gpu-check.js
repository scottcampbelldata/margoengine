import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

// Always point MARGO_GPU_LOCK at the main checkout when running in a worktree.
const release = await acquire({ owner: 'physical-material-maps-gpu-check' });
let browser;
try {
  await mkdir('test-results/physical-material-maps', { recursive: true });
  browser = await openBrowser({ startPath: '/tests/physical-material-maps.html', port: 5212 });
  const page = browser.page,
    errors = [],
    captures = [],
    checks = [],
    failures = [],
    focus = process.argv.find((arg) => arg.startsWith('--focus='))?.slice(8),
    selected = (name) => !focus || name.includes(focus);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.physicalMaps);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');

  async function capture(label, action) {
    const state = await action?.();
    const result = await decodePNG(
      await page.locator('canvas').screenshot({
        path: 'test-results/physical-material-maps/' + label + '.png',
      }),
    );
    const i = (120 * result.width + 160) * 4;
    captures.push({ label, center: Array.from(result.data.subarray(i, i + 3)), state });
    return result;
  }
  function difference(a, b, rect = [50, 50, 270, 190]) {
    let max = 0,
      sum = 0,
      channels = 0,
      changed = 0;
    for (let y = rect[1]; y < rect[3]; y++)
      for (let x = rect[0]; x < rect[2]; x++)
        for (let c = 0; c < 3; c++) {
          const k = (y * a.width + x) * 4 + c,
            error = Math.abs(a.data[k] - b.data[k]);
          max = Math.max(max, error);
          sum += error;
          channels++;
          changed += error > 0;
        }
    return { max, mean: sum / channels, changed };
  }
  function equivalent(name, actual, reference, tolerance = 2, rect) {
    const error = difference(actual, reference, rect);
    checks.push({ name, ...error, tolerance });
    if (error.max > tolerance) failures.push(name + ': max channel error ' + error.max + ' > ' + tolerance);
  }
  function effect(name, a, b, threshold = 2) {
    const error = difference(a, b);
    checks.push({ name, ...error, minimum: threshold });
    if (error.max < threshold) failures.push(name + ': effect was only ' + error.max + ' channel levels');
  }
  async function render(name, variant, hdr = false) {
    return capture(name + '-' + variant + (hdr ? '-hdr' : ''), () =>
      page.evaluate(({ name, variant, hdr }) => physicalMaps.render(name, variant, hdr), { name, variant, hdr }),
    );
  }
  if (selected('baseline')) {
    const base = await capture('baseline-standard', () => page.evaluate(() => physicalMaps.baseline(false))),
      physical = await capture('baseline-zero-clearcoat', () => page.evaluate(() => physicalMaps.baseline(true)));
    equivalent('zero clearcoat preserves the no-map baseline', physical, base, 0);
  }
  const names = await page.evaluate(() => physicalMaps.names);
  for (const name of names.filter(selected)) {
    const a = await render(name, 'a'),
      b = await render(name, 'b'),
      uv0 = await render(name, 'map0'),
      uv1 = await render(name, 'map1'),
      transformed = await render(name, 'transform'),
      fallback = await render(name, 'fallback');
    equivalent(name + ' UV0 channel/color-space factor', uv0, a);
    equivalent(name + ' UV1 channel/color-space factor', uv1, b);
    equivalent(name + ' independent UV1 offset transform', transformed, a);
    equivalent(name + ' absent UV1 falls back to UV0', fallback, a);
    effect(name + ' selected texels have a measurable effect', a, b);
  }
  if (selected('clearcoatNormalMap')) {
    const image = {};
    for (const mode of ['base', 'a', 'b', 'map0', 'map1', 'transform', 'fallback', 'zero', 'mirrorReference', 'mirror'])
      image[mode] = await capture('clearcoatNormalMap-' + mode, () =>
        page.evaluate((mode) => physicalMaps.coatNormal(mode), mode),
      );
    equivalent('clearcoatNormalMap linear RGB UV0', image.map0, image.a, 2, [140, 100, 180, 140]);
    equivalent('clearcoatNormalMap linear RGB UV1', image.map1, image.b, 2, [140, 100, 180, 140]);
    equivalent('clearcoatNormalMap independent UV transform', image.transform, image.a, 2, [140, 100, 180, 140]);
    equivalent('clearcoatNormalScale zero retains the geometric coat normal', image.zero, image.base, 0);
    equivalent(
      'clearcoatNormalMap uses its mirrored UV1 tangent frame',
      image.mirror,
      image.mirrorReference,
      2,
      [140, 100, 180, 140],
    );
    equivalent('clearcoatNormalMap absent UV1 falls back to UV0', image.fallback, image.a, 2, [140, 100, 180, 140]);
    effect('clearcoatNormalMap changes the coat lobe', image.map0, image.base);
    effect('clearcoatNormalMap mirrored tangent changes the coat lobe', image.mirror, image.map0);
  }
  if (selected('anisotropyMirror')) {
    const reference = await capture('anisotropy-mirror-reference', () =>
        page.evaluate(() => physicalMaps.anisotropyMirror('reference')),
      ),
      mapped = await capture('anisotropy-mirror-map', () => page.evaluate(() => physicalMaps.anisotropyMirror('map'))),
      wrongFrame = await capture('anisotropy-mirror-wrong-frame', () =>
        page.evaluate(() => physicalMaps.anisotropyMirror('wrong')),
      );
    equivalent('anisotropyMap uses its mirrored UV1 tangent frame', mapped, reference);
    effect('anisotropyMap mirror case detects reuse of the UV0 tangent frame', mapped, wrongFrame);
  }
  for (const name of ['transmissionMap', 'thicknessMap'].filter((name) => selected(name) || selected('HDR'))) {
    const a = await render(name, 'a', true),
      b = await render(name, 'b', true),
      uv0 = await render(name, 'map0', true),
      uv1 = await render(name, 'map1', true),
      transformed = await render(name, 'transform', true);
    equivalent(name + ' HDR Transmission UV0 factor', uv0, a);
    equivalent(name + ' HDR Transmission UV1 factor', uv1, b);
    equivalent(name + ' HDR Transmission independent transform', transformed, a);
    effect(name + ' HDR Transmission texels have a measurable effect', a, b);
    const restored = await capture(name + '-hdr-restored', async () => {
      const state = await page.evaluate(() => physicalMaps.restore());
      assert.equal(state.changedDevice, true, 'Restoration reused the prior GPU device');
      return state;
    });
    equivalent(name + ' HDR Transmission device restoration', restored, transformed, 0);
  }
  if (selected('grouped')) {
    for (const instanced of [false, true]) {
      const label = instanced ? 'instances' : 'groups',
        reference = await capture(label + '-reference', () =>
          page.evaluate((instanced) => physicalMaps.grouped(false, instanced), instanced),
        ),
        mapped = await capture(label + '-mapped', async () => {
          const state = await page.evaluate((instanced) => physicalMaps.grouped(true, instanced), instanced);
          assert.deepEqual(state, { primitives: 2, sharedInstances: true });
          return state;
        });
      equivalent(label + ' preserve per-material maps, UV sets and range order', mapped, reference);
    }
  }
  if (selected('authoredAnisotropy')) {
    const image = {};
    for (const mode of ['base', 'assign', 'remove', 'reference', 'mapReference'])
      image[mode] = await capture('authored-anisotropy-' + mode, () =>
        page.evaluate((mode) => physicalMaps.authoredAnisotropy(mode), mode),
      );
    equivalent('factor-only anisotropy preserves the authored Y tangent', image.base, image.reference);
    equivalent(
      'anisotropyMap uses its UV tangent independently of the authored tangent',
      image.assign,
      image.mapReference,
    );
    equivalent('removing anisotropyMap restores the authored tangent', image.remove, image.base, 0);
    effect('authored anisotropy fixture distinguishes UV and authored tangent directions', image.assign, image.base);
  }
  if (selected('commonLive')) {
    const image = {};
    for (const mode of ['base', 'assign', 'remove'])
      image[mode] = await capture('common-layout-live-' + mode, () =>
        page.evaluate((mode) => physicalMaps.commonLive(mode), mode),
      );
    equivalent('common-only live map removal restores the native texture layout', image.remove, image.base, 0);
    effect('common-only material accepts a live UV1 clearcoat map', image.assign, image.base);
    const assignedAgain = await capture('common-layout-live-assigned-again', () =>
        page.evaluate(() => physicalMaps.commonLive('assign')),
      ),
      restored = await capture('common-layout-live-restored', () => page.evaluate(() => physicalMaps.restore()));
    equivalent('common-only material recreates mapped bindings after removal', assignedAgain, image.assign, 0);
    equivalent('common-only live assigned map survives device restoration', restored, image.assign, 0);
    const reference = await capture('common-layout-live-factor-reference', () =>
      page.evaluate(() => physicalMaps.commonLive('reference')),
    );
    equivalent('common-only live clearcoat map matches its UV1 scalar reference', assignedAgain, reference);
  }
  if (selected('live')) {
    const image = {};
    for (const mode of ['base', 'assign', 'update', 'remove', 'reset'])
      image[mode] = await capture('live-all-maps-' + mode, () =>
        page.evaluate((mode) => physicalMaps.live(mode), mode),
      );
    equivalent('all twelve map removals restore the original shared material', image.remove, image.base, 0);
    effect('all twelve live assignments affect grouped shared instances', image.assign, image.base);
    effect('Texture.update refreshes all shared map roles', image.update, image.assign);
    const assignedReference = await capture('live-all-maps-assigned-reference', () =>
        page.evaluate(() => physicalMaps.liveReference(false)),
      ),
      updatedReference = await capture('live-all-maps-updated-reference', () =>
        page.evaluate(() => physicalMaps.liveReference(true)),
      );
    equivalent('live assignments equal constructor assignments', image.assign, assignedReference, 0);
    equivalent('live Texture.update equals a fresh upload', image.update, updatedReference, 0);
    const restored = await capture('live-all-maps-restored', () => page.evaluate(() => physicalMaps.restore()));
    equivalent('all twelve shared maps survive device restoration', restored, updatedReference, 0);
  }
  if (selected('budget')) {
    const shared = await page.evaluate(() => physicalMaps.budget(false));
    assert.equal(shared.error, null, 'Shared base and physical texture roles must fit the sampled texture budget');
    await capture('shared-all-17-texture-roles');
    const overflow = await page.evaluate(() => physicalMaps.budget(true));
    assert.match(
      overflow.error ?? '',
      /texture.*(?:limit|16|budget)|(?:limit|16|budget).*texture/i,
      '17 distinct base + physical textures must fail explicitly',
    );
    assert.deepEqual(overflow.errors, [], 'Over-limit rejection reached WebGPU validation');
    checks.push({ name: 'shared 17-role fit and explicit 17-distinct-texture overflow', error: overflow.error });
  }
  assert.deepEqual(errors, [], 'Unexpected page errors');
  assert.ok(checks.length > 0, 'The focus filter did not select any checks');
  assert.deepEqual(await page.evaluate(() => physicalMaps.errors), [], 'Unexpected GPU/engine errors');
  const report = { hardware: browser.hardware, checks, failures, captures };
  await writeFile('test-results/physical-material-maps/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        hardware: browser.hardware.webgpu,
        checks: checks.length,
        captures: captures.length,
        worstEquivalentChannelError: Math.max(
          0,
          ...checks.filter((check) => 'tolerance' in check).map((check) => check.max),
        ),
        failures,
        report: 'test-results/physical-material-maps/gpu.json',
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Physical texture map image comparisons failed');
} finally {
  await browser?.page.evaluate(() => window.physicalMaps?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
