// Crowd density: with `density`, a Crowd walks at the speeds measured crowds walk at. Reference: Weidmann's fundamental
// diagram (Weidmann 1993, "Transporttechnik der Fussgaenger"), v(rho) = 1.34 (1 - e^(-1.913 (1 / rho - 1 / 5.4))) m/s,
// the fit to the measured studies he gathered, and its specific flow J = rho v, which peaks near 1.2 people per metre a
// second at about 1.8 people per square metre (Fruin's level of service E to F boundary).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '../dist/index.js';

/** A corridor `length` by `width` metres of 1 m square polygons at y 0. */
function corridor(length, width) {
  const vertices = [],
    polygons = [];
  for (let r = 0; r <= width; r++) for (let c = 0; c <= length; c++) vertices.push([c, 0, r]);
  for (let r = 0; r < width; r++)
    for (let c = 0; c < length; c++) {
      const v = (cc, rr) => rr * (length + 1) + cc;
      polygons.push([v(c, r), v(c + 1, r), v(c + 1, r + 1), v(c, r + 1)]);
    }
  return new NavMesh(vertices, polygons);
}
const weidmann = (rho) => 1.34 * (1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
/** A seeded random number in [0, 1). */
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/**
 * Mean speed, m/s, of the walkers that start in the middle third of a block at density `rho` walking down a 6 m wide
 * corridor, from 2 to 5 seconds in.
 */
function walk(rho, density) {
  const nav = corridor(80, 6),
    crowd = new Crowd(nav, { density, maxNeighbors: 10, timeHorizon: 1 }),
    spacing = 1 / Math.sqrt(rho),
    next = random(7),
    middle = [];
  for (let x = 5 + spacing / 2; x < 35; x += spacing)
    for (let z = 0.3 + spacing / 2; z < 5.7; z += spacing) {
      const at = [x + (next() - 0.5) * spacing * 0.5, 0, Math.min(5.75, Math.max(0.25, z + (next() - 0.5) * spacing * 0.5))],
        agent = crowd.addAgent({ position: at, radius: 0.2, maxSpeed: 1.34, maxAcceleration: 6 });
      agent.setTarget([79.5, 0, at[2]]);
      if (x > 15 && x < 25) middle.push(agent);
    }
  const dt = 1 / 30;
  for (let k = 0; k < 60; k++) crowd.update(dt);
  const start = middle.map((a) => a.position[0]);
  for (let k = 0; k < 90; k++) crowd.update(dt);
  const speed = middle.reduce((sum, a, i) => sum + (a.position[0] - start[i]) / 3, 0) / middle.length;
  crowd.dispose();
  return speed;
}

test("a dense crowd walks at Weidmann's measured speeds", () => {
  for (const rho of [0.5, 1, 1.5, 2]) {
    const got = walk(rho, true),
      want = weidmann(rho);
    assert.ok(Math.abs(got - want) <= 0.15 * want + 0.03, `at ${rho} people/m^2: ${got.toFixed(3)} m/s, Weidmann ${want.toFixed(3)}`);
  }
});

test('the specific flow rises, peaks and falls as in the fundamental diagram', () => {
  const flow = [0.75, 1.75, 3].map((rho) => rho * walk(rho, true));
  assert.ok(flow[1] > flow[0] && flow[1] > flow[2], `flow ${flow.map((f) => f.toFixed(2))}`);
  assert.ok(flow[1] > 1.0 && flow[1] < 1.4, `peak specific flow ${flow[1].toFixed(2)} people/m/s, Weidmann about 1.2`);
});

test('without density every walker keeps its own speed, and bad fits are refused', () => {
  assert.ok(walk(2, false) > 1.2, 'off by default: a unidirectional crowd walks at maxSpeed');
  const nav = corridor(4, 2);
  assert.throws(() => new Crowd(nav, { density: { jam: -1 } }), RangeError);
  assert.throws(() => new Crowd(nav, { density: 'yes' }), TypeError);
});
