// @margoengine/kinematics-constraints/urdf: the proof is a real published robot, the Franka Emika Panda as published in
// example-robot-data (tests/fixtures/panda, Apache-2.0, see NOTICE.md there). Joint ranges are read against the numbers
// in the file; the forward kinematics are checked against the Craig DH table Franka publishes, a source that shares
// nothing with the URDF's origins.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSTL } from '../../loaders/dist/index.js';
import { ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { JointLimitSolver } from '../dist/limits.js';
import { planPath } from '../dist/plan.js';
import { sweepRobot } from '../dist/swept.js';
import { loadURDF, parseURDF } from '../dist/urdf.js';

const folder = new URL('./fixtures/panda/', import.meta.url);
const text = (path) => readFileSync(new URL(path, folder), 'utf8');
const root = 'https://robots.test/data/',
  home = `${root}robots/panda_description/`,
  document = `${home}urdf/panda.urdf`;
/** Serves the fixture at the paths the published file names, and lists what was asked for. */
const asked = [];
const fixtureFetch = async (url) => {
  asked.push(url);
  const file = url.startsWith(home) ? new URL(url.slice(home.length), folder) : null;
  return file && existsSync(file) ? new Response(readFileSync(file)) : new Response('', { status: 404 });
};
const loadPanda = () => loadURDF(document, { fetch: fixtureFetch, packages: { 'example-robot-data': root } });

/** A cube of side 2 round the origin, the least COLLADA that holds a mesh. */
const COLLADA = `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<library_geometries><geometry id="g"><mesh>
<source id="p"><float_array id="pa" count="24">-1 -1 -1 1 -1 -1 1 1 -1 -1 1 -1 -1 -1 1 1 -1 1 1 1 1 -1 1 1</float_array>
<technique_common><accessor source="#pa" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
<triangles count="12"><input semantic="VERTEX" source="#v" offset="0"/>
<p>0 2 1 0 3 2 4 5 6 4 6 7 0 1 5 0 5 4 1 2 6 1 6 5 2 3 7 2 7 6 3 0 4 3 4 7</p></triangles>
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#s"/></scene></COLLADA>`;

/** Franka's published modified DH table: a, d, alpha per joint, then the flange. */
const DH = [
  [0, 0.333, 0],
  [0, 0, -Math.PI / 2],
  [0, 0.316, Math.PI / 2],
  [0.0825, 0, Math.PI / 2],
  [-0.0825, 0.384, -Math.PI / 2],
  [0, 0, Math.PI / 2],
  [0.088, 0, Math.PI / 2],
  [0, 0.107, 0],
];
function flange(q) {
  // Row-major 4x4, modified DH: Rot x(alpha) Trans x(a) Rot z(theta) Trans z(d).
  let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  DH.forEach(([a, d, alpha], i) => {
    const t = i < 7 ? q[i] : 0,
      ct = Math.cos(t),
      st = Math.sin(t),
      ca = Math.cos(alpha),
      sa = Math.sin(alpha),
      step = [ct, -st, 0, a, st * ca, ct * ca, -sa, -d * sa, st * sa, ct * sa, ca, d * ca, 0, 0, 0, 1],
      next = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) next[r * 4 + c] += m[r * 4 + k] * step[k * 4 + c];
    m = next;
  });
  return [m[3], m[7], m[11]];
}

test('Panda: every link and joint of the published file is read, with its ranges, mimic and inertia', async () => {
  const model = await loadPanda(),
    { robot } = model;
  assert.equal(model.name, 'panda');
  assert.equal(model.root, 'panda_link0');
  assert.equal(model.links.length, (text('urdf/panda.urdf').match(/<link /g) ?? []).length);
  assert.equal(model.joints.length, (text('urdf/panda.urdf').match(/<joint /g) ?? []).length);
  // Seven arm joints and one finger; the second finger repeats the first.
  assert.equal(robot.dof, 8);
  assert.deepEqual(robot.variableNames.slice(0, 2), ['panda_joint1', 'panda_joint2']);
  assert.equal(robot.lower[1], -1.7628);
  assert.equal(robot.upper[1], 1.7628);
  assert.equal(robot.lower[3], -3.0718);
  assert.equal(robot.upper[3], -0.0698);
  assert.equal(robot.upper[7], 0.04);
  assert.equal(model.joints[0].velocity, 2.175);
  assert.equal(model.joints[0].effort, 87);
  assert.equal(model.links[0].inertial.mass, 0.629769);
  assert.equal(model.links[0].visuals[0].geometry.type, 'mesh');
  assert.deepEqual([...model.home.subarray(0, 4)], [0, 0, 0, -0.0698]);
  // Each link's collision mesh, and nothing missing.
  assert.equal(model.missingMeshes.length, 0);
  assert.ok(model.meshes.length >= 9);
  assert.equal(robot.shapeCount, (text('urdf/panda.urdf').match(/<collision/g) ?? []).length);
});

test('Panda: forward kinematics agree with the DH table Franka publishes, on 200 poses', async () => {
  const { robot, links } = await loadPanda(),
    tip = links.find((link) => link.name === 'panda_link8').joint;
  let s = 85;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i++) {
    const q = new Float64Array(8);
    for (let k = 0; k < 7; k++) q[k] = robot.lower[k] + (robot.upper[k] - robot.lower[k]) * rand();
    robot.forward(q);
    const got = robot.pointOn(tip, [0, 0, 0]),
      want = flange(q);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - want[k]) < 1e-9, `pose ${i} axis ${k}: ${got[k]} ${want[k]}`);
  }
  // Franka's zero pose, by hand from the same table: a 0.088 reach and 0.926 of height.
  robot.forward(new Float64Array(8));
  const zero = robot.pointOn(tip, [0, 0, 0]);
  assert.ok(Math.abs(zero[0] - 0.088) < 1e-9 && Math.abs(zero[2] - 0.926) < 1e-9);
});

test('Panda: the second finger repeats the first, in the opposite direction by the file', async () => {
  const { robot, links } = await loadPanda(),
    left = links.find((link) => link.name === 'panda_leftfinger').joint,
    right = links.find((link) => link.name === 'panda_rightfinger').joint,
    q = new Float64Array(8),
    apart = () => {
      robot.forward(q);
      const a = robot.pointOn(left, [0, 0, 0]),
        b = robot.pointOn(right, [0, 0, 0]);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
  q[3] = -1;
  q[7] = 0;
  assert.ok(apart() < 1e-9);
  q[7] = 0.03;
  assert.ok(Math.abs(apart() - 0.06) < 1e-9);
});

test('Panda: a collision hull holds every vertex of the real STL it came from', async () => {
  const { robot, links } = await loadPanda(),
    pose = new Float64Array([0.3, -0.5, 0.2, -1.8, 0.1, 1.4, 0.4, 0.02]);
  robot.place(pose);
  let shape = 0,
    meshes = 0;
  for (const link of links) {
    for (const part of link.collisions) {
      const index = shape++;
      if (part.geometry.type !== 'mesh') continue;
      meshes++;
      const file = part.geometry.filename.split('/').pop(),
        stl = parseSTL(new Uint8Array(readFileSync(new URL(`meshes/collision/${file}`, folder)))),
        v = stl.positions;
      for (let i = 0; i < v.length; i += 3 * 7) {
        const point = robot.pointOn(link.joint, [v[i], v[i + 1], v[i + 2]]),
          probe = new SphereVolume({ center: point, radius: 0 });
        // The hull's corners are the file's own vertices, so a vertex is on it or in it, up to the rounding of a pose.
        assert.ok(robot.shapeGap(index, probe) < 1e-9, `${file} vertex ${i / 3}`);
      }
    }
  }
  assert.equal(shape, robot.shapeCount);
  assert.ok(meshes >= 9);
});

test('Panda: a limit solve reaches a point inside the real joint ranges', async () => {
  const { robot, links } = await loadPanda(),
    tip = links.find((link) => link.name === 'panda_link8').joint,
    ready = new Float64Array([0, -Math.PI / 4, 0, (-3 * Math.PI) / 4, 0, Math.PI / 2, Math.PI / 4, 0.02]),
    goal = new Float64Array([0.5, -0.3, 0.2, -2, 0.1, 1.9, 0.6, 0.02]);
  robot.forward(goal);
  const position = [...robot.pointOn(tip, [0, 0, 0])],
    out = new JointLimitSolver(robot, { tip, maxIterations: 200 }).solve(ready, { position });
  assert.equal(out.reached, true);
  assert.equal(robot.within(out.q), true);
});

test('Panda: plans round a real obstacle with its real shapes, keeping off itself, and a dense scan holds', async () => {
  const { robot } = await loadPanda(),
    ready = new Float64Array([0, -Math.PI / 4, 0, (-3 * Math.PI) / 4, 0, Math.PI / 2, Math.PI / 4, 0.02]),
    goal = new Float64Array([-2.2, -0.5, 0.1, -2.1, 0.1, 1.7, 0.6, 0.02]),
    points = [];
  for (const x of [-0.35, -0.05]) for (const y of [0.2, 0.5]) for (const z of [0, 1]) points.push(x, y, z);
  // A post between the two poses. Parts that touch at the ready pose are left out of the self check.
  robot.ignoreContactsAt(ready, 0.005);
  const post = new ConvexHullVolume({ points }),
    colliders = [post],
    minClearance = 0.01;
  assert.ok(robot.clearance(ready, colliders, true) > minClearance);
  assert.ok(robot.clearance(goal, colliders, true) > minClearance);
  assert.equal(sweepRobot(robot, ready, goal, colliders, { minClearance, selfCollision: true }).clear, false);
  const plan = await planPath(robot, ready, goal, { colliders, minClearance, selfCollision: true, seed: 12 });
  assert.equal(plan.status, 'found');
  const q = new Float64Array(8);
  for (let i = 1; i < plan.path.length; i++) {
    for (let s = 0; s <= 400; s++) {
      for (let k = 0; k < 8; k++) q[k] = plan.path[i - 1][k] + ((plan.path[i][k] - plan.path[i - 1][k]) * s) / 400;
      assert.ok(robot.clearance(q, colliders, true) >= minClearance - 1e-9);
      assert.ok(robot.within(q));
    }
  }
});

test('the primitive description of the same arm needs no file, and parseURDF reports the meshes it was not given', () => {
  const source = text('urdf/panda_collision.urdf'),
    primitive = parseURDF(source);
  assert.equal(primitive.meshes.length, 0);
  assert.equal(primitive.robot.shapeCount, (source.match(/<collision/g) ?? []).length);
  assert.ok(primitive.robot.shapeCount > 20);
  const meshed = text('urdf/panda.urdf'),
    bare = parseURDF(meshed);
  assert.ok(bare.missingMeshes.length >= 9);
  assert.deepEqual(bare.missingMeshes, bare.meshes);
  assert.equal(bare.robot.shapeCount, (meshed.match(/<collision/g) ?? []).length - (meshed.match(/<collision>\s*(<origin[^>]*>\s*)?<geometry>\s*<mesh/g) ?? []).length);
});

test('a cylinder holds, a box and a sphere measure, and origins follow roll, pitch, yaw', () => {
  const { robot } = parseURDF(`
    <robot name="shapes"><link name="a">
      <collision><origin xyz="0 0 2" rpy="1.5707963267948966 0 0"/><geometry><cylinder radius="0.5" length="1"/></geometry></collision>
      <collision><origin xyz="4 0 0"/><geometry><sphere radius="0.25"/></geometry></collision>
      <collision><origin xyz="0 4 0"/><geometry><box size="1 2 3"/></geometry></collision>
    </link></robot>`);
  robot.place(new Float64Array(0));
  // Rolled a quarter turn, the cylinder's axis lies along y through z = 2: 1 long, 0.5 round.
  const probe = (x, y, z) => new SphereVolume({ center: [x, y, z], radius: 0 }),
    round = 0.5 / Math.cos(Math.PI / 16);
  assert.ok(robot.shapeGap(0, probe(0, 0.5, 2)) <= 1e-9);
  assert.ok(Math.abs(robot.shapeGap(0, probe(0, 1, 2)) - 0.5) < 1e-9);
  assert.ok(robot.shapeGap(0, probe(0.5, 0.2, 2)) <= 1e-9, 'the prism holds the cylinder');
  assert.ok(robot.shapeGap(0, probe(round + 0.1, 0.2, 2)) > 0);
  assert.ok(Math.abs(robot.shapeGap(1, probe(5, 0, 0)) - 0.75) < 1e-9);
  assert.ok(Math.abs(robot.shapeGap(2, probe(0, 6, 0)) - 1) < 1e-9);
});

test('a planar and a floating joint open into plain joints, and a continuous joint has no range', () => {
  const { robot } = parseURDF(`
    <robot name="free"><link name="w"/><link name="p"/><link name="f"/><link name="c"/>
      <joint name="glide" type="planar"><parent link="w"/><child link="p"/><axis xyz="0 0 1"/></joint>
      <joint name="fly" type="floating"><parent link="p"/><child link="f"/></joint>
      <joint name="spin" type="continuous"><parent link="f"/><child link="c"/><axis xyz="0 0 1"/></joint>
    </robot>`);
  assert.equal(robot.dof, 2 + 6 + 1);
  assert.equal(robot.upper[8], Infinity);
  const q = new Float64Array(9);
  q[2] = 1;
  q[3] = 2;
  q[4] = 3;
  robot.forward(q);
  assert.deepEqual([...robot.pointOn(robot.jointCount - 1, [0, 0, 0])], [1, 2, 3]);
});

test('a mimic joint takes its multiplier and offset, and may come before the joint it repeats in the file', () => {
  const { robot } = parseURDF(`
    <robot name="m"><link name="r"/><link name="a"/><link name="b"/>
      <joint name="follow" type="prismatic"><parent link="r"/><child link="b"/><axis xyz="1 0 0"/>
        <mimic joint="lead" multiplier="2" offset="0.5"/><limit lower="-9" upper="9" effort="1" velocity="1"/></joint>
      <joint name="lead" type="prismatic"><parent link="r"/><child link="a"/><axis xyz="0 1 0"/>
        <limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
    </robot>`);
  assert.equal(robot.dof, 1);
  robot.forward([0.25]);
  assert.deepEqual([...robot.pointOn(robot.jointIndex('follow'), [0, 0, 0])], [1, 0, 0]);
  assert.deepEqual([...robot.pointOn(robot.jointIndex('lead'), [0, 0, 0])], [0, 0.25, 0]);
});

test('a broken document is refused with a reason', () => {
  const joint = (from, to, extra = '<limit lower="0" upper="1" effort="1" velocity="1"/>', type = 'revolute') =>
    `<joint name="${from}${to}" type="${type}"><parent link="${from}"/><child link="${to}"/>${extra}</joint>`;
  const robot = (body) => `<robot name="r">${body}</robot>`;
  assert.throws(() => parseURDF('<nothing/>'), /<robot> root/);
  assert.throws(() => parseURDF(robot('<link name="a"/><link name="b"/>')), /one root link/);
  assert.throws(() => parseURDF(robot(`<link name="a"/>${joint('a', 'z')}`)), /names no link z/);
  assert.throws(() => parseURDF(robot(`<link name="a"/><link name="b"/>${joint('a', 'b', '')}`)), /needs a <limit>/);
  assert.throws(() => parseURDF(robot(`<link name="a"/><link name="b"/>${joint('a', 'b', '', 'hover')}`)), /unknown type hover/);
  assert.throws(
    () => parseURDF(robot(`<link name="a"/><link name="b"/><link name="c"/>${joint('a', 'b')}${joint('b', 'a')}${joint('b', 'c')}`)),
    /two parents|one root link/,
  );
  assert.throws(() => parseURDF(robot('<link name="a"><collision><geometry/></collision></link>')), /no geometry/);
  assert.throws(() => parseURDF(robot('<link name="a"><collision><geometry><box size="1 2"/></geometry></collision></link>')), /3 numbers/);
});

/** A one-link robot whose collision is the mesh at `filename`. */
const meshRobot = (filename, scale = '') => `<robot name="m"><link name="a"><collision><geometry>
  <mesh filename="${filename}"${scale}/></geometry></collision></link></robot>`;
const serving = (files) => async (url) => (url in files ? new Response(files[url]) : new Response('', { status: 404 }));
const tetrahedron = (size) =>
  `v 0 0 0\nv ${size} 0 0\nv 0 ${size} 0\nv 0 0 ${size}\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n`;

test('loadURDF: an OBJ and a COLLADA file are read too, and a flat mesh keeps its shape', async () => {
  const probe = (x, y, z) => new SphereVolume({ center: [x, y, z], radius: 0 }),
    loaded = await loadURDF('https://r.test/a/m.urdf', {
      fetch: serving({
        'https://r.test/a/m.urdf': meshRobot('t.obj', ' scale="0.5 0.5 0.5"'),
        'https://r.test/a/t.obj': tetrahedron(2),
      }),
    });
  loaded.robot.place(new Float64Array(0));
  // The scale halves the tetrahedron: its corner on x is at 1, so a point at 3 is 2 away from it.
  assert.ok(Math.abs(loaded.robot.shapeGap(0, probe(3, 0, 0)) - 2) < 1e-9);
  const collada = await loadURDF('https://r.test/a/m.urdf', {
    fetch: serving({ 'https://r.test/a/m.urdf': meshRobot('c.dae'), 'https://r.test/a/c.dae': COLLADA }),
  });
  collada.robot.place(new Float64Array(0));
  assert.ok(Math.abs(collada.robot.shapeGap(0, probe(4, 0, 0)) - 3) < 1e-9);
  // One triangle of a binary STL: no volume, which a hull cannot hold, and its three corners are the shape.
  const stl = new Uint8Array(84 + 50),
    view = new DataView(stl.buffer);
  view.setUint32(80, 1, true);
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ].forEach((corner, i) => corner.forEach((value, k) => view.setFloat32(84 + 12 + i * 12 + k * 4, value, true)));
  const flat = await loadURDF('https://r.test/a/m.urdf', {
    fetch: serving({ 'https://r.test/a/m.urdf': meshRobot('f.stl'), 'https://r.test/a/f.stl': stl }),
  });
  flat.robot.place(new Float64Array(0));
  assert.ok(Math.abs(flat.robot.shapeGap(0, probe(0, 0, 3)) - 3) < 1e-9);
});

test('loadURDF: reports a file it cannot fetch, resolves package paths, and stops on abort', async () => {
  // Not listed, a package is the folder above the document, which is not where this file keeps it.
  asked.length = 0;
  await assert.rejects(loadURDF(document, { fetch: fixtureFetch }), /could not load/);
  assert.ok(asked.some((url) => url.includes(`${home}robots/panda_description/meshes/collision/`)));
  const guessed = await loadURDF('https://r.test/arm/urdf/m.urdf', {
    fetch: serving({
      'https://r.test/arm/urdf/m.urdf': meshRobot('package://arm/meshes/t.obj'),
      'https://r.test/arm/meshes/t.obj': tetrahedron(1),
    }),
  });
  assert.equal(guessed.robot.shapeCount, 1);
  await assert.rejects(
    loadURDF('https://r.test/a/m.urdf', {
      fetch: serving({ 'https://r.test/a/m.urdf': meshRobot('t.ply'), 'https://r.test/a/t.ply': tetrahedron(1) }),
    }),
    /not \.stl, \.dae or \.obj/,
  );
  const stopped = new AbortController(),
    seen = [];
  stopped.abort();
  await assert.rejects(
    loadURDF(document, {
      signal: stopped.signal,
      fetch: async (url, init) => {
        seen.push(init.signal);
        init.signal.throwIfAborted();
        return fixtureFetch(url);
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(seen[0], stopped.signal);
});
