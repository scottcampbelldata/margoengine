import test from 'node:test';
import assert from 'node:assert/strict';
import { viewMatrix } from '../packages/shared/view.js';

// Keep the native-norm reference independent of the optimized norm arithmetic.
function reference(out, camera) {
  const p = camera.position,
    up = camera.up ?? [0, 1, 0];
  let x = p[0] - camera.target[0],
    y = p[1] - camera.target[1],
    z = p[2] - camera.target[2];
  const length = Math.hypot(x, y, z);
  x /= length;
  y /= length;
  z /= length;
  let xx = up[1] * z - up[2] * y,
    xy = up[2] * x - up[0] * z,
    xz = up[0] * y - up[1] * x;
  const side = Math.hypot(xx, xy, xz);
  if (!length || !side) throw new RangeError('Invalid camera view');
  xx /= side;
  xy /= side;
  xz /= side;
  const yx = y * xz - z * xy,
    yy = z * xx - x * xz,
    yz = x * xy - y * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = x;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = y;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = z;
  out[11] = 0;
  out[12] = -xx * p[0] - xy * p[1] - xz * p[2];
  out[13] = -yx * p[0] - yy * p[1] - yz * p[2];
  out[14] = -x * p[0] - y * p[1] - z * p[2];
  out[15] = 1;
  return out;
}

test('view matrices match native norms bit for bit across extreme and random camera frames', () => {
  const expected = new Float64Array(16),
    actual = new Float64Array(16);
  const check = (camera) => {
    expected.fill(17);
    actual.fill(17);
    let errorExpected, errorActual;
    try {
      reference(expected, camera);
    } catch (error) {
      errorExpected = [error.constructor.name, error.message];
    }
    try {
      assert.equal(viewMatrix(actual, camera), actual);
    } catch (error) {
      errorActual = [error.constructor.name, error.message];
    }
    assert.deepEqual(errorActual, errorExpected);
    assert.deepEqual(new Uint32Array(actual.buffer), new Uint32Array(expected.buffer));
  };
  const edges = [
    -0,
    0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    1e-300,
    -1e-300,
    1,
    -1,
    1e300,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    NaN,
    Infinity,
    -Infinity,
  ];
  for (const x of edges)
    for (const y of edges)
      for (const z of edges) {
        check({ position: [x, y, z], target: [0, 0, 0] });
        check({ position: [1, 2, 3], target: [0, 0, 0], up: [x, y, z] });
      }
  let state = 0xa1285c7;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < 25000; i++) {
    const scale = 2 ** (random() * 2000 - 1000);
    check({
      position: [random() * scale, -random() * scale, random() * scale],
      target: [-random() * scale, random() * scale, 0],
      up: i % 2 ? undefined : [random(), random(), random()],
    });
  }
});

test('view matrices preserve camera getter order, nested calls and output aliasing', () => {
  function observe(fn) {
    const events = [],
      nested = new Float64Array(16);
    const wrap = (name, values) =>
      new Proxy(values, {
        get(target, key) {
          events.push(name + '.' + key);
          return Reflect.get(target, key);
        },
      });
    const position = wrap('position', [1, 2, 3]),
      target = wrap('target', [-1, 0, 0.5]),
      up = wrap('up', [0.1, 1, 0.3]);
    const camera = new Proxy(
      {
        position,
        target,
        get up() {
          fn(nested, { position: [3, 2, 1], target: [0, 0, 0], up: [0, 1, 0] });
          return up;
        },
      },
      {
        get(target, key) {
          events.push('camera.' + key);
          return Reflect.get(target, key);
        },
      },
    );
    const output = new Float64Array(16);
    fn(output, camera);
    return { events, output, nested };
  }
  assert.deepEqual(observe(viewMatrix), observe(reference));
  for (const alias of ['position', 'target', 'up']) {
    const cameraA = { position: [1, 2, 3], target: [-1, 0, 0.5], up: [0.1, 1, 0.3] };
    const cameraB = structuredClone(cameraA);
    reference(cameraA[alias], cameraA);
    viewMatrix(cameraB[alias], cameraB);
    assert.deepEqual(cameraB, cameraA);
  }
});

test('invalid camera frames and conversion errors leave the output untouched', () => {
  for (const camera of [
    { position: [0, 0, 0], target: [0, 0, 0] },
    { position: [0, 1, 0], target: [0, 0, 0], up: [0, 1, 0] },
    { position: [NaN, 1, 2], target: [0, 0, 0] },
    { position: [Infinity, 1, 2], target: [0, 0, 0] },
    { position: [Symbol('position'), 1, 2], target: [0, 0, 0] },
    { position: [1n, 1, 2], target: [0n, 0, 0] },
  ]) {
    const output = new Float64Array(16).fill(17);
    assert.throws(() => viewMatrix(output, camera));
    assert.deepEqual([...output], Array(16).fill(17));
  }
});
