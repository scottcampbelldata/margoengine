// Face probes for soft bodies (`Physics.softFaceContacts`): a triangle of a cloth, thickened by its thickness, meets what lies
// over its inside, which the particle probe at its corners cannot (Bridson, Fedkiw and Anderson 2002; Mueller et al. 2007,
// the point and triangle constraint); a fast triangle is met at its first touch; and each contact says what the collider's
// surface is there (`curvature`: -1 a flat face, else its radius of curvature), so a solver holds a round body from the centre
// of its curvature and a face by its plane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

const world = (colliders, position = [0, 0, 0]) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { type: 'fixed', position, colliders });
  physics.step();
  return physics;
};
// A flat triangle 20 cm across at height y, still over the step.
const triangle = (y) => {
  const corners = [-0.1, y, -0.1, 0.1, y, -0.1, 0, y, 0.12];
  return { from: corners, to: corners };
};

test('a small ball over the inside of a triangle is met by the triangle, not by its corners', () => {
  // A 1 cm ball 1.5 cm over the middle of the triangle; the corners are 8 cm and more away, past their reach.
  const physics = world({ shape: 'sphere', radius: 0.01 }, [0, 0.015, 0]);
  const corners = triangle(0).from;
  const particles = physics.softContacts({ from: corners, to: corners, radius: 0.01 }, 1);
  for (let k = 0; k < 3; k++) assert.equal(particles.collider[k], 0xffffffff, 'no corner meets the ball');
  const faces = physics.softFaceContacts({ ...triangle(0), thickness: 0.01, margin: 0.01 }, 4);
  assert.notEqual(faces.collider[0], 0xffffffff, 'the triangle meets it');
  // The point on the ball's bottom, the normal out of the ball toward the triangle (down), and the gap still open of 5 mm past
  // the thickness: the ball's bottom is at 5 mm, the sheet's top at 10 mm.
  near(faces.point[1], 0.005, 1e-5, 'point');
  near(faces.normal[1], -1, 1e-5, 'normal');
  near(faces.depth[0], 0.005, 1e-5, 'depth');
  // The weights of the point of the triangle under the ball: (0, 0) of corners (-0.1, -0.1), (0.1, -0.1), (0, 0.12).
  const w = [faces.weights[0], faces.weights[1], faces.weights[2]];
  near(w[0] + w[1] + w[2], 1, 1e-6, 'weights add to 1');
  near(w[0] * -0.1 + w[1] * 0.1, 0, 1e-5, 'x of the point');
  near(w[0] * -0.1 + w[1] * -0.1 + w[2] * 0.12, 0, 1e-5, 'z of the point');
  // A ball is round: its radius, whose centre is the ball's.
  near(faces.curvature[0], 0.01, 1e-6, 'radius of curvature');
});

test('a fast triangle is met at its first touch, not passed', () => {
  // A triangle rising 0.5 m in the step through a 1 cm ball at 0.2 m: the touch is where the sheet's top reaches the ball's
  // bottom (0.19 m less the thickness).
  const physics = world({ shape: 'sphere', radius: 0.01 }, [0, 0.2, 0]);
  const from = triangle(0).from,
    to = triangle(0.5).from;
  const faces = physics.softFaceContacts({ from, to, thickness: 0.005, margin: 0 }, 1);
  assert.notEqual(faces.collider[0], 0xffffffff, 'the triangle meets the ball on its way through');
  near(faces.t[0], (0.19 - 0.005) / 0.5, 1e-3, 'fraction of the move at the touch');
  near(faces.normal[1], -1, 1e-4, 'from the side it came from');
});

test('a contact says what the surface is: a face, a corner, a round place', () => {
  const at = (colliders, point, radius = 0.01) => {
    const physics = world(colliders);
    const p = physics.softContacts({ from: point, to: point, radius, margin: 0.02 }, 1);
    assert.notEqual(p.collider[0], 0xffffffff, `${colliders.shape} is met`);
    return p.curvature[0];
  };
  // A box's face, edge and corner.
  const box = { shape: 'box', halfExtents: [0.5, 0.5, 0.5] };
  assert.equal(at(box, [0.1, 0.505, 0.2]), -1, 'over a face');
  assert.equal(at(box, [0.505, 0.505, 0.2]), 0, 'over an edge');
  assert.equal(at(box, [0.505, 0.505, 0.505]), 0, 'over a corner');
  // A ball, a capsule, a cylinder's side and its cap.
  near(at({ shape: 'sphere', radius: 0.3 }, [0, 0.305, 0]), 0.3, 1e-6, 'a ball');
  near(at({ shape: 'capsule', halfHeight: 0.5, radius: 0.2 }, [0.205, 0.1, 0]), 0.2, 1e-6, 'a capsule');
  near(at({ shape: 'cylinder', halfHeight: 0.5, radius: 0.3 }, [0.305, 0.1, 0]), 0.3, 1e-5, "a cylinder's side");
  assert.equal(at({ shape: 'cylinder', halfHeight: 0.5, radius: 0.3 }, [0.1, 0.505, 0]), -1, "a cylinder's cap");
  // A mesh's triangle is flat inside.
  const mesh = { shape: 'trimesh', vertices: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 2, 1, 0, 3, 2] };
  assert.equal(at(mesh, [1, 0.005, -2]), -1, "inside a mesh's triangle");
});

test('the face query checks what it is given', () => {
  const physics = world({ shape: 'sphere', radius: 0.01 });
  assert.throws(() => physics.softFaceContacts({ from: [0, 0, 0], to: [0, 0, 0], thickness: 0.01 }), /nine numbers/);
  assert.throws(() => physics.softFaceContacts({ ...triangle(0), thickness: -1 }), /thickness of 0 or more/);
  assert.throws(() => physics.softFaceContacts({ ...triangle(0), thickness: 0.01 }, 9), /1 to 4 contacts/);
});
