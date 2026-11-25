// Arrival in a crowd: an agent whose target others already cover (seats closer together than two people, a meeting
// point a whole group walks to) stops where it meets them instead of never arriving, so it stops cleanly instead of
// circling the target, pushing into the people already there or pressing against a wall beside it, and all end apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '../dist/index.js';

const floor = (w, d) =>
  new NavMesh(
    [
      [0, 0, 0],
      [w, 0, 0],
      [w, 0, d],
      [0, 0, d],
    ],
    [[0, 1, 2, 3]],
  );

/**
 * Runs at 60 Hz until every agent has arrived or `seconds` pass, and measures each agent while it walks somewhere
 * (state `moving`): `reversals` counts frames whose velocity points against the last frame's; `winding` sums the signed
 * change of its direction of travel (radians: a full circle adds 2 pi); `spins` counts the frames that end a 2 s
 * stretch over which it turned more than half a circle while getting less than 0.25 m anywhere (turning on the spot);
 * `walked` is the ground covered and `arrived` the time of arrival. Returns them with the time used.
 */
function measure(crowd, agents, seconds) {
  const dt = 1 / 60,
    window = 120,
    m = agents.map((a) => ({
      reversals: 0,
      winding: 0,
      spins: 0,
      walked: 0,
      arrived: null,
      heading: null,
      last: [a.position[0], a.position[2]],
      v: [0, 0],
      history: [],
    }));
  let frame = 0;
  for (; frame < seconds * 60 && agents.some((a) => a.state !== 'arrived'); frame++) {
    crowd.update(dt);
    agents.forEach((a, i) => {
      const s = m[i],
        vx = a.velocity[0],
        vz = a.velocity[2];
      if (a.state === 'moving' && Math.hypot(vx, vz) > 0.05) {
        const heading = Math.atan2(vx, vz);
        if (s.heading !== null) {
          let d = heading - s.heading;
          d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          s.winding += d;
        }
        s.heading = heading;
        if (Math.hypot(s.v[0], s.v[1]) > 0.05 && vx * s.v[0] + vz * s.v[1] < 0) s.reversals++;
      }
      s.history.push([a.position[0], a.position[2], s.winding]);
      if (s.history.length > window) {
        const [x, z, w] = s.history.shift();
        if (Math.hypot(a.position[0] - x, a.position[2] - z) < 0.25 && Math.abs(s.winding - w) > Math.PI) s.spins++;
      }
      s.walked += Math.hypot(a.position[0] - s.last[0], a.position[2] - s.last[1]);
      s.last = [a.position[0], a.position[2]];
      s.v = [vx, vz];
      if (a.state === 'arrived' && s.arrived === null) s.arrived = frame * dt;
    });
  }
  return { m, time: frame * dt };
}
/** The smallest gap between two agents' discs (negative: they overlap). */
function gap(agents) {
  let least = Infinity;
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i],
        b = agents[j];
      least = Math.min(least, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]) - a.radius - b.radius);
    }
  return least;
}
/** Settles a crowd whose agents have all arrived, so overlaps left by arrival get their steps to clear. */
const settle = (crowd, seconds = 1) => {
  for (let k = 0; k < seconds * 60; k++) crowd.update(1 / 60);
};

test('agents sent to packed seats all sit down, without circling, and end apart', () => {
  // Eight seats 0.5 m apart in a row; people 0.6 m across, so neighbouring seats overlap.
  const crowd = new Crowd(floor(10, 6)),
    agents = [];
  for (let i = 0; i < 8; i++) {
    const agent = crowd.addAgent({ position: [0.5 + (i % 4) * 0.9, 0, 0.5 + Math.floor(i / 4) * 0.9], radius: 0.3 });
    agent.setTarget([3 + i * 0.5, 0, 5]);
    agents.push(agent);
  }
  const { m } = measure(crowd, agents, 30);
  for (const [i, s] of m.entries()) {
    assert.equal(agents[i].state, 'arrived', `agent ${i} sits down`);
    assert.ok(s.reversals <= 2, `agent ${i}: ${s.reversals} velocity reversals`);
    assert.ok(Math.abs(s.winding) <= 2 * Math.PI, `agent ${i} wound ${s.winding} rad: it circled`);
    assert.equal(s.spins, 0, `agent ${i} turned on the spot`);
    assert.ok(s.walked <= 3 * Math.hypot(3 + i * 0.5 - agents[i].path[0][0], 5 - agents[i].path[0][2]) + 2, `agent ${i} walked ${s.walked} m`);
  }
  settle(crowd);
  assert.ok(gap(agents) >= -1e-3, `seated people overlap by ${-gap(agents)} m`);
  for (const a of agents) assert.equal(a.state, 'arrived');
});

test('nine agents from three groups sent to one point gather round it, arrive and do not overlap', () => {
  const crowd = new Crowd(floor(12, 12)),
    agents = [];
  for (const [x, z, dx, dz] of [
    [1, 2, 0, 0.7],
    [11, 2, 0, 0.7],
    [6, 11, 0.7, 0],
  ])
    for (let i = -1; i <= 1; i++) {
      const agent = crowd.addAgent({ position: [x + i * dx, 0, z + i * dz], radius: 0.3 });
      agent.setTarget([6, 0, 6]);
      agents.push(agent);
    }
  const { m, time } = measure(crowd, agents, 30);
  assert.ok(time < 15, `every agent arrived within ${time} s`);
  for (const [i, s] of m.entries()) {
    assert.equal(agents[i].state, 'arrived', `agent ${i} arrives`);
    assert.ok(Math.abs(s.winding) <= 2 * Math.PI, `agent ${i} wound ${s.winding} rad: it circled`);
    assert.equal(s.spins, 0, `agent ${i} turned on the spot`);
    assert.ok(Math.hypot(agents[i].position[0] - 6, agents[i].position[2] - 6) < 2, `agent ${i} gathered near the point`);
  }
  settle(crowd);
  assert.ok(gap(agents) >= -1e-3, `gathered agents overlap by ${-gap(agents)} m`);
});

test('an agent whose target beside a wall is taken stops beside it instead of pressing into the wall', () => {
  // A diagonal corridor; two agents walk to the same point 0.4 m from its lower wall.
  const nav = new NavMesh(
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
    ),
    crowd = new Crowd(nav),
    first = crowd.addAgent({ position: [0.4, 0, 0.6], radius: 0.25 }),
    second = crowd.addAgent({ position: [2, 0, 0.6], radius: 0.25 });
  first.setTarget([11.5, 0, 4.4]);
  second.setTarget([11.5, 0, 4.4]);
  const { m } = measure(crowd, [first, second], 20);
  for (const [i, s] of m.entries()) {
    assert.equal([first, second][i].state, 'arrived', `agent ${i} arrives`);
    assert.ok(s.reversals <= 1, `agent ${i}: ${s.reversals} velocity reversals`);
    assert.ok(Math.abs(s.winding) <= 2 * Math.PI, `agent ${i} wound ${s.winding} rad: it circled`);
    assert.equal(s.spins, 0, `agent ${i} turned on the spot`);
  }
  settle(crowd);
  assert.ok(gap([first, second]) >= -1e-3, 'they end apart');
});
