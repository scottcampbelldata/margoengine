// GAP-FILM-TIME for the weather events: Avalanche, SnowDrift and Eruption kept film time with `update(delta)` and no
// `advanceTime`, so `seek` from @margoengine/cutscene/seek could not take them (its `extra` refused them) and a scene
// started at film time T showed the slab unbroken, the snow fresh and the column not yet risen. Run A takes n + 1 live
// updates of 1 / fps; run B is fresh, seeks n steps with the event in `extra`, then takes one live update. Every field
// must be equal, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Avalanche } from '../dist/avalanche.js';
import { SnowDrift } from '../dist/snow-drift.js';
import { Eruption } from '../dist/eruption.js';
import { seekSync } from '../../cutscene/dist/seek.js';

const FPS = 30;
const world = { scene: { plugins: new Map() } };
function state(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (seen.has(value)) return '[seen]';
  seen.add(value);
  if (value instanceof Map) return [...value].map((v) => state(v, seen));
  if (value instanceof Set) return [...value].map((v) => state(v, seen));
  if (Array.isArray(value)) return value.map((v) => state(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, state(v, seen)]).filter(([, v]) => v !== undefined));
}

function slope(deg = 35, length = 600, cell = 4, across = 5) {
  const depth = Math.round(length / cell) + 1,
    ground = new Float32Array(across * depth);
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < across; i++) ground[j * across + i] = -Math.tan((deg * Math.PI) / 180) * Math.min(j * cell, 400);
  return { width: across, depth, cellSize: cell, ground };
}
function ridge(W = 96, D = 8) {
  const g = new Float32Array(W * D);
  for (let j = 0; j < D; j++)
    for (let i = 0; i < W; i++) g[j * W + i] = i < 40 ? 8 * Math.max(0, 1 - (40 - i) / 30) : 8 * Math.max(0, 1 - (i - 40) / 6);
  return { width: W, depth: D, ground: g };
}

const events = {
  // Released 2 s in, so the seek crosses the release, the flow, the cloud and the deposit.
  Avalanche: () => new Avalanche({ ...slope(), cover: 0.5, coverDensity: 250, release: { at: [8, 120], size: [100, 60] }, releaseTime: 2 }),
  SnowDrift: () => new SnowDrift({ ...ridge(), initialDepth: 0.3, wind: 16, windDirection: 90, snowfall: 2, temperature: -8, timeScale: 60 }),
  Eruption: () => new Eruption({ rise: 1, wind: 8, timeScale: 10 }),
};

for (const [name, make] of Object.entries(events))
  for (const n of [1, 600, 5400])
    test(`${name} seeked ${n} steps holds what a continuous run holds, bit for bit`, () => {
      const a = make(),
        b = make();
      assert.equal(b.time, 0, 'a fresh event starts at 0');
      for (let step = 0; step <= n; step++) a.update(1 / FPS);
      const result = seekSync(world, n / FPS, { fps: FPS, extra: [b] });
      assert.equal(result.steps, n);
      b.update(1 / FPS);
      assert.ok(Object.is(b.time, a.time), `${b.time} against ${a.time}`);
      assert.deepEqual(state(b), state(a));
    });

test('an event at T without the seek restarts (the cut a film showed)', () => {
  for (const make of Object.values(events)) {
    const a = make(),
      c = make();
    for (let step = 0; step <= 600; step++) a.update(1 / FPS);
    c.update(1 / FPS);
    assert.notDeepEqual(state(c), state(a));
  }
});

test('advanceTime refuses what update refuses', () => {
  for (const make of Object.values(events)) {
    const e = make();
    assert.throws(() => e.advanceTime(-1), RangeError);
    assert.throws(() => e.advanceTime(Number.NaN), RangeError);
    assert.equal(e.time, 0);
  }
});
