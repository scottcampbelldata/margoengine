import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avoid, Crowd, NavMesh } from '../dist/index.js';

const base = { position: [0, 0], velocity: [0, 0], preferred: [0, 0], radius: 0.5, maxSpeed: 20 };
const near = (got, expected) => assert.ok(Math.abs(got - expected) <= 1e-12, got + ' vs ' + expected);

test('ORCA distributes the relative velocity change by inverse inertia', () => {
  const a = { ...base, id: 1, mass: 20 };
  const b = { ...base, id: 2, mass: 80 };
  const va = avoid(a, [b], 0.1, 2);
  const vb = avoid(b, [a], 0.1, 2);
  near(va[0], -8);
  near(vb[0], 2);
  near(20 * va[0] + 80 * vb[0], 0);
  assert.equal(va[1], 0);
  assert.equal(vb[1], 0);
});

test('equal or unspecified masses preserve the equal split and obstacles leave full responsibility', () => {
  const a = { ...base, id: 1 };
  const b = { ...base, id: 2 };
  near(avoid(a, [b], 0.1, 2)[0], -5);
  near(avoid(a, [{ ...b, reciprocal: false, mass: 80 }], 0.1, 2)[0], -10);
  assert.throws(() => avoid({ ...a, mass: 0 }, [b], 0.1, 2), /mass/);
});

test('the actual navmesh crowd forwards walker inertia to its ORCA discs', () => {
  const nav = new NavMesh(
    [
      [-3, 0, -3],
      [3, 0, -3],
      [3, 0, 3],
      [-3, 0, 3],
    ],
    [[0, 1, 2, 3]],
  );
  const crowd = new Crowd(nav);
  const a = crowd.addAgent({ position: [-0.15, 0, 0], mass: 20, radius: 0.2 });
  const b = crowd.addAgent({ position: [0.15, 0, 0], mass: 80, radius: 0.2 });
  a.setTarget([2, 0, 0]);
  b.setTarget([-2, 0, 0]);
  crowd.update(0.1);
  assert.equal(a.mass, 20);
  assert.equal(b.mass, 80);
  assert.ok(Math.abs(a.velocity[0]) > Math.abs(b.velocity[0]), String(a.velocity) + ' / ' + String(b.velocity));
  crowd.dispose();
});
