// GAP-FILM-RESET: every vfx clock's `resetTime()` leaves it as a fresh one with the same options, before and after a
// seek: VFX (counters, step seeds, queued bursts, the frame-update flag and the last step), BlownSand, Clouds, Flame,
// Smoke (its puffs' effect too), FireFront (cells, ignitions, the random stream and its children), Battery (queue, shots,
// banks, lights and the holes in its targets' masks) and HullFire (its children and its mask). The drawn half (particles
// on the GPU after a reset equal a fresh effect's) is the reset case of seek-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/base.js';
import { schedule } from '../dist/schedule.js';
import { BlownSand } from '../dist/blown-sand.js';
import { Clouds } from '../dist/clouds.js';
import { Flame } from '../dist/flame.js';
import { Smoke } from '../dist/smoke.js';
import { FireFront } from '../dist/fire-front.js';
import { Battery, HullFire, hullMaskImage } from '../dist/gunfire.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { assertResetLikeFresh, clockState, usedDeltas } from '../../../tests/support/clock-reset.js';

const FPS = 60;
function world() {
  const h = optionalGPU();
  h.context.delta = 1 / FPS;
  h.engine.stats = { drawCalls: 0 };
  h.engine.lighting = {
    direction: new Float32Array([0, 3, 4, 2]),
    radiance: new Float32Array([1, 0.5, 0.25, 0.2]),
    ambient: new Float32Array([1, 2, 3]),
  };
  h.engine.gpu.createCommandEncoder = () => ({ ...h.context.encoder, finish: () => ({}) });
  return h;
}
const vfxOptions = () => ({
  capacity: 2000,
  initialCount: 40,
  rate: 37.3,
  lifetime: [1, 2],
  schedule: {
    prewarm: 0.25,
    seed: 9,
    bursts: [{ time: 0.1, count: 25, cycles: 4000, interval: 0.5, probability: 0.7 }],
  },
});
const attachedVFX = () => {
  const h = world(),
    vfx = new VFX(vfxOptions(), { schedule });
  h.engine.use(vfx);
  return { h, vfx };
};

test('VFX.resetTime is a fresh effect: counters, seeds, bursts and the frame-update flag (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => attachedVFX().vfx, {
    label: 'VFX',
    use: (vfx) => vfx.burst(30, { position: [1, 2, 3] }),
  });
  // Unattached, as a scene builds it.
  assertResetLikeFresh(() => new VFX({ rate: 11.3 }), { label: 'VFX unattached' });
});

test('a VFX drawn, reset and drawn again uploads what a fresh one uploads, frame for frame (GAP-FILM-RESET)', () => {
  const a = attachedVFX(),
    b = attachedVFX();
  for (let i = 0; i < 200; i++) a.h.frame();
  a.vfx.burst(17);
  a.vfx.resetTime();
  assert.equal(a.vfx.time, 0);
  for (let i = 0; i < 120; i++) {
    a.h.frame();
    b.h.frame();
    assert.deepEqual(Array.from(a.vfx['values']), Array.from(b.vfx['values']), `frame ${i}`);
  }
  assert.equal(a.vfx['frames'], b.vfx['frames']);
  // A frame update that never reached it before the reset: the simulate pass counts its own step again.
  const c = attachedVFX();
  c.vfx.advanceTime(1 / FPS);
  c.vfx.resetTime();
  assert.equal(c.vfx['clocked'], false, 'the frame-update flag goes back');
  c.vfx.dispose();
  c.vfx.resetTime();
});

test('BlownSand and Clouds reset as fresh ones (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new BlownSand({ ground: () => 0, wind: { speed: 11, direction: 0.3 }, seed: 4 }), {
    label: 'BlownSand',
  });
  const clouds = () => {
    const c = new Clouds({ limit: 64 });
    c.add({ seed: 3, segments: 8 });
    return c;
  };
  assertResetLikeFresh(clouds, { label: 'Clouds' });
});

const gusts = { sample: (x, y, z, t) => [3 + 2 * Math.sin(0.7 * t), 0, 1.5 * Math.cos(0.31 * t)] };

test('Flame and Smoke reset as fresh ones; the smoke puffs go back with the column (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => Flame.attach(world().engine, { position: [1, 0, 2], length: 4, wind: gusts }), {
    label: 'Flame',
  });
  assertResetLikeFresh(
    () => Smoke.attach(world().engine, { position: [0, 0, 0], heat: 5e6, prewarm: false, rate: 13.7, wind: gusts }),
    { label: 'Smoke' },
  );
  // Drawn: a reset column's puffs upload what a fresh column's upload.
  const make = () => {
    const h = world();
    return { h, it: Smoke.attach(h.engine, { position: [0, 0, 0], heat: 5e6, rate: 13.7, wind: gusts }) };
  };
  const a = make(),
    b = make();
  for (let i = 0; i < 90; i++) a.h.frame();
  a.it.resetTime();
  for (let i = 0; i < 60; i++) {
    a.h.frame();
    b.h.frame();
  }
  assert.ok(Object.is(a.it.time, b.it.time));
  assert.deepEqual(Array.from(a.it.effect['values']), Array.from(b.it.effect['values']));
});

test('FireFront.resetTime unburns every cell, queues its ignitions again and replays the same fire (GAP-FILM-RESET)', () => {
  const make = () =>
    FireFront.create({
      size: [400, 400],
      cell: 10,
      seed: 5,
      wind: [6, 2],
      spotting: 0.2,
      ignitions: [{ at: [0, 0], radius: 15 }],
      structures: [{ at: [80, 40] }],
    });
  assertResetLikeFresh(make, { label: 'FireFront', delta: 1, steps: 400 });
  const fire = make(),
    fresh = make();
  fire.ignite(-100, -100, 10);
  for (const d of usedDeltas) fire.advanceTime(d * 200);
  assert.ok(fire.burningCells > 0 || fire.state(0, 0) === 2, 'it burned');
  fire.resetTime();
  assert.equal(fire.state(0, 0), 0, 'unburnt again');
  for (let i = 0; i < 600; i++) {
    fire.advanceTime(1);
    fresh.advanceTime(1);
  }
  assert.equal(fire.state(-100, -100), fresh.state(-100, -100), 'an ignite() before the reset is dropped');
  assert.deepEqual(fire.read(), fresh.read());
  assert.equal(fire.embers, fresh.embers);
});

const gun = { position: [0, 3, 0], direction: [0, 0, 1] };
test('Battery.resetTime fires the same shots again and clears the holes it drew (GAP-FILM-RESET)', () => {
  // The target lies across the line of fire 150 m out, so both shots strike it.
  const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 150, 1]);
  const make = () => {
    const mask = { source: hullMaskImage(64, 16), update() {} };
    const target = { ship: { matrix: () => pose }, length: 100, beam: 20, height: 10, draft: 5, mask };
    return Battery.attach(world().engine, {
      guns: [gun, { ...gun, position: [0, 3, 10] }],
      shots: [
        { gun: 0, time: 0.2 },
        { gun: 1, time: 0.9 },
      ],
      wind: [4, 1],
      targets: [target],
    });
  };
  assertResetLikeFresh(make, { label: 'Battery', use: (b) => b.fire(1, 0.05), steps: 120 });
  const b = make(),
    mask = b.options.targets[0].mask.source.data;
  for (let i = 0; i < 180; i++) b.advanceTime(1 / 30);
  assert.equal(b.fired.length, 2);
  assert.ok(b.hits().length > 0 && mask.some((v, i) => i % 4 === 2 && v > 0), 'the shots holed the target');
  b.resetTime();
  assert.equal(b.hits().length, 0);
  assert.equal(b.fired.length, 0);
  for (let i = 2; i < mask.length; i += 4) assert.equal(mask[i], 0, 'no hole left');
});

test('HullFire.resetTime puts its flames, smoke and mask back to time 0 (GAP-FILM-RESET)', () => {
  const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const make = (engine = world().engine) =>
    HullFire.attach(engine, {
      ship: { matrix: () => pose },
      spread: 0.1,
      ports: [{ position: [6.5, 3, 0], size: [0.8, 0.7] }],
      mask: { source: hullMaskImage(32, 8), update() {} },
    });
  // Its children are reset clocks of their own (tested above), placed for time 0 after the reset; their caches of the
  // placed options refresh on the next step, so they are compared from there.
  assertResetLikeFresh(() => make(), {
    label: 'HullFire',
    delta: 1,
    steps: 300,
    ignore: ['flameVolumes', 'smokeColumns'],
  });
  // A seek steps every plugin of the scene: the fire and the flames and columns it attached.
  const scene = () => {
    const h = world(),
      fire = make(h.engine);
    const step = (d) => {
      for (const plugin of h.engine.plugins.values())
        if (typeof plugin.advanceTime === 'function') plugin.advanceTime(d);
    };
    return { fire, step };
  };
  const used = scene(),
    fresh = scene();
  for (const d of usedDeltas) used.step(d * 100);
  used.fire.resetTime();
  for (let i = 0; i < 3; i++) {
    used.step(1 / 60);
    fresh.step(1 / 60);
  }
  assert.deepEqual(clockState(used.fire), clockState(fresh.fire), 'HullFire and its children one step after the reset');
  const fire = make(),
    data = fire.options.mask.source.data;
  for (let i = 0; i < 600; i++) fire.advanceTime(1);
  assert.ok(
    data.some((v, i) => i % 4 === 0 && v > 0),
    'it charred',
  );
  fire.resetTime();
  assert.equal(fire.time, 0);
  assert.ok(
    data.every((v, i) => i % 4 > 1 || v === 0),
    'char and glow are those of time 0',
  );
});
