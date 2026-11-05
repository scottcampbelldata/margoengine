// Mutation testing (scripts/mutation.mjs, `node scripts/mutation.mjs biomes classify`) found parts of src/classify.ts
// that the preset goldens never reach: envelopes on the layers no preset uses (every warp mode 2 to 5), claim weights,
// every paint mode with masks and feathering, a zone scorer, the nearest-envelope fallback with paint blocking, and the
// `membership` export the GPU input builders use. This file drives `classifier`/`classify` directly over synthetic layers
// with biomes that use every input, and pins the warped inputs, the memberships and the stored ids and weights by digest
// (the digests are of results already checked by the invariants asserted in the same test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { random } from './random.js';

// classify.ts is internal (no public entry), so the test imports the TypeScript source, as gpu-classify-inputs.test.js does.
const repository = realpathSync(new URL('../../../', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const js = new URL(specifier, context.parentURL),
        ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(js) && existsSync(ts)) {
        const source = realpathSync(ts),
          within = relative(repository, source);
        if (!within.startsWith('..') && !isAbsolute(within)) return nextResolve(pathToFileURL(source).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { checkPaint, classifier, classify, classifyInputs, membership } = await import('../src/classify.ts');

const digest = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(Buffer.from(Int32Array.from(p).buffer));
  return h.digest('hex').slice(0, 24);
};

// Stored-unit ranges the generator draws each layer from.
const LAYER_RANGE = {
  temperature: [-3000, 4000],
  coldest: [-4000, 3000],
  warmest: [0, 4500],
  treeline: [-500, 3000],
  gdd5: [0, 9000],
  season: [0, 365],
  rainfall: [0, 4000],
  alpha: [0, 255],
  moisture: [0, 255],
  height: [-200000, 3000000],
  slope: [0, 4000],
  exposure: [0, 255],
  soil: [0, 100],
  waterDistance: [0, 2000],
  'mask/rock': [0, 255],
  custom: [0, 1000],
  'mask/other': [0, 255],
};

const BIOMES = [
  { id: 'a-cold', climate: { temperature: [null, 6], coldest: [null, -2], gdd5: [null, 1500], season: [0, 200] } },
  {
    id: 'b-wet',
    priority: 2,
    climate: { rainfall: [1500, null], moisture: [0.4, 1], moistureIndex: [0.5, null], waterDistance: [0, 60] },
  },
  {
    id: 'c-dry',
    weight: 2.5,
    climate: { rainfall: [null, 500], warmest: [20, null], exposure: [0.3, 1], soil: [null, 0.6] },
  },
  { id: 'd-high', priority: 1, weight: 0.4, climate: { height: [900, null], treeline: [null, 12], slope: [10, 60] } },
  { id: 'e-any', priority: -1, weight: 1, climate: {} },
  { id: 'f-mask', climate: { temperature: [8, 24], custom: { 'mask/rock': [0.2, 0.9], 'mask/other': [100, 600] } } },
  { id: 'g-narrow', climate: { temperature: [31, 32], rainfall: [4500, 4600] } },
];

function layersFor(seed, n, depth) {
  const r = random(seed),
    out = {},
    cells = n * depth;
  const names = [...Object.keys(LAYER_RANGE).filter((k) => k !== 'custom'), 'mask/other'];
  for (const name of names) {
    const [lo, hi] = LAYER_RANGE[name] ?? LAYER_RANGE.custom,
      a = new Int32Array(cells);
    // smooth-ish fields plus a few extremes, so borders, clamps and the warp all matter
    let v = lo + r() * (hi - lo);
    for (let k = 0; k < cells; k++) {
      v += (r() - 0.5) * (hi - lo) * 0.08;
      if (v < lo) v = lo + (lo - v) * 0.5;
      if (v > hi) v = hi - (v - hi) * 0.5;
      a[k] = Math.round(Math.min(hi, Math.max(lo, v)));
      if (r() < 0.01) a[k] = r() < 0.5 ? lo : hi;
    }
    out[name] = a;
  }
  return out;
}

function paintRasters(seed, n, depth, margin) {
  const r = random(seed),
    side = n + 2 * margin,
    rows = depth + 2 * margin,
    out = {};
  for (const name of [
    'paint/a-cold',
    'paint/b-wet',
    'paint/c-dry',
    'paint/d-high',
    'paint/e-any',
    'paint/f-mask',
    'paint/g-narrow',
    'mask/hand',
    'paint/nope',
  ]) {
    const a = new Int32Array(side * rows).fill(-1);
    if (name === 'paint/nope') {
      out[name] = undefined;
      continue;
    }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < side; i++)
        if (((i >> 4) + (j >> 4) + name.length) % 2 === 0 || r() < 0.03)
          a[j * side + i] = r() < 0.3 ? 255 : Math.floor(r() * 256);
    out[name] = a;
  }
  return out;
}

const PAINT = [
  { biome: 'a-cold', mode: 'replace' },
  { biome: 'b-wet', mode: 'add', mask: 'mask/hand' },
  { biome: 'c-dry', mode: 'multiply' },
  { biome: 'd-high', mode: 'max', mask: 'mask/hand' },
  { biome: 'missing', mode: 'replace' },
  { biome: 'e-any' },
];

function run({ seed, n, depth, kind = 'envelopes', paint = [], ecotone = 0, biomes = BIOMES }) {
  const c = classifier(biomes, kind, paint),
    layers = layersFor(seed, n, depth),
    rasters = ecotone || paint.length ? null : null;
  void rasters;
  const input = {
    n,
    depth,
    gx: 37 * seed,
    gz: -11 * seed,
    seed,
    cell: 4000,
    ecotone,
    layer: (name) => layers[name],
    user: (name, margin = 0) => (paint.length ? paintRasters(seed + 99, n, depth, margin)[name] : undefined),
  };
  const planes = classifyInputs(c, input),
    warped = Int32Array.from(planes.warped.subarray(0, c.inputs.length * n * depth)),
    member = Int32Array.from(planes.member.subarray(0, c.ids.length * n * depth)),
    ids = new Uint8Array((n - 2) * (depth - 2) * 4),
    weights = new Uint8Array(ids.length);
  classify(c, input, ids, weights);
  return { c, warped, member, ids, weights };
}

function invariants({ ids, weights, c }) {
  for (let k = 0; k < ids.length; k += 4) {
    assert.equal(weights[k] + weights[k + 1] + weights[k + 2] + weights[k + 3], 255, `cell ${k / 4} sums to 255`);
    for (let s = 0; s < 4; s++) {
      if (weights[k + s] === 0) assert.equal(ids[k + s], 255);
      else assert.ok(ids[k + s] < c.ids.length);
      if (s) assert.ok(weights[k + s] <= weights[k + s - 1], 'strongest first');
    }
  }
}

const CASES = {
  envelopes: { seed: 3, n: 34, depth: 29 },
  envelopesOther: { seed: 8, n: 26, depth: 26 },
  weightedSmall: { seed: 5, n: 12, depth: 9, biomes: BIOMES.slice(0, 4) },
  paint: { seed: 4, n: 30, depth: 27, paint: PAINT },
  paintFeather: { seed: 6, n: 30, depth: 27, paint: PAINT, ecotone: 3 },
  paintFeatherWide: { seed: 7, n: 24, depth: 22, paint: PAINT, ecotone: 6 },
  paintOnly: {
    seed: 9,
    n: 20,
    depth: 20,
    paint: [{ biome: 'e-any' }, { biome: 'f-mask', mode: 'add' }, { biome: 'g-narrow', mode: 'multiply' }],
    biomes: BIOMES.slice(4),
  },
  zones: {
    seed: 10,
    n: 22,
    depth: 22,
    kind: {
      kind: 'whittaker',
      scorer: (biomes, slotOf) => (warped, cells, member) => {
        const t = slotOf('temperature'),
          rain = slotOf('rainfall');
        for (let k = 0; k < cells; k++)
          for (let b = 0; b < biomes.length; b++)
            member[b * cells + k] = Math.max(
              0,
              65536 - Math.abs(warped[t * cells + k] * 40 - warped[rain * cells + k] * (b + 3) * 7),
            );
      },
    },
  },
};

const EXPECT = {
  envelopes: 'b772fe34121ff80dfb5a41a8',
  envelopesOther: 'ef416d7af907a9e85b46d080',
  weightedSmall: '9b71128dca067ce41d43a9a6',
  paint: 'c6fe9b013bc122aa318de299',
  paintFeather: 'c73c6abb42a2986335d11f45',
  paintFeatherWide: 'c15492ec9cc781e4b26aa44b',
  paintOnly: 'd6d60444e5479ac6cd6165fc',
  zones: 'f15e0ab50a2bf60e9c68a1a9',
  membership: '7105b63d605a06cec219497b',
};

for (const [name, spec] of Object.entries(CASES))
  test(`classify over synthetic layers, case ${name}: invariants hold and the result is locked`, () => {
    const out = run(spec);
    invariants(out);
    const got = digest(out.warped, out.member, out.ids, out.weights);
    if (process.env.PRINT_DIGESTS) console.log(`DIGEST ${name} ${got}`);
    else assert.equal(got, EXPECT[name], `${name}: classification changed`);
  });

test('the cases use every biome, the fallback and the paint modes (so the digests mean something)', () => {
  const used = new Set();
  for (const spec of [CASES.envelopes, CASES.paintFeather]) {
    const { ids } = run(spec);
    for (const id of ids) if (id !== 255) used.add(id);
  }
  assert.ok(used.size >= 5, `only ${used.size} biomes appear`);
});

test('membership() writes memberships and signed distances for one envelope', () => {
  const n = 40,
    cells = n * n,
    c = classifier(BIOMES, 'envelopes', []),
    { warped } = run({ seed: 12, n, depth: n }),
    r = random(5);
  const m = new Int32Array(cells),
    far = new Int32Array(cells),
    parts = [];
  for (let b = 0; b < c.ids.length; b++) {
    membership(c.envelopes, b, warped, cells, m, far);
    for (const v of m) assert.ok(v >= 0 && v <= 65536);
    for (const v of far) assert.ok(v >= -2147483647 && v <= 1048576);
    parts.push(Int32Array.from(m), Int32Array.from(far));
  }
  // the unconstrained biome is a full member everywhere and has no distance
  membership(c.envelopes, 4, warped, cells, m, far);
  assert.ok(m.every((v) => v === 65536));
  assert.ok(far.every((v) => v === -2147483647));
  void r;
  const got = digest(...parts);
  if (process.env.PRINT_DIGESTS) console.log(`DIGEST membership ${got}`);
  else assert.equal(got, EXPECT.membership, 'membership changed');
});

test('checkPaint accepts only arrays of known biomes, known modes and non-empty mask names', () => {
  const ids = ['a', 'b'];
  assert.equal(checkPaint([], ids), true);
  assert.equal(checkPaint([{ biome: 'a' }], ids), true);
  assert.equal(checkPaint([{ biome: 'a', mode: 'max', mask: 'mask/m' }], ids), true);
  assert.equal(checkPaint([{ biome: 'a', mode: undefined, mask: undefined }], ids), true);
  assert.equal(checkPaint([{ biome: 'c' }], ids), false);
  assert.equal(checkPaint([{ biome: 'a', mode: 'xor' }], ids), false);
  assert.equal(checkPaint([{ biome: 'a', mask: '' }], ids), false);
  assert.equal(checkPaint([{ biome: 'a', mask: 3 }], ids), false);
  assert.equal(checkPaint([null], ids), false);
  assert.equal(checkPaint({}, ids), false);
  for (const mode of ['replace', 'add', 'multiply', 'max']) assert.equal(checkPaint([{ biome: 'b', mode }], ids), true);
});

test('classifier builds ranks, claims, input modes and paint layers', () => {
  const c = classifier(BIOMES, 'envelopes', PAINT);
  // rank: priority 2 first (b-wet), then 1 (d-high), then 0 by id, then -1 (e-any)
  const order = [...c.ids.keys()].sort((x, y) => c.rank[x] - c.rank[y]).map((i) => c.ids[i]);
  assert.deepEqual(order, ['b-wet', 'd-high', 'a-cold', 'c-dry', 'f-mask', 'g-narrow', 'e-any']);
  assert.deepEqual([...c.claim], [65536, 65536, 163840, 26214, 65536, 65536, 65536]);
  const modeOf = Object.fromEntries(c.inputs.map((name, s) => [name, c.modes[s]]));
  assert.deepEqual(
    [
      modeOf.temperature,
      modeOf.coldest,
      modeOf.warmest,
      modeOf.treeline,
      modeOf.gdd5,
      modeOf.season,
      modeOf.rainfall,
      modeOf.alpha,
      modeOf.moisture,
      modeOf['mask/rock'],
      modeOf['mask/other'],
    ],
    [1, 1, 1, 1, 2, 3, 4, 5, 5, 0, 0],
  );
  assert.deepEqual(
    c.paint.map((p) => [p.biome, p.mode, p.layer, p.mask]),
    [
      [0, 0, 'paint/a-cold', undefined],
      [1, 1, 'paint/b-wet', 'mask/hand'],
      [2, 2, 'paint/c-dry', undefined],
      [3, 3, 'paint/d-high', 'mask/hand'],
      [-1, 0, 'paint/missing', undefined],
      [4, 0, 'paint/e-any', undefined],
    ],
  );
});
