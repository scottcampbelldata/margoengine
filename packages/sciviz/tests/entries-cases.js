// The drawing cases of entries-browser.js, one per entry feature. Each places the camera, adds its layer and returns
// the facts it checked.
import { gridLayer, meshLayer, sliceGrid, CELL_TYPES } from '@margoengine/sciviz/grids';
import { streamTubeGeometry, streamRibbonGeometry, streamMeshTriangles } from '@margoengine/sciviz/tubes';
import { ForceLayout, graphLayer } from '@margoengine/sciviz/graph';
import { tileLayer } from '@margoengine/sciviz/geo';
import { tracePathline, traceStreakline, flowParticles, flowSeeds } from '@margoengine/sciviz/flow';
import { lic } from '@margoengine/sciviz/lic';

/** The cases entries-browser.js runs, in order. */
export const cases = [];
const addCase = (name, run, mode = '3d') => cases.push({ name, run, mode });

for (const kind of ['tubes', 'ribbons']) addCase(kind, async (figure, { assert, pixels, lit }) => {
  look(figure);
  const positions = Array.from({ length: 65 }, (_, i) => {
    const t = i / 64 * 2 * Math.PI; return [Math.cos(t), Math.sin(t), i / 32 - 1];
  }).flat(), scalar = Array.from({ length: 65 }, (_, i) => i / 64);
  const mesh = kind === 'tubes'
    ? streamTubeGeometry({ positions, scalar }, { radius: scalar.map((v) => 0.06 + 0.1 * v), sides: 16, steps: 192 })
    : streamRibbonGeometry({ positions, scalar }, { width: 0.3, steps: 192,
      streamwiseVorticity: scalar.map(() => 2), speeds: scalar.map(() => 1) });
  const set = streamMeshTriangles(mesh), layer = meshLayer(figure, set, { range: [0, 1] });
  await figure.ready();
  const image = await pixels(), count = lit(image);
  assert(count > 1000, `${kind} has ${count} lit pixels`);
  assert(layer.triangles === mesh.indices.length / 3, 'all generated triangles are drawn');
  assert(set.normals.every(Number.isFinite), 'smooth normals survive triangle conversion');
  return { triangles: layer.triangles, lit: count };
});

addCase('lic', async (figure, { assert, pixels, lit }) => {
  figure.engine.stop();
  const base = { dims: [2, 2, 1], bounds: [-2, 2, -1, 1, 5, 5], u: [1, 1, 1, 1], v: [0, 0, 0, 0] };
  const options = { resolution: [64, 32], steps: 8, step: 1, seed: 171, contrast: 1, coloured: false };
  const hash = (x, y) => {
    let h = (Math.imul(x, 1664525) + Math.imul(y, 1013904223)) ^ 171;
    h = Math.imul(h ^ (h >>> 16), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 8) / 16777216;
  };
  const layer = await lic(figure, base, options);
  const read = await layer.readIntensity();
  let error = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    let sum = 0, n = 0;
    for (let at = Math.max(0, x - 8); at <= Math.min(63, x + 8); at++) { sum += hash(at, y); n++; }
    error = Math.max(error, Math.abs(read[y * 64 + x] - sum / n));
  }
  assert(error < 2e-6, `LIC horizontal analytical box convolution error ${error}`);
  // Static LIC has no orientation: reversing the field must preserve every texel.
  const reverse = await lic(figure, { ...base, u: [-1, -1, -1, -1] }, options);
  const reversed = await reverse.readIntensity();
  assert(read.every((v, i) => Math.abs(v - reversed[i]) < 2e-6), 'symmetric forward/backward convolution');
  figure.remove(reverse);
  const tiny = await lic(figure, { ...base, u: [1e-100, 1e-100, 1e-100, 1e-100] }, options);
  const tinyImage = await tiny.readIntensity();
  assert(read.every((v, i) => Math.abs(v - tinyImage[i]) < 2e-6), 'tiny velocities have identical geometry'); figure.remove(tiny);
  const mixed = await lic(figure, { ...base, dims: [4, 2, 1],
    u: [1e-24, 1e-24, 1, 1, 1e-24, 1e-24, 1, 1], v: Array(8).fill(0) }, options);
  const mixedImage = await mixed.readIntensity();
  assert(read.every((v, i) => Math.abs(v - mixedImage[i]) < 2e-6),
    '24 orders of magnitude of parallel velocities preserve every LIC tangent and intensity');
  figure.remove(mixed);
  // Orthogonal field: exact vertical, rather than horizontal, convolution.
  const vertical = await lic(figure, { ...base, u: [0, 0, 0, 0], v: [1, 1, 1, 1] }, options);
  const vr = await vertical.readIntensity();
  for (const [x, y] of [[0, 0], [32, 16], [63, 31]]) {
    let sum = 0, n = 0;
    for (let at = Math.max(0, y - 8); at <= Math.min(31, y + 8); at++) { sum += hash(x, at); n++; }
    assert(Math.abs(vr[y * 64 + x] - sum / n) < 2e-6, 'vertical box convolution in an anisotropic field');
  }
  figure.remove(vertical); figure.remove(layer);
  const stopped = await lic(figure, { ...base, u: [0, 0, 0, 0] }, { ...options, animated: true, phase: Math.PI });
  const noise = await stopped.readIntensity();
  assert(noise.every((v, i) => Math.abs(v - hash(i % 64, Math.floor(i / 64))) < 2e-6), 'stagnation retains noise even at a zero filter weight');
  figure.remove(stopped);
  const volume = { dims: [2, 2, 2], bounds: [-2, 2, -1, 1, 3, 7], u: new Float32Array(8).fill(1), v: new Float32Array(8), w: new Float32Array(8).fill(1) };
  const slice = { origin: [-2, -1, 3], axisU: [4, 0, 4], axisV: [0, 2, 0] };
  const oblique = await lic(figure, volume, { ...options, slice });
  const sr = await oblique.readIntensity();
  assert(read.every((v, i) => Math.abs(v - sr[i]) < 2e-6), 'oblique 3D projection follows the slice tangent'); figure.remove(oblique);
  const masked = await lic(figure, { ...base, u: [NaN, 1, NaN, 1] }, options);
  assert((await masked.readIntensity()).every(Number.isNaN), 'weighted missing field nodes mask without bridging'); figure.remove(masked);
  const partial = await lic(figure, base, { ...options, slice: { origin: [-4, -1, 5], axisU: [8, 0, 0], axisV: [0, 2, 0] } });
  const pr = await partial.readIntensity();
  assert(pr.filter(Number.isFinite).length === 32 * 32, 'outside slice texels are transparent'); figure.remove(partial);
  const animation = await lic(figure, base, { ...options, animated: true, coloured: true, scalar: [0, 1, 0, 1] });
  const initial = await animation.readIntensity(); animation.setPhase(1);
  const moved = await animation.readIntensity();
  assert(moved.every(Number.isFinite) && moved.some((v, i) => Math.abs(v - initial[i]) > 0.01), 'phase changes the convolution');
  animation.setPhase(1 + 2 * Math.PI);
  const loop = await animation.readIntensity();
  assert(moved.every((v, i) => Math.abs(v - loop[i]) < 2e-6), 'animation loops in phase');
  look(figure, ...TOP); await figure.ready();
  const count = lit(await pixels()); assert(count > 5000, `LIC surface lit ${count} pixels`);
  return { analyticalError: error, lit: count };
});

addCase('lic-curvature', async (figure, { assert, pixels, lit }) => {
  figure.engine.stop();
  const u = [], v = [];
  for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) { u.push(-(y / 8 - 1)); v.push(x / 8 - 1); }
  const grid = { dims: [17, 17, 1], bounds: [-1, 1, -1, 1, 0, 0], u, v };
  const options = { resolution: [64, 64], steps: 12, step: 0.5, contrast: 1, coloured: false, seed: 0 };
  const layer = await lic(figure, grid, options);
  const raw = await layer.readIntensity();
  // Independent exact circular streamline, with the specified bilinear noise image.
  const hash = (x, y) => {
    let h = Math.imul(x, 1664525) + Math.imul(y, 1013904223);
    h = Math.imul(h ^ (h >>> 16), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 8) / 16777216;
  };
  const noise = (x, y) => {
    x = Math.max(0, Math.min(63, x)); y = Math.max(0, Math.min(63, y));
    const i = Math.floor(x), j = Math.floor(y), tx = x - i, ty = y - j;
    return (hash(i, j) * (1 - tx) + hash(Math.min(63, i + 1), j) * tx) * (1 - ty) +
      (hash(i, Math.min(63, j + 1)) * (1 - tx) + hash(Math.min(63, i + 1), Math.min(63, j + 1)) * tx) * ty;
  };
  let error = 0;
  for (const [x, y] of [[48, 32], [45, 45], [32, 48], [16, 32], [32, 16]]) {
    const px = x - 31.5, py = y - 31.5, radius = Math.hypot(px, py), angle = Math.atan2(py, px);
    let sum = 0;
    for (let i = -12; i <= 12; i++) {
      const a = angle + i * 0.5 / radius;
      sum += noise(31.5 + radius * Math.cos(a), 31.5 + radius * Math.sin(a));
    }
    error = Math.max(error, Math.abs(raw[y * 64 + x] - sum / 25));
  }
  assert(error < 0.001, `curved-streamline LIC differs from exact circular arcs by ${error}`);
  figure.remove(layer);
  const animation = await lic(figure, grid, { ...options, animated: true, phase: 0.7 });
  const ar = await animation.readIntensity(); figure.remove(animation);
  const reverse = await lic(figure, { ...grid, u: u.map((x) => -x), v: v.map((x) => -x) }, { ...options, animated: true, phase: -0.7 });
  const rr = await reverse.readIntensity();
  assert(ar.every((value, i) => Math.abs(value - rr[i]) < 2e-6), 'reversing velocity and phase preserves direction-animation luminance');
  look(figure, ...TOP); await figure.ready();
  const count = lit(await pixels()); assert(count > 5000, 'curved LIC covers its plane');
  return { exactArcError: error, lit: count };
});

addCase('flow-motion', async (figure, { assert, pixels, lit }) => {
  figure.engine.stop();
  const field = {
    dims: [2, 2, 1], bounds: [-4, 4, -4, 4, 0, 0],
    frames: [{ time: 0, u: new Float32Array(4).fill(1), v: new Float32Array(4).fill(0.5) }],
  };
  const reject = async (promise, check) => {
    let error;
    try { await promise; } catch (e) { error = e; }
    assert(error && check(error), `expected rejection, got ${error?.message}`);
  };
  const close = (a, b, bound = 0.0002) => {
    assert(a.length === b.length, 'matching sample counts');
    a.forEach((v, i) => assert(Math.abs(v - b[i]) <= bound, `component ${i}: ${v} vs ${b[i]}`));
  };
  const options = { count: 96, trails: 16, width: 3, opacity: 1, lifetime: 10,
    seeding: { kind: 'region', bounds: [-3, 1, -3, 1, 0, 0] } };
  const layer = await flowParticles(figure, field, options);
  const seeds = flowSeeds(field, options.count, options.seeding);
  await layer.advance(1, { step: 0.125 });
  const actual = await layer.readPositions();
  for (let i = 0; i < options.count; i++) close(actual.slice(4 * i, 4 * i + 4), [seeds[3 * i] + 1, seeds[3 * i + 1] + 0.5, 0, 1]);
  const again = await flowParticles(figure, field, options);
  await again.advance(1, { step: 0.125 });
  close(await again.readPositions(), actual, 0);
  again.dispose();
  // Analytic unsteady 3D expansion/rotation and a piecewise temporal kink, against the CPU Wasm reference.
  const dims = [5, 5, 5], frames = [0, 0.3, 2].map((time) => {
    const u = new Float32Array(125), v = new Float32Array(125), w = new Float32Array(125);
    for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const k = x + 5 * (y + 5 * z);
      u[k] = -(y - 2) + time * 0.125; v[k] = x - 2; w[k] = (z - 2) * 0.125;
    }
    return { time, u, v, w };
  });
  const grid = { dims, bounds: [-2, 2, -2, 2, -2, 2], frames }, seed = [0.5, 0, 0.25];
  const rotation = await flowParticles(figure, grid, { count: 1, respawn: false, lifetime: 10,
    seeding: { kind: 'rake', start: seed, end: seed } });
  const reference = await tracePathline(grid, seed, { from: 0, to: 1, step: 0.025 });
  await rotation.advance(1, { step: 0.025 });
  close((await rotation.readPositions()).slice(0, 3), reference.samples.slice(-4, -1));
  rotation.dispose();
  const streak = await traceStreakline(grid, seed, [0, 0.3, 1], { to: 1, step: 0.025 });
  close(streak.samples.slice(0, 3), reference.samples.slice(-4, -1), 1e-12);
  close(streak.samples.slice(-4), [...seed, 1], 0);
  // Lifetimes and domain exits restart at the fixed seeds, without joining different releases.
  const life = await flowParticles(figure, field, { count: 1, lifetime: 0.25, seeding: { kind: 'rake', start: [0, 0, 0], end: [0, 0, 0] } });
  await life.advance(0.375, { step: 0.125 });
  close(await life.readPositions(), [0.125, 0.0625, 0, 0.125]);
  life.dispose();
  const longLife = await flowParticles(figure, { ...field, frames: [{ time: 0, u: new Float32Array(4), v: new Float32Array(4) }] },
    { count: 1, lifetime: 3e38 });
  await longLife.advance(4e38, { step: 2e38 });
  assert((await longLife.readPositions())[3] === 0, 'finite large ages/steps expire without storing an overflowing sum');
  longLife.dispose();
  const missing = { ...field, frames: [field.frames[0], { time: 1, u: new Float32Array(4).fill(NaN), v: new Float32Array(4) }] };
  const death = await flowParticles(figure, missing, { count: 1, respawn: false });
  assert((await death.readPositions())[3] === 0, 'inactive NaN next frame does not invalidate exact current time');
  await death.advance(0.1, { step: 0.1 });
  assert((await death.readPositions())[3] === -1, 'an active NaN frame kills the particle');
  death.dispose();
  const abort = new AbortController(), reason = { cancelled: true };
  const pending = layer.advance(1.5, { step: 0.125, signal: abort.signal });
  await reject(layer.advance(2, { step: 0.125 }), (e) => e.code === 'state');
  abort.abort(reason);
  await reject(pending, (e) => e === reason);
  assert(layer.time === 1.125, 'cancelled advance retains exactly the first submitted step');
  await reject(layer.readPositions({ signal: abort.signal }), (e) => e === reason);
  await reject(flowParticles(figure, field, { signal: abort.signal }), (e) => e === reason);
  await reject(layer.advance(0, { step: 0.1 }), (e) => e instanceof RangeError);
  await reject(flowParticles(figure, field, { count: 1_000_000, trails: 256 }), (e) => e instanceof RangeError);
  await reject(flowParticles(figure, field, { respawn: 'yes' }), (e) => e instanceof RangeError);
  const extreme = await flowParticles(figure, { ...field, frames: [{ ...field.frames[0], u: new Float32Array(4).fill(1e37) }] }, { count: 1 });
  await reject(extreme.advance(1e10, { step: 1e10 }), (e) => e instanceof RangeError);
  assert(extreme.steps === 0, 'float32 overflow is rejected before any integration dispatch');
  extreme.dispose();
  const offset = await flowParticles(figure, { ...field, bounds: [100, 108, 200, 208, 5, 5] }, { count: 1 });
  const m = figure.model;
  close(offset.center(), [0, 1, 2].map((row) => m[row] * 104 + m[row + 4] * 204 + m[row + 8] * 5 + m[row + 12]), 1e-12);
  figure.remove(offset); // Remove its offset bounds as well as its GPU resources.
  const copiedField = { ...field, frames: [{ ...field.frames[0], u: field.frames[0].u.slice() }] };
  const copied = await flowParticles(figure, copiedField, { count: 1, maxSteps: 1, respawn: false,
    seeding: { kind: 'rake', start: [0, 0, 0], end: [0, 0, 0] } });
  copiedField.frames[0].u.fill(-1);
  copiedField.bounds = [0, 1, 0, 1, 0, 0];
  await copied.advance(1, { step: 1 });
  close(await copied.readPositions(), [1, 0.5, 0, 1]);
  await reject(copied.advance(2, { step: 1 }), (e) => e instanceof RangeError);
  copied.dispose();
  copied.dispose();
  await reject(copied.advance(2, { step: 1 }), (e) => e.code === 'disposed');
  for (const respawn of [true, false]) {
    const exit = await flowParticles(figure, field, { count: 1, respawn,
      seeding: { kind: 'rake', start: [3.9375, 0, 0], end: [3.9375, 0, 0] } });
    await exit.advance(0.125, { step: 0.125 });
    const position = await exit.readPositions();
    if (respawn) close(position, [3.9375, 0, 0, 0]);
    else assert(position[3] === -1, 'domain exit without respawn is explicitly dead');
    exit.dispose();
  }
  const count = lit(await pixels());
  assert(count > 500, `particles/trails cover ${count} pixels`);
  // Runner also replaces the actual device and requires exact rendered pixels after replay.
  return { checked: 'GPU RK4 2D/3D steady/unsteady, CPU oracle, deterministic replay, trails, seeds, respawn, NaNs, abort and bounds', steps: layer.steps, lit: count };
});

addCase('flow-pathline', async (figure, { assert }) => {
  figure.engine.stop();
  const frames = [0, 1].map((time) => ({
    time, u: new Float32Array(4).fill(2 * time), v: new Float32Array(4).fill(1),
  }));
  const path = await tracePathline({ dims: [2, 2, 1], bounds: [-1, 2, -1, 2, 0, 0], frames },
    [0, 0, 0], { from: 0, to: 1, step: 1 / 32 });
  assert(path.stop === 'end' && path.samples.length === 33 * 4, 'browser Wasm load and complete path');
  const x = [], y = [];
  for (let i = 0; i < path.samples.length; i += 4) {
    const t = path.samples[i + 3];
    assert(Math.abs(path.samples[i] - t * t) < 1e-12 && Math.abs(path.samples[i + 1] - t) < 1e-12,
      'every browser pathline sample matches the physical-time analytic trajectory');
    x.push(path.samples[i]);
    y.push(path.samples[i + 1]);
  }
  figure.setLimits([-0.2, 1.2, -0.2, 1.2]);
  await figure.line({ x, y }, { width: 6, color: '#ffffff' });
  return { checked: 'feature-local Wasm fetch, all analytic xyzt samples, GPU line and device replacement' };
}, '2d');

for (const kind of ['scatter', 'quiver', 'streamlines', 'histogram']) {
  addCase(
    `replace-${kind}`,
    async (figure, { pixels, lit, assert }) => {
      figure.engine.stop?.();
      figure.setLimits([0, 4, 0, 4]);
      const x = [],
        y = [];
      for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) x.push(0.5 + i / 10), y.push(0.5 + j / 10);
      const make = (offset) => {
        const shifted = x.map((v) => v + offset);
        const style = { color: '#ffffff', name: `Frame ${offset}` };
        if (kind === 'scatter') return figure.scatter({ x: shifted, y }, { ...style, size: 10 });
        if (kind === 'quiver')
          return figure.quiver(
            { x: shifted, y, u: x.map(() => 1), v: x.map(() => 0) },
            { ...style, scale: 0.3, width: 3 },
          );
        if (kind === 'histogram') return figure.histogram(shifted, { ...style, bins: 4, density: true });
        return figure.streamlines(
          { u: [1, 1, 1, 1], v: [0, 0, 0, 0], dims: [2, 2], bounds: [0, 4, 0, 4] },
          {
            ...style,
            width: 3,
            seeds: y.slice(0, 10).map((v, i) => [0.5 + offset, v + i / 5, 0]),
            maxSteps: 12,
            step: 0.03,
            direction: 'forward',
          },
        );
      };
      let trace = await make(0);
      const timeline = figure.timeline(
        [0, 1, 2],
        async (index) => {
          // Data preparation can span rendered frames. The previous trace stays drawn throughout.
          assert(lit(await pixels()) > 500, `${kind}: old trace vanished while preparing data`);
          await new Promise(requestAnimationFrame);
          const old = trace;
          trace = figure.replace(trace, await make(index));
          assert(
            figure.layers.length === 1 && figure.layers[0] === trace && !figure.layers.includes(old),
            `${kind}: duplicate or stale trace`,
          );
          assert(lit(await pixels()) > 500, `${kind}: replacement is empty`);
        },
        { controls: false },
      );
      await Promise.all([timeline.seek(1), timeline.seek(2)]);
      assert(timeline.index === 2 && trace.name === 'Frame 2', 'latest seek committed');
      assert(figure.replace(trace, trace) === trace, 'self replacement is a no-op');
      let refused = false;
      try {
        figure.replace({}, trace);
      } catch (error) {
        refused = error instanceof TypeError;
      }
      assert(refused && figure.layers.length === 1, 'foreign layer rejected without mutation');
      const svg = await figure.toSVG();
      assert(svg.includes('<svg'), 'replacement exports');
      const image = await pixels();
      const plugin = [...figure.engine.plugins.values()].find(
        (p) => p.name === (kind === 'scatter' ? 'points' : 'lines'),
      );
      if (kind === 'scatter') assert(plugin.pointClouds.size === 1, 'only the replacement cloud is registered');
      else if (kind !== 'histogram') assert(plugin.lines.size === 1, 'only the replacement line is registered');
      figure.remove(trace);
      assert(lit(await pixels()) === 0, 'removing the replacement leaves no stale drawn layers');
      trace = await make(2);
      const reference = await pixels();
      assert(
        image.data.every((v, i) => v === reference.data[i]),
        'replacement matches the same data drawn alone',
      );
      return { lit: lit(image), layers: figure.layers.length };
    },
    '2d',
  );
}

// The figure puts data x along scene x, data y along scene -z and data z up, so a flat (z = 0) layer is seen from
// above: TOP looks down with data y up the screen.
const TOP = [
  [0, 2.8, 0],
  [0, 0, -1],
];
function look(figure, position = [1.9, 1.3, 2.1], up = [0, 1, 0]) {
  figure.engine.stop?.();
  figure.engine.camera.position = position;
  figure.engine.camera.target = [0, 0, 0];
  figure.engine.camera.up = up;
}

// n x n x n unit hexahedra with point data x + y + z, as in tests/grids.test.js.
function block(n) {
  const points = [],
    id = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push(i, j, k);
  const connectivity = [],
    offsets = [],
    types = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        connectivity.push(id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k));
        connectivity.push(id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1));
        offsets.push(connectivity.length);
        types.push(CELL_TYPES.hexahedron);
      }
  const pointData = [];
  for (let p = 0; p < points.length; p += 3) pointData.push(points[p] + points[p + 1] + points[p + 2]);
  return { points, connectivity, offsets, types, pointData };
}

addCase('grid-surface', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles === 6 * 16 * 2, `surface has ${layer.triangles} triangles`);
  assert(count > 5000, `the grid surface lit ${count} pixels`);
  return { triangles: layer.triangles, lit: count };
});

addCase('grid-slice', async (figure, { pixels, lit, assert }) => {
  look(figure);
  const layer = gridLayer(figure, block(4), { slice: { normal: [1, 1, 1], offset: 6 }, colormap: 'aurora' });
  await figure.ready();
  const image = await pixels(),
    count = lit(image);
  assert(layer.triangles > 0, 'the slice cut no cells');
  assert(count > 2000, `the slice lit ${count} pixels`);
  const updated = sliceGrid(block(4), { normal: [1, 1, 1], offset: 5 });
  layer.update(updated);
  const moved = await pixels();
  assert(
    image.data.some((v, i) => v !== moved.data[i]),
    'updated mesh differs from its initial data before restore',
  );
  return { triangles: layer.triangles, lit: count };
});

// A ring of 120 nodes with chords, laid out for 150 steps; edges as lines and nodes as discs.
function ringGraph(nodes) {
  const edges = [];
  for (let i = 0; i < nodes; i++) edges.push(i, (i + 1) % nodes);
  for (let i = 0; i < nodes; i += 15) edges.push(i, (i + nodes / 2) % nodes);
  return { nodes, edges };
}

for (const dimensions of [2, 3])
  addCase(`graph-${dimensions}d`, async (figure, { pixels, lit, assert }) => {
    if (dimensions === 2) look(figure, ...TOP);
    else look(figure);
    const graph = ringGraph(120),
      layout = new ForceLayout(graph, { dimensions, seed: 3 });
    for (let i = 0; i < 150; i++) layout.step();
    assert(layout.positions.every(Number.isFinite), 'the layout gave a position that is not finite');
    // Colour by index so no node takes a colour map end that could match the background.
    const values = Array.from({ length: graph.nodes }, (_, i) => i),
      layer = graphLayer(figure, graph, layout.positions, {
        nodeSize: 6,
        values,
        range: [-20, 140],
        colormap: 'aurora',
      });
    await figure.ready();
    const image = await pixels(),
      count = lit(image);
    assert(layer.edges === graph.edges.length / 2, `the layer holds ${layer.edges} edges`);
    // 120 discs of 6 pixels across cover about 120 x 28 = 3,400 pixels; at least half must show past overlaps.
    assert(count > 1700, `the graph lit ${count} pixels`);
    layer.setPositions(layout.positions.map((v) => v * 0.8));
    const moved = await pixels();
    assert(
      image.data.some((v, i) => v !== moved.data[i]),
      'updated graph positions differ before restore',
    );
    return { edges: layer.edges, lit: count };
  });

// The nine Terrarium PNG tiles of the terrain fixtures, reused as the 16 tiles of zoom 2, so the whole map lights.
const FIXTURES = '/packages/terrain/test/fixtures/terrarium-10/';
const fixtureTile = async (z, x, y, signal) => {
  const response = await fetch(`${FIXTURES}${164 + (x % 3)}-${359 + (y % 3)}.png`, { signal });
  return response.blob();
};

// The map's area on screen in pixels: the convex hull of its outline (the plane) or of points all over it (the
// globe, whose silhouette is convex) projected by the figure's data-to-clip transform.
function mapArea(figure, map, image) {
  const m = figure.engine.camera.matrix,
    d = figure.model,
    at = (p) => {
      const s = [0, 1, 2].map((r) => d[r] * p[0] + d[4 + r] * p[1] + d[8 + r] * p[2] + d[12 + r]);
      const c = [0, 1, 2, 3].map((r) => m[r] * s[0] + m[4 + r] * s[1] + m[8 + r] * s[2] + m[12 + r]);
      return [((c[0] / c[3] + 1) / 2) * image.width, ((1 - c[1] / c[3]) / 2) * image.height];
    };
  const points = [];
  if (map.projection === 'globe')
    for (let lat = -90; lat <= 90; lat += 3)
      for (let lon = -180; lon < 180; lon += 3) points.push(at(map.project(lon, lat)));
  else
    for (const [lon, lat] of [
      [-180, -85.0511],
      [180, -85.0511],
      [180, 85.0511],
      [-180, 85.0511],
    ])
      points.push(at(map.project(lon, lat)));
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]),
    hull = [];
  for (const pass of [points, [...points].reverse()]) {
    const start = hull.length;
    for (const p of pass) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  const width = image.width,
    height = image.height;
  if (!hull.every(([x, y]) => x >= 0 && x <= width && y >= 0 && y <= height))
    throw new Error(`the ${map.projection} map runs off the ${width} x ${height} canvas`);
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i],
      [x1, y1] = hull[(i + 1) % hull.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

for (const projection of ['mercator', 'globe'])
  addCase(`geo-${projection}`, async (figure, { pixels, lit, assert }) => {
    if (projection === 'globe') look(figure, [1.6, 0.9, 2.2]);
    else look(figure, ...TOP);
    const map = await tileLayer(figure, { tiles: fixtureTile, projection, zoom: 2, attribution: 'Test tiles' });
    assert(map.loaded === 16 && map.missing === 0, `loaded ${map.loaded}, missing ${map.missing}`);
    // A URL template whose tile does not exist counts it as missing rather than failing.
    if (projection === 'mercator') {
      (window.expectedMissing ??= []).push(`${FIXTURES}0-0.png`);
      const none = await tileLayer(figure, { tiles: `${FIXTURES}{x}-{y}.png`, zoom: 0 });
      assert(none.loaded === 0 && none.missing === 1, `404 tile: loaded ${none.loaded}, missing ${none.missing}`);
      figure.remove(none);
    }
    await figure.ready();
    const image = await pixels(),
      count = lit(image),
      area = mapArea(figure, map, image);
    // Every pixel the map covers differs from the background (Terrarium tiles are mid red and green); its edge
    // pixels are partly covered, so at least 90 % of the projected area, and nothing outside it plus its rim.
    assert(area > 5000, `the ${projection} map covers only ${area} pixels on screen`);
    assert(count >= 0.9 * area && count <= area * 1.05 + 400, `the ${projection} map lit ${count} pixels of ${area}`);
    return { tiles: map.loaded, lit: count, area: Math.round(area) };
  });
