import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

// In parallel worktrees, set MARGO_GPU_LOCK to the shared adapter lock before running.
// Browser/channel/adapter choices are supplied through scripts/browser.js environment options.
const release = await acquire({ owner: 'material-depth-distance-gpu-check' }),
  report = { checks: [], failures: [], captures: [] },
  points = [
    [80, 80],
    [160, 120],
    [235, 165],
  ],
  baseCamera = { position: [0, 0, 5], target: [0, 0, 0] },
  output = 'test-results/material-depth-distance';
let browser,
  samples = 4;
const sub = (a, b) => a.map((v, i) => v - b[i]),
  add = (a, b) => a.map((v, i) => v + b[i]),
  scale = (a, k) => a.map((v) => v * k),
  dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0),
  unit = (a) => scale(a, 1 / Math.hypot(...a)),
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  clamp = (v) => Math.max(0, Math.min(1, v));

// CPU ray/plane intersection uses authored camera/frustum values, never a renderer matrix or shader string.
function worldAt([x, y], variant = {}, z = variant.z ?? 0) {
  const camera = variant.camera ?? baseCamera,
    backward = unit(sub(camera.position, camera.target)),
    right = unit(cross([0, 1, 0], backward)),
    up = cross(backward, right),
    nx = (2 * (x + 0.5)) / 320 - 1,
    ny = 1 - (2 * (y + 0.5)) / 240,
    origin =
      variant.projection === 'orthographic'
        ? add(camera.position, add(scale(right, nx * 4), scale(up, ny * 3)))
        : camera.position,
    direction =
      variant.projection === 'orthographic'
        ? scale(backward, -1)
        : add(
            scale(backward, -1),
            add(scale(right, nx * (4 / 3) * Math.tan(Math.PI / 6)), scale(up, ny * Math.tan(Math.PI / 6))),
          ),
    transformed = variant.geometry === 'transformed',
    normal = transformed ? [Math.sin(0.3), 0, Math.cos(0.3)] : [0, 0, 1],
    plane = transformed ? [1, -2, z] : [0, 0, z],
    t = dot(sub(plane, origin), normal) / dot(direction, normal);
  return add(origin, scale(direction, t));
}
function expected(point, options, variant = {}, z) {
  const world = worldAt(point, variant, z),
    camera = variant.camera ?? baseCamera,
    viewDepth = dot(sub(world, camera.position), unit(sub(camera.target, camera.position))),
    forwardDepth = variant.projection === 'orthographic' ? (viewDepth - 1) / 20 : (21 / 20) * (1 - 1 / viewDepth),
    distance =
      (Math.hypot(...sub(world, options.referencePosition ?? [0, 0, 0])) - (options.nearDistance ?? 1)) /
      ((options.farDistance ?? 1000) - (options.nearDistance ?? 1)),
    packing = options.depthPacking ?? (options.shading === 'distance' ? 'rgba' : 'basic');
  return {
    world,
    packing,
    value: clamp(options.shading === 'depth' ? (packing === 'basic' ? 1 - forwardDepth : forwardDepth) : distance),
  };
}
// Independent inverse of the base-256 RGBA encoding. Endpoints map to all-zero/all-one channels.
function unpack(rgba) {
  const weights = [255 / 256, 255 / 65536, 255 / 16777216, 1 / 16777216];
  return rgba.reduce((sum, byte, index) => sum + (byte / 255) * weights[index], 0);
}
function check(name, actual, expected) {
  report.checks.push({ name, samples, actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    report.failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function close(name, actual, expected, tolerance) {
  const error = Math.abs(actual - expected);
  report.checks.push({ name, samples, actual, expected, error, tolerance });
  if (!Number.isFinite(actual) || error > tolerance)
    report.failures.push(`${samples}x ${name}: ${actual} != ${expected} (error ${error}, tolerance ${tolerance})`);
}
function numeric(label, image, options, variant = {}, region) {
  for (const [index, { point, rgba }] of image.entries()) {
    const local = region?.(point, index) ?? {},
      reference = expected(point, { ...options, ...local.options }, variant, local.z),
      name = `${label} at ${point}`;
    // Analytic rays and fixed-point raster interpolation differ slightly for mirrored perspective triangles.
    if (reference.packing === 'rgba') close(name + ' independently unpacked', unpack(rgba), reference.value, 3e-6);
    else {
      for (let channel = 0; channel < 3; channel++)
        close(name + ' ' + 'RGB'[channel], rgba[channel] / 255, reference.value, 0.5 / 255 + 2e-6);
      close(name + ' alpha', rgba[3] / 255, options.transparent ? (options.opacity ?? 1) : 1, 0.5 / 255 + 1e-6);
    }
  }
}
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/material-depth-distance.html', port: 5217 });
  report.hardware = browser.hardware;
  const page = browser.page,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.depthDistanceFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const legacyAvailable = await access('test-results/pre-depth-materials-dist/index.js').then(
    () => true,
    () => false,
  );
  report.legacyBaselineAvailable = legacyAvailable;
  async function read(label, state, selected = points) {
    const image = await page.evaluate((points) => window.depthDistanceFixture.read(points), selected);
    report.captures.push({ label, samples, state, image });
    return { state, image };
  }
  async function render(label, options = {}, variant = {}, selected = points) {
    const state = await page.evaluate(({ options, variant }) => window.depthDistanceFixture.render(options, variant), {
      options,
      variant,
    });
    check(label + ' actual raster samples', state.sampleCount, samples);
    return read(label, state, selected);
  }
  async function live(label, options, selected = points) {
    const state = await page.evaluate((options) => window.depthDistanceFixture.live(options), options);
    check(label + ' unchanged-frame resource allocations', state.allocations, state.controlAllocations);
    for (const resource of ['textures', 'samplers', 'buffers'])
      check(label + ' no new ' + resource, state.allocations[resource], 0);
    return read(label, state, selected);
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.goto('http://127.0.0.1:5217/tests/material-depth-distance.html?samples=1');
      await page.waitForFunction(() => window.depthDistanceFixture);
    }
    // First RED run rejects this public constructor against the preimplementation dist.
    const probe = await render('depth-default', { shading: 'depth' });
    check('depth defaults to basic packing', probe.state.properties.depthPacking, 'basic');
    numeric('depth default reverse-Z', probe.image, { shading: 'depth' });
    for (const projection of ['perspective', 'orthographic']) {
      for (const shading of ['depth', 'distance'])
        for (const depthPacking of ['basic', 'rgba']) {
          const options = {
              shading,
              depthPacking,
              nearDistance: 0.2,
              farDistance: 7.3,
              referencePosition: [-1.2, 0.7, -0.4],
            },
            variant = { projection, z: 0.4 },
            label = `${projection}-${shading}-${depthPacking}`,
            actual = await render(label, options, variant);
          numeric(label, actual.image, options, variant);
        }
      for (const [label, z, value] of [
        ['near', 4, 0],
        ['far', -16, 1],
      ]) {
        const options = { shading: 'depth', depthPacking: 'rgba' },
          variant = { projection, z },
          actual = await render(`${projection}-depth-${label}-endpoint`, options, variant, [[160, 120]]);
        numeric(`${projection} depth ${label} endpoint`, actual.image, options, variant);
        check(`${projection} depth ${label} endpoint exact bytes`, actual.image[0].rgba, Array(4).fill(value * 255));
      }
      const centreWorld = worldAt([160, 120], { projection });
      for (const [label, nearDistance, farDistance, byte] of [
        ['near', 1, 2, 0],
        ['far', 0, 1, 255],
      ]) {
        const options = {
            shading: 'distance',
            nearDistance,
            farDistance,
            referencePosition: [centreWorld[0], centreWorld[1], -1],
          },
          variant = { projection },
          actual = await render(`${projection}-distance-${label}-endpoint`, options, variant, [[160, 120]]);
        numeric(`${projection} distance ${label} exact endpoint`, actual.image, options, variant);
        check(`${projection} distance ${label} exact endpoint bytes`, actual.image[0].rgba, Array(4).fill(byte));
      }
    }
    const distanceDefault = await render('distance-default', { shading: 'distance' });
    check('distance default properties', distanceDefault.state.properties, {
      shading: 'distance',
      depthPacking: 'rgba',
      referencePosition: [0, 0, 0],
      nearDistance: 1,
      farDistance: 1000,
    });
    numeric('distance defaults', distanceDefault.image, { shading: 'distance' });
    for (const [name, nearDistance, farDistance, referencePosition, byte] of [
      ['near-clamp', 10, 15, [0, 0, 1], 0],
      ['far-clamp', 0, 2, [0, 0, 5], 255],
    ]) {
      const options = { shading: 'distance', nearDistance, farDistance, referencePosition },
        actual = await render(name, options);
      numeric(name, actual.image, options);
      for (const pixel of actual.image) check(name + ' endpoint bytes ' + pixel.point, pixel.rgba, Array(4).fill(byte));
    }
    const movedCamera = { position: [3, 2, 6], target: [1, -1, 0] };
    for (const shading of ['depth', 'distance'])
      for (const geometry of ['transformed', 'mirror']) {
        const options = {
            shading,
            depthPacking: 'rgba',
            referencePosition: [1.3, -1.7, 2.4],
            nearDistance: 0.1,
            farDistance: 9,
          },
          variant = { geometry, z: 0.7, camera: movedCamera },
          label = shading + '-' + geometry,
          actual = await render(label, options, variant);
        numeric(label, actual.image, options, variant);
      }
    for (const geometry of ['groups', 'instances', 'shared']) {
      const options = { shading: 'distance', referencePosition: [-0.7, 1, 1.2], nearDistance: 0.2, farDistance: 8 },
        secondary = { referencePosition: [2, -1, 0.3], nearDistance: 0.5, farDistance: 5 },
        variant = { projection: 'orthographic', geometry, z: 0.4, secondary },
        selected =
          geometry === 'instances'
            ? [
                [91, 120],
                [117, 120],
                [203, 120],
                [229, 120],
              ]
            : [
                [80, 120],
                [240, 120],
              ],
        actual = await render('geometry-' + geometry, options, variant, selected),
        region = (point, index) => ({
          options:
            geometry === 'shared' || (geometry === 'instances' ? index % 2 === 0 : point[0] < 160) ? {} : secondary,
          z: 0.4 - (geometry === 'instances' ? +(index >= 2) : geometry === 'shared' ? +(point[0] > 160) : 0),
        });
      numeric(geometry + ' world distance', actual.image, options, variant, region);
      check(geometry + ' primitive ranges', actual.state.primitives, geometry === 'shared' ? [1, 1] : [2]);
      check(geometry + ' shared instance storage', actual.state.sharedInstances, true);
      const update = { referencePosition: [0.4, -0.8, 3], nearDistance: 0, farDistance: 10 },
        changed = await live(geometry + '-live', update, selected);
      numeric(geometry + ' live world distance', changed.image, { ...options, ...update }, variant, region);
      const restored = await read(
        geometry + '-restored',
        await page.evaluate(() => window.depthDistanceFixture.restore()),
        selected,
      );
      check(geometry + ' replacement device', restored.state.changedDevice, true);
      check(geometry + ' restored raw pixels', restored.image, changed.image);
    }
    for (const shading of ['depth', 'distance']) {
      const options = {
          shading,
          depthPacking: 'basic',
          referencePosition: [-1, 2, 0],
          nearDistance: 0,
          farDistance: 7,
        },
        original = await render(shading + '-live-basic', options),
        packed = await live(shading + '-live-rgba', { depthPacking: 'rgba' });
      numeric(shading + ' live packing', packed.image, { ...options, depthPacking: 'rgba' });
      const basic = await live(shading + '-live-basic-again', { depthPacking: 'basic' });
      check(shading + ' live packing restores exact basic bytes', basic.image, original.image);
      const opaque = await render(shading + '-basic-opacity', {
        ...options,
        transparent: true,
        opacity: 0.35,
        blending: 'none',
      });
      numeric(shading + ' basic opacity', opaque.image, { ...options, transparent: true, opacity: 0.35 });
      const blank = await render(shading + '-empty', {}, { empty: true }),
        cut = { ...options, alphaTest: 0.5 },
        uv0 = await render(shading + '-alpha-uv0', cut, { mapped: 'uv0' }),
        uv1 = await render(shading + '-alpha-uv1', cut, { mapped: 'uv1' }),
        transformed = await render(shading + '-alpha-transform', cut, { mapped: 'uv1-transform' });
      check(shading + ' UV0 alpha discards', uv0.image, blank.image);
      numeric(shading + ' UV1 alpha survives without tinting data', uv1.image, cut);
      check(shading + ' independent UV1 transform discards', transformed.image, blank.image);
      for (const mapped of [undefined, 'uv1']) {
        const auxiliary = await render(
          shading + '-aux-' + (mapped ?? 'plain'),
          { ...options, alphaTest: 0.5 },
          { auxiliary: true, mapped },
        );
        numeric(shading + ' auxiliary compilation keeps beauty data', auxiliary.image, options);
        check(shading + ' gbuffer entry compiled', auxiliary.state.entries.includes('gbuffer'), true);
        check(shading + ' ambient entry compiled', auxiliary.state.entries.includes('ambientFragment'), true);
      }
      const node = await render(shading + '-node', options, { node: true, auxiliary: true });
      numeric(shading + ' NodeMaterial composes with data output', node.image, options);
      const vertexNode = await render(shading + '-node-position', options, {
        node: true,
        nodePosition: 0.6,
        auxiliary: true,
      });
      numeric(shading + ' NodeMaterial uses the deformed world position', vertexNode.image, options, { z: 0.6 });
      const packedTransparent = {
          ...options,
          depthPacking: 'rgba',
          transparent: true,
          opacity: 0.35,
          blending: 'none',
        },
        transparentPacked = await render(shading + '-packed-transparent-no-blending', packedTransparent);
      numeric(shading + ' explicit unblended transparent packed data', transparentPacked.image, packedTransparent);
      const expectedUniform = [...options.referencePosition, 0, options.nearDistance, options.farDistance, 1, 0].map(
        Math.fround,
      );
      check(
        shading + ' binding 196 uploads exactly eight configured floats',
        transparentPacked.state.uniforms.some((values) => JSON.stringify(values) === JSON.stringify(expectedUniform)),
        true,
      );
    }
    const halfWorld = worldAt([160, 120]),
      halfOptions = {
        shading: 'distance',
        depthPacking: 'rgba',
        transparent: true,
        opacity: 0.35,
        blending: 'none',
        referencePosition: [halfWorld[0], halfWorld[1], -1],
        nearDistance: 0,
        farDistance: 2,
      },
      half = await render('distance-half-transparent-unblended', halfOptions, {}, [[160, 120]]);
    numeric('distance half with packed alpha zero', half.image, halfOptions);
    check('transparent packed alpha is actual data', half.image[0].rgba, [128, 0, 0, 0]);
    if (legacyAvailable)
      for (const shading of [undefined, 'standard', 'basic', 'normal']) {
        const options = { ...(shading ? { shading } : {}), color: [0.3, 0.6, 0.2], roughness: 0.7 },
          before = await render('legacy-' + (shading ?? 'default'), options, { legacy: true });
        const beforeDigest = await page.evaluate(() => window.depthDistanceFixture.digest()),
          after = await render('current-' + (shading ?? 'default'), options),
          afterDigest = await page.evaluate(() => window.depthDistanceFixture.digest());
        check((shading ?? 'default') + ' pixels equal the preimplementation dist', after.image, before.image);
        check((shading ?? 'default') + ' entire attachment equals preimplementation dist', afterDigest, beforeDigest);
      }
  }
  check('page errors', errors, []);
  check('GPU validation and engine errors', await page.evaluate(() => window.depthDistanceFixture.errors), []);
  assert.deepEqual(report.failures, [], 'Material depth/distance GPU comparisons failed');
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
  await browser?.page.evaluate(() => window.depthDistanceFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
