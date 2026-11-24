// Live comparisons with Rapier 2D as an oracle for the same scenes. Rapier is not a dependency: it is a black box
// installed outside the repository (docs/benchmarking.md, "Comparing engines"), named by RAPIER2D_MODULE, the path of its
// `rapier.mjs` (@dimforge/rapier2d-compat 0.21). The tests run when it is named and are listed as not run otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Physics2D } from '../dist/index.js';

const path = process.env.RAPIER2D_MODULE;
const skip = path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module';
let R;
if (path) {
  R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
}
await Physics2D.load();

/** A seeded random stream, so both engines see the same scene. */
function stream(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('voxels: points and rays agree with Rapier 2D on a random grid', { skip }, () => {
  const next = stream(7);
  const cols = 12,
    rows = 9,
    size = 2;
  const solid = Array.from({ length: cols * rows }, () => (next() < 0.45 ? 1 : 0));
  // Rapier: grid coordinates of each filled voxel, voxel (i, j) spanning [i size, (i + 1) size) by [j size, (j + 1) size).
  const coords = [];
  solid.forEach((v, k) => v && coords.push(k % cols, Math.floor(k / cols)));
  const world = new R.World({ x: 0, y: 0 });
  world.createCollider(R.ColliderDesc.voxels(new Int32Array(coords), { x: size, y: size }));
  world.step();
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cellWidth: size, cellHeight: size, columns: cols, rows, solid } });
  let compared = 0;
  for (let i = 0; i < 400; i++) {
    const p = [next() * 30 - 3, next() * 24 - 3];
    let theirs = false;
    world.intersectionsWithPoint({ x: p[0], y: p[1] }, () => ((theirs = true), false));
    assert.equal(physics.overlapPoint(p).length > 0, theirs, `point ${p}`);
    compared++;
  }
  for (let i = 0; i < 400; i++) {
    const o = [next() * 40 - 8, next() * 34 - 8],
      a = next() * Math.PI * 2,
      d = [Math.cos(a), Math.sin(a)];
    const theirs = world.castRayAndGetNormal(new R.Ray({ x: o[0], y: o[1] }, { x: d[0], y: d[1] }), 60, true);
    const ours = physics.raycast(o, d, { maxDistance: 60 });
    assert.equal(!!ours, !!theirs, `ray from ${o} along ${d}`);
    if (ours && theirs) assert.ok(Math.abs(ours.distance - theirs.timeOfImpact) < 1e-3, `ray ${o} ${d}: ${ours.distance} against ${theirs.timeOfImpact}`);
    compared++;
  }
  assert.equal(compared, 800);
  world.free();
  physics.dispose();
});
