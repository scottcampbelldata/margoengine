// exportAnimatedUSDZ: the numbers in the file, read back with USD's own rules and compared with glTF's. Apple's usdchecker,
// usdcat and ModelIO read the real models by hand (claims.md, reproduce.md); this file's reader is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportGLB, joinGLB, splitGLB } from '@margoengine/exporters';
import { compressDraco } from '@margoengine/exporters/draco';
import { exportAnimatedUSDZ } from '@margoengine/exporters/usdz-anim';
import { sceneOfGLB } from '../dist/glb-scene.js';

const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const usda = async ({ usdz }) => new TextDecoder().decode(await readZipEntry(usdz, readZipDirectory(usdz)[0]));
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const numbers = (text) => (text.match(/-?\d+\.?\d*(?:e[-+]?\d+)?/gi) ?? []).map(Number);
/** The frames of a `name.timeSamples = { ... }` block, as lists of numbers. */
function samples(text, name, from = 0) {
  const start = text.indexOf(`${name}.timeSamples = {`, from);
  if (start < 0) return null;
  const end = text.indexOf('\n    }', start) >= 0 ? text.indexOf('}', start) : -1,
    frames = [];
  for (const line of text.slice(start, end).split('\n').slice(1)) {
    const at = line.indexOf(':');
    if (at >= 0) frames.push(numbers(line.slice(at + 1)));
  }
  return frames;
}
const near = (actual, expected, bound, label) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${label}: ${actual} against ${expected}, bound ${bound}`);

// Column-major maths written out here, so the checks share no code with the writer.
const multiply = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = ([tx, ty, tz], [x, y, z, w], [sx, sy, sz]) => [
  sx * (1 - 2 * (y * y + z * z)),
  sx * 2 * (x * y + z * w),
  sx * 2 * (x * z - y * w),
  0,
  sy * 2 * (x * y - z * w),
  sy * (1 - 2 * (x * x + z * z)),
  sy * 2 * (y * z + x * w),
  0,
  sz * 2 * (x * z + y * w),
  sz * 2 * (y * z - x * w),
  sz * (1 - 2 * (x * x + y * y)),
  0,
  tx,
  ty,
  tz,
  1,
];
const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const IDENTITY = trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
const invertTRS = (t, q, s) =>
  multiply(
    multiply(
      trs(
        [0, 0, 0],
        [0, 0, 0, 1],
        s.map((v) => 1 / v),
      ),
      trs([0, 0, 0], [-q[0], -q[1], -q[2], q[3]], [1, 1, 1]),
    ),
    trs(
      t.map((v) => -v),
      [0, 0, 0, 1],
      [1, 1, 1],
    ),
  );

test('a moving node gets time samples, the layer its time codes, and what does not move a plain value', async () => {
  const node = { name: 'box', geometry: quad },
    result = await exportAnimatedUSDZ(
      {
        nodes: [node],
        animations: [
          { name: 'Slide', channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 3, 0, 0] }] },
        ],
      },
      { fps: 4 },
    ),
    text = await usda(result);
  assert.equal(result.frames, 5);
  assert.equal(result.clip, 'Slide');
  assert.match(text, /startTimeCode = 0/);
  assert.match(text, /endTimeCode = 4/);
  assert.match(text, /timeCodesPerSecond = 4/);
  assert.deepEqual(samples(text, 'double3 xformOp:translate'), [
    [0, 0, 0],
    [0.75, 0, 0],
    [1.5, 0, 0],
    [2.25, 0, 0],
    [3, 0, 0],
  ]);
  assert.equal(samples(text, 'quatf xformOp:orient'), null);
  assert.match(text, /quatf xformOp:orient = \(1, 0, 0, 0\)/);
  assert.match(text, /float3 xformOp:scale = \(1, 1, 1\)/);
  assert.match(text, /xformOpOrder = \["xformOp:translate", "xformOp:orient", "xformOp:scale"\]/);
});

test('STEP holds and CUBICSPLINE follows its tangents', async () => {
  const stepped = { name: 'a', geometry: quad },
    curved = { name: 'b', geometry: quad },
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [stepped, curved],
          animations: [
            {
              channels: [
                {
                  node: stepped,
                  path: 'translation',
                  interpolation: 'STEP',
                  times: [0, 1],
                  values: [0, 0, 0, 8, 0, 0],
                },
                {
                  node: curved,
                  path: 'translation',
                  interpolation: 'CUBICSPLINE',
                  times: [0, 1],
                  // in tangent, value, out tangent for each key: x goes 0 to 1 with both tangents 0.
                  values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
                },
              ],
            },
          ],
        },
        { fps: 2 },
      ),
    ),
    first = text.indexOf('displayName = "a"'),
    second = text.indexOf('displayName = "b"');
  assert.deepEqual(samples(text, 'double3 xformOp:translate', first), [
    [0, 0, 0],
    [0, 0, 0],
    [8, 0, 0],
  ]);
  // Hermite at the middle with zero tangents: 0.5 exactly.
  assert.deepEqual(samples(text, 'double3 xformOp:translate', second), [
    [0, 0, 0],
    [0.5, 0, 0],
    [1, 0, 0],
  ]);
});

test('a clip that ends off the grid keeps its last pose on the last frame', async () => {
  const node = { name: 'box', geometry: quad },
    result = await exportAnimatedUSDZ(
      {
        nodes: [node],
        animations: [{ channels: [{ node, path: 'translation', times: [0, 0.25], values: [0, 0, 0, 1, 0, 0] }] }],
      },
      { fps: 10 },
    ),
    frames = samples(await usda(result), 'double3 xformOp:translate');
  assert.equal(result.frames, 4, 'ceil(2.5) + 1');
  assert.equal(frames.at(-1)[0], 1);
});

test('a child rides its moving parent through the hierarchy', async () => {
  const child = { name: 'child', translation: [0, 2, 0], geometry: quad },
    parent = { name: 'parent', children: [child] },
    text = await usda(
      await exportAnimatedUSDZ({
        nodes: [parent],
        animations: [{ channels: [{ node: parent, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
      }),
    ),
    outer = text.indexOf('displayName = "parent"'),
    inner = text.indexOf('displayName = "child"');
  assert.ok(outer >= 0 && outer < inner);
  assert.match(
    text.slice(inner),
    /matrix4d xformOp:transform = \(\(1, 0, 0, 0\), \(0, 1, 0, 0\), \(0, 0, 1, 0\), \(0, 2, 0, 1\)\)/,
  );
});

test('a rotation written with its sign flipped stays on the short way round', async () => {
  const node = { name: 'spin', geometry: quad },
    s = Math.SQRT1_2,
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [node],
          animations: [
            {
              channels: [
                { node, path: 'rotation', interpolation: 'STEP', times: [0, 1], values: [0, 0, 0, 1, -0, -s, -0, -s] },
              ],
            },
          ],
        },
        { fps: 1 },
      ),
    ),
    [a, b] = samples(text, 'quatf xformOp:orient');
  assert.ok(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] > 0);
  near(b[0], s, 1e-6, 'w first, as USD writes it');
  near(b[2], s, 1e-6, 'y');
});

test('nodes that share a geometry share a shape, and a mirrored node a reflected one, with no reflection left', async () => {
  const motion = (node) => ({ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }),
    a = { name: 'a', geometry: quad },
    b = { name: 'b', translation: [3, 0, 0], geometry: quad },
    mirror = { name: 'm', translation: [6, 0, 0], scale: [-1, 1, 1], geometry: quad },
    text = await usda(
      await exportAnimatedUSDZ({ nodes: [a, b, mirror], animations: [{ channels: [motion(a), motion(b)] }] }),
    );
  assert.equal(count(text, /class Mesh "/g), 1);
  assert.equal(count(text, /point3f\[\] points/g), 2, 'the shape and its reflection');
  const mirrored = text.slice(text.indexOf('displayName = "m"'));
  assert.match(mirrored, /float3 xformOp:scale = \(-1, 1, 1\)/);
  // Node scale -1 times the mesh's -1: every vertex goes where glTF puts it, through a matrix with a positive determinant.
  assert.match(mirrored, /point3f\[\] points = \[\(0, 0, 0\), \(-1, 0, 0\), \(-1, 1, 0\), \(0, 1, 0\)\]/);
  assert.match(mirrored, /faceVertexIndices = \[0, 2, 1, 0, 3, 2\]/);
});

/** A two-bone arm: `upper` at the origin, `lower` 2 up, a strip of vertices up it, the lower half on `lower`. */
function arm(extra = {}) {
  const lower = { name: 'lower', translation: [0, 2, 0], ...extra.lower },
    upper = { name: 'upper', children: [lower], ...extra.upper },
    positions = [],
    joints = [],
    weights = [];
  for (let row = 0; row <= 4; row++)
    for (const x of [-0.5, 0.5]) {
      positions.push(x, row, 0);
      // Listed as the skin lists them: lower is joint 0, upper joint 1.
      joints.push(0, 1, 0, 0);
      const share = row / 4;
      weights.push(share, 1 - share, 0, 0);
    }
  const indices = [];
  for (let row = 0; row < 4; row++) {
    const a = row * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const inverses = [...invertTRS([0, 2, 0], [0, 0, 0, 1], [1, 1, 1]), ...IDENTITY],
    geometry = {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      indices: new Uint32Array(indices),
      joints: new Uint8Array(joints),
      weights: new Float32Array(weights),
    },
    mesh = { name: 'sleeve', geometry, skin: { joints: [lower, upper], inverseBindMatrices: inverses } };
  return { lower, upper, mesh, geometry, inverses };
}

const turn = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];

/** Reads a skeleton back by USD's rules: skel-space joints from the joint paths and locals, then linear blend skinning. */
function skinnedByUSD(text, frame, geometry) {
  const joints = JSON.parse(`[${/uniform token\[\] joints = \[([^\]]*)\]/.exec(text)[1]}]`),
    binds = numbers(/matrix4d\[\] bindTransforms = \[(.*)\]/.exec(text)[1]),
    translations =
      samples(text, 'float3[] translations')?.[frame] ?? numbers(/float3\[\] translations = (.*)/.exec(text)[1]),
    rotations = samples(text, 'quatf[] rotations')?.[frame] ?? numbers(/quatf\[\] rotations = (.*)/.exec(text)[1]),
    scales = samples(text, 'half3[] scales')?.[frame] ?? numbers(/half3\[\] scales = (.*)/.exec(text)[1]),
    points = numbers(/point3f\[\] points = (.*)/.exec(text)[1]),
    indices = numbers(/primvars:skel:jointIndices = \[([^\]]*)\]/.exec(text)[1]),
    weights = numbers(/primvars:skel:jointWeights = \[([^\]]*)\]/.exec(text)[1]),
    world = [],
    bindInverse = (j) => {
      // Rows of USD's matrix are the columns of the column-major one.
      const m = binds.slice(j * 16, j * 16 + 16);
      // The binds here are rigid or uniform: build the inverse from the columns.
      const size = Math.hypot(m[0], m[1], m[2]),
        r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1].map((v, i) =>
          i % 4 === 3 ? v : v / (size * size),
        ),
        t = apply(r, [m[12], m[13], m[14]]);
      return [...r.slice(0, 12), -t[0], -t[1], -t[2], 1];
    };
  joints.forEach((path, j) => {
    const [w, x, y, z] = rotations.slice(j * 4, j * 4 + 4),
      local = trs(translations.slice(j * 3, j * 3 + 3), [x, y, z, w], scales.slice(j * 3, j * 3 + 3)),
      above = joints.indexOf(path.slice(0, path.lastIndexOf('/')));
    world.push(above < 0 ? local : multiply(world[above], local));
  });
  const out = [];
  for (let v = 0; v < geometry.positions.length / 3; v++) {
    const p = points.slice(v * 3, v * 3 + 3),
      sum = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const at = v * 4 + k,
        moved = apply(multiply(world[indices[at]], bindInverse(indices[at])), p);
      for (let r = 0; r < 3; r++) sum[r] += weights[at] * moved[r];
    }
    out.push(sum);
  }
  return out;
}

/** What glTF says at `frame`: every joint's world matrix times its inverse bind matrix, blended by the weights. */
function skinnedByGLTF(geometry, inverses, jointWorlds) {
  const out = [];
  for (let v = 0; v < geometry.positions.length / 3; v++) {
    const p = [...geometry.positions.subarray(v * 3, v * 3 + 3)],
      sum = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const joint = geometry.joints[v * 4 + k],
        moved = apply(multiply(jointWorlds[joint], inverses.slice(joint * 16, joint * 16 + 16)), p);
      for (let r = 0; r < 3; r++) sum[r] += geometry.weights[v * 4 + k] * moved[r];
    }
    out.push(sum);
  }
  return out;
}

test('a skin moves every vertex where glTF puts it, frame by frame, by USD`s own formula', async () => {
  const { lower, upper, mesh, geometry, inverses } = arm(),
    bent = turn(Math.PI / 2),
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [upper, mesh],
          animations: [
            {
              channels: [
                { node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...bent] },
                { node: upper, path: 'translation', times: [0, 1], values: [0, 0, 0, 5, 0, 0] },
              ],
            },
          ],
        },
        { fps: 2 },
      ),
    );
  // Parents come first, whatever order the skin listed them in, so the weights' joint numbers moved with them.
  assert.match(text, /joints = \["upper", "upper\/lower"\]/);
  // Frame 2 is the end of the clip: the bend is 90 degrees and the arm 5 along.
  const upperWorld = trs([5, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
    lowerWorld = multiply(upperWorld, trs([0, 2, 0], bent, [1, 1, 1])),
    want = skinnedByGLTF(geometry, inverses, [lowerWorld, upperWorld]),
    got = skinnedByUSD(text, 2, geometry);
  // Values go through decimal text exact to Float32's 24 bits; sizes here are below 8, so 8 * 2^-23 per step, a few steps.
  want.forEach((point, v) => point.forEach((value, r) => near(got[v][r], value, 1e-5, `vertex ${v}`)));
});

test('a joint under a node that is no joint takes that node`s motion', async () => {
  const { lower, upper, mesh, geometry, inverses } = arm(),
    rig = { name: 'rig', scale: [2, 2, 2], children: [upper] },
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [rig, mesh],
          animations: [{ channels: [{ node: rig, path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 4, 0] }] }],
        },
        { fps: 1 },
      ),
    ),
    rigWorld = trs([0, 4, 0], [0, 0, 0, 1], [2, 2, 2]),
    upperWorld = rigWorld,
    lowerWorld = multiply(upperWorld, trs(lower.translation, [0, 0, 0, 1], [1, 1, 1])),
    want = skinnedByGLTF(geometry, inverses, [lowerWorld, upperWorld]),
    got = skinnedByUSD(text, 1, geometry);
  want.forEach((point, v) => point.forEach((value, r) => near(got[v][r], value, 1e-5, `vertex ${v}`)));
  assert.equal(count(text, /def Xform "Node_/g), 0, 'nothing rigid to place, so no Xform');
});

test('a skin in another space than the world rests in the world and still moves as glTF says', async () => {
  // As robot-expressive and RiggedFigure do: the joints sit under a scale and a turn the mesh's own numbers know nothing of.
  const { lower, upper, mesh, geometry, inverses } = arm(),
    quarter = [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    rig = { name: 'rig', rotation: quarter, scale: [100, 100, 100], children: [upper] },
    bent = [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [rig, mesh],
          animations: [{ channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, ...bent] }] }],
        },
        { fps: 1 },
      ),
    ),
    rigWorld = trs([0, 0, 0], quarter, [100, 100, 100]),
    lowerWorld = multiply(rigWorld, trs(lower.translation, bent, [1, 1, 1])),
    want = skinnedByGLTF(geometry, inverses, [lowerWorld, rigWorld]),
    got = skinnedByUSD(text, 1, geometry),
    points = numbers(/point3f\[\] points = (.*)/.exec(text)[1]),
    normal = numbers(/normal3f\[\] normals = (\[[^\]]*\])/.exec(text)[1]);
  // Sizes here are up to 400, so a Float32 step is about 3e-5, over a few steps.
  want.forEach((point, v) => point.forEach((value, r) => near(got[v][r], value, 2e-3, `vertex ${v}`)));
  apply(rigWorld, [...geometry.positions.subarray(6, 9)]).forEach((value, r) => near(points[6 + r], value, 1e-3, 'rest'));
  [0, -1, 0].forEach((value, r) => near(normal[r], value, 1e-6, 'normal turned with the points'));
});

test('a mesh on a joint rides as an Xform beside the skin', async () => {
  const { lower, upper, mesh } = arm(),
    hat = { name: 'hat', geometry: quad };
  lower.children = [hat];
  const text = await usda(
    await exportAnimatedUSDZ({
      nodes: [upper, mesh],
      animations: [{ channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...turn(1)] }] }],
    }),
  );
  assert.ok(text.indexOf('displayName = "upper"') >= 0);
  assert.ok(text.indexOf('displayName = "lower"') > text.indexOf('displayName = "upper"'));
  assert.equal(count(text, /def SkelRoot /g), 1);
  assert.equal(count(text, /def Mesh /g), 2);
});

test('the skeleton carries its schema, its rest pose and every binding', async () => {
  const { upper, lower, mesh } = arm(),
    text = await usda(
      await exportAnimatedUSDZ({
        nodes: [upper, mesh],
        animations: [
          { channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...turn(1)] }] },
        ],
      }),
    );
  assert.match(text, /def SkelRoot "Skin_0"/);
  assert.match(text, /def Skeleton "Skeleton" \(\s*prepend apiSchemas = \["SkelBindingAPI"\]/);
  assert.match(text, /rel skel:animationSource = <\/Margo\/Skin_0\/Motion>/);
  assert.match(text, /rel skel:skeleton = <\/Margo\/Skin_0\/Skeleton>/);
  assert.match(text, /apiSchemas = \["MaterialBindingAPI", "SkelBindingAPI"\]/);
  assert.match(text, /primvars:skel:jointIndices = \[.*\] \(\n\s+elementSize = 4\n\s+interpolation = "vertex"\n\s+\)/);
  assert.match(text, /primvars:skel:jointWeights = \[.*\] \(\n\s+elementSize = 4\n\s+interpolation = "vertex"\n\s+\)/);
  const rest = numbers(/matrix4d\[\] restTransforms = \[(.*)\]/.exec(text)[1]);
  assert.deepEqual(
    rest.slice(16),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1],
    'the local of lower, in its own rest pose',
  );
  assert.equal(samples(text, 'float3[] translations'), null, 'nothing translates, so one plain value');
  assert.notEqual(samples(text, 'quatf[] rotations'), null);
});

test('the rest pose stays the rest pose when the clip starts elsewhere', async () => {
  const { upper, lower, mesh } = arm(),
    text = await usda(
      await exportAnimatedUSDZ({
        nodes: [upper, mesh],
        animations: [{ channels: [{ node: lower, path: 'translation', times: [0, 1], values: [9, 9, 9, 8, 8, 8] }] }],
      }),
    ),
    rest = numbers(/matrix4d\[\] restTransforms = \[(.*)\]/.exec(text)[1]);
  assert.deepEqual(rest.slice(28, 31), [0, 2, 0]);
});

test('joint names become USD paths, unique and legal', async () => {
  const first = { name: '1st bone' },
    second = { name: '1st bone' },
    root = { name: 'root:rig', children: [first, second] },
    geometry = { ...quad, joints: new Uint8Array(16), weights: new Float32Array(16).map((_, i) => (i % 4 ? 0 : 1)) },
    skin = { joints: [root, first, second], inverseBindMatrices: [...IDENTITY, ...IDENTITY, ...IDENTITY] },
    text = await usda(
      await exportAnimatedUSDZ({
        nodes: [root, { geometry, skin }],
        animations: [{ channels: [{ node: first, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
      }),
    );
  assert.match(text, /joints = \["root_rig", "root_rig\/_1st_bone", "root_rig\/_1st_bone_1"\]/);
});

test('a joint with shear in what lies above it is refused with a fix', async () => {
  const lean = { name: 'tilt', rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
    { upper, lower, mesh } = arm();
  lean.children = [upper];
  const squash = { name: 'squash', scale: [1, 3, 1], children: [lean] },
    source = {
      nodes: [squash, mesh],
      animations: [{ channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...turn(1)] }] }],
    };
  // A turn inside a non-uniform scale is a shear, which USD's translate, rotate and scale cannot hold; upper is a root joint.
  upper.rotation = [0, 0, Math.sin(0.4), Math.cos(0.4)];
  await assert.rejects(exportAnimatedUSDZ(source), /shear/);
});

test('a root joint scaled to zero under a node that turns keeps its turn, so a clip can make a character appear', async () => {
  const { upper, lower, mesh, geometry, inverses } = arm(),
    quarter = turn(Math.PI / 2),
    rig = { name: 'rig', rotation: quarter, children: [upper] },
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [rig, mesh],
          animations: [{ channels: [{ node: upper, path: 'scale', times: [0, 1], values: [0, 0, 0, 1, 1, 1] }] }],
        },
        { fps: 1 },
      ),
    ),
    first = samples(text, 'half3[] scales')[0];
  assert.deepEqual(
    first.slice(0, 3),
    [0, 0, 0],
    'the matrix at this frame is all zero, so the scale can only come from the track',
  );
  // The last frame, full size: the turn of the rig lands on the root joint and the skin follows it.
  const upperWorld = trs([0, 0, 0], quarter, [1, 1, 1]),
    lowerWorld = multiply(upperWorld, trs(lower.translation, [0, 0, 0, 1], [1, 1, 1])),
    want = skinnedByGLTF(geometry, inverses, [lowerWorld, upperWorld]),
    got = skinnedByUSD(text, 1, geometry);
  want.forEach((point, v) => point.forEach((value, r) => near(got[v][r], value, 1e-5, `vertex ${v}`)));
});

test('a joint under a zero-scale joint with a node between them is written, as its parts need no inverse', async () => {
  const { upper, lower, mesh } = arm(),
    link = { name: 'link', translation: [1, 0, 0], children: [lower] };
  upper.children = [link];
  const text = await usda(
    await exportAnimatedUSDZ(
      {
        nodes: [upper, mesh],
        animations: [{ channels: [{ node: upper, path: 'scale', times: [0, 1], values: [0, 0, 0, 1, 1, 1] }] }],
      },
      { fps: 1 },
    ),
  );
  // 1 along from the link plus lower's own 2 up, both in the joint above's space, whatever that joint's scale is.
  assert.deepEqual(samples(text, 'half3[] scales')[0].slice(3), [1, 1, 1]);
  assert.deepEqual(numbers(/float3\[\] translations = (.*)/.exec(text)[1]).slice(3), [1, 2, 0]);
});

test('a rotation of a joint written with its sign flipped stays on the short way round', async () => {
  const { upper, lower, mesh } = arm(),
    s = Math.SQRT1_2,
    text = await usda(
      await exportAnimatedUSDZ(
        {
          nodes: [upper, mesh],
          animations: [
            {
              channels: [
                {
                  node: lower,
                  path: 'rotation',
                  interpolation: 'STEP',
                  times: [0, 1],
                  values: [0, 0, 0, 1, 0, -s, 0, -s],
                },
              ],
            },
          ],
        },
        { fps: 1 },
      ),
    ),
    [a, b] = samples(text, 'quatf[] rotations');
  // Joint 1 is lower: (w, x, y, z) at each frame. A blend between q and -q would swing through the long way.
  const at = [a.slice(4, 8), b.slice(4, 8)];
  assert.ok(at[0].reduce((sum, v, k) => sum + v * at[1][k], 0) > 0);
  near(at[1][0], s, 1e-6, 'w');
  near(at[1][2], s, 1e-6, 'y');
});

test('every node between two joints adds its part, nearest last', async () => {
  const { upper, lower, mesh } = arm(),
    inner = { name: 'inner', translation: [0, 1, 0], children: [lower] },
    outer = { name: 'outer', rotation: turn(Math.PI / 2), children: [inner] };
  upper.children = [outer];
  const text = await usda(
    await exportAnimatedUSDZ({
      nodes: [upper, mesh],
      animations: [{ channels: [{ node: upper, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
    }),
  );
  // outer turns 90 degrees about z, so what lies 3 up inside it (inner's 1, lower's 2) lands 3 along -x.
  const t = numbers(
    /float3\[\] translations = (.*)/.exec(text)?.[1] ?? samples(text, 'float3[] translations')[0].join(' '),
  ).slice(3);
  [-3, 0, 0].forEach((value, r) => near(t[r], value, 1e-6, `lower axis ${r}`));
});

test('morph weight channels are named, not lost in silence', async () => {
  const node = {
      name: 'face',
      geometry: { ...quad, morphs: [{ positions: new Float32Array(12) }] },
      morphWeights: [0],
    },
    { skipped } = await exportAnimatedUSDZ({
      nodes: [node],
      animations: [
        {
          channels: [
            { node, path: 'weights', times: [0, 1], values: [0, 1] },
            { node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] },
          ],
        },
      ],
    });
  assert.deepEqual(skipped, [{ kind: 'morph-weights', target: 'face' }]);
});

test('a channel of a node left out of the scene is named', async () => {
  const hidden = { name: 'hidden', visible: false, geometry: quad },
    shown = { name: 'shown', geometry: quad },
    { skipped } = await exportAnimatedUSDZ({
      nodes: [hidden, shown],
      animations: [
        {
          channels: [
            { node: hidden, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] },
            { node: shown, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] },
          ],
        },
      ],
    });
  assert.deepEqual(skipped, [{ kind: 'not-exported', target: 'hidden' }]);
});

test('a clip is picked by index or by name', async () => {
  const node = { name: 'box', geometry: quad },
    clip = (name, end) => ({
      name,
      channels: [{ node, path: 'translation', times: [0, end], values: [0, 0, 0, 1, 0, 0] }],
    }),
    source = { nodes: [node], animations: [clip('Walk', 1), clip('Run', 2)] };
  assert.equal((await exportAnimatedUSDZ(source)).clip, 'Walk');
  assert.equal((await exportAnimatedUSDZ(source, { clip: 1, fps: 1 })).frames, 3);
  assert.equal((await exportAnimatedUSDZ(source, { clip: 'Run' })).clip, 'Run');
});

test('GLB bytes go in as they are: nodes, skin, clip and materials', async () => {
  const { upper, lower, mesh } = arm(),
    glb = exportGLB({
      nodes: [upper, mesh],
      animations: [
        {
          name: 'Bend',
          channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...turn(1)] }],
        },
      ],
    }),
    result = await exportAnimatedUSDZ(glb, { clip: 'Bend' }),
    text = await usda(result);
  assert.equal(result.clip, 'Bend');
  assert.equal(result.frames, 31);
  assert.match(text, /joints = \["upper", "upper\/lower"\]/);
  assert.equal(count(text, /def SkelRoot /g), 1);
});

test('the real Fox plays: 24 joints, a clip by name, and its texture in the archive', async () => {
  const fox = new Uint8Array(readFileSync(new URL('../../../examples/assets/khronos/Fox/Fox.glb', import.meta.url))),
    result = await exportAnimatedUSDZ(fox, { clip: 'Walk' }),
    text = await usda(result),
    joints = JSON.parse(`[${/uniform token\[\] joints = \[([^\]]*)\]/.exec(text)[1]}]`);
  assert.equal(result.clip, 'Walk');
  assert.equal(joints.length, 24);
  assert.ok(result.frames > 20);
  assert.ok(readZipDirectory(result.usdz).some(({ name }) => name.startsWith('textures/')));
  assert.deepEqual(result.skipped, []);
});

test('what it cannot take is refused with what to do', async () => {
  const node = { name: 'box', geometry: quad },
    source = {
      nodes: [node],
      animations: [{ channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
    },
    { glb: packed } = await compressDraco(exportGLB({ nodes: [{ geometry: quad }], animations: [] }));
  await assert.rejects(exportAnimatedUSDZ({ nodes: [node] }), /exportUSDZ/);
  await assert.rejects(exportAnimatedUSDZ(source, { clip: 3 }), /no clip 3/);
  await assert.rejects(exportAnimatedUSDZ(source, { clip: 'Run' }), /no clip "Run"/);
  await assert.rejects(exportAnimatedUSDZ(source, { fps: 0 }), RangeError);
  await assert.rejects(exportAnimatedUSDZ(source, { fps: Infinity }), RangeError);
  await assert.rejects(exportAnimatedUSDZ(packed), /decoded/);
  await assert.rejects(exportAnimatedUSDZ(new Uint8Array(4)), TypeError);
  const long = {
    nodes: [node],
    animations: [{ channels: [{ node, path: 'translation', times: [0, 5000], values: [0, 0, 0, 1, 0, 0] }] }],
  };
  await assert.rejects(exportAnimatedUSDZ(long), /lower fps/);
  const empty = { nodes: [{ name: 'nothing' }], animations: source.animations };
  await assert.rejects(exportAnimatedUSDZ(empty), /at least one mesh/);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(exportAnimatedUSDZ(source, { signal: stop.signal }), /stopped/);
});

test('a skin joint outside the scene is refused', async () => {
  const { upper, lower, mesh } = arm();
  await assert.rejects(
    exportAnimatedUSDZ({
      nodes: [mesh],
      animations: [{ channels: [{ node: lower, path: 'rotation', times: [0, 1], values: [...turn(0), ...turn(1)] }] }],
    }),
    /joint is not in the scene/,
  );
  assert.ok(upper);
});

/** A GLB of one mesh, built field by field, so a test can hold what the writers here never produce. */
function handGLB({ primitive = {}, extra = {}, data = [] }) {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    tail = new Uint8Array(new Float32Array(data).buffer),
    bin = new Uint8Array(36 + tail.length);
  bin.set(new Uint8Array(positions.buffer));
  bin.set(tail, 36);
  return joinGLB({
    json: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'n', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...primitive }] }],
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        ...(tail.length ? [{ buffer: 0, byteOffset: 36, byteLength: tail.length }] : []),
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
        ...(tail.length ? [{ bufferView: 1, componentType: 5126, count: tail.length / 4, type: 'SCALAR' }] : []),
      ],
      ...extra,
    },
    bin,
  });
}
/** Two keys moving node 0: the time and value accessors of a one-second slide, after the position accessor. */
const slide = {
  data: [0, 1, 0, 0, 0, 1, 0, 0],
  extra: {
    animations: [
      { channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 1, output: 2 }] },
    ],
  },
};
function slidingGLB(primitive = {}, more = {}) {
  const parts = splitGLB(handGLB({ primitive, ...slide }));
  parts.json.bufferViews[1].byteLength = 8;
  parts.json.bufferViews.push({ buffer: 0, byteOffset: 44, byteLength: 24 });
  parts.json.accessors[1] = { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] };
  parts.json.accessors[2] = { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' };
  Object.assign(parts.json, more);
  return joinGLB(parts);
}

test('a GLB primitive with no normals gets them from its faces, and one with no indices draws its vertices in order', async () => {
  const text = await usda(await exportAnimatedUSDZ(slidingGLB()));
  assert.match(text, /faceVertexIndices = \[0, 1, 2\]/);
  // The triangle lies in z = 0 and winds counter-clockwise from +z.
  assert.match(text, /normal3f\[\] normals = \[\(0, 0, 1\), \(0, 0, 1\), \(0, 0, 1\)\]/);
});

test('a GLB primitive that is not triangles is named and left out', async () => {
  await assert.rejects(exportAnimatedUSDZ(slidingGLB({ mode: 1 })), /at least one mesh/);
});

test('a channel with no node, as KHR_animation_pointer writes it, is named', async () => {
  const glb = slidingGLB();
  const parts = splitGLB(glb);
  parts.json.animations[0].channels.push({ sampler: 0, target: { path: 'pointer' } });
  const { skipped } = await exportAnimatedUSDZ(joinGLB(parts));
  assert.deepEqual(skipped, [{ kind: 'channel', target: 0 }]);
});

test('a texture that is not PNG or JPEG is named and the material stays', async () => {
  const material = {
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0, 0, 1] } }],
      textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
      images: [{ bufferView: 0, mimeType: 'image/webp' }],
    },
    { skipped, usdz } = await exportAnimatedUSDZ(slidingGLB({ material: 0 }, material));
  assert.deepEqual(skipped, [{ kind: 'texture', target: 0 }]);
  assert.match(await usda({ usdz }), /diffuseColor = \(1, 0, 0\)/);
});

test('more than four influences a vertex are refused with what to do', async () => {
  await assert.rejects(
    exportAnimatedUSDZ(
      slidingGLB({ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, JOINTS_1: 1, WEIGHTS_1: 2 } }),
    ),
    /more than four skin influences/,
  );
});

test('normalized integers read as the spec divides them', async () => {
  const parts = splitGLB(slidingGLB({ attributes: { POSITION: 0, TEXCOORD_0: 3 } }));
  const bytes = new Uint8Array(parts.bin.length + 8);
  bytes.set(parts.bin);
  // 65535 is 1 and 0 is 0, whatever the type's range.
  new Uint16Array(bytes.buffer, parts.bin.length, 4).set([65535, 0, 0, 65535]);
  parts.bin = bytes;
  parts.json.buffers[0].byteLength = bytes.length;
  parts.json.bufferViews.push({ buffer: 0, byteOffset: bytes.length - 8, byteLength: 8 });
  parts.json.accessors.push({ bufferView: 3, componentType: 5123, normalized: true, count: 2, type: 'VEC2' });
  // Two uvs for three vertices would be invalid, so the test reads what the reader makes of them.
  const { scene } = sceneOfGLB(joinGLB(parts));
  assert.deepEqual(Array.from(scene.nodes[0].primitives[0].geometry.uvs), [1, 0, 0, 1]);
});

test('a texture prefix that leaves the archive is refused here too', async () => {
  const node = { name: 'box', geometry: quad },
    source = {
      nodes: [node],
      animations: [{ channels: [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 0, 0] }] }],
    };
  await assert.rejects(exportAnimatedUSDZ(source, { texturePrefix: '../up/' }), /leaves the archive/);
});
