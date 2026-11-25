// The coupling-test harness of the physics framework (docs/physics-framework.md, section 10). Every solver that claims a
// physical effect and every coupling edge between solvers is held to these properties by a test in a `tests/coupling/`
// folder that calls them; `npm run check:coupling` (in check:merge) refuses a solver no such test names.
//
// Each check takes a `make` function that builds a fresh world with the solvers under test (and whatever settings the
// check passes it), so the check owns the clock and the solvers own the physics.
import assert from 'node:assert/strict';

const SECOND = 7680;

/**
 * Frame-rate independence: the same shot at each of `rates` frames a second, advanced frame by frame, gives identical
 * state (the same state hash) at shared times.
 * @param make (rate: {num, den}) => PhysicsWorld
 */
export function frameRateIndependent(make, { seconds = 1, rates = [24, 30, 60] } = {}) {
  const hashes = rates.map((fps) => {
    const world = make({ num: fps, den: 1 });
    for (let f = 1; f <= seconds * fps; f++) world.advance(f);
    assert.equal(world.tick % SECOND, 0, `at ${fps} fps the world stands on a whole second`);
    return world.hash();
  });
  for (let i = 1; i < rates.length; i++) assert.equal(hashes[i], hashes[0], `${rates[i]} fps against ${rates[0]} fps`);
}

/**
 * Snapshot: a snapshot, a restore and a re-run, done in capped pieces and a settle, match an uninterrupted run bit for bit.
 * @param make () => PhysicsWorld at 24 frames a second
 */
export function seekEqualsContinuous(make, { frames = 48, at = 12, cap = 333 } = {}) {
  const continuous = make();
  continuous.advance(frames);
  const seeking = make();
  seeking.advance(at);
  const saved = seeking.takeSnapshot();
  seeking.advance(frames);
  seeking.restoreSnapshot(saved.bytes);
  assert.equal(seeking.hash(), saved.hash, 'a restore puts the snapshot back');
  seeking.advance(frames, { maxTicks: cap });
  seeking.settle();
  assert.equal(seeking.hash(), continuous.hash(), 'the re-run matches the uninterrupted run');
}

/**
 * Conservation of momentum: `momentum(world)` (every solver's momentum plus what is in flight between them) is the same,
 * exactly, after every frame.
 */
export function conservesMomentum(make, momentum, { frames = 24 } = {}) {
  const world = make(),
    start = momentum(world);
  for (let f = 1; f <= frames; f++) {
    world.advance(f);
    const now = momentum(world);
    for (let k = 0; k < start.length; k++) assert.equal(now[k], start[k], `momentum component ${k} at frame ${f}`);
  }
}

/** Energy: against a static boundary the energy plus what was dissipated never rises past `slack` of the start. */
export function energyNeverRises(make, energy, { frames = 24, slack = 0 } = {}) {
  const world = make();
  let last = energy(world);
  for (let f = 1; f <= frames; f++) {
    world.advance(f);
    const now = energy(world);
    assert.ok(now <= last + slack * Math.abs(last), `energy rose from ${last} to ${now} at frame ${f}`);
    last = now;
  }
}

/**
 * Effect both ways: a push given to each side reaches the other. `make(side)` builds the world with the push on `side`
 * (0 or 1), `response(world, side)` measures the other side's response, which must differ from the unpushed world's.
 */
export function effectBothWays(make, response, { frames = 12 } = {}) {
  for (const side of [0, 1]) {
    const pushed = make(side),
      still = make(-1);
    pushed.advance(frames);
    still.advance(frames);
    assert.notEqual(response(pushed, side), response(still, side), `a push on side ${side} reaches the other side`);
  }
}

/**
 * Order sensitivity: swapping two solvers (by the order `make(swapped)` puts them in) changes `observe(world)` only by the
 * scheme's truncation order: halving the step (`make(swapped, level)` one rate level up) shrinks the difference by at least
 * 2^order, within `slack`.
 */
export function orderSensitivity(make, observe, { order = 1, frames = 24, level = 1, slack = 0.25 } = {}) {
  const difference = (l) => {
    const a = make(false, l),
      b = make(true, l);
    a.advance(frames);
    b.advance(frames);
    return Math.abs(observe(a) - observe(b));
  };
  const coarse = difference(level),
    fine = difference(level + 1);
  assert.ok(coarse > 0, 'swapping the solvers changes the result at all (else the test proves nothing)');
  assert.ok(
    fine <= coarse / 2 ** order + slack * (coarse / 2 ** order),
    `the swap's effect shrank from ${coarse} to ${fine}, less than order ${order}`,
  );
}

/**
 * Added mass: over a sweep of body-to-added-mass ratios, `observe(world)` stays within `tolerance` of `exact(ratio)` (a
 * stable coupling gives the coupled answer at every ratio).
 */
export function addedMassStable(
  make,
  observe,
  exact,
  { ratios = [0.1, 0.5, 0.9, 1.1, 2, 10], frames = 60, tolerance = 1e-9 } = {},
) {
  for (const ratio of ratios) {
    const world = make(ratio);
    world.advance(frames);
    const value = observe(world),
      want = exact(ratio);
    assert.ok(
      Math.abs(value - want) <= tolerance * Math.max(1, Math.abs(want)),
      `ratio ${ratio}: ${value} against ${want}`,
    );
  }
}
