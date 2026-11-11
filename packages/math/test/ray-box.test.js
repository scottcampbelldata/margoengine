// Ray box slabs keep inclusive corner and point hits: the three slab entry times can round one step apart.
import { OBB, Ray, Box3, Vector3 } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';

test('a ray aimed at a point box or point OBB from any whole-number offset 1 to 8 on each axis hits it', () => {
  const missed = [],
    missedObb = [],
    box = new Box3(new Vector3(0, 0, 0), new Vector3(0, 0, 0)),
    point = new OBB(new Vector3(0, 0, 0), new Vector3(0, 0, 0)),
    hit = new Vector3();
  for (let x = 1; x <= 8; x++)
    for (let y = 1; y <= 8; y++)
      for (let z = 1; z <= 8; z++) {
        const ray = new Ray(new Vector3(-x, -y, -z), new Vector3(x, y, z).normalize());
        if (!ray.intersectsBox(box) || !ray.intersectBox(box, hit)) missed.push([x, y, z]);
        else assert.ok(hit.length() < 1e-12, `[${x}, ${y}, ${z}] lands on the point, ${hit.length()} away`);
        if (!point.intersectsRay(ray)) missedObb.push([x, y, z]);
      }
  assert.deepEqual(missed, [], 'Ray.intersectsBox');
  assert.deepEqual(missedObb, [], 'OBB.intersectsRay');
});

test('the slab allowance keeps clear misses and far hits as they were', () => {
  for (const anchor of [0, 1e12]) {
    const at = new Vector3(anchor, anchor, anchor),
      box = new Box3(at.clone(), at.clone()),
      p = new Vector3(1, 3, 7),
      origin = at.clone().sub(p),
      toward = p.clone().normalize();
    assert.equal(new Ray(origin, toward).intersectsBox(box), true, `${anchor}: toward`);
    assert.equal(new Ray(origin, toward.clone().negate()).intersectsBox(box), false, `${anchor}: behind`);
    assert.equal(new Ray(origin, new Vector3(1, 0, 0)).intersectsBox(box), false, `${anchor}: sideways`);
    // Aimed a hair to the side: one part in a million of the distance is far beyond rounding.
    const side = new Vector3(1, 3, 7 + 7e-6).normalize();
    assert.equal(new Ray(origin, side).intersectsBox(box), false, `${anchor}: just past`);
  }
  // An ordinary hit keeps its exact distance: the allowance only decides hit or miss.
  const box = new Box3(new Vector3(1, -1, -1), new Vector3(3, 1, 1)),
    out = new Vector3();
  assert.ok(new Ray(new Vector3(-2, 0, 0), new Vector3(1, 0, 0)).intersectBox(box, out));
  assert.deepEqual([out.x, out.y, out.z], [1, 0, 0]);
});
