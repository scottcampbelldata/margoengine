import assert from 'node:assert/strict';
import test from 'node:test';
import { FoamSolver } from '../../dist/foam.js';
import { WakeSolver, WAKE_BREAKING_HEADER_WORDS, WAKE_BREAKING_WORDS } from '../../dist/sea.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';

const gravity = 9.81;
const depth = 0.4;
const dx = 0.125;
const cells = [64, 16];
const k = (2 * Math.PI * 2) / (cells[0] * dx);
const vertical = k * Math.tanh(k * depth);
const omega = Math.sqrt(gravity * vertical);

function couple(ratio, withLocalCrests, foamRate = 0) {
  const wake = new WakeSolver('wake', undefined, undefined, { capacity: 128 });
  const foam = new FoamSolver('foam', withLocalCrests ? wake.breakingField : undefined);
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] });
  // No spectral whitecaps. The only possible source is the local wake's crest field.
  const calm = {
    frequencies: Float64Array.of(0.25, 0.5),
    directions: Float64Array.of(0, Math.PI),
    energy: new Float64Array(4),
    depth,
    density: 1025,
  };
  // Manufactured travelling wave. This isolates the breaking read from the nonlinear evolution of the crest.
  const height = (ratio * vertical) / (k * k);
  world
    .add(wake, {
      cells,
      cellSize: dx,
      depth,
      sponge: 0,
      initial: (x) => [height * Math.cos(k * x), ((height * omega) / vertical) * Math.sin(k * x)],
    })
    .add(foam, {
      cells: [32, 8],
      cellSize: 2 * dx,
      waves: { cell: [0, 0, 0], sample: () => calm },
      rate: foamRate,
      bubbles: false,
      windrows: false,
    });
  const read = () => {
    const port = wake.exportPorts(world.tick).find((p) => p.field === wake.breakingField.name);
    return regionWords(world.memory, port.region);
  };
  return { world, wake, foam, read };
}

test('SEA-04 detected crests feed the live foam field through its registered port and replay exactly', () => {
  const live = couple(0.93, true);
  const disconnected = couple(0.93, false);
  const belowOnset = couple(0.7, true);
  const start = live.world.takeSnapshot();

  for (const fixture of [live, disconnected, belowOnset]) fixture.world.advance(6);

  const crest = live.read();
  assert.ok(crest[0] > 0);
  assert.equal(crest[1], crest[0], 'the active crest region fits this test');
  assert.equal(crest[2], dx);
  const positions = [];
  for (let row = 0; row < crest[0]; row++) {
    const at = WAKE_BREAKING_HEADER_WORDS + row * WAKE_BREAKING_WORDS;
    const x = crest[at],
      z = crest[at + 1];
    positions.push([x, z]);
    assert.ok(crest[at + 7] > 0.85);
    assert.ok(live.foam.activeCoverage(x, z) >= 0.25, 'a fine detector cell covers a quarter of a foam cell');
    assert.equal(disconnected.foam.activeCoverage(x, z), 0);
  }
  assert.ok(live.foam.meanCoverage() > 0);
  const [sprayX, sprayZ] = positions[0];
  assert.ok(live.foam.spray(sprayX, sprayZ, 5) > 0);
  assert.equal(disconnected.foam.spray(sprayX, sprayZ, 5), 0);
  assert.equal(disconnected.foam.meanCoverage(), 0);
  assert.equal(belowOnset.read()[0], 0);
  assert.equal(belowOnset.foam.meanCoverage(), 0);
  assert.deepEqual(disconnected.wake.heights(), live.wake.heights(), 'the diagnostic reader preserves the wave state');

  const end = live.world.hash();
  const coverage = positions.map(([x, z]) => live.foam.coverage(x, z));
  live.world.restoreSnapshot(start.bytes);
  live.world.advance(6);
  assert.equal(live.world.hash(), end);
  assert.deepEqual(
    positions.map(([x, z]) => live.foam.coverage(x, z)),
    coverage,
  );
});

test('a faster foam solver only fades residual coverage while the wake publication is held', () => {
  const { world, foam, read } = couple(0.93, true, 1);
  world.advance(6);
  const [residual, , clock] = foam.stateRegions();
  const acceptedTick = regionWords(world.memory, clock)[2];
  const before = regionWords(world.memory, residual).slice();
  const crest = read().slice();
  assert.ok(before.some((value) => value > 0));
  world.advance(6, { offset: { num: 1, den: 2 } });
  assert.deepEqual(read(), crest);
  assert.equal(regionWords(world.memory, clock)[2], acceptedTick);
  const after = regionWords(world.memory, residual);
  const fade = Math.exp(-1 / (120 * 3.8));
  for (let i = 0; i < before.length; i++) {
    const error = Math.abs(after[i] - before[i] * fade);
    assert.ok(error <= 16 * Number.EPSILON * Math.abs(before[i]), `extra foam on held publication at row ${i / 2}`);
  }
});
