// Route corners in a crowd: an agent passes a corner once the point after it can be walked to straight, not only once
// it comes within a step of the corner. Avoidance and the walls (a hard constraint: the agent brakes before one) carry
// agents wide of corners, and an agent that missed one by a few centimetres used to turn round and walk back to touch
// it, circling the corner or turning on the spot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '../dist/index.js';

/** A corridor 1.2 m wide along X, then 45 degrees up a diagonal, then along X again. */
const diagonal = () =>
  new NavMesh(
    [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 1.2],
      [0, 0, 1.2],
      [8, 0, 4],
      [8, 0, 5.2],
      [12, 0, 4],
      [12, 0, 5.2],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [4, 6, 7, 5],
    ],
  );

/**
 * Runs at 60 Hz and measures each agent while it walks somewhere (state `moving`): `winding`, the signed change of its
 * direction of travel (radians; a full circle adds 2 pi); `spins`, the frames that end a 2 s stretch over which it
 * turned more than half a circle while getting less than 0.5 m anywhere (turning back on the spot); and when it
 * arrived. Every agent stays on the mesh.
 */
function measure(crowd, agents, seconds) {
  const dt = 1 / 60,
    m = agents.map(() => ({ winding: 0, spins: 0, heading: null, arrived: null, history: [] }));
  for (let frame = 0; frame < seconds * 60; frame++) {
    crowd.update(dt);
    agents.forEach((a, i) => {
      const s = m[i],
        vx = a.velocity[0],
        vz = a.velocity[2];
      assert.ok(a.surface.locate(a.position) >= 0, `agent ${i} left the mesh`);
      if (a.state === 'moving' && Math.hypot(vx, vz) > 0.05) {
        const heading = Math.atan2(vx, vz);
        if (s.heading !== null) {
          let d = heading - s.heading;
          d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          s.winding += d;
        }
        s.heading = heading;
      }
      s.history.push([a.position[0], a.position[2], s.winding]);
      if (s.history.length > 120) {
        const [x, z, w] = s.history.shift();
        if (Math.hypot(a.position[0] - x, a.position[2] - z) < 0.5 && Math.abs(s.winding - w) > Math.PI) s.spins++;
      }
      if (a.state === 'arrived' && s.arrived === null) s.arrived = frame * dt;
    });
  }
  return m;
}

test('agents following each other round two corners of a diagonal corridor never turn back to touch one', () => {
  const crowd = new Crowd(diagonal()),
    agents = [];
  for (let i = 0; i < 3; i++) {
    const agent = crowd.addAgent({ position: [0.4 + i * 0.8, 0, 0.6], radius: 0.25 });
    agent.setTarget([11.5 - i * 0.7, 0, 4.6]);
    agents.push(agent);
  }
  const m = measure(crowd, agents, 15);
  for (const [i, s] of m.entries()) {
    assert.ok(s.arrived !== null, `agent ${i} arrives`);
    assert.equal(s.spins, 0, `agent ${i} turned back to a corner it had missed`);
    // The corridor turns 45 degrees left and back right: no loop.
    assert.ok(Math.abs(s.winding) < Math.PI, `agent ${i} wound ${s.winding} rad`);
  }
});
