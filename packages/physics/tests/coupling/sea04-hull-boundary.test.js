import assert from 'node:assert/strict';
import test from 'node:test';
import { FiniteQuayWake, QuayPotential } from '../../dist/loads.js';
import { WakeHullBoundary } from '../../src/sea/wake-hull-boundary.ts';
import { PhysicsWorld } from '../../dist/world.js';

const gravity = 9.81;
const density = 1000;
const dt = 1 / 60;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function tank(sideCells, layers, blocked) {
  const length = 1.6;
  const depth = 0.7;
  const dx = length / sideCells;
  const nx = 2 * sideCells + 1;
  const nz = 2;
  const plane = nx * nz;
  const cells = [nx, nz];
  const depths = Array.from({ length: layers + 1 }, (_, i) => (depth * i) / layers);
  const grid = { cells, cellSize: dx, depths };
  const hull = Uint8Array.from({ length: plane * layers }, (_, i) => Number(i % nx === sideCells));
  const boundary = blocked
    ? new WakeHullBoundary({ grid, hull, centre: [(sideCells + 0.5) * dx, -depth / 2, dx] })
    : undefined;
  const operator = new QuayPotential(boundary?.grid ?? grid);
  const height = new Float64Array(plane);
  const trace = new Float64Array(plane);
  const rise = new Float64Array(plane);
  const bulk = new Float64Array(plane * layers);
  const nextBulk = new Float64Array(bulk.length);
  const source = new Float64Array(bulk.length);
  const stage = new Float64Array(plane);
  const stageRise = new Float64Array(plane);
  const area = dx * dx;
  let startSpeed = 0;

  function flux(speed) {
    source.fill(0);
    boundary?.addFlux(source, [speed, 0, 0]);
  }

  function step(endSpeed = 0) {
    const speed = (startSpeed + endSpeed) / 2;
    flux(speed);
    const robin = (gravity * dt * dt) / 4;
    for (let i = 0; i < plane; i++) stage[i] = trace[i] - (dt / 2) * gravity * height[i];
    operator.project(stage, stageRise, source, robin, nextBulk);

    // A closed hull face passes no Eulerian neighbor flux. Its incident control volume gets the actual wall speed.
    let maxResidual = 0;
    if (boundary) {
      for (let i = 0; i < source.length; i++) {
        if (!source[i]) continue;
        const left = i % nx === sideCells - 1;
        assert.equal(operator.faceFlux('x', left ? i : i - 1, nextBulk), 0);
        const inflowX = i % nx ? operator.faceFlux('x', i - 1, nextBulk) : 0;
        const inflowZ = Math.floor(i / nx) % nz ? operator.faceFlux('z', i - nx, nextBulk) : 0;
        const inflowDown = i >= plane ? operator.faceFlux('down', i - plane, nextBulk) : 0;
        const otherOutflow =
          operator.faceFlux('x', i, nextBulk) +
          operator.faceFlux('z', i, nextBulk) +
          operator.faceFlux('down', i, nextBulk) -
          inflowX -
          inflowZ -
          inflowDown +
          (i < plane ? stageRise[i] * area : 0);
        maxResidual = Math.max(maxResidual, Math.abs(otherOutflow - source[i]));
      }
    }

    for (let i = 0; i < plane; i++) {
      height[i] += dt * stageRise[i];
      trace[i] = 2 * (stage[i] - robin * stageRise[i]) - trace[i];
      rise[i] = 2 * stageRise[i] - rise[i];
    }
    for (let i = 0; i < nextBulk.length; i++) nextBulk[i] = 2 * nextBulk[i] - bulk[i];
    const impulse = boundary?.pressureImpulse(bulk, nextBulk, density)[0] ?? 0;
    bulk.set(nextBulk);
    startSpeed = endSpeed;
    return { work: -impulse * speed, impulse, maxResidual };
  }

  function energy() {
    flux(startSpeed);
    const surface = height.reduce((sum, value, i) => sum + gravity * value * value + trace[i] * rise[i], 0);
    return (density / 2) * (area * surface - dot(bulk, source));
  }

  function volume() {
    const result = [0, 0];
    for (let i = 0; i < plane; i++) {
      const x = i % nx;
      if (x !== sideCells) result[Number(x > sideCells)] += height[i] * area;
    }
    return result;
  }

  return { length, depth, dx, nx, nz, sideCells, height, step, energy, volume };
}

test('the hull reflects a standing water wave while the open control transmits it', (t) => {
  function run(side, layers, blocked) {
    const model = tank(side, layers, blocked);
    const k = Math.PI / model.length;
    const omega = Math.sqrt(gravity * k * Math.tanh(k * model.depth));
    // Use the independently known oscillator phase for the time scheme to isolate spatial refinement.
    const midpointPhase = 2 * Math.atan((omega * dt) / 2);
    const initial = Float64Array.from({ length: side }, (_, i) => 0.015 * Math.cos(k * (i + 0.5) * model.dx));
    for (let z = 0; z < model.nz; z++) model.height.set(initial, z * model.nx);
    for (let tick = 0; tick < 30; tick++) model.step();
    const left = model.height.subarray(0, side);
    const right = model.height.subarray(side + 1, model.nx);
    const ratio = dot(left, initial) / dot(initial, initial);
    return {
      error: Math.abs(ratio - Math.cos(30 * midpointPhase)),
      transmitted: Math.max(...right.map(Math.abs)),
    };
  }
  const coarse = run(16, 8, true);
  const fine = run(32, 16, true);
  const open = run(16, 8, false);
  assert.equal(coarse.transmitted, 0);
  assert.equal(fine.transmitted, 0);
  assert.ok(open.transmitted > 0.001);
  assert.ok(coarse.error > 3 * fine.error && fine.error < 0.002);
  t.diagnostic(JSON.stringify({ coarse, fine, open }));
});

test('a moving impermeable hull piston radiates and returns its pressure impulse and work', (t) => {
  function run(blocked) {
    const model = tank(16, 8, blocked);
    let work = 0;
    let displacement = 0;
    let previousSpeed = 0;
    let maxVolumeError = 0;
    let maxPowerError = 0;
    let maxFluxResidual = 0;
    for (let tick = 1; tick <= 72; tick++) {
      const speed = 0.016 * Math.sin((2 * Math.PI * tick) / 72);
      const result = model.step(speed);
      if (blocked && tick === 1) assert.ok(result.impulse < 0, 'positive acceleration sees opposing dynamic pressure');
      work += result.work;
      displacement += ((previousSpeed + speed) / 2) * dt;
      const displaced = model.depth * model.nz * model.dx * displacement;
      previousSpeed = speed;
      const [left, right] = model.volume();
      maxVolumeError = Math.max(maxVolumeError, Math.abs(left + displaced), Math.abs(right - displaced));
      maxPowerError = Math.max(maxPowerError, Math.abs(work - model.energy()));
      maxFluxResidual = Math.max(maxFluxResidual, result.maxResidual);
    }
    return { ...model, work, maxVolumeError, maxPowerError, maxFluxResidual };
  }
  const live = run(true);
  const control = run(false);
  assert.equal(control.work, 0);
  assert.ok(control.height.every((value) => value === 0));
  assert.ok(live.work > 1e-4 && live.height.some((value) => Math.abs(value) > 1e-3));
  assert.ok(live.maxVolumeError < 1e-11);
  assert.ok(live.maxPowerError < 1e-10);
  assert.ok(live.maxFluxResidual < 1e-11);
  for (let x = 0; x < live.sideCells; x++) assert.ok(Math.abs(live.height[x] + live.height[live.nx - 1 - x]) < 1e-12);
  assert.deepEqual(run(true).height, live.height);
  const { work, maxVolumeError, maxPowerError, maxFluxResidual } = live;
  t.diagnostic(JSON.stringify({ work, maxVolumeError, maxPowerError, maxFluxResidual }));
});

test('hull face flux and pressure torque share the same finite moment arms', () => {
  const cells = [5, 5];
  const depths = [0, 0.1, 0.23, 0.6];
  const cellSize = 0.2;
  const hull = new Uint8Array(75);
  const origin = [2, -1];
  const centre = [2.41, -0.2, -0.56];
  // A fully submerged cell, with all six fluid neighbor faces.
  hull[37] = 1;
  const boundary = new WakeHullBoundary({ grid: { cells, depths, cellSize }, hull, origin, centre });
  const linear = [1.2, -0.08, 0.12];
  const angular = [-0.7, 0.8, -0.6];
  const flux = new Float64Array(hull.length);
  boundary.addFlux(flux, linear, angular);
  const xFace = [2.6, -0.165, -0.5];
  const xArea = cellSize * (depths[2] - depths[1]);
  const expected = xArea * (linear[0] + angular[1] * (xFace[2] - centre[2]) - angular[2] * (xFace[1] - centre[1]));
  assert.ok(Math.abs(flux[38] - expected) < 2e-16);
  assert.ok(Math.abs(flux.reduce((a, b) => a + b)) < 2e-16);
  const old = new Float64Array(hull.length);
  const changed = Float64Array.from({ length: hull.length }, (_, i) => 0.1 * Math.sin(i));
  const wrench = boundary.pressureImpulse(old, changed, density);
  assert.ok(wrench.slice(3).some((value) => Math.abs(value) > 0.01));
  assert.ok(Math.abs(dot(wrench, [...linear, ...angular]) - density * dot(changed, flux)) < 1e-14);
  assert.throws(() => boundary.addFlux(flux, [0, 0, NaN]), { code: 'state' });
  assert.throws(() => boundary.pressureImpulse(old, changed, 0), { code: 'state' });
});

test('the live finite wake pairs an oscillating hull pressure with work, volume and seek', (t) => {
  const side = 16;
  const nx = 2 * side + 1;
  const nz = 2;
  const dx = 0.1;
  const layers = 8;
  const plane = nx * nz;
  const depth = 0.7;
  const depths = Array.from({ length: layers + 1 }, (_, i) => (depth * i) / layers);
  const mask = Uint8Array.from({ length: plane * layers }, (_, i) => Number(i % nx === side));
  const x = (side + 0.5) * dx;
  const pressureX = [x - dx, x + dx];
  const span = nz * dx;
  const motion = (seconds) => [0.016 * Math.sin((2 * Math.PI * seconds) / (72 * dt)), 0, 0, 0, 0, 0];
  const wake = new FiniteQuayWake();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] });
  world.add(wake, {
    cells: [nx, nz],
    cellSize: dx,
    depths,
    density,
    pressureAtDepth: true,
    hull: { mask, centre: [x, -depth / 2, span / 2], velocity: motion },
  });
  assert.equal(wake.wet(x, dx / 2), false);
  assert.deepEqual(wake.hullExchange(), { impulse: [0, 0, 0, 0, 0, 0], joules: 0, displacedVolume: 0 });
  const start = world.takeSnapshot();
  let intermediate;
  let work = 0;
  let displacement = 0;
  let previousSpeed = 0;
  let maxEnergyError = 0;
  let maxPressureError = 0;
  let maxVolumeError = 0;
  for (let tick = 1; tick <= 72; tick++) {
    world.advance(tick);
    if (tick === 31) intermediate = world.takeSnapshot();
    const speed = motion(tick * dt)[0];
    const midpoint = (previousSpeed + speed) / 2;
    previousSpeed = speed;
    displacement += dt * midpoint;

    const exchange = wake.hullExchange();
    if (tick === 1) assert.ok(exchange.impulse[0] < 0);
    let pressureImpulse = 0;
    for (let i = 0; i < layers; i++) {
      const y = -(depths[i] + depths[i + 1]) / 2;
      const area = dx * (depths[i + 1] - depths[i]);
      for (let z = 0; z < nz; z++) {
        const atZ = (z + 0.5) * dx;
        pressureImpulse += dt * area * (wake.pressure(pressureX[0], y, atZ) - wake.pressure(pressureX[1], y, atZ));
      }
    }
    maxPressureError = Math.max(maxPressureError, Math.abs(exchange.impulse[0] - pressureImpulse));
    work -= exchange.impulse[0] * midpoint;
    maxEnergyError = Math.max(maxEnergyError, Math.abs(wake.energy() - work), Math.abs(exchange.joules - work));
    assert.equal(wake.work().joules, exchange.joules);
    const signedVolume = [0, 0];
    for (const [i, height] of wake.heights().entries()) {
      const ix = i % nx;
      if (ix !== side) signedVolume[Number(ix > side)] += height * dx * dx;
    }
    const displaced = span * depth * displacement;
    maxVolumeError = Math.max(
      maxVolumeError,
      Math.abs(signedVolume[0] + displaced),
      Math.abs(signedVolume[1] - displaced),
      Math.abs(exchange.displacedVolume),
    );
  }
  assert.ok(work > 0.06 && maxEnergyError < 1e-10);
  assert.ok(maxVolumeError < 1e-12 && maxPressureError < 1e-11);
  const accepted = world.takeSnapshot();
  for (const snapshot of [start, intermediate]) {
    world.restoreSnapshot(snapshot.bytes);
    world.advance(72);
    assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  }
  t.diagnostic(JSON.stringify({ work, maxEnergyError, maxVolumeError, maxPressureError }));
});

test('frame zero retains a heaving hull flux and the wake accounts for its signed volume', () => {
  const cells = [7, 7];
  const dx = 0.1;
  const depth = 0.3;
  const layers = [0, 0.1, 0.2, depth];
  const plane = cells[0] * cells[1];
  const mask = new Uint8Array(plane * (layers.length - 1));
  const at = 3 * cells[0] + 3;
  mask[at] = 1;
  const velocity = 0.006;
  const wake = new FiniteQuayWake();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const params = {
    cells,
    cellSize: dx,
    depths: layers,
    hull: { mask, centre: [3.5 * dx, -dx / 2, 3.5 * dx], velocity: () => [0, velocity, 0, 0, 0, 0] },
  };
  world.add(wake, params);
  const initial = world.takeSnapshot();
  const energy = wake.energy();
  assert.ok(energy > 0);
  const openDown = wake.operator.faceFlux('down', plane + at, wake.words(2));
  const centreVelocity = (velocity - openDown / (dx * dx)) / 2;
  assert.ok(Math.abs(wake.velocityAt(3.5 * dx, -0.15, 3.5 * dx)[1] - centreVelocity) < 1e-15);
  world.advance(8);
  const volume = -dx * dx * velocity * dt * 8;
  const exchange = wake.hullExchange();
  assert.ok(Math.abs(exchange.displacedVolume - volume) < 1e-17);
  assert.ok(Math.abs(wake.work().displacedVolume - volume) < 1e-17);
  assert.ok(Math.abs(wake.heights().reduce((sum, value) => sum + value, 0) * dx * dx - volume) < 1e-16);
  assert.ok(Math.abs(wake.energy() - energy - exchange.joules) < 1e-12);
  const accepted = world.takeSnapshot();
  world.restoreSnapshot(initial.bytes);
  assert.equal(wake.energy(), energy);
  world.advance(8);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);

  assert.throws(() => new PhysicsWorld().add(new FiniteQuayWake(), { ...params, temporalOrder: 4 }), {
    code: 'unsupported',
  });
});

test('a prescribed hull added to an active world starts and restores at its actual world time', () => {
  const params = { cells: [5, 5], cellSize: 0.1, depths: [0, 0.1, 0.2] };
  const mask = new Uint8Array(50);
  mask[12] = 1;
  const centre = [0.25, -0.05, 0.25];
  const observed = [];
  const velocity = (time) => {
    observed.push(time);
    return [0, 0.005 + time * 0.01, 0, 0, 0, 0];
  };
  const make = () => new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const world = make();
  world.advance(19);
  const wake = new FiniteQuayWake();
  world.add(wake, { ...params, hull: { mask, centre, velocity, startTime: world.time } });
  const late = world.takeSnapshot();
  assert.deepEqual(observed, [19 / 60]);
  assert.ok(wake.energy() > 0);
  world.advance(22);
  const accepted = world.takeSnapshot();
  assert.deepEqual(observed, [19 / 60, 20 / 60, 21 / 60, 22 / 60]);
  world.restoreSnapshot(late.bytes);
  world.advance(22);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);

  const wrongTime = make();
  wrongTime.advance(19);
  wrongTime.add(new FiniteQuayWake(), { ...params, hull: { mask, centre, velocity } });
  assert.throws(() => wrongTime.advance(20), /Set hull.startTime to world.time/);
  const fixed = make();
  fixed.advance(19);
  fixed.add(new FiniteQuayWake(), { ...params, hull: { mask, centre } });
  assert.doesNotThrow(() => fixed.advance(20));
});
