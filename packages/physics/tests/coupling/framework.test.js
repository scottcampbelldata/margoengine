// The framework's own coupling tests (docs/physics-framework.md, sections 5 and 10): every scheme of the scheduler, on small
// solvers with known answers, held to the harness's properties: momentum conserved exactly across an impulse pair, the same
// simulation at 24, 30 and 60 frames a second, a seek equal to a continuous run, energy that never rises, an effect both
// ways, a swap of solvers that changes results only at the scheme's order, an iterated coupling equal to the monolithic
// solve, and an added-mass sweep where plain staggering diverges past the body's mass and the iterated scheme does not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PhysicsWorld, regionWords, staggeringStable } from '../../dist/world.js';
import {
  addedMassStable,
  conservesMomentum,
  effectBothWays,
  energyNeverRises,
  frameRateIndependent,
  orderSensitivity,
  seekEqualsContinuous,
} from './harness.js';

const scalar = (name, quantity, unit) => ({ name, kind: 'scalarSeries', quantity, unit, centring: 'particle' });

/**
 * A solver of a few f64 state words, publishing one of them as `out` and reading `reads`: `update(state, inputs, dt)` is its
 * step. It saves its start at each step so `iterate` re-runs the tick.
 */
function solver(id, { rate = 0, words, start = [], out, reads = [], update, accumulate, own = [] }) {
  const s = {
    describe: () => ({
      id,
      rate,
      stableRate: () => 0,
      fields: [
        ...(out ? [{ field: out.field, access: 'write' }] : []),
        ...own.map((field) => ({ field, access: 'write' })),
        ...reads.map((field) => ({ field, access: 'read' })),
        ...(accumulate ? [{ field: accumulate.field, access: 'accumulate' }] : []),
      ],
    }),
    init(host) {
      s.host = host;
      s.state = host.allocate('state', words * 8, 'f64', 1);
      s.saved = host.allocate('start', words * 8, 'f64', 1);
      s.port = host.allocate('out', 8, 'f64', 1);
      s.push = host.allocate('push', 8, 'f64', 1);
      s.w().set(start);
    },
    w: () => regionWords(s.host.memory, s.state),
    read: (context, field) => regionWords(s.host.memory, context.inputs.get(field.name).region)[0],
    step(context, dt) {
      regionWords(s.host.memory, s.saved).set(s.w());
      s.run(context, dt);
    },
    iterate(context, dt) {
      s.w().set(regionWords(s.host.memory, s.saved));
      s.run(context, dt);
    },
    run(context, dt) {
      const pushed = update(s.w(), (field) => s.read(context, field), dt);
      if (accumulate) regionWords(s.host.memory, s.push)[0] = pushed;
    },
    exportPorts(tick) {
      const ports = [];
      if (out) {
        regionWords(s.host.memory, s.port)[0] = s.w()[out.word];
        ports.push({ field: out.field.name, region: s.port, tick });
      }
      if (accumulate) ports.push({ field: accumulate.field.name, region: s.push, tick });
      return ports;
    },
    importPorts() {
      for (const field of own) {
        const sum = s.host.port(field.name);
        if (sum) s.w()[1] += regionWords(s.host.memory, sum.region)[0];
      }
    },
    stateRegions: () => [s.state],
    extraState: () => [s.saved],
  };
  return s;
}

/** Two masses on a spring between them, each its own solver, the spring force implicit in both positions. */
function springPair({ k = 400, ma = 1, mb = 3, level = 0, ids = ['a', 'b'], va = 0, vb = 0 } = {}) {
  const xa = scalar('xa', 'position', 'm'),
    xb = scalar('xb', 'position', 'm');
  // Backward Euler in the coupling: v' = v - dt k/m (x' - other'), x' = x + dt v'; given the other's new position.
  const side = (m, other) => (w, read, dt) => {
    const c = (dt * dt * k) / m;
    w[0] = (w[0] + dt * w[1] + c * read(other)) / (1 + c);
    w[1] = (w[0] - w[2]) / dt; // w[2] keeps the position the step began at
    w[2] = w[0];
  };
  const a = solver(ids[0], {
      rate: level,
      words: 3,
      start: [0, va, 0],
      out: { field: xa, word: 0 },
      reads: [xb],
      update: side(ma, xb),
    }),
    b = solver(ids[1], {
      rate: level,
      words: 3,
      start: [1, vb, 1],
      out: { field: xb, word: 0 },
      reads: [xa],
      update: side(mb, xa),
    });
  return { a, b, k, ma, mb };
}

/** A world at `rate` with a spring pair coupled by `scheme`. */
function pairWorld(scheme, { rate = { num: 24, den: 1 }, ...pair } = {}) {
  const p = springPair(pair),
    world = new PhysicsWorld({ rate }).add(p.a, {}).add(p.b, {});
  world.couple(pair.order ?? pair.ids ?? ['a', 'b'], scheme);
  return Object.assign(world, { pair: p });
}

/** The same pair stepped as one system: the 2 x 2 linear solve of backward Euler, by Cramer's rule. */
function monolithic({ k, ma, mb }, steps, dt) {
  let [xa, va, xb, vb] = [0, 0, 1, 0];
  for (let n = 0; n < steps; n++) {
    // (1 + ca) xa' - ca xb' = xa + dt va; -cb xa' + (1 + cb) xb' = xb + dt vb
    const ca = (dt * dt * k) / ma,
      cb = (dt * dt * k) / mb,
      ra = xa + dt * va,
      rb = xb + dt * vb,
      det = (1 + ca) * (1 + cb) - ca * cb,
      na = (ra * (1 + cb) + ca * rb) / det,
      nb = ((1 + ca) * rb + cb * ra) / det;
    va = (na - xa) / dt;
    vb = (nb - xb) / dt;
    xa = na;
    xb = nb;
  }
  return [xa, xb];
}

test('momentum crossing an interface as an impulse pair is conserved exactly, under every scheme', () => {
  const make = (scheme) => {
    const push = scalar('hullPush', 'impulse', 'N s'),
      sailX = scalar('sailX', 'position', 'm'),
      hullX = scalar('hullX', 'position', 'm'),
      // Each reads the other's position, so the two are one coupling group.
      hull = solver('hull', {
        words: 2,
        own: [push],
        out: { field: hullX, word: 0 },
        reads: [sailX],
        update: (w, _read, dt) => void (w[0] += w[1] * dt),
      }),
      sail = solver('sail', {
        words: 2,
        out: { field: sailX, word: 0 },
        reads: [hullX],
        accumulate: { field: push },
        // A push of 1/8 N s a step, taken from the sail's own momentum: an exact impulse pair.
        update: (w, _read, dt) => {
          w[1] -= 1 / 8;
          w[0] += w[1] * dt;
          return 1 / 8;
        },
      }),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(hull, {}).add(sail, {});
    world.couple(['hull', 'sail'], scheme);
    return { world, hull, sail };
  };
  for (const scheme of ['staggered', 'predicted', 'implicitPressure']) {
    // Both momenta plus the push in flight in the registry (the sail's contribution not yet summed into the hull's field).
    let parts;
    conservesMomentum(
      () => {
        parts = make(scheme);
        return parts.world;
      },
      (world) => {
        const inFlight = world.fields.regionsOf('hullPush').find((r) => r.name === 'hullPush/from/sail');
        return [parts.hull.w()[1] + parts.sail.w()[1] + regionWords(world.memory, inFlight)[0]];
      },
      { frames: 20 },
    );
  }
});

test('every scheme is frame-rate independent and seeks to the continuous run', () => {
  for (const scheme of ['staggered', 'strang', 'predicted', 'iterated']) {
    frameRateIndependent((rate) => pairWorld(scheme, { rate, level: 1 }));
    seekEqualsContinuous(() => pairWorld(scheme, { level: 2 }));
  }
});

test('a coupled pair acts both ways, loses energy under backward Euler, and swapping it changes results at first order', () => {
  // A kick to either mass moves the other.
  effectBothWays(
    (side) => pairWorld('iterated', { va: side === 0 ? 1 : 0, vb: side === 1 ? 1 : 0 }),
    (world, side) => (side === 0 ? world.pair.b : world.pair.a).w()[0],
  );
  // Backward Euler dissipates: kinetic plus spring energy never rises.
  energyNeverRises(
    () => pairWorld('iterated', { va: 2 }),
    ({ pair }) => {
      const [a, b] = [pair.a.w(), pair.b.w()];
      return 0.5 * pair.ma * a[1] ** 2 + 0.5 * pair.mb * b[1] ** 2 + 0.5 * pair.k * (b[0] - a[0]) ** 2;
    },
  );
  // Staggered, which mass steps first is a first-order splitting error: the order given to couple() orders the members.
  orderSensitivity(
    (swapped, level) => pairWorld('staggered', { level, order: swapped ? ['b', 'a'] : ['a', 'b'] }),
    (world) => world.pair.a.w()[0],
  );
});

test('a staggered coupling steps its members in the order given to couple(), whatever order they were added in', () => {
  // b before a against a before b: a different first-order splitting, so different bits.
  const run = (order, added) => {
    const p = springPair(),
      world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
    for (const id of added) world.add(id === 'a' ? p.a : p.b, {});
    world.couple(order, 'staggered');
    world.advance(24);
    return world.hash();
  };
  const bFirst = run(['b', 'a'], ['a', 'b']);
  assert.notEqual(bFirst, run(['a', 'b'], ['a', 'b']), 'the order given is the order stepped');
  // The same calls give the same order and the same bits, however the solvers were added.
  assert.equal(run(['b', 'a'], ['b', 'a']), bFirst);
  assert.equal(run(['b', 'a'], ['a', 'b']), bFirst);
});

test('an iterated coupling equals the monolithic solve of the same discretisation', () => {
  for (const accelerator of ['anderson', 'aitken']) {
    const pair = springPair(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pair.a, {}).add(pair.b, {});
    world.couple(['a', 'b'], 'iterated', { accelerator, iterations: accelerator === 'anderson' ? 4 : 12 });
    world.advance(120);
    const [xa, xb] = monolithic(pair, 120, 1 / 60);
    assert.ok(Math.abs(pair.a.w()[0] - xa) < 1e-12, `${accelerator}: a ${pair.a.w()[0]} against ${xa}`);
    assert.ok(Math.abs(pair.b.w()[0] - xb) < 1e-12, `${accelerator}: b ${pair.b.w()[0]} against ${xb}`);
  }
  // Staggered, the same pair lags a step behind the monolithic answer.
  const pair = springPair(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(pair.a, {}).add(pair.b, {});
  world.advance(120);
  const [xa] = monolithic(pair, 120, 1 / 60);
  assert.ok(Math.abs(pair.a.w()[0] - xa) > 1e-6, 'a once-a-tick exchange is not the monolithic solve');
});

test('added-mass sweep: staggering diverges past the body mass, the iterated scheme does not', () => {
  // A body pushed by a constant force through a fluid whose reaction is -addedMass times the body's acceleration.
  const run = (bodyMass, addedMass, scheme) => {
    const accel = scalar('bodyAccel', 'acceleration', 'm/s^2'),
      reaction = scalar('fluidForce', 'force', 'N'),
      body = solver('body', {
        words: 3,
        out: { field: accel, word: 2 },
        reads: [reaction],
        update: (w, read, dt) => {
          w[2] = (1 + read(reaction)) / bodyMass; // 1 N pushes it
          w[1] += w[2] * dt;
          w[0] += w[1] * dt;
        },
      }),
      fluid = solver('fluid', {
        words: 1,
        out: { field: reaction, word: 0 },
        reads: [accel],
        update: (w, read) => {
          w[0] = -addedMass * read(accel);
        },
      }),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(body, {}).add(fluid, {});
    world.couple(['body', 'fluid'], scheme, scheme === 'iterated' ? { iterations: 4 } : {});
    world.body = body;
    if (scheme === 'staggered') world.advance(60);
    return world;
  };
  const exact = (ms, ma) => 1 / (ms + ma);
  addedMassStable(
    (ratio) => run(1, ratio, 'iterated'),
    (world) => world.body.w()[2],
    (ratio) => exact(1, ratio),
    { tolerance: 1e-12 },
  );
  for (const ratio of [0.25, 0.5, 0.9, 1.1, 2, 10]) {
    const staggered = run(1, ratio, 'staggered').body.w()[2],
      diverged = !(Math.abs(staggered - exact(1, ratio)) < 1e-3);
    assert.equal(diverged, ratio > 1, `staggered at ${ratio}: ${staggered}`);
    assert.equal(staggeringStable(1, ratio, 1), ratio < 1);
  }
  assert.throws(() => new PhysicsWorld().couple([], 'staggered', { bodyMass: 1, addedMass: 2 }), RangeError);
});

test('a strongly coupled group steps at the finest level any member chooses; a Strang pair one level apart', () => {
  // The rule is one for every scheme that steps its members together (iterated, predicted, implicit pressure).
  for (const scheme of ['iterated', 'predicted']) {
    const { a, b } = springPair(),
      slow = { ...a, describe: () => ({ ...a.describe(), rate: 0 }) },
      fast = { ...b, describe: () => ({ ...b.describe(), rate: 2 }) };
    const world = new PhysicsWorld().add(slow, {}).add(fast, {}).couple(['a', 'b'], scheme);
    assert.deepEqual([world.levelOf('a'), world.levelOf('b')], [2, 2], scheme);
  }
  const { a, b } = springPair({ level: 1 }),
    world = new PhysicsWorld().add(a, {}).add(b, {}).couple(['a', 'b'], 'strang');
  assert.deepEqual([world.levelOf('a'), world.levelOf('b')], [2, 1], 'the half-stepped member runs one level above');
});
