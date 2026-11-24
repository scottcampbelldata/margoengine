// walkCrowd: a navmesh Crowd drives a crowd drawer. Feet do not slide (the cycle advances by the ground covered, at
// whatever speed Weidmann's density relation leaves), heads turn toward the way of walking at a bounded rate, standing
// agents play the stand clip, and each agent keeps its own outfit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '@margoengine/navmesh';
import { walkCrowd } from '../dist/crowd.js';

/** A drawer that records what the walkers set, shaped like a VATCrowd. */
function recorder() {
  const instances = [];
  return {
    instances,
    vat: { clips: [{ name: 'walk', duration: 1.1 }, { name: 'stand', duration: 4 }] },
    add(instance = {}) {
      instances.push({ ...instance });
      return instances.length - 1;
    },
    set(index, instance) {
      instances[index] = { ...instances[index], ...instance, matrix: Array.from(instance.matrix) };
    },
  };
}
function square(size) {
  const vertices = [],
    polygons = [];
  for (let r = 0; r <= size; r++) for (let c = 0; c <= size; c++) vertices.push([c, 0, r]);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const v = (cc, rr) => rr * (size + 1) + cc;
      polygons.push([v(c, r), v(c + 1, r), v(c + 1, r + 1), v(c, r + 1)]);
    }
  return new NavMesh(vertices, polygons);
}

test('the walk cycle advances by the ground covered, so feet do not slide, in a dense crowd too', () => {
  const crowd = new Crowd(square(40), { density: true }),
    drawer = recorder();
  for (let k = 0; k < 300; k++) {
    const agent = crowd.addAgent({ position: [2 + (k % 15) * 0.5, 0, 2 + Math.floor(k / 15) * 0.5], radius: 0.2, maxSpeed: 1.34 });
    agent.setTarget([38, 0, 2 + Math.floor(k / 15) * 0.5 + 10]);
  }
  const walkers = walkCrowd(crowd, drawer, { walk: 0, stand: 1, stride: 1.4, variants: [0, 1, 2, 3].map((k) => ({ offset: [k / 4, 0], scale: [0.25, 1] })) });
  assert.equal(drawer.instances.length, 300, 'one instance per agent');
  const dt = 1 / 30;
  for (let k = 0; k < 30; k++) {
    crowd.update(dt);
    walkers.update(dt);
  }
  const ground = new Float64Array(300),
    phase = Float64Array.from(walkers.phases);
  for (let k = 0; k < 60; k++) {
    const before = crowd.agents.map((a) => [a.position[0], a.position[2]]);
    crowd.update(dt);
    walkers.update(dt);
    crowd.agents.forEach((a, i) => (ground[i] += Math.hypot(a.position[0] - before[i][0], a.position[2] - before[i][1])));
  }
  let worst = 0;
  // The ground each walked over 2 s against stride times the phase its cycle advanced.
  crowd.agents.forEach((a, i) => (worst = Math.max(worst, Math.abs(ground[i] - (walkers.phases[i] - phase[i]) * 1.4))));
  assert.ok(worst < 0.05, `foot slide over 2 s: ${worst.toFixed(3)} m`);
  // Instances sit at their agents.
  const m = drawer.instances[17].matrix,
    p = crowd.agents[17].position;
  assert.deepEqual([m[12], m[13], m[14]].map((v) => +v.toFixed(4)), [p[0], p[1], p[2]].map((v) => +Math.fround(v).toFixed(4)));
  // Outfits: several variants in use, each agent keeps its own.
  const used = new Set(drawer.instances.map((d) => d.uvTransform?.offset?.[0]));
  assert.ok(used.size >= 3, `variants in use: ${[...used]}`);
});

test('heading turns toward the walk at a bounded rate, and a stopped agent stands', () => {
  const crowd = new Crowd(square(10)),
    drawer = recorder(),
    agent = crowd.addAgent({ position: [5, 0, 5], radius: 0.3, maxSpeed: 1.4 });
  agent.setTarget([9, 0, 5]); // +X: heading pi / 2
  const walkers = walkCrowd(crowd, drawer, { walk: 0, stand: 1, stride: 1.4, turnRate: 2 });
  walkers.headings[0] = 0;
  const dt = 1 / 30;
  crowd.update(dt);
  walkers.update(dt);
  assert.ok(walkers.headings[0] <= 2 * dt + 1e-9, `one frame turns at most turnRate dt: ${walkers.headings[0]}`);
  for (let k = 0; k < 30; k++) {
    crowd.update(dt);
    walkers.update(dt);
  }
  assert.ok(Math.abs(walkers.headings[0] - Math.PI / 2) < 0.01, `faces the way it walks: ${walkers.headings[0]}`);
  assert.equal(drawer.instances[0].clip, 0, 'walking');
  for (let k = 0; k < 150; k++) {
    crowd.update(dt);
    walkers.update(dt);
  }
  assert.equal(agent.state, 'arrived');
  assert.equal(drawer.instances[0].clip, 1, 'standing plays the stand clip');
  assert.equal(drawer.instances[0].speed, 1);
});

test('walkCrowd refuses what it cannot drive', () => {
  const crowd = new Crowd(square(4));
  assert.throws(() => walkCrowd(null, recorder(), { stride: 1.4 }), TypeError);
  assert.throws(() => walkCrowd(crowd, {}, { stride: 1.4 }), TypeError);
  assert.throws(() => walkCrowd(crowd, recorder(), { stride: 0 }), RangeError);
  assert.throws(() => walkCrowd(crowd, recorder(), { stride: 1.4, walk: 5 }), RangeError);
});
