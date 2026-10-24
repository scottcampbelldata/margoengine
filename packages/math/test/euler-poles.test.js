import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from '../dist/index.js';

const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];
const radians = Math.PI / 180;
const vertices = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => new Vector3(x, y, z))));

// Independent forward reference: multiply the documented axis matrices rather than
// reconstructing either expected angles or the quaternion-to-Euler implementation.
const referenceMatrix = (order, first, middle, last) => {
  const matrix = new Matrix4();
  for (const [index, angle] of [first, middle, last].entries()) {
    const rotation = new Matrix4();
    rotation[`makeRotation${order[index]}`](angle * radians);
    matrix.multiply(rotation);
  }
  return matrix;
};

const preservesVertices = (angles, expected, label, tolerance = 1e-11) => {
  const quaternion = new Quaternion().setFromEuler(angles);
  assert.ok(angles.toArray().every(Number.isFinite), `${label}: finite angles`);
  for (const vertex of vertices) {
    const want = vertex.clone().applyMatrix4(expected);
    const got = vertex.clone().applyQuaternion(quaternion);
    const error = want.distanceTo(got);
    assert.ok(error <= tolerance, `${label}: posed vertex error ${error} exceeds ${tolerance}`);
  }
};

for (const order of orders) {
  for (const route of ['quaternion', 'matrix3', 'matrix4']) {
    test(`Euler ${order} ${route} preserves mixed rotations on both sides of both poles`, () => {
      for (const pole of [-90, 90]) {
        for (const offset of [
          -1, -0.026, -0.025, -0.01, -0.001, -1e-7, -1e-10, 0, 1e-10, 1e-7, 0.001, 0.01, 0.025, 0.026, 1,
        ]) {
          for (const [first, last] of [
            [20, 35],
            [-123, 77],
            [179, -179],
            [0, 90],
          ]) {
            const matrix = referenceMatrix(order, first, pole + offset, last);
            const quaternion = new Quaternion().setFromRotationMatrix(matrix).normalize();
            const angles = new Euler(0, 0, 0, order);
            if (route === 'quaternion') angles.setFromQuaternion(quaternion);
            else angles.setFromRotationMatrix(route === 'matrix3' ? new Matrix3().setFromMatrix4(matrix) : matrix);
            assert.equal(angles.order, order);
            preservesVertices(angles, matrix, `${order} ${route} [${first}, ${pole + offset}, ${last}]`);
          }
        }
      }
    });
  }
}

test('Euler ZYX preserves the authored [35, 89.975, 20] degree unit cube pose', () => {
  const quaternion = new Quaternion().setFromEuler(new Euler(35 * radians, 89.975 * radians, 20 * radians, 'ZYX'));
  const angles = new Euler().setFromQuaternion(quaternion.clone().normalize(), 'ZYX');
  preservesVertices(angles, referenceMatrix('ZYX', 20, 89.975, 35), 'Margo Mesh authored pose');
});

test('Euler conversion keeps caller normalization, quaternion sign and default-order contracts', () => {
  for (const order of orders) {
    const expected = referenceMatrix(order, 20, 89.99, 35);
    const original = new Quaternion().setFromRotationMatrix(expected);
    const scaled = new Quaternion(...original.toArray().map((value) => value * 7));
    const normalized = scaled.clone().normalize();
    const snapshot = normalized.toArray();
    const receiver = new Euler(0, 0, 0, order);
    assert.equal(receiver.setFromQuaternion(normalized), receiver, 'conversion remains chainable');
    assert.deepEqual(normalized.toArray(), snapshot, 'unit quaternion input is not mutated');
    assert.equal(receiver.order, order, 'omitted order keeps the receiver order');
    preservesVertices(receiver, expected, `${order} explicitly normalized input`);
    preservesVertices(
      new Euler().setFromQuaternion(new Quaternion(...snapshot.map((value) => -value)), order),
      expected,
      `${order} negative quaternion represents the same orientation`,
    );
  }
});

test('Euler reads exact pole matrices without inventing a nonzero final angle', () => {
  for (const order of orders) {
    for (const pole of [-90, 90]) {
      const matrix = referenceMatrix(order, 0, pole, 0);
      // A literal signed-permutation rotation has an exactly zero middle-angle cosine.
      matrix.elements.forEach((value, index) => {
        if (Math.abs(value) < Number.EPSILON) matrix.elements[index] = 0;
      });
      const angles = new Euler().setFromRotationMatrix(matrix, order);
      assert.equal(Math.abs(angles[order[2].toLowerCase()]), 0);
      preservesVertices(angles, matrix, `${order} exact ${pole} degree matrix`);
    }
  }
});
