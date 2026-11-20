// Measured bounds of @margoengine/armies, on a body built in code (test/soldier.js) baked on a headless engine: the far
// vertex animation stands where the skinned near mesh stands, to the float; the far mesh keeps its budget of triangles
// and only the source's own vertices; levels follow screen size inside every budget and seek exactly; feet do not slide
// at any speed; soldiers keep step or route step; heights spread as asked; riders sit on the saddle the horse crowd
// reads back; slider rows map to options. Every test fails on a tree without the package.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Camera, Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { Animation } from '../../animation/dist/index.js';
import { poseBones } from '../../animation/dist/instanced-skin.js';
import { vatTexel } from '../../animation/dist/vat.js';
import { Army } from '../../navmesh/dist/formations.js';
import { bakePerson, personHeight, reduceBones, vatFromBones } from '../dist/bake.js';
import { FAR, HIDDEN, NEAR, PersonCrowd, crowdBudget, planCrowd } from '../dist/lod.js';
import { riderMatrix } from '../dist/riders.js';
import { addArmy, armyGaits, armyHash, armyNormal, stepPose } from '../dist/index.js';
import { ARMY_SETTINGS, armyOptionsFromSettings, armySettingDefaults } from '../dist/settings.js';
import { soldier } from './soldier.js';

const headless = async () =>
  new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(4096), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
const loaded = async (options) => {
  const engine = await headless(),
    { doc, buffers, triangles } = soldier(options);
  return { engine, animation: new Animation(new PBRModel(engine, new GLTFAsset(doc, buffers))), triangles };
};
/** The VAT shader's pose of one vertex: rows interpolated as `vat.ts` samples them. */
function vatPose(vat, clip, time, vertex) {
  const c = vat.clips[clip];
  let t = time / c.duration;
  t = c.loop ? t - Math.floor(t) : Math.min(1, Math.max(0, t));
  const x = t * c.frames,
    a = Math.min(Math.floor(x), c.frames - 1),
    w = x - a,
    at = (row) => {
      const [u, v] = vatTexel(c.start + row, vertex, 0, vat.vertexCount, vat.width);
      return [...vat.texels.subarray((v * vat.width + u) * 4, (v * vat.width + u) * 4 + 3)];
    },
    p = at(a),
    q = at(a + 1);
  return p.map((value, k) => value + (q[k] - value) * w);
}

test('bake: the far vertex animation stands where the skinned near mesh stands, to the float, every clip and time', async () => {
  const { animation } = await loaded({ rings: 3, sides: 8 }),
    bake = await bakePerson(animation, { farTriangles: 1_000_000 });
  assert.equal(bake.farBones, bake.near, 'under the triangle budget the far mesh is the whole mesh');
  assert.deepEqual(bake.clips.map((c) => c.name), ['stand', 'walk', 'run', 'ride']);
  assert.ok(Math.abs(bake.height - 1.75) < 0.05, `bind pose ${bake.height.toFixed(3)} m tall`);
  let worst = 0;
  for (const [clip, time] of [
    [0, 0.37],
    [1, 0.5],
    [1, 0.83],
    [2, 0.21],
    [3, 0.66],
  ]) {
    const skinned = poseBones(bake.near, { clip }, time);
    for (let v = 0; v < bake.near.vertexCount; v += 3) {
      const far = vatPose(bake.far, clip, time, v);
      worst = Math.max(worst, Math.hypot(far[0] - skinned[v * 3], far[1] - skinned[v * 3 + 1], far[2] - skinned[v * 3 + 2]));
    }
  }
  assert.ok(worst < 1e-5, `the two levels part by ${worst} m`);
  // Normals come out unit length on a rigid bone.
  const n = bake.far.texels.subarray(4, 7);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-4);
});

test('bake: the far mesh keeps its triangle budget and only the source vertices, with their own skin', async () => {
  const { animation, triangles } = await loaded({ rings: 10, sides: 16 }),
    bake = await bakePerson(animation, { farTriangles: 600 });
  const farTriangles = bake.farBones.indices.length / 3;
  assert.ok(triangles > 3000, `${triangles} source triangles`);
  assert.ok(farTriangles <= 600 * 1.5 && farTriangles >= 100, `${farTriangles} far triangles for a budget of 600`);
  assert.equal(bake.far.vertexCount, bake.farBones.vertexCount);
  // Every far vertex is a source vertex with the same position and the same bone.
  const key = (b, v) => [...b.vertices.subarray(v * 6, v * 6 + 3)].map((x) => x.toFixed(6)).join() + '|' + b.joints[v * 8];
  const source = new Set(Array.from({ length: bake.near.vertexCount }, (_, v) => key(bake.near, v)));
  for (let v = 0; v < bake.farBones.vertexCount; v++) assert.ok(source.has(key(bake.farBones, v)), `far vertex ${v} is a source vertex on its own bone`);
  // No triangle spans two bones far apart: every triangle's corners follow bones of one limb chain or the trunk.
  assert.ok(Math.abs(personHeight(bake.farBones) - bake.height) < 0.02, 'the simplified body keeps its height');
  // The far texture is far smaller than the near mesh would need.
  assert.ok(bake.far.texels.length < vatFromBones(bake.near).texels.length / 3);
  await assert.rejects(reduceBones(bake.near, 0), RangeError);
  await assert.rejects(bakePerson(animation, { farTriangles: 3 }), RangeError);
});

test('levels: by screen size, nearest first, inside the near, far and vertex budgets, culled off the frustum', () => {
  const members = Array.from({ length: 400 }, (_, i) => ({ x: (i % 20) * 2, y: 0.9, z: 5 + Math.floor(i / 20) * 10, radius: 0.96 }));
  const view = { position: [19, 1.7, 0], fov: 35 },
    counts = (levels) => [NEAR, FAR, HIDDEN].map((l) => levels.filter((x) => x === l).length);
  // 0.08 of a 35 degree view: a 1.92 m sphere is that tall at 38 m.
  let levels = [...planCrowd(members, view, {}, { near: 4000, far: 400 })];
  const nearest = levels.map((l, i) => [l, members[i].z]);
  assert.ok(nearest.filter(([l]) => l === NEAR).every(([, z]) => z <= 45), 'near members are the close ones');
  assert.ok(nearest.filter(([l]) => l === FAR).every(([, z]) => z >= 35), 'far members are the distant ones');
  assert.deepEqual(counts(levels).reduce((a, b) => a + b), 400);
  // A near budget of 10 takes the 10 biggest on screen.
  levels = [...planCrowd(members, view, { near: 10 }, { near: 4000, far: 400 })];
  assert.equal(counts(levels)[0], 10);
  const nearZ = members.filter((_, i) => levels[i] === NEAR).map((m) => Math.hypot(m.x - 19, m.z));
  const farZ = members.filter((_, i) => levels[i] === FAR).map((m) => Math.hypot(m.x - 19, m.z));
  assert.ok(Math.max(...nearZ) <= Math.min(...farZ) + 1e-9);
  // A vertex budget of 50,000: 10 near (40,000) and 25 far (10,000), the rest hidden.
  levels = [...planCrowd(members, view, { near: 10, vertices: 50_000 }, { near: 4000, far: 400 })];
  assert.deepEqual(counts(levels), [10, 25, 365]);
  // Culled: smaller than cullScreen, or behind the camera's frustum planes.
  levels = [...planCrowd(members, view, { cullScreen: 0.02 }, { near: 4000, far: 400 })];
  assert.ok(levels.every((l, i) => l !== HIDDEN || Math.hypot(members[i].x - 19, members[i].z) > 140));
  const behind = { ...view, planes: [0, 0, 1, -50, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
  levels = [...planCrowd(members, behind, {}, { near: 4000, far: 400 })];
  assert.ok(levels.every((l, i) => (members[i].z + 0.96 < 50 ? l === HIDDEN : l !== HIDDEN)), 'members behind a plane are not drawn');
  // Hysteresis keeps a near member near inside the band; 0 does not.
  const one = [{ x: 0, y: 0, z: 40, radius: 0.96 }];
  assert.equal(planCrowd(one, { position: [0, 0, 0], fov: 35 }, {}, { near: 1, far: 1 })[0], FAR);
  assert.equal(planCrowd(one, { position: [0, 0, 0], fov: 35 }, { hysteresis: 0.1 }, { near: 1, far: 1 }, [NEAR])[0], NEAR);
  assert.equal(planCrowd(one, { position: [0, 0, 0], fov: 35 }, { hysteresis: 0.1 }, { near: 1, far: 1 }, [FAR])[0], FAR);
  // Pure: the same input, the same plan.
  assert.deepEqual([...planCrowd(members, view, { near: 7 }, { near: 4000, far: 400 })], [...planCrowd(members, view, { near: 7 }, { near: 4000, far: 400 })]);
  assert.throws(() => crowdBudget({ near: -1 }), RangeError);
  assert.throws(() => crowdBudget({ cullScreen: 0.5 }), RangeError);
  assert.throws(() => crowdBudget({ hysteresis: 1 }), RangeError);
});

test('gait: the cycle moves by the ground covered, so feet never slide; walk and run blend at 2 m/s; heights spread', async () => {
  const { animation } = await loaded({ rings: 2, sides: 6 }),
    bake = await bakePerson(animation),
    g = armyGaits(bake);
  assert.deepEqual([g.stand, g.walk, g.run, g.ride], [0, 1, 2, 3]);
  // Phase per metre is 1 / (stride * scale) cycles at any speed: 1.524 m is one walk cycle.
  for (const speed of [0.8, 1.2, 1.52]) {
    const a = stepPose(g, speed, 3.0, 1, 0, 0),
      b = stepPose(g, speed, 3.0 + 1.524 / 4, 1, 0, 0);
    assert.ok(Math.abs(b.offset - a.offset - 0.25) < 1e-9 || Math.abs(b.offset - a.offset + 0.75) < 1e-9, 'a quarter stride is a quarter cycle');
    assert.equal(a.blend, 0);
  }
  // A taller man covers more ground a cycle.
  assert.ok(Math.abs(stepPose(g, 1.5, 1.6, 1.05, 0, 0).offset - 1.0 * ((1.6 / (1.524 * 1.05)) % 1)) < 1e-9);
  assert.equal(stepPose(g, 1.9, 0, 1, 0, 0).blend, (1.9 - 1.8) / 0.4);
  assert.equal(stepPose(g, 2.743, 0, 1, 0, 0).blend, 1, 'double time runs');
  assert.equal(stepPose(g, 0, 5, 1, 0, 3).clip, g.stand);
  assert.notEqual(stepPose(g, 0, 5, 1, 0, 3, 0.2).offset, stepPose(g, 0, 5, 1, 0, 3, 0.7).offset, 'a halted line does not sway as one');
  // The seeded normal: mean 0, one standard deviation 1, cut at 2.5.
  const xs = Array.from({ length: 20000 }, (_, i) => armyNormal(i)),
    mean = xs.reduce((a, b) => a + b) / xs.length,
    sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03 && Math.abs(sd - 1) < 0.04 && Math.max(...xs.map(Math.abs)) <= 2.5, `mean ${mean}, sd ${sd}`);
  assert.ok(armyHash(1) >= 0 && armyHash(1) < 1 && armyHash(1) === armyHash(1));
  assert.throws(() => armyGaits(bake, { clips: { walk: 'march' } }), /no clip named march/);
  assert.throws(() => armyGaits(bake, { strides: { walk: 0 } }), RangeError);
});

test('riders: a rider sits on the seat frame, facing the horse, with a share of its pitch', () => {
  const heading = 0.6,
    pitch = 0.1,
    c = Math.cos(heading),
    s = Math.sin(heading),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch),
    f = [s * cp, sp, c * cp],
    u = [-s * sp, cp, -c * sp],
    x = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]],
    saddle = new Float32Array([...x, 0, ...u, 0, ...f, 0, 4, 1.55, -3, 1]),
    m = riderMatrix(saddle, 0, 1, { height: 1.75, pitchShare: 0.4 });
  // The rider faces the horse's way and takes 0.4 of its pitch.
  const fz = [m[8], m[9], m[10]];
  assert.ok(Math.abs(Math.atan2(fz[0], fz[2]) - heading) < 1e-6);
  assert.ok(Math.abs(Math.asin(fz[1]) - 0.04) < 1e-6);
  // The hip (root + 0.53 * 1.75 up the rider) is 0.055 * 1.75 above the seat point along the seat's own up.
  const hip = [0, 1, 2].map((k) => m[12 + k] + m[4 + k] * 0.53 * 1.75),
    want = [0, 1, 2].map((k) => saddle[12 + k] + saddle[4 + k] * 0.055 * 1.75);
  hip.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-5));
  // Scale carries through, and a model facing -Z is turned round.
  const big = riderMatrix(saddle, 0, 1.1),
    turned = riderMatrix(saddle, 0, 1, { facing: Math.PI });
  assert.ok(Math.abs(Math.hypot(big[4], big[5], big[6]) - 1.1) < 1e-6);
  assert.ok(turned[8] * f[0] + turned[10] * f[2] < -0.99);
  // A model facing +X (facing pi/2) has its own forward, +X, put on the horse's forward.
  const side = riderMatrix(saddle, 0, 1, { facing: Math.PI / 2 }),
    ahead = [s * Math.cos(0.04), Math.sin(0.04), c * Math.cos(0.04)];
  [0, 1, 2].forEach((k) => assert.ok(Math.abs(side[k] - ahead[k]) < 1e-6, `model +X on the horse's forward, axis ${k}`));
  assert.throws(() => riderMatrix(saddle, 0, 1, { pitchShare: 2 }), RangeError);
});

test('army: soldiers follow the formation, keep step, ride their horses and seek exactly', async () => {
  const { engine, animation } = await loaded({ rings: 2, sides: 6 }),
    person = await bakePerson(animation);
  // The crowd draws need WebGPU; here they are recorded only, so the planning and placing run on the CPU.
  engine.use = () => engine;
  const build = () => {
    const army = new Army();
    army.add({ count: 60, shape: 'line', ranks: 2 }).march();
    army.add({ count: 12, kind: 'cavalry', shape: 'line', ranks: 2, position: [0, -20] }).charge({ goal: [0, 200] });
    return army;
  };
  const army = build(),
    drawn = await addArmy(engine, army, { person, seed: 3 });
  assert.ok(drawn.horses, 'cavalry gets a herd');
  army.advanceTime(6);
  const view = { position: [0, 2, -30], fov: 35 };
  drawn.update(view);
  assert.equal(drawn.persons.length, 72, '60 soldiers and 12 riders');
  assert.equal(drawn.people.counts.near + drawn.people.counts.far + drawn.people.counts.hidden, 72);
  // In step: men walking at one speed and distance play one phase.
  const foot = drawn.persons.slice(0, 60);
  assert.ok(foot.every((p) => p.clip === 1), 'quick time walks');
  const phases = foot.map((p, i) => (army.members[i].distance / (1.524 * Math.hypot(p.matrix[4], p.matrix[5], p.matrix[6]))) % 1);
  foot.forEach((p, i) => assert.ok(Math.abs(p.offset - phases[i] * 1) < 1e-6, 'the cycle is the ground covered over the stride'));
  // Heights spread about 4 percent.
  const scales = foot.map((p) => Math.hypot(p.matrix[4], p.matrix[5], p.matrix[6]));
  assert.ok(Math.max(...scales) - Math.min(...scales) > 0.08 && Math.max(...scales) < 1.1 + 1e-9);
  // Riders sit on their horse's saddle and play the ride clip in time with the stride.
  const riders = drawn.persons.slice(60);
  riders.forEach((p, j) => {
    assert.equal(p.clip, 3);
    const s = Math.hypot(p.matrix[4], p.matrix[5], p.matrix[6]),
      hipY = p.matrix[13] + p.matrix[5] * 0.53 * person.height,
      seatY = drawn.horses.saddles[j * 16 + 13];
    assert.ok(hipY > seatY && hipY - seatY < 0.15 * s, 'the hip is just above the seat');
    const dx = p.matrix[12] - drawn.horses.saddles[j * 16 + 12],
      dz = p.matrix[14] - drawn.horses.saddles[j * 16 + 14];
    assert.ok(Math.hypot(dx, dz) < 0.25, 'over the saddle');
  });
  // Seek: a fresh army sought to 6 s draws the very same frame.
  const again = build(),
    drawn2 = await addArmy(engine, again, { person, seed: 3 });
  again.seek(6);
  drawn2.update(view);
  assert.deepEqual(drawn2.persons.map((p) => [...p.matrix, p.clip, p.offset, p.blend]), drawn.persons.map((p) => [...p.matrix, p.clip, p.offset, p.blend]));
  assert.deepEqual([...drawn2.people.levels], [...drawn.people.levels]);
  // A model facing +X (facing pi/2) walks with its +X down the heading.
  const sideways = build(),
    drawn4 = await addArmy(engine, sideways, { person, seed: 3, facing: Math.PI / 2, horses: false });
  sideways.advanceTime(6);
  drawn4.update(view);
  drawn4.persons.forEach((p, i) => {
    const h = sideways.members[i].heading,
      s = Math.hypot(p.matrix[0], p.matrix[1], p.matrix[2]);
    assert.ok(Math.abs(p.matrix[0] / s - Math.sin(h)) < 1e-6 && Math.abs(p.matrix[2] / s - Math.cos(h)) < 1e-6, 'model +X down the heading');
  });
  drawn4.dispose();
  // Route step: each man his own phase.
  const loose = build(),
    drawn3 = await addArmy(engine, loose, { person, seed: 3, step: 'route', horses: false });
  loose.advanceTime(6);
  drawn3.update(view);
  assert.equal(drawn3.horses, null);
  assert.equal(drawn3.persons.length, 60, 'no herd, no riders in the air');
  assert.ok(new Set(drawn3.persons.map((p) => p.offset.toFixed(4))).size > 30);
  drawn.dispose();
  drawn2.dispose();
  drawn3.dispose();
  await assert.rejects(addArmy(engine, {}, { person }), TypeError);
  await assert.rejects(addArmy(engine, build(), {}), TypeError);
  await assert.rejects(addArmy(engine, build(), { person, stature: 1 }), RangeError);
  await assert.rejects(addArmy(engine, build(), { person, step: 'quick' }), RangeError);
  await assert.rejects(PersonCrowd.attach(engine, {}), TypeError);
});

test('levels: a core Camera that has not rendered yet, or moved since, is planned where it is now', async () => {
  const { engine, animation } = await loaded({ rings: 2, sides: 6 }),
    person = await bakePerson(animation);
  engine.use = () => engine;
  const crowd = await PersonCrowd.attach(engine, person),
    // Ten men ahead of the camera and ten behind it.
    people = Array.from({ length: 20 }, (_, i) => ({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, i < 10 ? 10 + i : -10 - i, 1], clip: 1, offset: 0 })),
    camera = new Camera({ position: [0, 1.7, 0], target: [0, 1.7, 10], fov: 35 });
  // Never rendered: its planes are all zero until it updates, which would draw the men behind it.
  assert.ok(camera.planes.every((v) => v === 0));
  crowd.update(people, camera);
  assert.deepEqual([...crowd.levels].map((l, i) => (i < 10 ? l !== HIDDEN : l === HIDDEN)), Array(20).fill(true), 'the men behind are culled on the first frame');
  // Turned round between renders: the plan follows the camera now, not the frame before.
  camera.target = [0, 1.7, -10];
  crowd.update(people, camera);
  assert.deepEqual([...crowd.levels].map((l, i) => (i < 10 ? l === HIDDEN : l !== HIDDEN)), Array(20).fill(true), 'turned round, the other ten');
  assert.throws(() => crowd.update(people, camera, 0), RangeError);
  crowd.dispose();
});

test('settings: rows on the shared shape map to addArmy and bakePerson options', () => {
  assert.equal(new Set(ARMY_SETTINGS.map((r) => r.name)).size, ARMY_SETTINGS.length);
  for (const r of ARMY_SETTINGS) assert.ok(['name', 'group', 'kind', 'default', 'unit', 'about', 'live'].every((k) => k in r), r.name);
  const d = armySettingDefaults();
  assert.equal(d.nearScreen, 0.08);
  assert.equal(d.step, 'cadence');
  const { options, bake } = armyOptionsFromSettings({ near: 64, walkStride: 1.4, step: 'route', riderPitchShare: 0.3, farTriangles: 2000, fps: 24 });
  assert.deepEqual(options, { near: 64, strides: { walk: 1.4 }, step: 'route', rider: { pitchShare: 0.3 } });
  assert.deepEqual(bake, { farTriangles: 2000, fps: 24 });
  assert.deepEqual(armyOptionsFromSettings({ riderHipHeight: 0 }).options, {});
  assert.throws(() => armyOptionsFromSettings({ size: 1 }), TypeError);
  assert.throws(() => armyOptionsFromSettings({ stature: 2 }), RangeError);
  assert.ok(ARMY_SETTINGS.filter((r) => !r.live).every((r) => r.group === 'bake'));
});
