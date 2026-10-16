import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvoidanceSolver, CapsuleVolume, SphereVolume } from '../dist/index.js';

// An ordinary structural collider must use the public evaluate contract. Pairing
// it with the same built-in volume audits the internal dispatch without adding
// a public testing API or importing implementation-only functions.
function fallback(volume) {
  return {
    evaluate(point, surface, normal) {
      return volume.evaluate(point, surface, normal);
    },
    segmentClearance(start, end, radius) {
      return volume.segmentClearance(start, end, radius);
    },
  };
}

function targetPair(volumes, points, options = {}) {
  const direct = new AvoidanceSolver(volumes, options);
  const publicOnly = new AvoidanceSolver(volumes.map(fallback), options);
  for (let i = 0; i < points.length; i++) {
    const dt = [1 / 240, 1 / 60, 0.05][i % 3];
    assert.deepEqual([...direct.resolveTarget(points[i], dt)], [...publicOnly.resolveTarget(points[i], dt)]);
    assert.deepEqual(direct.targetResult, publicOnly.targetResult);
  }
}

test('built-in target evaluation matches public fallback across mixed moving volumes', () => {
  const sphere = new SphereVolume({ center: [-0.2, 0.4, 0.1], radius: 0.3 });
  const capsule = new CapsuleVolume({ start: [0.1, -0.7, -0.1], end: [0.3, 0.8, 0.2], radius: 0.25 });
  const secondSphere = new SphereVolume({ center: [0.5, -0.2, 0.15], radius: 0.18 });
  const secondCapsule = new CapsuleVolume({ start: [-0.65, -0.5, -0.1], end: [-0.65, 0.35, -0.2], radius: 0.15 });
  const volumes = [sphere, capsule, secondSphere, secondCapsule];
  const direct = new AvoidanceSolver(volumes, { damping: 0.1, minClearance: 0.02, targetRadius: 0.04 });
  const publicOnly = new AvoidanceSolver(volumes.map(fallback), {
    damping: 0.1,
    minClearance: 0.02,
    targetRadius: 0.04,
  });
  for (let i = 0; i < 220; i++) {
    sphere.set([-0.2, 0.4 + Math.sin(i * 0.11) * 0.1, 0.1]);
    capsule.set([0.1, -0.7, -0.1], [0.3, 0.8, Math.cos(i * 0.07) * 0.2]);
    secondSphere.set([0.5 + Math.sin(i * 0.09) * 0.05, -0.2, 0.15]);
    secondCapsule.set([-0.65, -0.5, -0.1], [-0.65, 0.35 + Math.cos(i * 0.05) * 0.04, -0.2]);
    const target = [Math.cos(i * 0.1) * 0.8, Math.sin(i * 0.13) * 0.9, Math.sin(i * 0.17) * 0.2];
    const dt = [1 / 240, 1 / 120, 1 / 60, 0.04][i % 4];
    assert.deepEqual(
      [...direct.resolveTarget(target, dt)],
      [...publicOnly.resolveTarget(target, dt)],
      `target frame ${i}`,
    );
    assert.deepEqual(direct.targetResult, publicOnly.targetResult, `result frame ${i}`);
  }
});

test('built-in and public fallback agree at centers, zero-length axes, subnormals, and large finite coordinates', () => {
  const tiny = Number.MIN_VALUE;
  targetPair(
    [new SphereVolume({ center: [0, 0, 0], radius: 0.3 })],
    [
      [0, 0, 0],
      [tiny, tiny, 0],
      [0.4, 0, 0],
    ],
  );
  targetPair(
    [new CapsuleVolume({ start: [0, 0, 0], end: [0, 0, 0], radius: 0.3 })],
    [
      [0, 0, 0],
      [tiny, tiny, 0],
      [0.4, 0, 0],
    ],
  );
  targetPair(
    [new CapsuleVolume({ start: [0, 0, 0], end: [tiny, tiny, 0], radius: 0.3 })],
    [
      [tiny, 0, 0],
      [tiny, tiny, 0],
      [0.4, 0.2, 0],
    ],
  );
  targetPair(
    [new SphereVolume({ center: [0, 0, 0], radius: tiny })],
    [
      [tiny, tiny, 0],
      [0, 0, 0],
    ],
    { minClearance: 0 },
  );
  targetPair(
    [new CapsuleVolume({ start: [-tiny, 0, 0], end: [tiny, tiny, 0], radius: tiny })],
    [
      [0, tiny, 0],
      [tiny, 0, 0],
    ],
    { minClearance: 0 },
  );
  targetPair(
    [new SphereVolume({ center: [1e30, 2e30, -1e30], radius: 1e29 })],
    [
      [1e30, 2e30, -1e30],
      [1.2e30, 2e30, -1e30],
    ],
  );
  targetPair(
    [new CapsuleVolume({ start: [1e30, 1e30, 0], end: [1e30, 2e30, 0], radius: 1e29 })],
    [
      [1e30, 1.5e30, 0],
      [1.2e30, 1.5e30, 0],
    ],
  );
});

function evaluateElbow(root, target, angle, out) {
  const upper = 1.5,
    lower = 1.25;
  let ax = target[0] - root[0],
    ay = target[1] - root[1],
    az = target[2] - root[2];
  const distance = Math.hypot(ax, ay, az);
  ax /= distance;
  ay /= distance;
  az /= distance;
  let bx = -az * ax,
    by = -az * ay,
    bz = 1 - az * az;
  const length = Math.hypot(bx, by, bz);
  bx /= length;
  by /= length;
  bz /= length;
  const cx = ay * bz - az * by,
    cy = az * bx - ax * bz,
    cz = ax * by - ay * bx;
  const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along)),
    cosine = Math.cos(angle),
    sine = Math.sin(angle);
  out[0] = root[0] + ax * along + height * (bx * cosine + cx * sine);
  out[1] = root[1] + ay * along + height * (by * cosine + cy * sine);
  out[2] = root[2] + az * along + height * (bz * cosine + cz * sine);
}

test('complete IK solves remain identical through mixed built-in and public-only evaluation', () => {
  const volumes = [
    new SphereVolume({ center: [0, 0.4, 0], radius: 0.2 }),
    new CapsuleVolume({ start: [0.2, -0.6, 0], end: [0.2, 0.2, 0], radius: 0.12 }),
    new SphereVolume({ center: [0.8, -0.3, -0.15], radius: 0.1 }),
    new CapsuleVolume({ start: [-0.45, 0.2, -0.3], end: [-0.45, 0.7, -0.3], radius: 0.1 }),
  ];
  const direct = new AvoidanceSolver(volumes, { damping: 0.06, targetRadius: 0.04 });
  const publicOnly = new AvoidanceSolver(volumes.map(fallback), { damping: 0.06, targetRadius: 0.04 });
  const root = [-1, 0, 0],
    handA = new Float32Array([1, 0, 0]),
    handB = new Float32Array(handA);
  for (let i = 0; i < 160; i++) {
    const target = [0.6 + Math.cos(i * 0.09) * 0.6, Math.sin(i * 0.13) * 0.6, Math.sin(i * 0.11) * 0.3];
    const dt = [1 / 120, 1 / 60, 0.04][i % 3];
    const a = direct.solve(root, handA, target, 1.5, 1.25, 0.03, 0.05, dt, evaluateElbow);
    const b = publicOnly.solve(root, handB, target, 1.5, 1.25, 0.03, 0.05, dt, evaluateElbow);
    assert.deepEqual(a, b, `complete solve ${i}`);
    if (a.resolved) {
      handA.set(a.target);
      handB.set(b.target);
    }
  }
});

test('subclass evaluate overrides retain their geometry and observable calls', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    let calls = 0;
    const replacement = new SphereVolume({ center: [0, 0, 0], radius: 2 });
    class Custom extends Base {
      evaluate(point, surface, normal) {
        calls++;
        return replacement.evaluate(point, surface, normal);
      }
    }
    const volume =
      Base === SphereVolume
        ? new Custom({ center: [0, 0, 0], radius: 0.1 })
        : new Custom({ start: [0, 0, 0], end: [0, 1, 0], radius: 0.1 });
    const target = new AvoidanceSolver([volume]).resolveTarget([0.3, 0, 0], 1 / 60);
    assert.ok(calls > 0);
    assert.ok(Math.hypot(...target) >= 2.025 - 1e-6);
  }
});

test('instance evaluate replacements are honored even after solver construction', () => {
  for (const volume of [
    new SphereVolume({ center: [0, 0, 0], radius: 0.1 }),
    new CapsuleVolume({ start: [0, 0, 0], end: [0, 1, 0], radius: 0.1 }),
  ]) {
    const solver = new AvoidanceSolver([volume]);
    solver.resolveTarget([0.3, 0, 0], 1 / 60);
    const replacement = new SphereVolume({ center: [0, 0, 0], radius: 2 });
    let calls = 0;
    volume.evaluate = (point, surface, normal) => {
      calls++;
      return replacement.evaluate(point, surface, normal);
    };
    const target = solver.resolveTarget([0.3, 0, 0], 1 / 60);
    assert.ok(calls > 0);
    assert.ok(Math.hypot(...target) >= 2.025 - 1e-6);
  }
});

test('prototype evaluate replacements remain observable and restore cleanly', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    const original = Base.prototype.evaluate;
    let calls = 0;
    const volume =
      Base === SphereVolume
        ? new Base({ center: [0, 0, 0], radius: 0.3 })
        : new Base({ start: [0, 0, 0], end: [0, 1, 0], radius: 0.3 });
    const solver = new AvoidanceSolver([volume]);
    try {
      Base.prototype.evaluate = function (point, surface, normal) {
        calls++;
        return original.call(this, point, surface, normal);
      };
      const target = solver.resolveTarget([0.2, 0.4, 0], 1 / 60);
      assert.ok(calls > 0);
      assert.ok([...target].every(Number.isFinite));
    } finally {
      Base.prototype.evaluate = original;
    }
  }
});

test('structural custom colliders keep the public validation contract', () => {
  for (const invalid of [
    {
      evaluate(_p, surface, normal) {
        surface.set([0, 0, 0]);
        normal.set([1, 0, 0]);
        return NaN;
      },
    },
    {
      evaluate(_p, surface, normal) {
        surface.set([0, 0, 0]);
        normal.set([2, 0, 0]);
        return 1;
      },
    },
    {
      evaluate(_p, surface, normal) {
        surface.set([Infinity, 0, 0]);
        normal.set([1, 0, 0]);
        return 1;
      },
    },
  ]) {
    const solver = new AvoidanceSolver([
      {
        ...invalid,
        segmentClearance() {
          return 1;
        },
      },
    ]);
    assert.throws(() => solver.resolveTarget([1, 0, 0], 1 / 60));
  }
});

test('direct built-in dispatch still validates geometry mutated after construction', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 0.3 });
  const capsule = new CapsuleVolume({ start: [0, 0, 0], end: [0, 1, 0], radius: 0.3 });
  for (const volume of [sphere, capsule]) {
    const direct = new AvoidanceSolver([volume]),
      publicOnly = new AvoidanceSolver([fallback(volume)]);
    const radius = volume.radius;
    volume.radius = -1;
    assert.throws(() => direct.resolveTarget([1, 0, 0], 1 / 60));
    assert.throws(() => publicOnly.resolveTarget([1, 0, 0], 1 / 60));
    volume.radius = radius;
    const coordinate = volume instanceof SphereVolume ? volume.center : volume.end;
    const original = coordinate[0];
    coordinate[0] = Infinity;
    assert.throws(() => direct.resolveTarget([1, 0, 0], 1 / 60));
    assert.throws(() => publicOnly.resolveTarget([1, 0, 0], 1 / 60));
    coordinate[0] = original;
    assert.deepEqual([...direct.resolveTarget([1, 0, 0], 1 / 60)], [...publicOnly.resolveTarget([1, 0, 0], 1 / 60)]);
    assert.deepEqual(direct.targetResult, publicOnly.targetResult);
  }
});

test('public evaluation retains aliasing and atomic guard behavior after internal dispatch refactoring', () => {
  for (const volume of [
    new SphereVolume({ center: [0, 0, 0], radius: 0.3 }),
    new CapsuleVolume({ start: [0, -1, 0], end: [0, 1, 0], radius: 0.3 }),
  ]) {
    const expectedSurface = new Float64Array(3),
      expectedNormal = new Float64Array(3);
    const distance = volume.evaluate([1, 0.4, 0.2], expectedSurface, expectedNormal);
    const pointAndSurface = new Float64Array([1, 0.4, 0.2]),
      normal = new Float64Array(3);
    assert.equal(volume.evaluate(pointAndSurface, pointAndSurface, normal), distance);
    assert.deepEqual(pointAndSurface, expectedSurface);
    assert.deepEqual(normal, expectedNormal);
    const pointAndNormal = new Float64Array([1, 0.4, 0.2]),
      surface = new Float64Array(3);
    assert.equal(volume.evaluate(pointAndNormal, surface, pointAndNormal), distance);
    assert.deepEqual(surface, expectedSurface);
    assert.deepEqual(pointAndNormal, expectedNormal);
    const overlap = new Float64Array([7, 8, 9, 10]);
    assert.throws(() => volume.evaluate([1, 0, 0], overlap.subarray(0, 3), overlap.subarray(1, 4)));
    assert.deepEqual([...overlap], [7, 8, 9, 10]);
  }
  for (const volume of [
    new SphereVolume({ center: [1e80, 0, 0], radius: 1e80 }),
    new CapsuleVolume({ start: [1e80, 0, 0], end: [1e80, 1e80, 0], radius: 1e80 }),
  ]) {
    const surface = new Float32Array([7, 8, 9]),
      normal = new Float32Array([4, 5, 6]);
    assert.throws(() => volume.evaluate([3e80, 0, 0], surface, normal), /output precision/);
    assert.deepEqual([...surface], [7, 8, 9]);
    assert.deepEqual([...normal], [4, 5, 6]);
    const wideSurface = new Float64Array(3),
      wideNormal = new Float64Array(3);
    assert.ok(Number.isFinite(volume.evaluate([3e80, 0, 0], wideSurface, wideNormal)));
  }
});

test('public evaluation preserves its distance through a cross-primitive output-setter reentry', () => {
  const sphere = new SphereVolume({ center: [0.1, 0.2, 0.3], radius: 0.4 });
  const capsule = new CapsuleVolume({ start: [0, -1, 0], end: [0, 1, 0], radius: 0.2 });
  for (const [outer, nested] of [
    [sphere, capsule],
    [capsule, sphere],
  ]) {
    const point = [1.1, 0.6, 0.8],
      nestedPoint = [7, 3, -2];
    const expectedSurface = new Float64Array(3),
      expectedNormal = new Float64Array(3);
    const expectedDistance = outer.evaluate(point, expectedSurface, expectedNormal);
    const nestedSurface = new Float64Array(3),
      nestedNormal = new Float64Array(3);
    const expectedNestedDistance = nested.evaluate(nestedPoint, nestedSurface, nestedNormal);
    let z = 0,
      nestedDistance,
      setterCalls = 0;
    const normal = [0, 0, 0],
      surface = new Float64Array(3);
    Object.defineProperty(normal, '2', {
      configurable: true,
      get() {
        return z;
      },
      set(value) {
        z = value;
        setterCalls++;
        nestedDistance = nested.evaluate(nestedPoint, nestedSurface, nestedNormal);
      },
    });
    const actual = outer.evaluate(point, surface, normal);
    assert.equal(setterCalls, 1);
    assert.equal(nestedDistance, expectedNestedDistance);
    assert.notEqual(expectedDistance, expectedNestedDistance, 'nested evaluation must use a distinguishable distance');
    assert.equal(actual, expectedDistance, 'nested public evaluation must not overwrite the outer returned distance');
    assert.deepEqual(surface, expectedSurface);
    assert.deepEqual([...normal], [...expectedNormal]);
  }
});

test('borrowed public evaluate methods retain structurally valid receiver support', () => {
  for (const [Base, shape, point] of [
    [SphereVolume, { center: new Float64Array([1, 2, 3]), radius: 0.4 }, [2, 2.5, 3.2]],
    [
      CapsuleVolume,
      { start: new Float64Array([-1, 0, 0]), end: new Float64Array([1, 1, 0]), radius: 0.2 },
      [0.2, 0.3, 0.9],
    ],
  ]) {
    const expected = new Base(shape),
      expectedSurface = new Float64Array(3),
      expectedNormal = new Float64Array(3);
    const expectedDistance = expected.evaluate(point, expectedSurface, expectedNormal);
    const surface = new Float64Array(3),
      normal = new Float64Array(3);
    assert.equal(Base.prototype.evaluate.call(shape, point, surface, normal), expectedDistance);
    assert.deepEqual(surface, expectedSurface);
    assert.deepEqual(normal, expectedNormal);
  }
});
