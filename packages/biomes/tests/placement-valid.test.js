// The checks of bench/placement-valid.mjs that decide whether a G1 measurement counts: repetition, spread, outputs,
// lock, quiet gate and host; the slow-sample diagnosis; and the cold case's setup. Nothing here takes the GPU lock or
// times anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeWorld, defineBiome } from '../dist/index.js';
import { BiomePlacement } from '../dist/placement.js';
import { presetWorlds } from '../dist/presets.js';
import { fileURLToPath } from 'node:url';
import {
  BenchWorker,
  GATE,
  MIN_RUNS,
  OWNER,
  TARGETS,
  caseFailures,
  coldPlacement,
  conditionFailures,
  diagnose,
  g1,
  summarize,
} from '../bench/placement-valid.mjs';

const steady = (median, n = MIN_RUNS) => Array.from({ length: n }, (_, i) => median * (1 + ((i % 5) - 2) / 100));
const gate = (extra = {}) => ({
  ac: true,
  lock: { mode: 'exclusive', pid: 7, owner: OWNER },
  quiet: { cpuLoadPercent: 4, gpu: { checked: true, utilizationPercent: [0, 1, 0] } },
  ...extra,
});
const host = { gpu: [{ name: 'NVIDIA RTX A6000' }] };
const good = { gate: gate(), lockAtEnd: { mode: 'exclusive', pid: 7, owner: OWNER }, pid: 7, host };

test('summarize gives median, min, max and spread over the median', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, median: 2.5, min: 1, max: 4, spread: 1.2 });
  assert.equal(summarize([5, 1, 3]).median, 3);
});

test('a case of 20 steady samples with one output is valid', () => {
  assert.deepEqual(caseFailures('cpu', { samples: steady(300), digests: Array(MIN_RUNS).fill('a') }), []);
});

test('fewer than 20 samples fail, whatever --runs asked for', () => {
  assert.match(caseFailures('x', { samples: steady(300, 19) }, { runs: 5 }).join(), /19 samples, need 20/);
  assert.match(caseFailures('x', { samples: steady(300, 20) }, { runs: 25 }).join(), /20 samples, need 25/);
});

test('a spread over 10% fails; 10% exactly passes', () => {
  const at = (top) => [...Array(MIN_RUNS - 1).fill(100), top];
  assert.deepEqual(caseFailures('x', { samples: at(110) }), []);
  assert.match(caseFailures('x', { samples: at(111) }).join(), /spread 11\.0% over the 10% limit/);
});

test('a sample that is not a positive finite time fails', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const samples = steady(100);
    samples[3] = bad;
    assert.match(caseFailures('x', { samples }).join(), /not a positive finite time/);
  }
  assert.deepEqual(caseFailures('x', undefined), ['x: no samples']);
});

test('samples that placed different objects fail', () => {
  const digests = Array(MIN_RUNS).fill('a');
  digests[9] = 'b';
  assert.match(caseFailures('x', { samples: steady(100), digests }).join(), /different objects/);
});

test('good conditions pass; a wrapping gpu-lock run counts as holding the lock', () => {
  assert.deepEqual(conditionFailures(good), []);
  const held = { held: 'by the wrapping gpu-lock run' };
  assert.deepEqual(conditionFailures({ ...good, gate: gate({ lock: held }), lockAtEnd: held }), []);
});

test('the lock must be this run, exclusive, at the start and at the end', () => {
  assert.match(
    conditionFailures({ ...good, gate: gate({ lock: null }) }).join(),
    /not held by this run when timing started/,
  );
  const other = { mode: 'exclusive', pid: 8, owner: OWNER };
  assert.match(conditionFailures({ ...good, lockAtEnd: other }).join(), /when timing ended/);
  const shared = { mode: 'shared', pid: 7, owner: OWNER };
  assert.match(conditionFailures({ ...good, gate: gate({ lock: shared }) }).join(), /timing started/);
});

test('battery, a skipped or loud CPU gate, an unread or busy GPU and another host all fail', () => {
  const failing = [
    [{ gate: gate({ ac: false }) }, /on battery/],
    [{ gate: gate({ quiet: { skipped: true } }) }, /quiet gate did not run/],
    [{ gate: gate({ quiet: { cpuLoadPercent: GATE.quietMax + 1, gpu: { checked: true } } }) }, /CPU 21% at the gate/],
    [{ gate: gate({ quiet: { cpuLoadPercent: 3, gpu: { checked: false } } }) }, /could not read GPU load/],
    [
      {
        gate: gate({ quiet: { cpuLoadPercent: 3, gpu: { checked: false, reason: 'nvidia-smi exited 9: no driver' } } }),
      },
      /could not read GPU load: nvidia-smi exited 9: no driver/,
    ],
    [
      { gate: gate({ quiet: { cpuLoadPercent: 3, gpu: { checked: true, busy: true, utilizationPercent: [90] } } }) },
      /GPU busy/,
    ],
    [{ settles: [{ case: 'current:cpu', ac: true, cpuLoadPercent: 55 }] }, /CPU 55% before current:cpu/],
    [{ settles: [{ case: 'current:cpu', ac: false, cpuLoadPercent: 2 }] }, /on battery before current:cpu/],
    [{ host: { gpu: [{ name: 'Intel Arc' }] } }, /not the A6000 host/],
  ];
  for (const [change, why] of failing) assert.match(conditionFailures({ ...good, ...change }).join(), why);
  assert.deepEqual(conditionFailures({ ...good, host: { gpu: [] }, anyHost: true }), []);
});

test('G1 sums fields and objects for one thread and reads the eight-worker block; a miss is targetMet false', () => {
  const cases = {
    fields: { samples: steady(430) },
    placement: { samples: steady(250) },
    workers8: { samples: steady(120) },
  };
  assert.deepEqual(g1(cases), { oneThread: 680, eightWorkers: 120, targets: TARGETS, targetMet: false });
  const met = {
    fields: { samples: steady(200) },
    placement: { samples: steady(150) },
    workers8: { samples: steady(60) },
  };
  assert.equal(g1(met).targetMet, true);
  assert.equal(g1({}).targetMet, false);
});

test('other processes over the quiet limit during a sample, workers without GC or started in the timer all fail', () => {
  const ok = { samples: steady(100), otherLoad: Array(MIN_RUNS).fill(GATE.quietMax) };
  assert.deepEqual(caseFailures('x', ok), []);
  const loud = { ...ok, otherLoad: ok.otherLoad.with(4, 35) };
  assert.match(caseFailures('x', loud).join(), /other processes kept 35% of the CPU busy during sample 4/);
  assert.match(caseFailures('x', { ...ok, gcInWorkers: false }).join(), /could not collect garbage/);
  assert.match(caseFailures('x', { ...ok, workersStartedInTimer: 2 }).join(), /2 workers started inside the timer/);
});

test('diagnose names the cause of each slow sample from its CPU time and the other processes load', () => {
  const samples = steady(100),
    cpu = steady(700),
    otherLoad = Array(MIN_RUNS).fill(2);
  samples[3] = 200; // other processes busy
  otherLoad[3] = 40;
  samples[7] = 150; // as much more CPU as wall time: work in this process
  cpu[7] = 1050;
  samples[11] = 160; // wall time without CPU time: threads waiting
  assert.deepEqual(
    diagnose({ samples, cpu, otherLoad }).map(({ index, cause }) => [index, cause]),
    [
      [3, 'other processes'],
      [7, 'more work in this process'],
      [11, 'waiting in this process'],
    ],
  );
  assert.deepEqual(diagnose({ samples: steady(100) }), []);
});

const scrubWorld = (biomes, extra) =>
  BiomeWorld.create({
    seed: 11,
    size: [1024, 1024],
    height: { relief: presetWorlds.temperate.relief },
    climate: presetWorlds.temperate.climate,
    biomes,
    ...extra,
  });

test('the bench worker places what the world places alone, answers a GC request apart from jobs and exits', async () => {
  const script = fileURLToPath(new URL('../dist/workers/biomes.js', import.meta.url)),
    made = [],
    pooled = await scrubWorld(undefined, {
      workers: 2,
      createWorker: () => {
        const w = new BenchWorker(script);
        made.push(w);
        return w;
      },
    }),
    alone = await scrubWorld(undefined, { workers: 0 });
  try {
    const [a, b] = await Promise.all([
      BiomePlacement.attach(pooled).tile(1, 1),
      BiomePlacement.attach(alone).tile(1, 1),
    ]);
    assert.deepEqual(Buffer.from(a.instances), Buffer.from(b.instances));
    assert.ok(made.length >= 1);
    // Without --expose-gc (node --test) the worker says it could not collect; the bench runs with it.
    for (const ok of await Promise.all(made.map((w) => w.gc()))) assert.equal(ok, typeof globalThis.gc === 'function');
    assert.equal((await BiomePlacement.attach(pooled).tile(2, 1)).x, 2, 'jobs still run after a GC request');
  } finally {
    pooled.dispose();
    alone.dispose();
  }
  await Promise.all(made.map((w) => w.exited));
});

test('the cold case makes nothing before its timer: its own tile whole and only bands of neighbours inside it', async () => {
  // Small crowns, so every neighbour of an interior tile is read as a band (placement-band.test.js 'scrub').
  const biomes = [
    defineBiome({
      id: 'scrub',
      climate: {},
      ground: [{ material: 'grass' }],
      plants: [{ id: 'gorse', mesh: 'procedural:shrub', density: 900, radius: 0.8, shade: 0.6 }],
    }),
  ];
  const log = [];
  const create = async (extra) => {
    const world = await scrubWorld(biomes, extra),
      tile = world.tile.bind(world),
      part = world.tilePart.bind(world);
    assert.equal(world.workers, undefined, 'the cold case runs without workers');
    world.tile = (x, z, o) => {
      log.push(`tile ${x},${z}`);
      return tile(x, z, o);
    };
    world.tilePart = (x, z, window, o) => {
      log.push(`part ${x},${z}`);
      return part(x, z, window, o);
    };
    log.push('world');
    return world;
  };
  const placed = await coldPlacement({
    create,
    attach: (world) => BiomePlacement.attach(world),
    tiles: [
      [1, 1],
      [2, 2],
    ],
    time: async (fn) => {
      log.push('start');
      const value = await fn();
      log.push('end');
      return value;
    },
  });
  assert.equal(placed.length, 2);
  const runs = log.join('|').split('world|').filter(Boolean);
  assert.equal(runs.length, 2, 'a fresh world for each tile');
  for (const [k, run] of runs.entries()) {
    const steps = run.split('|').filter(Boolean),
      [x, z] = [k + 1, k + 1];
    assert.equal(steps[0], 'start', `nothing made before the timer: ${steps.join(' ')}`);
    assert.equal(steps.at(-1), 'end');
    const inside = new Set(steps.slice(1, -1));
    assert.deepEqual(
      [...inside].filter((s) => s.startsWith('tile')),
      [`tile ${x},${z}`],
      'only the own tile is made whole',
    );
    assert.equal([...inside].filter((s) => s.startsWith('part')).length, 8, 'a band of each of the 8 neighbours');
  }
});
