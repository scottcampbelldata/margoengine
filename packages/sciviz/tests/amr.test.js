import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  createAMR,
  sampleAMR,
  traceAMR,
  readAMReX,
  readEnzo,
  readFLASH,
  sliceAMR,
  contourAMR,
  amrOutlines,
  amrVolume,
  AMRVolume,
  amrLevelOutlines,
} from '../dist/amr.js';

const root = new URL('./fixtures/amr/', import.meta.url),
  fixture = (n) => readFile(new URL(n, root));
const constant = (level, bounds, value, dims = [2, 2, 2]) => ({
  level,
  bounds,
  dims,
  values: new Float64Array(dims.reduce((a, n) => a * n, 1)).fill(value),
});
const hierarchy = () => createAMR([constant(0, [0, 1, 0, 1, 0, 1], 1), constant(1, [0, 0.5, 0, 0.5, 0, 0.5], 3)]);
const close = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} differs from ${b}`);

test('AMR entry exposes direct rendering, masks, analysis and three native format readers', () => {
  assert.equal(typeof amrVolume, 'function');
  assert.equal(typeof AMRVolume.prototype[Symbol.dispose], 'function');
  assert.equal(typeof amrLevelOutlines, 'function');
  const data = hierarchy();
  assert.equal(
    data.masks[0].reduce((a, n) => a + n, 0),
    7,
  );
  assert.equal(
    data.masks[1].reduce((a, n) => a + n, 0),
    8,
  );
  assert.deepEqual(data.range, [1, 3]);
  assert.equal(sampleAMR(data, [0.2, 0.2, 0.2]), 3);
  assert.equal(sampleAMR(data, [0.5, 0.2, 0.2]), 1);
  assert.equal(sampleAMR(data, [1, 1, 1]), 1);
  assert.ok(Number.isNaN(sampleAMR(data, [-0.1, 0, 0])));
  const outlines = amrOutlines(data);
  assert.equal(outlines.positions.length, 2 * 12 * 2 * 3);
  assert.equal(outlines.levels.filter((v) => v === 1).length, 24);
});
test('partition volume and ordered ray lengths count fine regions once, with parallel faces and holes', () => {
  const data = hierarchy(),
    leaves = data.nodes.filter((n) => n.axis < 0 && n.block >= 0);
  close(
    leaves.reduce((s, n) => s + [0, 1, 2].reduce((v, k) => v * (n.bounds[2 * k + 1] - n.bounds[2 * k]), 1), 0),
    1,
  );
  close(
    traceAMR(data, [-1, 0.2, 0.2], [1, 0, 0]).reduce(
      (s, h) => s + (h.exit - h.enter) * data.blocks[h.block].values[0],
      0,
    ),
    2,
  );
  close(
    traceAMR(data, [2, 0.2, 0.2], [-1, 0, 0]).reduce((s, h) => s + (h.exit - h.enter), 0),
    1,
  );
  assert.deepEqual(traceAMR(data, [-1, 1, 0.2], [1, 0, 0]), []);
  const holes = createAMR([constant(0, [0, 1, 0, 1, 0, 1], 1), constant(0, [2, 3, 0, 1, 0, 1], 2)]);
  assert.ok(Number.isNaN(sampleAMR(holes, [1.5, 0.5, 0.5])));
  assert.deepEqual(
    traceAMR(holes, [-1, 0.5, 0.5], [1, 0, 0]).map((h) => [h.enter, h.exit]),
    [
      [1, 2],
      [3, 4],
    ],
  );
});
test('linear interpolation reproduces a linear field at cell centres, preserves missing samples and snapshots input', () => {
  const b = constant(0, [0, 1, 0, 1, 0, 1], 0, [4, 4, 4]);
  for (let i = 0; i < 64; i++)
    b.values[i] =
      ((i % 4) + 0.5) / 4 + (2 * ((Math.floor(i / 4) % 4) + 0.5)) / 4 + (3 * (Math.floor(i / 16) + 0.5)) / 4;
  const data = createAMR([b]);
  b.values.fill(99);
  close(sampleAMR(data, [0.4, 0.6, 0.3], 'linear'), 2.5);
  data.blocks[0].values[0] = NaN;
  assert.ok(Number.isNaN(sampleAMR(data, [0.125, 0.125, 0.125], 'linear')));
});
test('invalid hierarchies, fractional refinement, cut coarse cells and budgets fail explicitly', () => {
  assert.throws(() => createAMR([]), /at least one/);
  assert.throws(
    () => createAMR([constant(0, [0, 1, 0, 1, 0, 1], 1), constant(0, [0, 0.5, 0, 0.5, 0, 0.5], 2)]),
    /same level/,
  );
  assert.throws(
    () => createAMR([constant(0, [0, 1, 0, 1, 0, 1], 1), constant(1, [0.1, 0.6, 0, 0.5, 0, 0.5], 2)]),
    /cuts a coarse/,
  );
  assert.throws(() => createAMR([constant(0, [0, 1, 0, 1, 0, 1], NaN)]), /no finite/);
  assert.throws(() => createAMR(hierarchy().blocks, { maxNodes: 1 }), /exceeds/);
  assert.throws(() => traceAMR(hierarchy(), [0, 0, 0], [0, 0, 0]), /nonzero/);
  assert.throws(() => sampleAMR(hierarchy(), [NaN, 0, 0]), /finite coordinates/);
  assert.throws(() => sampleAMR(hierarchy(), [], 'nearest'), /finite coordinates/);
  assert.throws(() => traceAMR(hierarchy(), [], [1, 0, 0]), /finite origin/);
  assert.throws(() => sliceAMR(hierarchy(), { normal: [Infinity, 0, 0], offset: 0 }), /finite non-zero/);
  const c = new AbortController();
  c.abort('cancel AMR');
  assert.throws(
    () => createAMR(hierarchy().blocks, { signal: c.signal }),
    (e) => e === 'cancel AMR',
  );
});
test('masked planar slice conserves area and fine ownership at arbitrary plane orientations', () => {
  const set = sliceAMR(hierarchy(), { normal: [0, 0, 1], offset: 0.2 });
  let area = 0,
    weighted = 0;
  for (let i = 0; i < set.positions.length; i += 9) {
    const p = set.positions.subarray(i, i + 9),
      a = [p[3] - p[0], p[4] - p[1], p[5] - p[2]],
      b = [p[6] - p[0], p[7] - p[1], p[8] - p[2]],
      size = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
    area += size;
    weighted += size * set.values[i / 3];
  }
  close(area, 1);
  close(weighted, 1.5);
  const diagonal = sliceAMR(hierarchy(), { normal: [1, 1, 1], offset: 1 });
  assert.ok(diagonal.cells.length > 0);
  assert.throws(() => sliceAMR(hierarchy(), { normal: [0, 0, 0], offset: 0 }), /non-zero/);
});
test('cross-level contours share a covering lattice and obey explicit sampling budgets', async () => {
  const blocks = [constant(0, [0, 1, 0, 1, 0, 1], 0, [4, 4, 4]), constant(1, [0, 0.5, 0, 0.5, 0, 0.5], 0, [4, 4, 4])];
  for (const b of blocks)
    for (let i = 0; i < b.values.length; i++)
      b.values[i] = b.bounds[0] + (((i % 4) + 0.5) / 4) * (b.bounds[1] - b.bounds[0]);
  const result = await contourAMR(createAMR(blocks), [0.3], { dims: [9, 9, 9] });
  assert.ok(result.triangles.cells.length > 0);
  for (let i = 0; i < result.triangles.positions.length; i += 3) close(result.triangles.positions[i], 0.3, 4e-8);
  await assert.rejects(() => contourAMR(hierarchy(), [1], { maxPoints: 8 }), /exceeds maxPoints/);
});
test('real two-level Nyx plotfile matches yt native scalar bytes, bounds and child masks', async () => {
  const expected = JSON.parse(await fixture('expected.json')),
    data = await readAMReX(await fixture('nyx/Header'), { scalar: 'density', resolve: (n) => fixture('nyx/' + n) });
  assert.equal(data.blocks.length, expected.blocks.length);
  for (let i = 0; i < data.blocks.length; i++) {
    const b = data.blocks[i],
      e = expected.blocks[i];
    assert.deepEqual(b.dims, e.dims);
    assert.deepEqual(b.bounds, e.bounds);
    assert.equal(b.level, e.level);
    assert.equal(
      data.masks[i].reduce((a, n) => a + n, 0),
      e.visibleCells,
    );
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(b.values.buffer, b.values.byteOffset, b.values.byteLength))
        .digest('hex'),
      e.sha256,
    );
  }
  const metadata = JSON.parse(await fixture('source.json'));
  for (const [name, pin] of Object.entries(metadata.files)) {
    const bytes = await fixture(name);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
  }
  await assert.rejects(() => readAMReX(awaitable(), { scalar: 'absent' }));
  function awaitable() {
    return new Uint8Array(new TextEncoder().encode('HyperCLaw-V1.1\n1\ndensity\n3\n0\n0\n'));
  }
});
test('Enzo ASCII and HDF5 hierarchy select active cells, remove ghosts and agree', async () => {
  const options = { scalar: 'Density', resolve: fixture },
    a = await readEnzo(await fixture('enzo.hierarchy'), options),
    b = await readEnzo(await fixture('enzo-hierarchy.h5'), options);
  assert.equal(a.blocks.length, 2);
  assert.deepEqual(
    a.blocks.map((b) => Array.from(b.values)),
    [Array.from({ length: 8 }, (_, i) => 10 + i), Array.from({ length: 8 }, (_, i) => 20 + i)],
  );
  assert.deepEqual(
    a.blocks.map((b) => b.values),
    b.blocks.map((b) => b.values),
  );
  assert.deepEqual(
    a.blocks.map((b) => b.level),
    [0, 1],
  );
  assert.equal(a.masks[0][0], 0);
  await assert.rejects(() => readEnzo(awaitable(), options), /no grids/);
  function awaitable() {
    return new TextEncoder().encode('not a hierarchy');
  }
});

test('native IEEE32 FAB byte orders select components and trim ghost boxes in two dimensions', async () => {
  const encode = (s) => new TextEncoder().encode(s);
  const header = encode(
    'HyperCLaw-V1.1\n2\na\nb\n2\n0\n0\n0 0\n1 1\n\n((0,0) (1,1) (0,0))\n0\n.5 .5\n0\n0\n0 1 0\n0\n0 1\n0 1\nLevel_0/Cell\n',
  );
  for (const little of [true, false]) {
    const prefix = encode(
        `FAB ((4, (32 8 23 0 1 9 0 127)),(4, (${little ? '4 3 2 1' : '1 2 3 4'})))((-1,-1) (2,2) (0,0)) 2\n`,
      ),
      bytes = new Uint8Array(prefix.length + 32 * 4),
      view = new DataView(bytes.buffer);
    bytes.set(prefix);
    for (let c = 0; c < 2; c++)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          view.setFloat32(prefix.length + (c * 16 + y * 4 + x) * 4, c * 100 + (y - 1) * 2 + x - 1, little);
    const files = {
      'Level_0/Cell_H': encode('1\n1\n2\n1\n(1 0\n((0,0) (1,1) (0,0))\n)\n1\nFabOnDisk: data.bin 0\n'),
      'Level_0/data.bin': bytes,
    };
    const data = await readAMReX(header, { scalar: 'b', files });
    assert.deepEqual(data.blocks[0].dims, [2, 2, 1]);
    assert.deepEqual(Array.from(data.blocks[0].values), [100, 101, 102, 103]);
  }
});
test('FLASH rejects parent blocks and reads endian/chunk/shuffle scalar leaves in x-fastest order', async () => {
  const data = await readFLASH(await fixture('flash.h5'));
  assert.equal(data.blocks.length, 2);
  assert.deepEqual(data.blocks[0].dims, [2, 2, 2]);
  assert.deepEqual(
    Array.from(data.blocks[0].values),
    Array.from({ length: 8 }, (_, i) => 8 + i),
  );
  assert.deepEqual(
    data.blocks.map((b) => b.level),
    [2, 2],
  );
  await assert.rejects(async () => readFLASH(await fixture('flash.h5'), { scalar: 'nope' }), /does not exist/);
});

test('licensed AMReX demonstration preserves all source block IDs and pinned unscaled samples', async () => {
  const manifest = JSON.parse(await fixture('osc-cylinder/source.json'));
  assert.equal(manifest.license, 'CC BY 4.0');
  assert.equal(manifest.blocks.length, 4);
  const sourceIDs = manifest.blocks.flatMap((b) => b.sources);
  assert.equal(sourceIDs.length, manifest.nativeBlockCount);
  assert.equal(new Set(sourceIDs).size, sourceIDs.length);
  const blocks = [];
  for (const b of manifest.blocks) {
    const compressed = await fixture('osc-cylinder/' + b.file),
      bytes = gunzipSync(compressed);
    assert.equal(createHash('sha256').update(compressed).digest('hex'), b.sha256);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), b.rawSHA256);
    const values = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
    assert.equal(
      values.length,
      b.dims.reduce((a, n) => a * n, 1),
    );
    blocks.push({ ...b, values });
  }
  const data = createAMR(blocks);
  assert.equal(new Set(data.blocks.map((b) => b.level)).size, 4);
  assert.ok(data.nodes.length > 4);
});
