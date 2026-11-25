// The navmesh border is a hard ORCA constraint for crowd agents (van den Berg, Guy, Lin and Manocha 2011, section 5.4):
// an agent never drives into a wall and is stopped there by the mesh. Before this, walls were handled only after the
// fact: the move was cut back to one axis or to standing still, so an agent at a wall that is not along X or Z stopped
// dead, accelerated into the wall again the next frame and jittered against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '../dist/index.js';

/** A columns x rows grid of 1 m square polygons at y 0, without the cells `skip` names. */
function grid(columns, rows, skip = () => false) {
  const vertices = [],
    polygons = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= columns; c++) vertices.push([c, 0, r]);
  const v = (c, r) => r * (columns + 1) + c;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++)
      if (!skip(c, r)) polygons.push([v(c, r), v(c + 1, r), v(c + 1, r + 1), v(c, r + 1)]);
  return new NavMesh(vertices, polygons);
}
/** A corridor 1.2 m wide along X, then 45 degrees up a diagonal (0.85 m wide across), then along X again. */
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
 * Runs the crowd at 60 Hz and measures each agent: `hits` counts the frames whose change of velocity is more than the
 * agent's maxAcceleration allows, which only the mesh border can cause (a wall stopped the move); `reversals` counts
 * the frames whose velocity points against the last frame's (jitter); `walked` is the ground covered; `arrived` the
 * time of arrival. Every agent must stay on the mesh.
 */
function measure(crowd, agents, seconds) {
  const dt = 1 / 60,
    m = agents.map((a) => ({
      hits: 0,
      reversals: 0,
      walked: 0,
      arrived: null,
      last: [a.position[0], a.position[2]],
      v: [a.velocity[0], a.velocity[2]],
    }));
  for (let frame = 0; frame < seconds * 60; frame++) {
    crowd.update(dt);
    agents.forEach((a, i) => {
      const s = m[i],
        vx = a.velocity[0],
        vz = a.velocity[2];
      assert.ok(a.surface.locate(a.position) >= 0, `agent ${i} left the mesh at ${a.position}`);
      if (a.state !== 'arrived' && Math.hypot(vx - s.v[0], vz - s.v[1]) > a.maxAcceleration * dt * (1 + 1e-9)) s.hits++;
      if (Math.hypot(vx, vz) > 0.05 && Math.hypot(s.v[0], s.v[1]) > 0.05 && vx * s.v[0] + vz * s.v[1] < 0)
        s.reversals++;
      s.walked += Math.hypot(a.position[0] - s.last[0], a.position[2] - s.last[1]);
      s.last = [a.position[0], a.position[2]];
      s.v = [vx, vz];
      if (a.state === 'arrived' && s.arrived === null) s.arrived = frame * dt;
    });
  }
  return m;
}
const length = (path) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - path[i][0], p[2] - path[i][2]), 0);

test('an agent turning through a tight bend at full speed is never stopped by a wall', () => {
  // A Z bend: row 0 up to x 5, column 4 from z 0 to 3, row 2 from x 4. Corners 1.4 m apart; at 3.5 m/s and 8 m/s^2 the
  // agent cannot make either turn on the spot and used to run into the outer wall at both.
  const nav = grid(9, 3, (c, r) => !((r === 0 && c <= 4) || c === 4 || (r === 2 && c >= 4))),
    crowd = new Crowd(nav),
    agent = crowd.addAgent({ position: [0.5, 0, 0.5], radius: 0.3 });
  agent.setTarget([8.5, 0, 2.5]);
  crowd.update(1 / 60);
  const route = length(agent.path),
    [m] = measure(crowd, [agent], 10);
  assert.equal(m.hits, 0, 'no frame where a wall stopped the agent');
  assert.equal(m.reversals, 0, 'no jitter');
  assert.equal(agent.state, 'arrived');
  assert.ok(m.walked <= route * 1.15, `walked ${m.walked} m against a ${route} m route`);
  assert.ok(m.arrived <= route / agent.maxSpeed + 2, `arrived after ${m.arrived} s`);
});

test('agents passing head-on in a diagonal corridor slide along its walls without jitter', () => {
  const crowd = new Crowd(diagonal()),
    a = crowd.addAgent({ position: [0.5, 0, 0.6], radius: 0.25, maxSpeed: 1.4 }),
    b = crowd.addAgent({ position: [11.5, 0, 4.6], radius: 0.25, maxSpeed: 1.4 });
  a.setTarget([11.5, 0, 4.6]);
  b.setTarget([0.5, 0, 0.6]);
  crowd.update(1 / 60);
  const route = length(a.path),
    m = measure(crowd, [a, b], 20);
  for (const [i, s] of m.entries()) {
    assert.equal(s.hits, 0, `agent ${i}: no frame where a wall stopped it`);
    assert.equal(s.reversals, 0, `agent ${i}: no jitter`);
    assert.ok(s.arrived !== null, `agent ${i} arrives`);
    assert.ok(s.walked <= route * 1.15, `agent ${i} walked ${s.walked} m against a ${route} m route`);
  }
});

test('an agent pressed toward a diagonal wall by a group slides along it instead of stopping', () => {
  // Four agents walk the diagonal corridor together at 3.5 m/s; avoidance pushes them toward its walls.
  const crowd = new Crowd(diagonal()),
    agents = [];
  for (let i = 0; i < 4; i++) {
    const agent = crowd.addAgent({ position: [0.4 + i * 0.8, 0, 0.6], radius: 0.25 });
    agent.setTarget([11.5 - i * 0.6, 0, 4.6]);
    agents.push(agent);
  }
  const m = measure(crowd, agents, 20);
  for (const [i, s] of m.entries()) {
    assert.equal(s.hits, 0, `agent ${i}: no frame where a wall stopped it`);
    assert.ok(s.reversals <= 1, `agent ${i}: ${s.reversals} velocity reversals`);
    assert.ok(s.arrived !== null, `agent ${i} arrives`);
  }
});

test('an agent aimed at a border corner passes it and ends on the mesh, from several approach angles (KB-CROWD-WALLEND1)', () => {
  // A 2 m pillar in a 10 m yard; its corner (5, 3) is a convex border vertex. The route runs along the line of the
  // pillar's bottom wall (z 3) and bends at the corner, so the agent heads straight at the end of the wall at 8 m/s.
  // The end of a wall gives no ORCA half-plane, but the wall it stood level with held the agent to a slower and slower
  // approach (the closing speed allowed falls with its distance), and a step that grazed the corner was cut to one axis:
  // the agent crept toward the post and never passed it.
  const nav = grid(10, 10, (c, r) => c >= 3 && c < 5 && r >= 3 && r < 5);
  for (const [approach, turn] of [
    [0, 30],
    [0, 60],
    [0, 90],
    [20, 120],
    [40, 90],
  ]) {
    const a = (approach * Math.PI) / 180,
      b = ((approach + turn) * Math.PI) / 180,
      crowd = new Crowd(nav),
      agent = crowd.addAgent({
        position: [5 - 2.5 * Math.cos(a), 0, 3 - 2.5 * Math.sin(a)],
        radius: 0.25,
        maxSpeed: 8,
      });
    agent.setTarget([5 + 2.5 * Math.cos(b), 0, 3 + 2.5 * Math.sin(b)]);
    crowd.update(1 / 60);
    const route = length(agent.path),
      [m] = measure(crowd, [agent], 12),
      label = `approach ${approach}, turn ${turn}`;
    assert.equal(agent.state, 'arrived', `${label}: arrives`);
    assert.ok(m.arrived <= route / agent.maxSpeed + 6, `${label}: arrived after ${m.arrived} s`);
  }
});
