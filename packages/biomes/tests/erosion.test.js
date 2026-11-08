// /erosion: thermal and hydraulic erosion of a height grid in integers. Sediment is conserved to the unit (the heights'
// sum falls by exactly the outflow, thermal erosion alone keeps it), heights stay in their first range, drainage of the
// result never rises and reaches an outlet, flows cut where water gathers, a relief's `erosion` option is erodeRelief of
// the plain relief, a world's region corners are the eroded grid, worker replicas give the page's bytes, and golden
// digests lock the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { erode, erodeRelief } from '../dist/erosion.js';
import { BiomeWorld } from '../dist/index.js';
import { priorityFlood } from '../dist/region.js';
import { createRelief } from '../dist/relief.js';
import { takeLoaded, ThreadWebWorker } from './thread-worker.js';

const golden = JSON.parse(readFileSync(new URL('./golden/erosion.json', import.meta.url), 'utf8'));
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const step = 16000;

// A seeded rough slope in mm, a valley down its middle, with pits and ridges up to 98 m (`noise` 18) or 6 m (22) from an
// integer hash, so it is the same everywhere.
function rough(nx, nz, seed = 3, noise = 18) {
  const h = new Int32Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const r = Math.imul((x * 73856093) ^ (z * 19349663) ^ seed, 2654435761) >>> noise;
      h[z * nx + x] = 20000 + 2500 * Math.abs(x - (nx >> 1)) + 1800 * z + r * 6;
    }
  return h;
}
const sum = (a) => a.reduce((s, v) => s + v, 0);
const digest = (...arrays) => {
  const hash = createHash('sha256');
  for (const a of arrays) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return hash.digest('hex');
};
// The default relief's grid, as erodeRelief samples it.
const reliefGrid = (relief, s = step) => {
  const [ox, oz] = relief.settings.origin,
    nx = relief.settings.size[0] / s + 1,
    nz = relief.settings.size[1] / s + 1,
    height = new Int32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) height[j * nx + i] = relief.height(ox + i * s, oz + j * s);
  return { height, nx, nz, step: s };
};

test('erode checks its grid and options and names the fix', () => {
  const height = rough(8, 8);
  assert.throws(() => erode({ height: Array.from(height), nx: 8, nz: 8, step }), TypeError);
  assert.throws(() => erode({ height, nx: 8, nz: 8, step }, null), TypeError);
  assert.throws(() => erode({ height, nx: 7, nz: 8, step }), RangeError);
  assert.throws(() => erode({ height, nx: 8, nz: 8, step: 0 }), RangeError);
  assert.throws(() => erode({ height: new Int32Array(64).fill(40_000_000), nx: 8, nz: 8, step }), RangeError);
  assert.throws(() => erode({ height: new Int32Array(1449 * 1449), nx: 1449, nz: 1449, step }), RangeError);
  for (const bad of [
    { iterations: 1.5 },
    { iterations: 1025 },
    { talus: 90 },
    { thermal: 0.6 },
    { capacity: -1 },
    { incision: 2 },
    { deposition: '1' },
    { sea: NaN },
  ])
    assert.throws(() => erode({ height, nx: 8, nz: 8, step }, bad), RangeError, JSON.stringify(bad));
  assert.throws(() => erodeRelief(createRelief(), { step: 0.5 }), RangeError);
  assert.throws(() => createRelief({ erosion: 5 }), TypeError);
});

test('sediment is conserved to the unit: the sum falls by the outflow, thermal erosion alone keeps it', () => {
  const nx = 61,
    nz = 47,
    height = rough(nx, nz),
    before = Int32Array.from(height);
  for (const options of [{}, { sea: 60000 }, { capacity: 0.4, incision: 0.8, deposition: 0.1 }, { thermal: 0.5 }]) {
    const e = erode({ height, nx, nz, step }, { iterations: 24, ...options });
    assert.equal(sum(height) - sum(e.height), e.outflow, JSON.stringify(options));
    assert.equal(sum(e.wear) - sum(e.deposit), e.outflow);
    assert.ok(e.outflow > 0, 'flow carries sediment out');
    for (let c = 0; c < nx * nz; c++) assert.equal(e.height[c] - height[c], e.deposit[c] - e.wear[c]);
  }
  const thermal = erode({ height, nx, nz, step }, { iterations: 40, capacity: 0, talus: 5, thermal: 0.5 });
  assert.equal(thermal.outflow, 0);
  assert.equal(sum(thermal.height), sum(height));
  assert.ok(sum(thermal.wear) > 0, 'material slid');
  assert.deepEqual(height, before, 'the input is not changed');
  // Heights stay in their first range: no cell is pushed past the highest or the lowest.
  const lo = Math.min(...height),
    hi = Math.max(...height);
  assert.ok(thermal.height.every((v) => v >= lo && v <= hi));
  const none = erode({ height, nx, nz, step }, { iterations: 0 });
  assert.deepEqual(none.height, height);
  assert.equal(sum(none.wear) + sum(none.deposit) + none.outflow, 0);
});

test('drainage of the eroded grid never rises, flow grows downstream and every path reaches an outlet', () => {
  const nx = 73,
    nz = 59,
    sea = 45000,
    e = erode({ height: rough(nx, nz, 9), nx, nz, step }, { sea, iterations: 32 }),
    ocean = Uint8Array.from(e.height, (v) => (v < sea ? 1 : 0)),
    fill = priorityFlood(e.height, nx, nz, ocean);
  let outlets = 0;
  for (let z = 0, c = 0; z < nz; z++)
    for (let x = 0; x < nx; x++, c++) {
      const d = e.direction[c],
        border = x === 0 || z === 0 || x === nx - 1 || z === nz - 1;
      if (d < 0) {
        assert.ok(border || ocean[c], `outlet ${x},${z} is on the border or in the sea`);
        outlets += e.flow[c];
        continue;
      }
      const p = c + DZ[d] * nx + DX[d],
        filled = e.height[c] + fill[c];
      assert.ok(e.height[p] + fill[p] <= filled, `filled surface never rises at ${x},${z}`);
      if (!fill[c]) assert.ok(e.height[p] <= e.height[c], `height never rises outside lakes at ${x},${z}`);
      assert.ok(e.flow[p] > e.flow[c], `flow grows downstream at ${x},${z}`);
      // A path ends at an outlet within nx * nz steps.
      let at = c,
        steps = 0;
      while (e.direction[at] >= 0 && steps++ < nx * nz) at += DZ[e.direction[at]] * nx + DX[e.direction[at]];
      assert.equal(e.direction[at], -1);
    }
  assert.equal(outlets, nx * nz, 'every cell drains to one outlet');
});

test('flows cut where water gathers; with no hydraulic erosion they do not', () => {
  const nx = 65,
    nz = 65,
    height = rough(nx, nz, 5, 22),
    e = erode({ height, nx, nz, step }, { thermal: 0, iterations: 32 }),
    mean = (keep) => {
      let s = 0,
        k = 0;
      for (let c = 0; c < nx * nz; c++)
        if (keep(c)) {
          s += e.wear[c];
          k++;
        }
      return s / k;
    };
  assert.ok(mean((c) => e.flow[c] >= 40) > 2 * mean((c) => e.flow[c] === 1), 'channels wear more than ridges');
  const still = erode({ height, nx, nz, step }, { thermal: 0, capacity: 0 });
  assert.deepEqual(still.height, height);
});

test('same grid, same bytes: repeated runs and a golden digest', () => {
  const grid = reliefGrid(createRelief({ seed: 5, coast: 'west', rivers: 1 })),
    a = erode(grid, { sea: 0 }),
    b = erode({ ...grid, height: Int32Array.from(grid.height) }, { sea: 0 });
  assert.equal(
    digest(a.height, a.flow, a.direction, a.wear, a.deposit),
    digest(b.height, b.flow, b.direction, b.wear, b.deposit),
  );
  assert.equal(digest(a.height, a.flow, a.direction, a.wear, a.deposit), golden.coast);
  assert.equal(a.outflow, golden.coastOutflow);
  const r = rough(61, 47);
  assert.equal(digest(erode({ height: r, nx: 61, nz: 47, step }, { iterations: 24, sea: 60000 }).height), golden.rough);
});

test('relief erosion option: erodeRelief of the plain relief, exact on its grid, detail kept between corners', () => {
  const settings = { seed: 2, size: [2048, 2048], coast: 'south', rivers: 1 },
    plain = createRelief(settings),
    eroded = createRelief({ ...settings, erosion: { iterations: 16 } }),
    direct = erodeRelief(plain, { iterations: 16 }),
    e = eroded.erosion,
    [ox, oz] = plain.settings.origin;
  assert.equal(e.step, 16000);
  assert.equal(e.nx, 129);
  assert.deepEqual(e.height, direct.erosion.height);
  assert.deepEqual(eroded.rivers, plain.rivers);
  assert.equal(plain.erosion, undefined);
  let changed = 0;
  for (let j = 0; j < e.nz; j += 7)
    for (let i = 0; i < e.nx; i += 5) {
      const x = ox + i * e.step,
        z = oz + j * e.step;
      assert.equal(eroded.height(x, z), e.height[j * e.nx + i]);
      assert.equal(direct.height(x, z), e.height[j * e.nx + i]);
      // Halfway between corners: the plain relief plus the bilinear change, an integer.
      const mid = eroded.height(x + 8000, z + 4000);
      assert.ok(Number.isInteger(mid));
      if (e.height[j * e.nx + i] !== plain.height(x, z)) changed++;
    }
  assert.ok(changed > 0, 'the relief changed');
  // A 64 km world: the default grid doubles to 128 m, 513 corners a side.
  assert.equal(erodeRelief(createRelief({ size: [65536, 65536] }), { iterations: 0 }).erosion.nx, 513);
  assert.equal(erodeRelief(plain, { step: 64, iterations: 0 }).erosion.nx, 33);
});

test('a world with relief erosion: region corners are the eroded grid; tiles match their golden digest', async () => {
  const height = { relief: { coast: 'west', rivers: 1, erosion: {} } },
    w = await BiomeWorld.create({ seed: 3, size: [1024, 1024], height, workers: false }),
    relief = createRelief({ seed: 3, origin: [-512, -512], size: [1024, 1024], coast: 'west', rivers: 1, erosion: {} });
  assert.deepEqual(w.region.height, relief.erosion.height, 'region step 16 m is the erosion grid');
  assert.equal(await w.digest(1, 2), golden.world12);
  const plain = await BiomeWorld.create({
    seed: 3,
    size: [1024, 1024],
    height: { relief: { coast: 'west', rivers: 1 } },
  });
  assert.notEqual(await plain.digest(1, 2), golden.world12, 'erosion changes the tile');
});

test('same bytes on 1 and 4 workers as on the page', { timeout: 240000 }, async () => {
  const options = { seed: 8, size: [1024, 1024], height: { relief: { coast: 'east', erosion: { iterations: 24 } } } },
    page = await BiomeWorld.create({ ...options, workers: false }),
    one = await BiomeWorld.create({ ...options, workers: 1, createWorker: () => new ThreadWebWorker() }),
    four = await BiomeWorld.create({ ...options, workers: 4, createWorker: () => new ThreadWebWorker() });
  takeLoaded();
  try {
    assert.equal(four.workers.size, 4);
    for (const [x, z] of [
      [0, 0],
      [1, 2],
      [3, 3],
      [2, 1],
    ]) {
      const want = await page.digest(x, z);
      assert.equal(await one.digest(x, z), want, `1 worker ${x},${z}`);
      assert.equal(await four.digest(x, z), want, `4 workers ${x},${z}`);
    }
    assert.deepEqual(
      [...new Set(takeLoaded())],
      ['biomes-erosion.js'],
      'the workers ran the erosion part, from its own file',
    );
  } finally {
    one.dispose();
    four.dispose();
  }
});

test('erosion entry is loaded only for a relief that asks for it; without it the error names the entry', () => {
  // A fresh process: nothing has loaded the erosion entry yet.
  const relief = new URL('../dist/relief.js', import.meta.url).href,
    index = new URL('../dist/index.js', import.meta.url).href,
    script = `
      const { createRelief } = await import(${JSON.stringify(relief)});
      try { createRelief({ erosion: {} }); console.log('no error'); }
      catch (e) { console.log(e.name, e.code, e.message.includes('@margoengine/biomes/erosion')); }
      const { BiomeWorld } = await import(${JSON.stringify(index)});
      const w = await BiomeWorld.create({ size: [256, 256] });
      try { w.update({ height: { relief: { erosion: {} } } }); console.log('no error'); }
      catch (e) { console.log('update', e.code); }
      const v = await BiomeWorld.create({ size: [256, 256], height: { relief: { erosion: { iterations: 2 } } } });
      w.update({ height: { relief: { erosion: { iterations: 2 } } } });
      console.log('after load', (await w.digest(0, 0)) === (await v.digest(0, 0)));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(out, /MargoError state true/);
  assert.match(out, /update state/);
  assert.match(out, /after load true/);
});
