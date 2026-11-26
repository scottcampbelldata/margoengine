// Debug lines of soft bodies: edges, edges coloured by strain, particles and contacts with colliders.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

test('a rope draws an edge a segment, stress colours a stretched rope red and a slack one green, and contacts and particles add their own', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics);
  const rope = soft.create(SoftBodyDesc.rope([0, 1, 0], [2, 1, 0], 8));
  physics.step();
  const edges = soft.debugRender();
  assert.equal(edges.vertices.length / 6, 7, 'seven edges for eight particles');
  const rest = soft.debugRender({ stress: true });
  assert.ok(rest.colors[1] > rest.colors[0], 'at rest the colour is green');
  // Pull the far end out: every edge stretches a little, the colour moves to red.
  rope.setParticlePosition(7, [2.6, 1, 0]);
  const pulled = soft.debugRender({ stress: true, stressRange: 0.5 });
  const lastEdge = pulled.colors.slice((7 - 1) * 8, (7 - 1) * 8 + 4);
  assert.ok(lastEdge[0] > lastEdge[1], `the stretched end edge is red (${[...lastEdge]})`);
  assert.equal(
    soft.debugRender({ edges: false, particles: true }).vertices.length / 6,
    8 * 3,
    'a cross of three lines a particle',
  );
  assert.equal(soft.debugRender({ edges: false }).vertices.length, 0);
  assert.throws(() => soft.debugRender({ stressRange: 0 }), /positive fraction/);
  physics.dispose();
});

test('a rope lying on a floor shows a tick along the normal where a particle touches it', async () => {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  const soft = await SoftBodies.attach(physics);
  soft.create(SoftBodyDesc.rope([-1, 0.3, 0], [1, 0.3, 0], 8));
  for (let i = 0; i < 90; i++) physics.step();
  const lines = soft.debugRender({ edges: false, contacts: true });
  assert.ok(lines.vertices.length / 6 >= 1, 'at least one particle touches');
  const dy = lines.vertices[4] - lines.vertices[1];
  assert.ok(Math.abs(dy - 0.1) < 1e-4, `the tick is 0.1 m along the floor's normal, up (${dy})`);
  physics.dispose();
});
