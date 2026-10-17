import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

// Parallel worktrees must supply the shared adapter lock using MARGO_GPU_LOCK.
const release = await acquire({ owner: 'material-back-side-gpu-check' }),
  output = 'test-results/material-back-side',
  report = { checks: [], failures: [], captures: [] },
  points = [
    [80, 120],
    [160, 120],
    [240, 120],
  ],
  instancePoints = [
    [80, 120],
    [240, 120],
  ];
let browser,
  samples = 4;
function check(name, actual, expected) {
  report.checks.push({ name, samples, actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    report.failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/material-back-side.html', port: 5218 });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const page = browser.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.backSideFixture);
  const baseline = await access('test-results/pre-side-materials-dist/index.js').then(
    () => true,
    () => false,
  );
  report.legacyBaselineAvailable = baseline;
  async function read(label, state, selected = points) {
    const image = await page.evaluate((p) => window.backSideFixture.read(p), selected);
    report.captures.push({ label, samples, state, image });
    return { image, state };
  }
  async function render(label, options = {}, variant = {}, selected = points) {
    const state = await page.evaluate(({ options, variant }) => window.backSideFixture.render(options, variant), {
      options,
      variant,
    });
    check(label + ' actual raster samples', state.sampleCount, samples);
    return read(label, state, selected);
  }
  async function live(label, options, selected = points) {
    const state = await page.evaluate((o) => window.backSideFixture.live(o), options);
    for (const key of ['textures', 'samplers', 'buffers']) check(label + ' no new ' + key, state.allocations[key], 0);
    return read(label, state, selected);
  }
  async function picks(label, visible, selected = points) {
    for (const explicit of [false, true]) {
      const actual = await page.evaluate(({ selected, explicit }) => window.backSideFixture.picks(selected, explicit), {
        selected,
        explicit,
      });
      for (const path of ['gpu', 'cpu', 'snapshot'])
        if (actual[path].length)
          check(
            `${label} ${explicit ? 'explicit' : 'automatic'} ${path}`,
            actual[path],
            selected.map(() => visible),
          );
    }
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.goto('http://127.0.0.1:5218/tests/material-back-side.html?samples=1');
      await page.waitForFunction(() => window.backSideFixture);
    }
    const empty = await render('empty', {}, { empty: true });
    const emptyDigest = await page.evaluate(() => window.backSideFixture.digest());
    // A hidden current model independently defines the unchanged opaque background.
    for (const [path, hdr, mapped] of [
      ['transmission', true, false],
      ['fallback', true, false],
      ['fallback', false, false],
      ['fallback', false, true],
    ])
      for (const camera of ['front', 'back']) {
        const options = { side: 'back', transmission: 0.8, dispersion: 2, thickness: 0.2, roughness: 0.1 },
          variant = { camera, geometry: 'instances', hdr, mapped, [path]: true },
          label = `${camera}-${path}-${hdr ? 'HDR' : 'raw'}-${mapped ? 'mapped' : 'scalar'}-instances`,
          actual = await render(label + '-back', options, variant, instancePoints);
        const state = await page.evaluate(() => window.backSideFixture.visible(false)),
          hidden = await read(label + '-hidden', state, instancePoints);
        if (path === 'fallback')
          check(label + ' native tint entry compiled', actual.state.entries.includes('margoTint'), true);
        check(
          label + ' back-only visibility',
          JSON.stringify(actual.image) !== JSON.stringify(hidden.image),
          camera === 'back',
        );
      }
    for (const camera of ['front', 'back']) {
      for (const geometry of ['quad', 'mirror', 'instances']) {
        const selected = geometry === 'instances' ? instancePoints : points,
          variant = { camera, geometry },
          options = { shading: 'basic', color: [1, 0, 0] },
          double = await render(`${camera}-${geometry}-double`, { ...options, side: 'double' }, variant, selected);
        check(
          `${camera} ${geometry} double-sided is red`,
          double.image.map((p) => p.rgba),
          selected.map(() => [255, 0, 0, 255]),
        );
        for (const side of ['front', 'back']) {
          const visible = side === camera,
            actual = await render(`${camera}-${geometry}-${side}`, { ...options, side }, variant, selected);
          check(
            `${camera} ${geometry} ${side} culling`,
            actual.image.map((p) => p.rgba),
            visible ? double.image.map((p) => p.rgba) : selected.map(() => empty.image[0].rgba),
          );
          check(`${camera} ${geometry} public side`, actual.state.properties.side, side);
          check(`${camera} ${geometry} back is single-sided`, actual.state.properties.doubleSided, false);
          check(
            `${camera} ${geometry} picking metadata`,
            actual.state.metadata.every((p) => p.side === side && !p.doubleSided),
            true,
          );
          await picks(`${camera} ${geometry} ${side}`, visible, selected);
        }
      }
      for (const shading of ['standard', 'basic', 'normal', 'matcap', 'depth', 'distance']) {
        const options = {
            shading,
            color: [0.7, 0.3, 0.15],
            roughness: 0.8,
            depthPacking: 'basic',
            nearDistance: 0,
            farDistance: 10,
          },
          visible = await render(`${camera}-${shading}-double`, { ...options, side: 'double' }, { camera }),
          actual = await render(`${camera}-${shading}-back`, { ...options, side: 'back' }, { camera });
        check(
          `${camera} ${shading} back matches visible/culled reference`,
          actual.image,
          camera === 'back' ? visible.image : empty.image,
        );
        if (camera === 'back' && shading === 'normal')
          check(
            'rear normal flips toward viewer in view space',
            actual.image.map(
              (p) =>
                p.rgba[0] >= 127 &&
                p.rgba[0] <= 128 &&
                p.rgba[1] >= 127 &&
                p.rgba[1] <= 128 &&
                p.rgba[2] === 255 &&
                p.rgba[3] === 255,
            ),
            points.map(() => true),
          );
      }
      for (const feature of ['node', 'mapped', 'physical']) {
        const variant = { camera, [feature]: true },
          options = { color: [0.7, 0.4, 0.2], roughness: 0.6 },
          double = await render(`${camera}-${feature}-double`, { ...options, side: 'double' }, variant),
          actual = await render(`${camera}-${feature}-back`, { ...options, side: 'back' }, variant);
        check(
          `${camera} ${feature} back composes with shader`,
          actual.image,
          camera === 'back' ? double.image : empty.image,
        );
      }
      for (const side of ['front', 'back', 'double']) {
        const actual = await render(`${camera}-native-${side}`, { side }, { camera, loaded: true }),
          visible = side === 'double' || side === camera;
        check(
          `${camera} native ${side} culling`,
          actual.image.map((p) => JSON.stringify(p.rgba) !== JSON.stringify(empty.image[0].rgba)),
          points.map(() => visible),
        );
        await picks(`${camera} native ${side}`, visible);
      }
      const group = await render(
        `${camera}-groups`,
        { shading: 'basic', color: [1, 0, 0], side: 'back' },
        { camera, geometry: 'groups', secondary: { side: 'front', color: [0, 0, 1] } },
        instancePoints,
      );
      const expectedGroups =
        camera === 'front' ? [empty.image[0].rgba, [0, 0, 255, 255]] : [empty.image[0].rgba, [255, 0, 0, 255]];
      check(
        `${camera} grouped materials independently cull`,
        group.image.map((p) => p.rgba),
        expectedGroups,
      );
    }
    for (const extension of ['coat', 'graph-normal'])
      for (const geometry of ['quad', 'mirror', 'instances'])
        for (const camera of ['front', 'back']) {
          const selected = geometry === 'instances' ? instancePoints : points,
            label = `${extension}-${geometry}-${camera}`,
            actual = await render(
              label,
              { side: 'back', color: [0.7, 0.4, 0.2], roughness: 0.6 },
              { extension, geometry, camera, auxiliary: true, capture: true },
              selected,
            ),
            captures = await page.evaluate(async (points) => {
              const result = [];
              for (const point of points) result.push(await window.backSideFixture.readAuxiliary(point));
              return result;
            }, selected);
          check(
            label + ' beauty logical facing with prepended extension helpers',
            actual.image.map((p) => JSON.stringify(p.rgba) !== JSON.stringify(empty.image[0].rgba)),
            selected.map(() => camera === 'back'),
          );
          check(
            label + ' capture logical facing with prepended extension helpers',
            captures.map((entries) => entries[2][3]),
            selected.map(() => (camera === 'back' ? 1 : 0)),
          );
          check(label + ' capture entry actually compiled', actual.state.entries.includes('capture'), true);
        }
    for (const geometry of ['quad', 'mirror', 'instances'])
      for (const camera of ['front', 'back']) {
        const selected = geometry === 'instances' ? instancePoints : points,
          label = `integrated-occlusion-${geometry}-${camera}`,
          actual = await render(
            label,
            { side: 'back' },
            { geometry, camera, auxiliary: true, occlusion: true },
            selected,
          ),
          outputs = await page.evaluate(async (points) => {
            const result = [];
            for (const point of points) result.push(await window.backSideFixture.readAuxiliary(point));
            return result;
          }, selected);
        check(
          label + ' normal-depth MRT visibility',
          outputs.map((entries) => entries[3][3]),
          selected.map(() => (camera === 'back' ? 5 : 0)),
        );
        check(
          label + ' ambient MRT visibility',
          outputs.map((entries) => entries[4][3]),
          selected.map(() => (camera === 'back' ? 1 : 0)),
        );
        check(label + ' actual occlusion entry compiled', actual.state.entries.includes('margoOcclusion'), true);
      }
    await render('live-start', { shading: 'basic', color: [1, 0, 0], side: 'front' });
    for (const [label, options, side, visible] of [
      ['to-back', { side: 'back' }, 'back', false],
      ['to-double', { side: 'double' }, 'double', true],
      ['legacy-false', { doubleSided: false }, 'front', true],
      ['back-again', { side: 'back' }, 'back', false],
      ['legacy-true', { doubleSided: true }, 'double', true],
      ['back-reuse', { side: 'back' }, 'back', false],
    ]) {
      const actual = await live(label, options);
      check(label + ' public alias', actual.state.properties, { side, doubleSided: side === 'double' });
      check(
        label + ' raster pixels',
        actual.image.map((p) => p.rgba),
        points.map(() => (visible ? [255, 0, 0, 255] : empty.image[0].rgba)),
      );
      if (label === 'back-reuse')
        check('warmed side variant creates no new pipelines', actual.state.allocations.pipelines, 0);
    }
    await render(
      'restore-back',
      { shading: 'basic', color: [1, 0, 0], side: 'back' },
      { camera: 'back', geometry: 'instances' },
      instancePoints,
    );
    const restored = await page.evaluate(() => window.backSideFixture.restore());
    check('GPU device actually replaced', restored.changedDevice, true);
    const restoredImage = await read('restored-back', restored, instancePoints);
    check(
      'back-only mixed mirrored instances survive restore',
      restoredImage.image.map((p) => p.rgba),
      instancePoints.map(() => [255, 0, 0, 255]),
    );
    await picks('restored back instances', true, instancePoints);
    for (const camera of ['front', 'back']) {
      await render(`${camera}-aux-double`, { side: 'double' }, { camera, auxiliary: true });
      const reference = await page.evaluate(() => window.backSideFixture.readAuxiliary());
      const actual = await render(`${camera}-aux-back`, { side: 'back' }, { camera, auxiliary: true });
      const auxiliary = await page.evaluate(() => window.backSideFixture.readAuxiliary());
      check(
        `${camera} gbuffer and ambient cull back-only`,
        auxiliary,
        camera === 'back'
          ? reference
          : [
              [0, 0, 0, 0],
              [0, 0, 0, 0],
            ],
      );
      check(`${camera} gbuffer entry compiled`, actual.state.entries.includes('gbuffer'), true);
      check(`${camera} ambient entry compiled`, actual.state.entries.includes('ambientFragment'), true);
    }
    for (const mode of ['transmission', 'oit'])
      for (const camera of ['front', 'back']) {
        const options =
            mode === 'transmission'
              ? { transmission: 0.8, dispersion: 2, thickness: 0.2, roughness: 0.1 }
              : { shading: 'basic', color: [1, 0, 0], transparent: true, opacity: 0.6 },
          variant = { camera, [mode]: true, hdr: true },
          double = await render(`${camera}-${mode}-double`, { ...options, side: 'double' }, variant),
          back = await render(`${camera}-${mode}-back`, { ...options, side: 'back' }, variant);
        if (camera === 'back')
          check(`${mode} back-side path equals double-sided rear surface`, back.image, double.image);
        else {
          const front = await render(`${camera}-${mode}-front`, { ...options, side: 'front' }, variant);
          check(`${mode} visible front equals double`, front.image, double.image);
          check(`${mode} back-only actually culled`, JSON.stringify(back.image) !== JSON.stringify(front.image), true);
        }
      }
    for (const geometry of ['lines', 'points'])
      for (const mirror of [false, true]) {
        const label = geometry + (mirror ? '-mirrored' : '-ordinary');
        await render(label + '-front', { side: 'front' }, { geometry, mirror });
        const before = await page.evaluate(() => window.backSideFixture.digest());
        check(label + ' fixture actually renders geometry', before !== emptyDigest, true);
        await render(label + '-back', { side: 'back' }, { geometry, mirror });
        check(
          label + ' ignore triangle side controls',
          await page.evaluate(() => window.backSideFixture.digest()),
          before,
        );
      }
    if (baseline)
      for (const doubleSided of [false, true])
        for (const shading of [undefined, 'standard', 'basic', 'normal', 'depth', 'distance']) {
          const options = { ...(shading ? { shading } : {}), doubleSided, color: [0.3, 0.6, 0.2], roughness: 0.7 };
          await render(`legacy-${shading}-${doubleSided}`, options, { legacy: true });
          const before = await page.evaluate(() => window.backSideFixture.digest());
          await render(`current-${shading}-${doubleSided}`, options);
          check(
            `${shading ?? 'default'} legacy doubleSided=${doubleSided} entire attachment unchanged`,
            await page.evaluate(() => window.backSideFixture.digest()),
            before,
          );
        }
  }
  check('page errors', errors, []);
  check('GPU validation and engine errors', await page.evaluate(() => window.backSideFixture.errors), []);
  assert.deepEqual(report.failures, [], 'Back-side GPU comparisons failed');
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
  await browser?.page.evaluate(() => window.backSideFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
