// @margoengine/physics/breakable (BREAK-01, X-40 to X-43): convex Voronoi fracture into rigid bodies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry, box } from '@margoengine/core';
import { Physics, collisionGroups } from '../dist/index.js';
import {
  BreakableWorld,
  computePolyhedronMassProperties,
  createBoxPolyhedron,
  voronoiFractureBox,
  voronoiFractureGeometry,
} from '../dist/breakable.js';

await Physics.load();

function addFloor(physics) {
  return physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50], friction: 0.7 },
  });
}

test('exact polyhedral volume, centroid, inertia and Voronoi conservation', () => {
  const poly = createBoxPolyhedron(2, 3, 4);
  const props = computePolyhedronMassProperties(poly, 2.5);
  // Volume = 2 * 3 * 4 = 24, mass = 60, Ixx = 60*(9+16)/12 = 125, Iyy = 60*(4+16)/12 = 100, Izz = 60*(4+9)/12 = 65.
  assert.ok(Math.abs(props.volume - 24) < 1e-9, `expected volume 24, got ${props.volume}`);
  assert.ok(Math.abs(props.mass - 60) < 1e-9, `expected mass 60, got ${props.mass}`);
  assert.ok(Math.hypot(...props.centroid) < 1e-9);
  const sortedMoments = [...props.principalInertia].sort((a, b) => a - b);
  assert.ok(Math.abs(sortedMoments[0] - 65) < 1e-7);
  assert.ok(Math.abs(sortedMoments[1] - 100) < 1e-7);
  assert.ok(Math.abs(sortedMoments[2] - 125) < 1e-7);

  // Voronoi split must conserve total volume and total mass to tight floating-point accuracy.
  const frac = voronoiFractureBox([2, 3, 4], {
    cellCount: 18,
    seed: 42,
    density: 2.5,
  });
  assert.equal(frac.cells.length, 18);
  assert.ok(frac.adjacencies.length > 0);
  const sumVol = frac.cells.reduce((acc, c) => acc + c.volume, 0);
  const sumMass = frac.cells.reduce((acc, c) => acc + c.mass, 0);
  assert.ok(Math.abs(sumVol - 24) < 1e-6, `sumVol=${sumVol}`);
  assert.ok(Math.abs(sumMass - 60) < 1e-5, `sumMass=${sumMass}`);

  // Every cell must expose interior cut faces, UVs, and material groups.
  let hasInteriorGroup = false;
  for (const cell of frac.cells) {
    assert.ok(cell.geometry.indices.length > 0);
    assert.equal(cell.uvs.length, (cell.geometry.vertices.length / 6) * 2);
    if (cell.materialGroups.some((g) => g.materialIndex === 1 && g.count > 0)) hasInteriorGroup = true;
  }
  assert.ok(hasInteriorGroup, 'fractured cells should carry interior cut-face material groups');

  // Geometry-based Voronoi fracture works on core box() Geometry too.
  const geomFrac = voronoiFractureGeometry(box(1.5, 1.5, 1.5), {
    cellCount: 10,
    seed: 7,
  });
  const geomVol = geomFrac.cells.reduce((acc, c) => acc + c.volume, 0);
  assert.ok(Math.abs(geomVol - 3.375) < 1e-5, `geomVol=${geomVol}`);
});

test('intact stability: single rigid body has zero resting jitter and does not self-fracture', () => {
  const physics = new Physics(null);
  addFloor(physics);
  const breakable = new BreakableWorld(physics);

  // Dynamic crate resting on the floor + fixed anchored pillar.
  const crate = breakable.add(null, {
    size: [1, 1, 1],
    position: [0, 0.5, 0],
    cellCount: 10,
    bondStrength: 15,
    density: 1,
  });
  const pillar = breakable.add(null, {
    size: [1, 3, 1],
    position: [3, 1.5, 0],
    anchors: 'bottom',
    cellCount: 12,
    bondStrength: 15,
  });

  // Single intact body per breakable before fracture.
  assert.equal(crate.bodies.length, 1);
  assert.equal(pillar.bodies.length, 1);
  assert.equal(pillar.body.type, 'fixed');

  for (let i = 0; i < 120; i++) physics.step();

  assert.equal(crate.broken, false);
  assert.equal(pillar.broken, false);
  assert.equal(crate.totalDamage, 0, 'resting gravity weight must not accumulate damage');
  assert.equal(pillar.totalDamage, 0);
  assert.equal(crate.fragments.length, 0);
  assert.ok(Math.abs(crate.body.position[1] - 0.5) < 5e-3, `crate settled cleanly: y=${crate.body.position[1]}`);
  assert.deepEqual(pillar.body.position, [3, 1.5, 0]);

  breakable.dispose();
  physics.dispose();
});

test('cumulative light taps accumulate damage locally before fracturing on threshold (X-43)', () => {
  const physics = new Physics(null);
  const breakable = new BreakableWorld(physics);
  const events = [];
  breakable.onBreak((e) => events.push(e));

  // Two stacked vertical cells with one shared horizontal bond at y = 0 (strength = 20).
  const block = breakable.add(null, {
    size: [1, 2, 1],
    position: [0, 1, 0],
    anchors: 'bottom',
    sites: [
      [0, -0.5, 0],
      [0, 0.5, 0],
    ],
    bondStrength: 20,
    areaWeightedStrength: false,
  });

  assert.equal(block.cells.length, 2);
  assert.equal(block.bonds.length, 1);
  assert.equal(block.bonds[0].health, 1);

  // Light tap #1 at the bond seam (world y = 1): 8 N·s at distance 0 takes all 8 N·s off the bond (< 20). Holds.
  const frags1 = block.applyImpact([0, 1, 0], 8, 1.0);
  assert.equal(frags1.length, 0);
  assert.equal(block.broken, false);
  assert.equal(block.bonds[0].damage, 8);
  assert.ok(block.bonds[0].health < 1 && block.bonds[0].health > 0);
  assert.equal(events.length, 0);

  // Light tap #2: another 8 N·s -> 16 N·s in all (< 20). Still intact.
  const frags2 = block.applyImpact([0, 1, 0], 8, 1.0);
  assert.equal(frags2.length, 0);
  assert.equal(block.broken, false);

  // Tap #3: 5 N·s more makes 21 N·s, past 20: the bond breaks.
  const frags3 = block.applyImpact([0, 1, 0], 5, 1.0);
  assert.equal(frags3.length, 1, 'top unanchored half detaches');
  assert.equal(block.broken, true);
  assert.equal(block.bonds[0].broken, true);
  assert.equal(block.bonds[0].health, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].body, block);
  assert.equal(events[0].fragments.length, 1);

  breakable.dispose();
  physics.dispose();
});

test('anchored support stays standing while disconnected overhang detaches and falls (X-42)', () => {
  const physics = new Physics(null);
  addFloor(physics);
  const breakable = new BreakableWorld(physics);

  // Horizontal 3-segment cantilever beam elevated at y = 3:
  // left segment (x=-1) anchored to wall, middle (x=0) and right overhang (x=+1) cantilevered over open air.
  const beam = breakable.add(null, {
    size: [3, 1, 1],
    position: [0, 3, 0],
    anchors: (cell) => cell.boundsMin[0] <= -1.45,
    sites: [
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ],
    bondStrength: 10,
    areaWeightedStrength: false,
  });

  // Strike strictly at the seam between left anchor and middle (world x = -0.5) with tight radius (0.35 m),
  // leaving the bond between middle and right (world x = +0.5) intact!
  const detached = beam.applyImpact([-0.5, 3, 0], 25, 0.35);
  assert.equal(beam.broken, true);
  assert.equal(detached.length, 1, 'middle + right stay bonded as one falling overhang island');
  assert.equal(detached[0].cellIndices.length, 2, 'overhang carries both cantilevered cells');

  // Surviving anchored stub must remain fixed; overhang falls freely under gravity.
  const stub = beam.body;
  assert.ok(stub !== null);
  assert.equal(stub.type, 'fixed');
  const stubY0 = stub.position[1];
  const overhangY0 = detached[0].body.position[1];

  for (let i = 0; i < 45; i++) physics.step();

  assert.equal(stub.position[1], stubY0, 'anchored support stayed perfectly fixed');
  assert.ok(
    detached[0].body.position[1] < overhangY0 - 1.0,
    `disconnected overhang fell under gravity (y0=${overhangY0}, y=${detached[0].body.position[1]})`,
  );

  // Perimeter-anchored glass pane: hitting center shatters center while frame edges stay anchored.
  const glass = breakable.add(null, {
    size: [2, 2, 0.08],
    position: [6, 2, 0],
    anchors: 'perimeter',
    anchorTolerance: 0.08,
    pattern: 'radial',
    cellCount: 16,
    bondStrength: 6,
    seed: 7,
  });
  const shards = glass.applyImpact([6, 2, 0], 30, 0.7);
  assert.equal(glass.broken, true);
  assert.ok(shards.length >= 1, 'center glass shards detached');
  assert.ok(glass.body !== null && glass.body.type === 'fixed', 'perimeter-anchored glass rim stays fixed');

  breakable.dispose();
  physics.dispose();
});

test('runtime impact-clustered Voronoi mode defers splitting until threshold and clusters around hit', () => {
  const physics = new Physics(null);
  const breakable = new BreakableWorld(physics);

  const wall = breakable.add(null, {
    size: [4, 2, 0.4],
    position: [0, 1, 0],
    anchors: 'bottom',
    fractureMode: 'impact',
    cellCount: 14,
    bondStrength: 15,
    seed: 9,
  });

  // Undamaged impact-mode body has zero pre-generated cells.
  assert.equal(wall.cells.length, 0);
  assert.equal(wall.broken, false);

  // Light tap below threshold keeps it unsplit.
  assert.equal(wall.applyImpact([1.2, 1.5, 0.2], 6, 1.0).length, 0);
  assert.equal(wall.cells.length, 0);

  // Heavy hit on the right side triggers clustered Voronoi generation and local detachment.
  const frags = wall.applyImpact([1.2, 1.5, 0.2], 50, 1.0);
  assert.equal(wall.cells.length, 14);
  assert.ok(wall.broken);
  assert.ok(frags.length > 0);
  // Clustered sites should put multiple cells close to the local hit point (x = +1.2, y = +0.5).
  const nearHit = wall.cells.filter((c) => Math.hypot(c.site[0] - 1.2, c.site[1] - 0.5) < 0.9);
  assert.ok(nearHit.length >= 4, `expected cluster near impact, found ${nearHit.length} sites`);

  // Reset returns impact-mode body back to clean unfractured state.
  wall.reset();
  assert.equal(wall.broken, false);
  assert.equal(wall.cells.length, 0);
  assert.equal(wall.fragments.length, 0);

  breakable.dispose();
  physics.dispose();
});

test('detached fragments inherit exact linear and angular velocity (v + w × r)', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const breakable = new BreakableWorld(physics);

  const spinner = breakable.add(null, {
    size: [2, 1, 1],
    position: [0, 5, 0],
    anchors: 'none',
    sites: [
      [-0.5, 0, 0],
      [0.5, 0, 0],
    ],
    bondStrength: 5,
    areaWeightedStrength: false,
  });

  const parentV = [3, -2, 1];
  const parentW = [0, 0, 4]; // spinning around +Z
  spinner.body.setLinearVelocity(parentV);
  spinner.body.setAngularVelocity(parentW);

  // Break with scalar impact right at origin (zero-offset radial push along ±X only; check Y velocity from w × r).
  const frags = spinner.applyImpact([0, 5, 0], 10, 0.5);
  assert.equal(frags.length, 2);

  for (const frag of frags) {
    const pos = frag.body.position;
    const rx = pos[0] - 0; // +0.5 or -0.5
    const ry = pos[1] - 5; // ~0
    // Expected vy = parentV[1] + (w_z * rx - w_x * rz) = -2 + 4 * rx
    // Expected vz = parentV[2] + (w_x * ry - w_y * rx) = 1
    const expectedVy = parentV[1] + parentW[2] * rx;
    const expectedVz = parentV[2] - parentW[1] * rx + parentW[0] * ry;
    assert.ok(
      Math.abs(frag.body.linearVelocity[1] - expectedVy) < 1e-4,
      `expected vy=${expectedVy}, got ${frag.body.linearVelocity[1]}`,
    );
    assert.ok(
      Math.abs(frag.body.linearVelocity[2] - expectedVz) < 1e-4,
      `expected vz=${expectedVz}, got ${frag.body.linearVelocity[2]}`,
    );
    assert.ok(Math.abs(frag.body.angularVelocity[2] - parentW[2]) < 1e-4);
  }

  breakable.dispose();
  physics.dispose();
});

test('contactforce from projectile collision fractures breakable wall automatically', () => {
  const physics = new Physics(null);
  addFloor(physics);
  const breakable = new BreakableWorld(physics);
  let breakCalls = 0;
  breakable.onBreak(() => {
    breakCalls++;
  });

  const wall = breakable.add(null, {
    size: [2, 2, 0.4],
    position: [0, 1, 0],
    anchors: 'bottom',
    cellCount: 10,
    bondStrength: 8,
    minImpactImpulse: 1,
    seed: 5,
  });

  // Launch a fast heavy cannonball straight into the wall.
  const ball = physics.addBody(null, {
    position: [0, 1.3, 2.2],
    linearVelocity: [0, 0, -25],
    ccd: true,
    colliders: {
      shape: 'sphere',
      radius: 0.35,
      density: 15,
      contactForceEvents: true,
    },
  });
  assert.ok(ball.valid);

  for (let i = 0; i < 40 && !wall.broken; i++) physics.step();

  assert.equal(wall.broken, true, 'cannonball contactforce should fracture the wall');
  assert.ok(breakCalls >= 1);
  assert.ok(wall.fragments.length >= 1);

  breakable.dispose();
  physics.dispose();
});

test('applyExplosion fractures within blast radius and leaves distant objects untouched', () => {
  const physics = new Physics(null);
  const breakable = new BreakableWorld(physics);

  const nearBox = breakable.add(null, {
    size: [1, 1, 1],
    position: [1, 1, 0],
    cellCount: 8,
    bondStrength: 10,
    seed: 3,
  });
  const farBox = breakable.add(null, {
    size: [1, 1, 1],
    position: [20, 1, 0],
    cellCount: 8,
    bondStrength: 10,
    seed: 3,
  });

  const spawned = breakable.applyExplosion([0, 1, 0], 60, 4, { lift: 0.3 });
  assert.ok(spawned.length >= 2);
  assert.equal(nearBox.broken, true);
  assert.equal(farBox.broken, false);
  assert.equal(farBox.totalDamage, 0);

  // Step once so impulses integrate into outward velocity away from blast centre.
  physics.step();
  const avgVx = nearBox.fragments.reduce((sum, f) => sum + f.body.linearVelocity[0], 0) / nearBox.fragments.length;
  assert.ok(avgVx > 0.5, `fragments should blast outward (+X), avgVx=${avgVx}`);

  breakable.dispose();
  physics.dispose();
});

test('debris policy enforces maxDebris cap, debrisLifetime expiry, fast sleep, and collision groups', () => {
  const physics = new Physics(null);
  addFloor(physics);
  const debrisGroup = collisionGroups([2], [0]);
  const breakable = new BreakableWorld(physics, {
    maxDebris: 4,
    debrisLifetime: 0.5,
    debrisSleepThreshold: 0.5,
    debrisAngularSleepThreshold: 1.0,
    debrisSleepTime: 0.1,
    debrisCollisionGroups: debrisGroup,
  });

  const block = breakable.add(null, {
    size: [2, 2, 2],
    position: [0, 1, 0],
    cellCount: 12,
    bondStrength: 5,
    splitIslands: true,
    seed: 11,
  });

  block.applyExplosion([0, 1, 0], 80, 5);
  assert.ok(breakable.debrisCount <= 4, `maxDebris cap enforced: ${breakable.debrisCount}`);
  assert.equal(breakable.debrisCount, 4);

  // Verify debris collision groups applied.
  for (const frag of breakable.debris) {
    assert.equal(frag.body.colliders[0].collisionGroups(), debrisGroup);
  }

  // Step 40 frames (0.667 s > 0.5 s debrisLifetime): all debris should expire cleanly.
  for (let i = 0; i < 40; i++) physics.step();
  assert.equal(breakable.debrisCount, 0, 'debris expired after debrisLifetime');
  assert.equal(block.fragments.length, 0);

  breakable.dispose();
  physics.dispose();
});

test('deterministic seeded fracture yields identical cells, volumes and bonds across runs', () => {
  const a = voronoiFractureBox([1.5, 2.5, 1.0], {
    cellCount: 14,
    seed: 2026,
    pattern: 'uniform',
    density: 2,
  });
  const b = voronoiFractureBox([1.5, 2.5, 1.0], {
    cellCount: 14,
    seed: 2026,
    pattern: 'uniform',
    density: 2,
  });

  assert.equal(a.cells.length, b.cells.length);
  assert.equal(a.adjacencies.length, b.adjacencies.length);
  for (let i = 0; i < a.cells.length; i++) {
    assert.equal(a.cells[i].volume, b.cells[i].volume);
    assert.deepEqual(a.cells[i].centroid, b.cells[i].centroid);
    assert.deepEqual(a.cells[i].principalInertia, b.cells[i].principalInertia);
    assert.deepEqual(Array.from(a.cells[i].hullPoints), Array.from(b.cells[i].hullPoints));
  }
  for (let i = 0; i < a.adjacencies.length; i++) {
    assert.equal(a.adjacencies[i].cellA, b.adjacencies[i].cellA);
    assert.equal(a.adjacencies[i].cellB, b.adjacencies[i].cellB);
    assert.equal(a.adjacencies[i].area, b.adjacencies[i].area);
  }
});

test('debugRender outputs compatible line segments for cells, bond health, anchors, and debris', () => {
  const physics = new Physics(null);
  const breakable = new BreakableWorld(physics);

  const pillar = breakable.add(null, {
    size: [1, 2, 1],
    position: [0, 1, 0],
    anchors: 'bottom',
    sites: [
      [0, -0.5, 0],
      [0, 0.5, 0],
    ],
    bondStrength: 20,
    areaWeightedStrength: false,
  });

  // Full debug render: cells + bonds + anchors.
  const full = breakable.debugRender({
    cells: true,
    bonds: true,
    anchors: true,
    debris: true,
  });
  assert.ok(full.vertices instanceof Float32Array);
  assert.ok(full.colors instanceof Float32Array);
  assert.equal(full.vertices.length % 6, 0, 'two 3D vertices per segment');
  assert.equal(full.colors.length, (full.vertices.length / 3) * 4, 'RGBA per vertex');
  assert.ok(full.vertices.length > 0);

  // Bond-only view starts healthy green (G > R).
  const healthy = breakable.debugRender({
    cells: false,
    bonds: true,
    anchors: false,
    debris: false,
  });
  assert.equal(healthy.vertices.length, 6, 'single bond segment');
  assert.ok(healthy.colors[1] > healthy.colors[0], 'healthy bond is green (G > R)');

  // Partial damage (15 / 20 -> health 0.25) shifts bond toward red/orange (R > G).
  pillar.applyImpact([0, 1, 0], 13, 1.0);
  const damaged = breakable.debugRender({
    cells: false,
    bonds: true,
    anchors: false,
    debris: false,
  });
  assert.equal(damaged.vertices.length, 6);
  assert.ok(
    damaged.colors[0] > damaged.colors[1],
    `damaged bond shifts red (R=${damaged.colors[0]}, G=${damaged.colors[1]})`,
  );

  // Anchor-only view emits octahedron + stem segments (13 segments * 6 floats = 78).
  const anchorOnly = breakable.debugRender({
    cells: false,
    bonds: false,
    anchors: true,
    debris: false,
  });
  assert.equal(anchorOnly.vertices.length, 78);

  // Break the pillar and verify debris overlay emits segments.
  pillar.applyImpact([0, 1, 0], 20, 1.0);
  const debrisOnly = breakable.debugRender({
    cells: false,
    bonds: false,
    anchors: false,
    debris: true,
  });
  assert.ok(debrisOnly.vertices.length > 0, 'detached fragment emits debris wireframe');

  breakable.dispose();
  physics.dispose();
});

test('reset, disposal, Symbol.dispose, and coded error help links', () => {
  const physics = new Physics(null);
  const breakable = new BreakableWorld(physics);

  // Invalid inputs throw coded/range errors with help link.
  const coded = (pattern) => (err) =>
    err.name === 'MargoError' &&
    err.code === 'unsupported' &&
    pattern.test(err.message) &&
    err.message.endsWith('see https://margoengine.com/errors#physics-breakable');
  assert.throws(() => breakable.add(null, { cellCount: 1 }), coded(/cellCount must be an integer from 2 to 256/));
  assert.throws(() => breakable.add(null, { bondStrength: -5 }), coded(/bondStrength must be a positive finite/));
  assert.throws(() => breakable.add(null, { position: [0, NaN, 0] }), coded(/three finite numbers/));
  assert.throws(
    () =>
      breakable.add(null, {
        geometry: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0] },
      }),
    coded(/no volume to break/),
  );
  assert.throws(() => breakable.add(null, { geometry: { vertices: [0, 0, 0, 1] } }), coded(/whole vertices/));

  const boxBody = breakable.add(null, {
    size: [1, 1, 1],
    position: [0, 2, 0],
    cellCount: 6,
    bondStrength: 10,
  });
  boxBody.applyExplosion([0, 2, 0], 40, 3);
  assert.equal(boxBody.broken, true);
  assert.ok(breakable.debrisCount > 0);

  // Reset restores clean intact state.
  breakable.reset();
  assert.equal(boxBody.broken, false);
  assert.equal(breakable.debrisCount, 0);
  assert.equal(boxBody.bodies.length, 1);

  // Symbol.dispose cleanly disposes and blocks further use with MargoError(disposed).
  breakable[Symbol.dispose]();
  assert.equal(breakable.disposed, true);
  assert.throws(
    () => breakable.debugRender(),
    (err) => err.name === 'MargoError' && err.code === 'disposed' && err.message.includes('errors#physics-breakable'),
  );

  // Idempotent second dispose does not throw.
  breakable.dispose();
  physics.dispose();
});

// A regular octahedron with its corners at +-a on the axes: volume 4/3 a^3.
function octahedron(a) {
  return {
    vertices: [a, 0, 0, -a, 0, 0, 0, a, 0, 0, -a, 0, 0, 0, a, 0, 0, -a],
  };
}

test('a carried load never wears a bond down: a 2.4 t stone crate holds a 20 t block for 10 s', () => {
  // The crate's bonds take 10,000 N s (a drop of about 4 m/s) and impacts count from 2,000 N s (the default fifth).
  // The block's weight passes m g dt = 3,270 N s through the crate every step. Counted every step, as before the
  // rise-over-last-step filter, that broke the crate at rest within four steps; now only the step the block lands in
  // counts, once, and the damage stays where it is.
  const physics = new Physics(null);
  addFloor(physics);
  const breakable = new BreakableWorld(physics);
  const crate = breakable.add(null, {
    size: [1, 1, 1],
    position: [0, 0.5, 0],
    density: 2400,
    bondStrength: 10000,
    // Wide enough that a push on the top or bottom face reaches every bond inside.
    impactRadius: 2,
    cellCount: 8,
  });
  physics.addBody(null, {
    position: [0, 1.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 20000 },
  });
  for (let i = 0; i < 60; i++) physics.step();
  const settled = crate.totalDamage;
  for (let i = 0; i < 540; i++) physics.step();
  assert.equal(crate.broken, false, 'the crate carries the block');
  assert.equal(crate.totalDamage, settled, 'a steady load takes nothing more off a bond');
  breakable.dispose();
  physics.dispose();
});

test('a ball of momentum m v breaks a bond weaker than m v and leaves one stronger than m v whole', () => {
  // Restitution 0 against a fixed block: the contact takes the ball's momentum m v in the step it lands.
  const run = (strength) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const breakable = new BreakableWorld(physics);
    const block = breakable.add(null, {
      size: [2, 1, 1],
      type: 'fixed',
      sites: [
        [-0.5, 0, 0],
        [0.5, 0, 0],
      ],
      anchors: (cell) => cell.centroid[0] < 0,
      bondStrength: strength,
      areaWeightedStrength: false,
      minImpactImpulse: 1,
      impactRadius: 1000,
      restitution: 0,
    });
    const ball = physics.addBody(null, {
      position: [0, 0, 1.6],
      linearVelocity: [0, 0, -4],
      colliders: {
        shape: 'sphere',
        radius: 0.25,
        density: 1000,
        restitution: 0,
      },
    });
    const momentum = ball.mass * 4;
    for (let i = 0; i < 30; i++) physics.step();
    const out = { broken: block.broken, momentum };
    breakable.dispose();
    physics.dispose();
    return out;
  };
  const { momentum, broken } = run(1e9);
  assert.equal(broken, false);
  // The bond's face is 0 m from the hit point's x and the radius is 1000 m, so it takes all but 1/2000 of the impulse.
  assert.equal(run(momentum * 0.9).broken, true, `a bond of 0.9 m v = ${momentum * 0.9} N s breaks`);
  assert.equal(run(momentum * 1.1).broken, false, `a bond of 1.1 m v = ${momentum * 1.1} N s holds`);
});

test('any convex mesh breaks into convex rigid pieces whose masses add up to the whole (octahedron, core Geometry)', () => {
  const a = 0.8;
  const density = 2500;
  const exact = (4 / 3) * a ** 3 * density;
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const breakable = new BreakableWorld(physics, { debrisLifetime: Infinity });
  const raw = breakable.add(null, {
    geometry: octahedron(a),
    density,
    cellCount: 16,
    seed: 4,
    bondStrength: 1,
  });
  assert.ok(Math.abs(raw.body.mass - exact) / exact < 1e-6, `the intact body weighs ${raw.body.mass}, not ${exact}`);
  const cells = raw.cells.reduce((sum, c) => sum + c.mass, 0);
  // Mesh positions are float32, so the hull is the octahedron to about 1e-7; slivers outside it drop a little more.
  assert.ok(cells <= exact * (1 + 1e-6) && cells > exact * 0.99, `the cells weigh ${cells} kg of ${exact} kg`);
  const pieces = raw.applyExplosion([0, 0, 0], 100, 5);
  assert.ok(pieces.length >= 2);
  let sum = 0;
  for (const piece of pieces) {
    assert.ok(Math.abs(piece.body.mass - piece.mass) / piece.mass < 1e-6, 'each piece is a rigid body of its own mass');
    assert.equal(piece.body.type, 'dynamic');
    sum += piece.body.mass;
  }
  assert.ok(Math.abs(sum - cells) / cells < 1e-6, `the pieces weigh ${sum} kg, the cells ${cells} kg`);

  // A core Geometry (what a glTF loader gives) interleaves position and normal: the same octahedron, read at stride 6.
  const v = octahedron(a).vertices;
  const faces = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const fromMesh = breakable.add(null, {
    geometry: new Geometry(v, v, faces),
    density,
    cellCount: 16,
    seed: 4,
    position: [5, 0, 0],
  });
  assert.ok(Math.abs(fromMesh.body.mass - exact) / exact < 1e-6);
  assert.deepEqual(
    fromMesh.cells.map((c) => c.volume),
    raw.cells.map((c) => c.volume),
  );
  breakable.dispose();
  physics.dispose();
});

test('every kept cell is a hull the kernel builds, over seeds, patterns, shapes and impact points', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  let built = 0;
  const build = (frac) => {
    for (const cell of frac.cells) {
      physics.addBody(null, {
        type: 'fixed',
        colliders: { shape: 'convexHull', points: cell.hullPoints },
      });
      built++;
    }
  };
  for (const pattern of ['uniform', 'brick', 'radial']) {
    for (let seed = 1; seed <= 12; seed++) {
      for (const size of [
        [1, 3, 0.2],
        [2, 0.05, 2],
        [0.4, 0.4, 0.4],
      ]) {
        const frac = voronoiFractureBox(size, { cellCount: 24, seed, pattern });
        const volume = frac.cells.reduce((sum, c) => sum + c.volume, 0);
        const exact = size[0] * size[1] * size[2];
        // Sites inside a box hold a ball each, so no cell is a sliver and nothing is dropped.
        assert.ok(Math.abs(volume - exact) / exact < 1e-9, `${pattern} seed ${seed} ${size}: ${volume} of ${exact}`);
        build(frac);
      }
      // Sites from the bounds of an octahedron fall outside it too: their slivers are dropped, the rest build.
      build(
        voronoiFractureGeometry(octahedron(1), {
          cellCount: 24,
          seed,
          pattern,
        }),
      );
    }
  }
  assert.ok(built > 2000, `${built} hulls built`);
  physics.dispose();
});

test('the same inputs give the same state hash, and a snapshot and restore step on to the same bits', () => {
  const scene = () => {
    const physics = new Physics(null);
    addFloor(physics);
    const breakable = new BreakableWorld(physics);
    const wall = breakable.add(null, {
      size: [2, 2, 0.3],
      position: [0, 1, 0],
      anchors: 'bottom',
      fractureMode: 'impact',
      cellCount: 12,
      bondStrength: 40,
      minImpactImpulse: 2,
      seed: 8,
    });
    physics.addBody(null, {
      position: [0.3, 1.4, 2],
      linearVelocity: [0, 0, -20],
      ccd: true,
      colliders: { shape: 'sphere', radius: 0.3, density: 400 },
    });
    return { physics, breakable, wall };
  };
  const hash = (s) => [s.physics.kernel.hash, ...s.breakable.takeSnapshot().words].join(',');
  const run = () => {
    const s = scene();
    const hashes = [];
    for (let i = 0; i < 90; i++) {
      s.physics.step();
      hashes.push(hash(s));
    }
    return { s, hashes };
  };
  const first = run();
  const second = run();
  assert.equal(first.s.wall.broken, true, 'the ball broke the wall');
  assert.deepEqual(second.hashes, first.hashes, 'two runs of the same scene agree at every step');

  // After the break the pieces stay as they are: snapshot both, step, restore, step again.
  const { physics, breakable } = first.s;
  const world = physics.takeSnapshot();
  const state = breakable.takeSnapshot();
  const after = [];
  for (let i = 0; i < 60; i++) {
    physics.step();
    after.push(hash(first.s));
  }
  physics.restoreSnapshot(world);
  breakable.restoreSnapshot(state);
  for (let i = 0; i < 60; i++) {
    physics.step();
    assert.equal(hash(first.s), after[i], `step ${i} after the restore`);
  }
  assert.throws(() => breakable.restoreSnapshot({ islands: [], words: new Float64Array(0) }), {
    name: 'MargoError',
    code: 'state',
  });
  for (const s of [first.s, second.s]) {
    s.breakable.dispose();
    s.physics.dispose();
  }
});

test('a snapshot before a runtime split puts the bond graph back, and one after makes the same split again', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const breakable = new BreakableWorld(physics);
  const wall = breakable.add(null, {
    size: [4, 2, 0.4],
    anchors: 'all-boundary',
    fractureMode: 'impact',
    cellCount: 10,
    bondStrength: 1e6,
    seed: 3,
  });
  const before = breakable.takeSnapshot();
  wall.prefracture([1, 0.5, 0.2]);
  wall.applyImpact([1, 0.5, 0.2], 50, 1);
  const split = breakable.takeSnapshot();
  const volumes = wall.cells.map((c) => c.volume);
  assert.ok(volumes.length > 0 && wall.totalDamage > 0);
  breakable.restoreSnapshot(before);
  assert.equal(wall.cells.length, 0, 'the runtime split is undone');
  assert.equal(wall.totalDamage, 0);
  breakable.restoreSnapshot(split);
  assert.deepEqual(
    wall.cells.map((c) => c.volume),
    volumes,
  );
  assert.deepEqual(Array.from(breakable.takeSnapshot().words), Array.from(split.words));
  breakable.dispose();
  physics.dispose();
});
