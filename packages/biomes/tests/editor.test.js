// B4: editor hooks. Replaying a stroke gives the same digest, undo returns the exact previous bytes, every changed cell
// lies inside the dirty rectangle (fuzz), incremental edits give the same digests as a full rebuild (paint and height),
// brush modes, history, validation, and the undo time budget (G5: undo within one frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld } from '../dist/index.js';
import { presets } from '../dist/presets.js';
import { BiomeEditor } from '../dist/editor.js';
import { random } from './random.js';
import { ThreadWebWorker } from './thread-worker.js';

const options = {
  seed: 4,
  size: [1024, 1024],
  biomes: [presets.temperate, presets.boreal, presets.desert, presets.wetland],
};
const world = () => BiomeWorld.create(options);
const digests = async (w) => {
  const out = [];
  for (let z = 0; z < w.tilesZ; z++) for (let x = 0; x < w.tilesX; x++) out.push(await w.digest(x, z));
  return out;
};

test('a stroke replayed from its edit data gives the same digests', async () => {
  const a = await world(),
    editor = BiomeEditor.attach(a);
  editor.stroke(() => {
    editor.paint('desert', { center: [10, 20], radius: 60 });
    editor.paint('desert', { center: [70, 30], radius: 40, strength: 0.5, falloff: 'linear' });
    editor.erase('desert', { center: [40, 25], radius: 15 });
  });
  editor.fill('mask/dunes', { rect: [-200, -200, 0, 0], value: 0.8 });
  const b = await world(),
    replay = BiomeEditor.attach(b);
  for (const edit of JSON.parse(JSON.stringify(editor.edits))) replay.apply(edit);
  assert.deepEqual(await digests(b), await digests(a));
  assert.equal(editor.edits.length, 4);
});

test('undo returns the exact previous bytes, redo the exact later ones', async () => {
  const w = await world(),
    editor = BiomeEditor.attach(w),
    start = await digests(w);
  editor.paint('boreal', { center: [-100, 50], radius: 80, mode: 'set', strength: 0.7 });
  const once = await digests(w),
    raster = w.readLayer('paint/boreal', 1, 2);
  editor.stroke(() => {
    editor.paint('boreal', { center: [-60, 60], radius: 50, mode: 'max', strength: 1 });
    editor.paint('wetland', { center: [-60, 60], radius: 30 });
  });
  assert.notDeepEqual(await digests(w), once);
  assert.ok(editor.undo());
  assert.deepEqual(w.readLayer('paint/boreal', 1, 2), raster);
  assert.equal(w.readLayer('paint/wetland', 1, 2), undefined, 'a raster the stroke created is gone again');
  assert.deepEqual(await digests(w), once);
  assert.ok(editor.redo());
  const twice = await digests(w);
  assert.ok(editor.undo() && editor.undo());
  assert.deepEqual(await digests(w), start, 'back to the untouched world');
  assert.equal(editor.undo(), false);
  assert.ok(editor.redo() && editor.redo());
  assert.deepEqual(await digests(w), twice);
  editor.paint('desert', { center: [0, 0], radius: 5 });
  assert.equal(editor.canRedo, false, 'a new edit clears the redo list');
});

test('fuzz: every cell an edit changes lies inside the dirty rectangle, and the world reports it', async () => {
  const w = await world(),
    editor = BiomeEditor.attach(w),
    rng = random(31),
    reported = [];
  w.onChange((r) => reported.push(r));
  const layers = async () => {
    const out = [];
    for (let z = 0; z < 4; z++)
      for (let x = 0; x < 4; x++) out.push(await w.tile(x, z, { layers: ['biome', 'biomeWeight'] }));
    return out;
  };
  for (let k = 0; k < 6; k++) {
    const before = await layers();
    reported.length = 0;
    const id = ['desert', 'wetland', 'boreal'][k % 3];
    editor.paint(id, {
      center: [rng() * 1000 - 500, rng() * 1000 - 500],
      radius: 5 + rng() * 80,
      strength: rng(),
      mode: ['add', 'set', 'max'][k % 3],
      falloff: ['smooth', 'linear', 'constant'][k % 3],
    });
    const after = await layers(),
      [rect] = editor.dirty,
      world = reported.at(-1);
    let changed = 0;
    for (let t = 0; t < after.length; t++) {
      const a = before[t],
        b = after[t];
      for (const name of ['biome', 'biomeWeight'])
        for (let c = 0; c < 256 * 256; c++)
          for (let s = 0; s < 4; s++)
            if (a.layer(name).data[c * 4 + s] !== b.layer(name).data[c * 4 + s]) {
              changed++;
              const x = b.origin[0] + (c % 256),
                z = b.origin[1] + Math.floor(c / 256);
              for (const r of [rect, world])
                assert.ok(x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3], `cell ${x},${z} outside ${r}`);
            }
    }
    assert.ok(changed > 0 || rect, `edit ${k}`);
  }
  assert.ok(editor.margin() > 50, 'the placement margin (6 rounds x 2 x the largest crown, plus cluster spread) is in');
});

test('incremental edits give the same digests as a full rebuild, for paint and for heights', async () => {
  const live = await world(),
    editor = BiomeEditor.attach(live);
  await digests(live); // every tile cached before the edits
  editor.paint('desert', { center: [200, -150], radius: 90 });
  editor.fill('wetland', { rect: [-512, -512, -300, -300], value: 0.6 });
  const fresh = await world(),
    writes = [];
  for (const name of ['paint/desert', 'paint/wetland'])
    for (let z = 0; z < 4; z++)
      for (let x = 0; x < 4; x++) {
        const data = live.readLayer(name, x, z);
        if (data) writes.push({ name, x, z, data });
      }
  fresh.writeLayers(writes);
  assert.deepEqual(await digests(fresh), await digests(live));
  // A height edit changes fields far downwind and downstream: the whole world is dirty and recomputed.
  const height = { field: (x, z) => 100 + 0.05 * x + 30 * Math.sin(z / 90) },
    rects = [];
  live.onChange((r) => rects.push(r));
  live.update({ height });
  assert.deepEqual(rects.at(-1), live.bounds);
  const rebuilt = await BiomeWorld.create({ ...options, height });
  rebuilt.writeLayers(writes);
  assert.deepEqual(await digests(rebuilt), await digests(live));
});

test('brush modes, falloffs, fill with a mask and the history iterator', async () => {
  const w = await world(),
    editor = BiomeEditor.attach(w),
    seen = [],
    reader = (async () => {
      for await (const edit of editor.history()) seen.push(edit.kind);
    })();
  const at = (name, x, z) =>
    w.readLayer(name, Math.floor((x + 512) / 256), Math.floor((z + 512) / 256))?.[
      ((z + 512) % 256) * 256 + ((x + 512) % 256)
    ];
  editor.paint('desert', { center: [0, 0], radius: 20, mode: 'add', falloff: 'constant', strength: 0.5 });
  assert.equal(at('paint/desert', 0, 0), 128);
  editor.paint('desert', { center: [0, 0], radius: 20, mode: 'add', falloff: 'constant', strength: 0.5 });
  assert.equal(at('paint/desert', 0, 0), 255, 'add clamps at 255');
  editor.paint('desert', { center: [0, 0], radius: 20, mode: 'subtract', falloff: 'constant', strength: 0.25 });
  assert.equal(at('paint/desert', 0, 0), 191);
  editor.paint('desert', { center: [0, 0], radius: 20, mode: 'min', falloff: 'constant', strength: 0.5 });
  assert.equal(at('paint/desert', 0, 0), 128);
  editor.paint('desert', { center: [0, 0], radius: 20, falloff: 'smooth' });
  assert.ok(at('paint/desert', 0, 0) === 255 && at('paint/desert', 18, 0) < 255, 'smooth falloff fades toward the rim');
  editor.erase('desert', { center: [0, 0], radius: 30, falloff: 'constant' });
  assert.equal(at('paint/desert', 0, 0), 0);
  editor.fill('mask/m', { rect: [0, 0, 100, 100], value: 0.5 });
  editor.fill('desert', { rect: [-512, -512, 512, 512], mask: 'mask/m' });
  assert.equal(at('paint/desert', 50, 50), 127, 'fill scaled by the mask');
  assert.equal(at('paint/desert', -50, -50), 0, 'nothing outside the mask');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['paint', 'paint', 'paint', 'paint', 'paint', 'paint', 'fill', 'fill']);
  editor.dispose();
  await reader;
  assert.throws(() => editor.paint('desert', { center: [0, 0] }), { name: 'MargoError', code: 'disposed' });
});

test('validation, nested strokes and an edit inside onChange', async () => {
  const w = await world(),
    editor = BiomeEditor.attach(w);
  assert.throws(() => BiomeEditor.attach({}), TypeError);
  assert.throws(() => editor.paint('jungle', { center: [0, 0] }), RangeError);
  assert.throws(() => editor.paint('desert', { center: [0, 0], radius: -1 }), RangeError);
  assert.throws(() => editor.paint('desert', { center: [0, 0], strength: 2 }), RangeError);
  assert.throws(() => editor.paint('desert', { center: [0, 0], mode: 'blend' }), RangeError);
  assert.throws(() => editor.apply({ kind: 'cut' }), RangeError);
  const stroke = editor.stroke();
  assert.throws(() => editor.stroke(), { name: 'MargoError', code: 'state' });
  stroke.end();
  w.onChange(() =>
    assert.throws(() => editor.paint('desert', { center: [5, 5] }), { name: 'MargoError', code: 'state' }),
  );
  editor.paint('desert', { center: [0, 0], radius: 3 });
  // A dab entirely outside the world changes nothing and dirties nothing.
  editor.paint('desert', { center: [5000, 5000], radius: 10 });
  assert.deepEqual(editor.dirty, []);
});

test('time budget: an undo and a 50 m dab take under one 60 Hz frame (16.7 ms) of CPU before tiles are remade', async () => {
  const w = await world(),
    editor = BiomeEditor.attach(w);
  editor.paint('desert', { center: [0, 0], radius: 50 });
  let start = performance.now();
  for (let i = 0; i < 10; i++) editor.paint('desert', { center: [i, i], radius: 50 });
  const dab = (performance.now() - start) / 10;
  start = performance.now();
  editor.undo();
  const undo = performance.now() - start;
  assert.ok(dab < 16.7 && undo < 16.7, `dab ${dab.toFixed(2)} ms, undo ${undo.toFixed(2)} ms`);
});

// Biome look plan 2 item 4: a painted patch met its neighbour in a one-cell step (paint composed after the climate warp
// and the 3x3 blur, cell by cell), with none of the wander of the climate borders. The `ecotone` option (default 24 m)
// reads paint at the warped cell through a box that wide. On main the desert weight below falls 255 to 0 in one cell.
test('ecotone: a painted edge blends over at least 24 m with no hard step and wanders; ecotone 0 keeps the step', {
  timeout: 240000,
}, async () => {
  const wide = { ...options, size: [2048, 2048] },
    centre = [0, -300],
    radius = 200,
    rays = 32,
    paint = (w) => BiomeEditor.attach(w).paint('desert', { center: centre, radius, falloff: 'constant' }),
    // The desert weight (0..255) at world (x, z), from the tile's biome and biomeWeight layers.
    weightAt = async (w, x, z) => {
      const gx = Math.floor(x - w.bounds[0]),
        gz = Math.floor(z - w.bounds[1]),
        cells = w.tileSize / w.resolution, // float division: test arithmetic
        tx = Math.floor(gx / cells), // float division: test arithmetic
        tz = Math.floor(gz / cells), // float division: test arithmetic
        tile = await w.tile(tx, tz),
        at = ((gz - tz * cells) * cells + gx - tx * cells) * 4,
        ids = tile.layer('biome').data,
        weights = tile.layer('biomeWeight').data,
        desert = w.biomes.findIndex((b) => b.id === 'desert');
      for (let s = 0; s < 4; s++) if (ids[at + s] === desert) return weights[at + s];
      return 0;
    },
    // Each ray from the dab centre, 150 to 260 m at 1 m steps: the width of the ramp from the last 255 to the first 0,
    // the largest step between neighbouring samples and the radius where the weight first drops under 128.
    profile = async (w) => {
      const out = [];
      for (let r = 0; r < rays; r++) {
        const a = (2 * Math.PI * r) / rays, // float division: test arithmetic
          weights = [];
        for (let d = 150; d <= 260; d++)
          weights.push(await weightAt(w, centre[0] + d * Math.cos(a), centre[1] + d * Math.sin(a)));
        const last = weights.findLastIndex((v) => v === 255),
          first = weights.findIndex((v, i) => i > last && v === 0);
        let step = 0;
        for (let i = 1; i < weights.length; i++) step = Math.max(step, Math.abs(weights[i] - weights[i - 1]));
        out.push({ ramp: first - last, step, half: 150 + weights.findIndex((v) => v < 128) });
      }
      return out;
    };
  const soft = await BiomeWorld.create(wide);
  assert.equal(soft.ecotone, 24, 'the default ecotone');
  paint(soft);
  // Measured: ramps 24..34 m, steps at most 30, the weight-128 radius 194..207 m round the circle.
  const p = await profile(soft),
    halves = p.map((q) => q.half);
  for (const q of p) {
    assert.ok(q.ramp >= 24, `the desert weight falls 255 to 0 over ${q.ramp} m, under 24`);
    assert.ok(q.step <= 64, `a step of ${q.step} between neighbouring metres`);
  }
  assert.ok(
    Math.max(...halves) - Math.min(...halves) >= 2,
    `the weight-128 radius wanders round the circle: ${Math.min(...halves)}..${Math.max(...halves)} m`,
  );
  // The same world twice, and on worker replicas, gives the same bytes.
  const again = await BiomeWorld.create(wide),
    remote = await BiomeWorld.create({ ...wide, workers: 1, createWorker: () => new ThreadWebWorker() });
  paint(again);
  paint(remote);
  for (const [x, z] of [
    [4, 2],
    [3, 3],
  ]) {
    const d = await soft.digest(x, z);
    assert.equal(await again.digest(x, z), d, `tile ${x},${z} again`);
    assert.equal(await remote.digest(x, z), d, `tile ${x},${z} on a worker`);
  }
  remote.dispose();
  // ecotone 0 composes paint cell by cell: today's one-cell step, and the unpainted digests do not depend on it.
  const hard = await BiomeWorld.create({ ...wide, ecotone: 0 }),
    plain = await BiomeWorld.create(wide);
  assert.equal(await hard.digest(0, 0), await plain.digest(0, 0), 'unpainted tiles are the same at any ecotone');
  paint(hard);
  assert.ok(
    (await profile(hard)).every((q) => q.step > 128),
    'ecotone 0: the weight drops in one step',
  );
  // An unpainted tile far from the dab is the same with or without the feather; settings are checked.
  assert.equal(await soft.digest(0, 0), await plain.digest(0, 0));
  await assert.rejects(BiomeWorld.create({ ...wide, ecotone: -1 }), RangeError);
  await assert.rejects(BiomeWorld.create({ ...wide, ecotone: 200 }), RangeError);
  await assert.rejects(BiomeWorld.create({ ...wide, ecotone: '24' }), RangeError);
});
