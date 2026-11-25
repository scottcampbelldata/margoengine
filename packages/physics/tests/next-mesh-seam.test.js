// The seam between two meshes that meet in one plane. A ball or a capsule that rolls across it meets the second mesh's open
// edge from the side before it is over it; the ghost rule cannot see across meshes, so the contact with that edge, its normal
// leaning back, kicked the shape up (a ball at 6 m/s at 1.3 m/s, a capsule at 0.76) where one mesh gives none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const quad = (x0, x1) => ({ vertices: [x0, 0, 0, x1, 0, 0, x1, 0, 8, x0, 0, 8], indices: [0, 2, 1, 0, 3, 2] });

/** The most a body goes up or down, and where it ends, crossing x = 8 at 6 m/s over one plate or two that meet there. */
function cross(collider, rotation, seam) {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const plates = seam ? [quad(0, 8), quad(8, 16)] : [quad(0, 16)];
  for (const plate of plates)
    physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', ...plate, fixInternalEdges: true } });
  const body = physics.addBody(null, {
    position: [3, 0.401, 4],
    linearVelocity: [6, 0, 0],
    rotation,
    canSleep: false,
    colliders: collider,
  });
  let lift = 0;
  for (let i = 0; i < 90; i++) {
    physics.step();
    if (i > 5) lift = Math.max(lift, Math.abs(body.linearVelocity[1]));
  }
  const out = { lift, x: body.position[0], speed: body.linearVelocity[0] };
  physics.dispose();
  return out;
}

for (const [name, collider, rotation] of [
  ['ball', { shape: 'sphere', radius: 0.4 }, [0, 0, 0, 1]],
  [
    'capsule lying across the roll',
    { shape: 'capsule', halfHeight: 0.3, radius: 0.4 },
    [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  ],
])
  test(`a ${name} crosses the seam of two meshes as it crosses one mesh`, () => {
    const one = cross(collider, rotation, false);
    const two = cross(collider, rotation, true);
    assert.ok(two.lift <= one.lift + 1e-4, `the seam kicked it at ${two.lift} m/s, one mesh ${one.lift}`);
    assert.ok(Math.abs(two.x - one.x) < 1e-3, `it ended at ${two.x}, one mesh ${one.x}`);
    assert.ok(Math.abs(two.speed - one.speed) < 1e-3, `it kept ${two.speed} m/s, one mesh ${one.speed}`);
  });
