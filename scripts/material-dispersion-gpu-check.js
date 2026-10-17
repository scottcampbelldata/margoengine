import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';

// In worktrees, set MARGO_GPU_LOCK to the shared adapter lock before running this script.
const release = await acquire({ owner: 'material-dispersion-gpu-check' });
let browser;
try {
  await mkdir('test-results/material-dispersion', { recursive: true });
  browser = await openBrowser({ startPath: '/tests/material-dispersion.html', port: 5213 });
  const page = browser.page,
    errors = [],
    checks = [],
    failures = [],
    captures = [],
    focus = process.argv.find((arg) => arg.startsWith('--focus='))?.slice(8),
    selected = (name) => !focus || name.includes(focus);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.dispersionFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  let samples = 4;
  async function capture(label, action) {
    const state = await action?.(),
      file = `test-results/material-dispersion/${samples}x-${label}.png`;
    await page.locator('canvas').screenshot({ path: file });
    const image = await page.evaluate(() => window.dispersionFixture.read());
    assert.ok(image.every(Number.isFinite), label + ' produced a nonfinite HDR channel');
    captures.push({ label, samples, file, state });
    return { image, state, file };
  }
  function render(label, options = {}, variant = {}) {
    return capture(label, () =>
      page.evaluate(({ options, variant }) => window.dispersionFixture.render(options, variant), { options, variant }),
    );
  }
  function difference(a, b, channel) {
    let max = 0,
      sum = 0,
      changed = 0,
      count = 0;
    for (let i = channel ?? 0; i < a.length; i += channel === undefined ? 1 : 3) {
      const delta = Math.abs(a[i] - b[i]);
      max = Math.max(max, delta);
      sum += delta;
      changed += +(delta > 0);
      count++;
    }
    return { max, mean: sum / count, changed };
  }
  function equivalent(name, actual, reference, tolerance = 0.002, channel) {
    const error = difference(actual.image, reference.image, channel);
    checks.push({ name, samples, ...error, tolerance });
    if (error.max > tolerance)
      failures.push(`${samples}x ${name}: max linear channel error ${error.max} > ${tolerance}`);
  }
  function effect(name, actual, reference, minimum = 0.01, channel) {
    const error = difference(actual.image, reference.image, channel);
    checks.push({ name, samples, ...error, minimum });
    if (error.max < minimum) failures.push(`${samples}x ${name}: effect was only ${error.max}`);
  }
  function check(name, actual, expected) {
    checks.push({ name, samples, actual, expected });
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  // Khronos KHR_materials_dispersion defines 20/Abbe and these three RGB sample IORs.
  // Each reference renders an ordinary nondispersive material; there is no copied dispersion shader.
  // https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_dispersion#implementation
  function channelIors(options) {
    const ior = options.ior ?? 1.5,
      halfSpread = (ior - 1) * 0.025 * options.dispersion;
    return [Math.max(1, ior - halfSpread), ior, ior + halfSpread];
  }
  async function spectralCase(name, options, variant = {}) {
    const actual = await render(name + '-dispersive', options, variant),
      zero = await render(
        name + '-zero',
        { ...options, dispersion: 0 },
        {
          ...variant,
          ...(variant.secondary ? { secondary: { ...variant.secondary, dispersion: 0 } } : {}),
        },
      ),
      iors = channelIors(options),
      secondary = variant.secondary ? { ...options, ...variant.secondary } : undefined;
    effect(name + ' positive dispersion separates the patterned scene', actual, zero);
    for (let c = 0; c < 3; c++) {
      const reference = await render(
        name + '-scalar-' + 'rgb'[c],
        { ...options, dispersion: 0, ior: iors[c] },
        {
          ...variant,
          ...(secondary ? { secondary: { ...variant.secondary, dispersion: 0, ior: channelIors(secondary)[c] } } : {}),
        },
      );
      equivalent(name + ' ' + 'RGB'[c] + ' follows its independent scalar IOR', actual, reference, 0.002, c);
      if (c !== 1) effect(name + ' ' + 'RGB'[c] + ' visibly leaves central IOR', actual, zero, 0.003, c);
    }
    return actual;
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.goto('http://127.0.0.1:5213/tests/material-dispersion.html?samples=1');
      await page.waitForFunction(() => window.dispersionFixture);
    }
    const sampleProbe = await render('sample-count');
    check('scene raster sample count', sampleProbe.state.sampleCount, samples);
    if (selected('baseline')) {
      await render('warmup');
      const absent = await render('absent'),
        zero = await render('zero', { dispersion: 0 });
      equivalent('absent and zero preserve the original path exactly', zero, absent, 0);
      // The initial RED run leaves this optional same-adapter before/after legacy image.
      if (samples === 4) {
        const old = await readFile('test-results/material-dispersion/pre-dispersion-absent.png').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (old) {
          const before = await decodePNG(old),
            after = await decodePNG(await readFile(absent.file));
          check(
            'nondispersive pixels equal the preimplementation RED image',
            Buffer.from(after.data).equals(Buffer.from(before.data)),
            true,
          );
        }
      }
    }
    if (selected('spectral')) await spectralCase('spectral', { dispersion: 8 });
    if (selected('clamp')) await spectralCase('clamp-low-red-IOR', { ior: 1.05, dispersion: 60, thickness: 4 });
    if (selected('maps')) {
      const uv0 = await spectralCase('maps-uv0', { dispersion: 8 }, { maps: 'uv0' }),
        uv1 = await spectralCase('maps-uv1', { dispersion: 8 }, { maps: 'uv1' }),
        transformed = await render('maps-transformed-uv1', { dispersion: 8 }, { maps: 'transform' }),
        scalar0 = await render('maps-scalar0', { dispersion: 8 }, { maps: 'scalar0' }),
        scalar1 = await render('maps-scalar1', { dispersion: 8 }, { maps: 'scalar1' });
      equivalent('UV0 transmission red and thickness green factors', uv0, scalar0);
      equivalent('UV1 transmission red and thickness green factors', uv1, scalar1);
      equivalent('independent UV1 texture transform', transformed, uv0);
      effect('UV1 selects independently authored texture channels', uv1, uv0);
      // Native glTF supports transmissionTexture; imported thicknessTexture uses explicit install below.
      const transmissionOnly = await render(
          'maps-transmission-only',
          { dispersion: 8 },
          { maps: 'uv1', mapSlots: 'transmission' },
        ),
        loaded = await render(
          'maps-loaded-uv1',
          { dispersion: 8 },
          { maps: 'uv1', mapSlots: 'transmission', loaded: true },
        );
      equivalent('native loaded glTF and constructed meshes agree with UV1 transmission', loaded, transmissionOnly);
    }
    if (selected('loaded')) {
      const constructed = await render('constructed-positive', { dispersion: 8 }),
        loaded = await render('loaded-positive', { dispersion: 8 }, { loaded: true });
      equivalent('loaded glTF agrees with the constructed dispersive mesh', loaded, constructed, 0);
      await spectralCase('loaded-spectral', { dispersion: 8 }, { loaded: true });
    }
    if (selected('advanced')) {
      const options = {
          dispersion: 8,
          roughness: 0.18,
          iridescence: 0.65,
          iridescenceIOR: 1.3,
          iridescenceThicknessRange: [100, 420],
          anisotropy: 0.6,
          anisotropyRotation: 0.4,
        },
        actual = await spectralCase('advanced-iridescence-anisotropy', options, { maps: 'uv1', lit: true });
      effect(
        'advanced UV1 combination remains visible',
        actual,
        await render('advanced-zero', { ...options, dispersion: 0 }, { maps: 'uv1', lit: true }),
      );
      const plain = await render(
        'advanced-without-lobes',
        { ...options, iridescence: 0, anisotropy: 0 },
        { maps: 'uv1', lit: true },
      );
      effect('advanced fixture has measurable iridescence and anisotropic lighting', actual, plain, 0.002);
      const scalar = await render('advanced-scalar-volume', options, { lit: true }),
        loaded = await render('advanced-loaded', options, { loaded: true, lit: true });
      equivalent('native loaded glTF agrees with constructed iridescence and anisotropy', loaded, scalar);
    }
    if (selected('inert')) {
      for (const [label, options, variant] of [
        ['no-volume', { thickness: 0 }, {}],
        ['IOR-one', { ior: 1 }, {}],
        ['no-scene-tinted-fallback', { color: [0.7, 0.9, 0.5], transmission: 0.7 }, { path: 'fallback' }],
      ]) {
        const zero = await render(label + '-zero', { ...options, dispersion: 0 }, variant),
          positive = await render(label + '-positive', { ...options, dispersion: 8 }, variant);
        equivalent(label + ' introduces no invented dispersion', positive, zero, 0);
      }
    }
    if (selected('live')) {
      const base = await render('live-zero', { dispersion: 0 }),
        positive = await capture('live-positive', () => page.evaluate(() => window.dispersionFixture.live(8))),
        reset = await capture('live-zero-again', () => page.evaluate(() => window.dispersionFixture.live(0)));
      effect('live 0 to positive updates the existing surface', positive, base);
      equivalent('live positive to zero restores every old-path pixel', reset, base, 0);
      const constructed = await render('live-constructor-reference', { dispersion: 8 });
      equivalent('live assignment matches constructor dispersion', positive, constructed, 0);
      for (const [label, value] of [
        ['positive', positive],
        ['zero', reset],
      ]) {
        check('live ' + label + ' allocates no extra GPU resources', value.state.allocations, {
          textures: 0,
          samplers: 0,
          buffers: 0,
          groups: 0,
        });
        check('live ' + label + ' reuses the original bindings', value.state.newBindings, 0);
      }
      const zero = await render('resource-zero', { dispersion: 0 }),
        dispersive = await render('resource-positive', { dispersion: 8 });
      check(
        'positive dispersion has the same GPU resource counts as zero',
        dispersive.state.allocations,
        zero.state.allocations,
      );
      check('positive dispersion has the same binding entries as zero', dispersive.state.bindings, zero.state.bindings);
    }
    if (selected('geometry')) {
      for (const geometry of ['groups', 'instances', 'mirror']) {
        const variant = { geometry, secondary: { ior: 1.3, dispersion: 4, thickness: 1.4, transmission: 0.75 } },
          options = { dispersion: 8 },
          actual = await spectralCase('geometry-' + geometry, options, variant);
        check(
          geometry + ' preserves material primitive ranges',
          actual.state.primitives,
          geometry === 'mirror' ? 1 : 2,
        );
        check(geometry + ' shares its instance buffer across grouped primitives', actual.state.sharedInstances, true);
        const fresh = await render('geometry-' + geometry + '-before-restore', options, variant),
          restored = await capture('geometry-' + geometry + '-restored', () =>
            page.evaluate(() => window.dispersionFixture.restore()),
          );
        check(geometry + ' receives a replacement GPU device', restored.state.changedDevice, true);
        equivalent(geometry + ' positive dispersion survives device restoration', restored, fresh, 0);
      }
    }
    for (const path of ['install', 'caller'].filter((path) => selected(path))) {
      const absent = await render(path + '-absent', {}, { path }),
        zero = await render(path + '-explicit-zero', { dispersion: 0 }, { path });
      equivalent(path + ' absent and zero preserve the original path exactly', zero, absent, 0);
      await spectralCase(path + '-spectral', { dispersion: 8 }, { path });
      await spectralCase(path + '-low-red-IOR-clamp', { ior: 1.05, dispersion: 60, thickness: 4 }, { path });
      await spectralCase(
        path + '-attenuated',
        { dispersion: 8, attenuationColor: [0.4, 0.7, 0.9], attenuationDistance: 1.8 },
        { path },
      );
      if (path === 'install')
        await spectralCase('install-UV1-transmission-thickness', { dispersion: 8 }, { path, maps: 'uv1' });
      for (const [label, options] of [
        ['no-volume', { thickness: 0 }],
        ['IOR-one', { ior: 1 }],
      ]) {
        const zero = await render(path + '-' + label + '-zero', { ...options, dispersion: 0 }, { path }),
          positive = await render(path + '-' + label + '-positive', { ...options, dispersion: 8 }, { path });
        equivalent(path + ' ' + label + ' remains nondispersive', positive, zero, 0);
      }
      if (path === 'install') {
        const original = await render('install-before-restore', { dispersion: 8 }, { path }),
          restored = await capture('install-restored', () => page.evaluate(() => window.dispersionFixture.restore()));
        check('explicit installation receives a replacement device', restored.state.changedDevice, true);
        equivalent('explicit installation recreates dispersion factors and opaque bindings', restored, original, 0);
      }
    }
  }
  assert.deepEqual(errors, [], 'Unexpected page errors');
  assert.deepEqual(await page.evaluate(() => window.dispersionFixture.errors), [], 'Unexpected GPU/engine errors');
  assert.ok(checks.length, 'The focus filter did not select a case');
  await writeFile(
    'test-results/material-dispersion/gpu.json',
    JSON.stringify({ hardware: browser.hardware, checks, failures, captures }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        hardware: browser.hardware.webgpu,
        checks: checks.length,
        captures: captures.length,
        failures,
        report: 'test-results/material-dispersion/gpu.json',
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Material dispersion GPU comparisons failed');
} finally {
  await browser?.page.evaluate(() => window.dispersionFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
