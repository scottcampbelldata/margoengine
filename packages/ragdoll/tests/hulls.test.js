// @margoengine/ragdoll/hulls: bones fitted to a real skinned mesh, measured by ray silhouettes against the mesh itself in
// a stepping solver world. Knight.glb is a real character; Fox.glb is a real one at another scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { fitRagdollShapes } from '../dist/hulls.js';
import { realRig } from './rig.js';

const rtest = (name, fn) => test(name, { timeout: 60_000 }, fn);
const KNIGHT = 'kaykit/adventurers/characters/Knight.glb';

/** The model's triangles in bind pose, as a fixed trimesh body the rays can compare with. */
function meshBody(rig) {
  const { asset } = rig.model,
    vertices = [],
    indices = [];
  for (const p of rig.model.primitives) {
    const positions = asset.accessor(p.definition.attributes.POSITION, 'VEC3'),
      first = vertices.length / 3;
    vertices.push(...positions);
    if (p.definition.indices === undefined) for (let i = 0; i < positions.length / 3; i++) indices.push(first + i);
    else for (const index of asset.accessor(p.definition.indices, 'SCALAR')) indices.push(first + index);
  }
  // In a group nothing collides with: rays see it, the falling ragdoll does not.
  const colliders = { shape: 'trimesh', vertices, indices, collisionGroups: (0x4000 << 16) >>> 0 };
  return { vertices, body: rig.physics.addBody(null, { type: 'fixed', colliders }) };
}
const bounds = (vertices) => {
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    low[i % 3] = Math.min(low[i % 3], vertices[i]);
    high[i % 3] = Math.max(high[i % 3], vertices[i]);
  }
  return { low, high };
};
/** Which cells of a grid over the mesh's box a ray along `axis` hits, for bodies passing `keep`. */
function silhouette(rig, box, axis, keep, cells = 80) {
  const across = [0, 1, 2].filter((k) => k !== axis),
    size = Math.max(box.high[0] - box.low[0], box.high[1] - box.low[1], box.high[2] - box.low[2]),
    direction = [0, 0, 0],
    hit = new Uint8Array(cells * cells);
  direction[axis] = 1;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      const origin = [0, 0, 0];
      origin[axis] = box.low[axis] - size;
      origin[across[0]] = box.low[across[0]] + ((i + 0.5) / cells) * size;
      origin[across[1]] = box.low[across[1]] + ((j + 0.5) / cells) * size;
      if (rig.physics.raycast(origin, direction, { maxDistance: size * 4, predicate: keep, solid: false }))
        hit[i * cells + j] = 1;
    }
  return hit;
}
const overlap = (a, b) => {
  let both = 0,
    either = 0;
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    either += a[i] | b[i];
  }
  return both / either;
};
/** How well the ragdoll's shapes cover the mesh, over a front and a side view: 1 is the same silhouette. */
function fit(rig, mesh, ragdoll) {
  const box = bounds(mesh.vertices),
    mine = new Set(ragdoll.bones.map((part) => part.body));
  return (
    [0, 2]
      .map((axis) =>
        overlap(
          silhouette(rig, box, axis, (body) => body === mesh.body),
          silhouette(rig, box, axis, (body) => mine.has(body)),
        ),
      )
      .reduce((sum, value) => sum + value) / 2
  );
}
async function knight({ prepare, ...options } = {}) {
  const rig = await realRig(KNIGHT);
  rig.frames(1);
  prepare?.(rig);
  rig.frames(1);
  // The file's rest pose is its bind pose, so the mesh's triangles stand where the bones do.
  const skin = rig.asset.doc.skins[0],
    bind = rig.model.asset.accessor(skin.inverseBindMatrices, 'MAT4'),
    hips = skin.joints.findIndex((joint) => rig.asset.doc.nodes[joint].name === 'hips'),
    m = rig.node('hips').matrix;
  assert.ok(Math.abs(bind[hips * 16 + 13] + m[13]) < 1e-3, 'rest pose is bind pose');
  // The head has no child bone to measure, so it needs a length to be a bone, and the toes and hand slots are left out.
  const leaves = /^(toes|handslot)/,
    bones = rig.model.nodes.filter((node) => skin.joints.includes(rig.model.nodes.indexOf(node)) && node.name !== 'root'),
    ragdoll = Ragdoll.attach(rig.physics, {
      ...options,
      bones: bones
        .filter((node) => !leaves.test(node.name))
        .map((node) => (node.name === 'head' ? { node, length: 0.5 } : node)),
    }),
    mesh = meshBody(rig);
  rig.frames(2);
  return { rig, ragdoll, mesh };
}

rtest('hulls fit the real mesh better than capsules, and boxes do too', async () => {
  const { rig, ragdoll, mesh } = await knight(),
    capsules = fit(rig, mesh, ragdoll),
    masses = ragdoll.bones.map((part) => part.body.mass),
    fitted = fitRagdollShapes(ragdoll, rig.model);
  assert.ok(fitted.length >= 10, `most bones got a hull (${fitted.length} of ${ragdoll.bones.length})`);
  for (const { part, shape, vertexCount } of fitted) {
    assert.equal(part.shape, shape);
    assert.equal(shape.type, 'hull');
    assert.ok(vertexCount >= 4);
    assert.equal(part.body.colliders.length, 1, 'the capsule is gone');
  }
  assert.deepEqual(
    ragdoll.bones.map((part) => part.body.mass),
    masses,
    'a bone weighs the same at once, for motors added next',
  );
  rig.frames(2);
  const hulls = fit(rig, mesh, ragdoll);
  fitRagdollShapes(ragdoll, rig.model, { shape: 'box' });
  rig.frames(2);
  const boxes = fit(rig, mesh, ragdoll);
  // A hull holds the corners of what a bone carries, so it can miss only slivers at the seams and overshoot only the
  // hollows between corners; a capsule from bone lengths has no knowledge of the mesh at all.
  assert.ok(hulls > 0.85, `hulls overlap the mesh (${hulls})`);
  assert.ok(hulls > capsules + 0.1, `hulls beat capsules (${hulls} against ${capsules})`);
  assert.ok(boxes > capsules, `boxes beat capsules (${boxes} against ${capsules})`);
  assert.deepEqual(
    ragdoll.bones.map((part) => part.body.mass),
    masses,
    'masses are kept',
  );
  rig.dispose();
});

rtest('every vertex a bone carries is inside its hull, and inside its box', async () => {
  const { rig, ragdoll } = await knight(),
    { model } = rig,
    skin = rig.asset.doc.skins[0],
    joint = skin.joints.map((id) => ragdoll.bones.find((part) => part.node === model.nodes[id])),
    inside = (shape) => {
      fitRagdollShapes(ragdoll, model, { shape, maxPoints: 1024 });
      rig.frames(2);
      let checked = 0;
      for (const p of model.primitives) {
        const positions = model.asset.accessor(p.definition.attributes.POSITION, 'VEC3'),
          ids = model.asset.accessor(p.definition.attributes.JOINTS_0, 'VEC4'),
          weights = model.asset.accessor(p.definition.attributes.WEIGHTS_0, 'VEC4');
        for (let v = 0; v < positions.length / 3; v++) {
          const part = joint[ids[v * 4]];
          if (weights[v * 4] < 0.999 || !part) continue;
          // Pulled 1% toward the bone's centre of mass: a corner of the hull is on it, not in it.
          const at = positions.subarray(v * 3, v * 3 + 3),
            centre = part.body.colliders[0].translation(),
            point = { x: at[0] * 0.99 + centre.x * 0.01, y: at[1] * 0.99 + centre.y * 0.01, z: at[2] * 0.99 + centre.z * 0.01 };
          assert.ok(part.body.colliders[0].containsPoint(point), `${shape}: vertex ${v} of ${part.node.name}`);
          checked++;
        }
      }
      return checked;
    };
  assert.ok(inside('hull') > 1000);
  assert.ok(inside('box') > 1000);
  rig.dispose();
});

rtest('a fitted ragdoll falls and comes to rest on the floor on its hulls, joints holding', async () => {
  // Limits it can reach lying down: the default quarter-turn cone holds a T-posed arm up off a floor the thick hull lies
  // on, so a limit and a contact fight for ever (docs/limits.md).
  const { rig, ragdoll } = await knight({ joint: { type: 'cone', swing: 2.5, twist: [-1.5, 1.5] } });
  fitRagdollShapes(ragdoll, rig.model);
  ragdoll.activate();
  ragdoll.part(rig.node('chest')).body.applyImpulse([0, 0, -30]);
  rig.frames(600);
  for (const part of ragdoll.bones) {
    const position = part.body.position,
      speed = part.body.linearVelocity;
    assert.ok(position.every(Number.isFinite), part.node.name);
    assert.ok(position[1] > -0.05, `${part.node.name} above the floor (${position[1]})`);
    assert.ok(Math.hypot(...speed) < 0.5, `${part.node.name} at rest (${Math.hypot(...speed)} m/s)`);
  }
  for (const part of ragdoll.bones) {
    if (part.parent === -1) continue;
    const up = ragdoll.bones[part.parent].body.position,
      here = part.body.position;
    assert.ok(Math.hypot(up[0] - here[0], up[1] - here[1], up[2] - here[2]) < 1, `${part.node.name} stays on`);
  }
  rig.dispose();
});

rtest('setShape swaps the collider, and a refused shape leaves the old one', async () => {
  const { rig, ragdoll } = await knight(),
    before = ragdoll.part(rig.node('upperarm.l')),
    capsule = before.shape;
  assert.deepEqual(capsule, { type: 'capsule' });
  ragdoll.setShape(before, { type: 'box', center: [0, 0.1, 0], halfExtents: [0.05, 0.1, 0.05], rotation: [0, 0, 0, 1] });
  assert.equal(before.shape.type, 'box');
  ragdoll.setShape(before.node, capsule);
  assert.equal(before.body.colliders.length, 1);
  assert.throws(() => ragdoll.setShape(before, { type: 'sphere' }), { name: 'RangeError' });
  assert.throws(() => ragdoll.setShape(before, { type: 'hull', points: [0, 0, 0] }), { name: 'RangeError' });
  assert.throws(
    () => ragdoll.setShape(before, { type: 'box', center: [0, 0, 0], halfExtents: [0, 1, 1], rotation: [0, 0, 0, 1] }),
    { name: 'RangeError' },
  );
  assert.throws(() => ragdoll.setShape(rig.engine.createMesh(), capsule), { name: 'RangeError', message: /not a bone/ });
  assert.equal(before.shape, capsule, 'a refused shape changes nothing');
  assert.equal(before.body.colliders.length, 1);
  rig.dispose();
});

rtest('a real rig at another scale: Fox in centimetres fits in world units', async () => {
  const rig = await realRig('khronos/Fox/Fox.glb', { gravity: [0, -981, 0], floor: false });
  rig.frames(1);
  const ragdoll = Ragdoll.attach(rig.physics, { root: rig.node('b_Hip_01') ?? rig.node('b_Root_00') }),
    mesh = meshBody(rig);
  rig.frames(2);
  const capsules = fit(rig, mesh, ragdoll),
    fitted = fitRagdollShapes(ragdoll, rig.model);
  rig.frames(2);
  const hulls = fit(rig, mesh, ragdoll);
  assert.ok(fitted.length >= 10, `most bones got a hull (${fitted.length})`);
  assert.ok(hulls > capsules, `hulls beat capsules on Fox (${hulls} against ${capsules})`);
  rig.dispose();
});

rtest('a source must fit the ragdoll', async () => {
  const { rig, ragdoll } = await knight();
  assert.throws(() => fitRagdollShapes(null, rig.model), { name: 'TypeError' });
  assert.throws(() => fitRagdollShapes(ragdoll, null), { name: 'TypeError' });
  assert.throws(() => fitRagdollShapes(ragdoll, rig.model, { shape: 'sphere' }), { name: 'RangeError' });
  assert.throws(() => fitRagdollShapes(ragdoll, rig.model, { minWeight: 2 }), { name: 'RangeError' });
  const other = await realRig(KNIGHT);
  assert.throws(() => fitRagdollShapes(ragdoll, other.model), { name: 'RangeError', message: /root bone/ });
  other.dispose();
  rig.dispose();
});

rtest('a plain skinned mesh works as a source, with joints above the bones counting for no body', async () => {
  const { rig, ragdoll } = await knight(),
    hips = rig.node('hips'),
    spine = rig.node('spine'),
    corners = [-0.1, 0.1].flatMap((x) => [0, 0.2].flatMap((y) => [-0.1, 0.1].flatMap((z) => [x, y, z]))),
    m = hips.matrix,
    inverse = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  inverse.set([-m[12], -m[13], -m[14]], 12);
  const fitted = fitRagdollShapes(ragdoll, {
    positions: corners.map((v, i) => v + m[12 + (i % 3)]),
    joints: new Uint16Array(32).map((_, i) => (i % 4 === 0 ? (i < 16 ? 0 : 1) : 0)),
    weights: new Float32Array(32).map((_, i) => (i % 4 === 0 ? 1 : 0)),
    nodes: [hips, rig.model.root],
    inverseBindMatrices: new Float32Array([...inverse, ...inverse]),
  });
  assert.deepEqual(fitted, [], 'four corners on one plane span no volume, and the rest belong to no bone');
  assert.equal(ragdoll.part(hips).shape.type, 'capsule');
  assert.equal(ragdoll.part(spine).shape.type, 'capsule');
  rig.dispose();
});

rtest('a bone with an uneven scale gets a hull stretched along its own axes', async () => {
  // Stand-in scale on a real rig. The hull's points live in the bone's frame, so each axis keeps its own scale.
  const size = (points, axis) => {
    let low = Infinity,
      high = -Infinity;
    for (let i = axis; i < points.length; i += 3) {
      low = Math.min(low, points[i]);
      high = Math.max(high, points[i]);
    }
    return high - low;
  };
  const plain = await knight(),
    even = fitRagdollShapes(plain.ragdoll, plain.rig.model).find((hull) => hull.part.node.name === 'head').shape;
  plain.rig.dispose();
  const stretched = await knight({ prepare: (rig) => rig.node('head').setScale([1, 2, 1]) }),
    uneven = fitRagdollShapes(stretched.ragdoll, stretched.rig.model).find((hull) => hull.part.node.name === 'head').shape;
  const ratio = (axis) => size(uneven.points, axis) / size(even.points, axis);
  assert.ok(Math.abs(ratio(0) - 1) < 1e-4, `x keeps its size (${ratio(0)})`);
  assert.ok(Math.abs(ratio(1) - 2) < 1e-4, `y doubles (${ratio(1)})`);
  assert.ok(Math.abs(ratio(2) - 1) < 1e-4, `z keeps its size (${ratio(2)})`);
  stretched.rig.dispose();
});

