// node scripts/extract-skinning-ik-head-arm.js (requires built gltf-pro and geometry).
// Collects every vertex of examples/assets/skinning-ik.glb that UpperArm influences, moves it into the bind space of
// each joint that influences it (inverse bind matrix), keeps only the corners of each joint's convex hull
// (@margoengine/geometry convexGeometry), checks over 512 directions that the kept points support every plane the
// full set does, and writes examples/skinning-ik/arm-head-shape.ts.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { convexGeometry } from '../packages/geometry/dist/extras.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const bytes = await readFile('examples/assets/skinning-ik.glb'),
  doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))),
  asset = new GLTFAsset(doc, [bytes.subarray(28 + bytes.readUInt32LE(12))]);
const groups = new Map();
let selectedVertices = 0,
  maxWeightSumError = 0;
for (const node of doc.nodes) {
  if (node.mesh === undefined || node.skin === undefined) continue;
  const skin = doc.skins[node.skin],
    binds = asset.accessor(skin.inverseBindMatrices, 'MAT4');
  for (const primitive of doc.meshes[node.mesh].primitives) {
    const a = primitive.attributes,
      positions = asset.accessor(a.POSITION, 'VEC3'),
      joints = asset.accessor(a.JOINTS_0, 'VEC4'),
      weights = asset.accessor(a.WEIGHTS_0, 'VEC4');
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      let selected = false,
        sum = 0;
      for (let k = 0; k < 4; k++) {
        const weight = weights[vertex * 4 + k];
        assert.ok(weight >= 0 && Number.isFinite(weight));
        sum += weight;
        if (weight > 0 && doc.nodes[skin.joints[joints[vertex * 4 + k]]].name === 'UpperArm') selected = true;
      }
      if (!selected) continue;
      selectedVertices++;
      maxWeightSumError = Math.max(maxWeightSumError, Math.abs(sum - 1));
      const [x, y, z] = positions.subarray(vertex * 3, vertex * 3 + 3);
      for (let k = 0; k < 4; k++) {
        if (weights[vertex * 4 + k] === 0) continue;
        const slot = joints[vertex * 4 + k],
          name = doc.nodes[skin.joints[slot]].name,
          m = slot * 16;
        // Column-major glTF matrix times (x, y, z, 1).
        const point = [0, 1, 2].map(
          (r) => binds[m + r] * x + binds[m + 4 + r] * y + binds[m + 8 + r] * z + binds[m + 12 + r],
        );
        let points = groups.get(name);
        if (!points) groups.set(name, (points = new Map()));
        points.set(point.join(','), point);
      }
    }
  }
}
assert.deepEqual(
  [...groups.keys()].sort(),
  ['Forearm', 'UpperArm'],
  'New influences require updating ArmHeadClearance joint mapping',
);
assert.ok(maxWeightSumError < 1e-7, 'Skin weights exceed the numerical reserve assumptions');

/** The input points that are corners of their convex hull, in input order. */
function hullCorners(input) {
  // convexGeometry returns float32 positions; map each hull vertex back to the input point it came from.
  const { positions } = convexGeometry(input),
    keep = new Set();
  for (let v = 0; v < positions.length; v += 3) {
    let best = -1,
      bestDistance = Infinity;
    input.forEach((p, i) => {
      const d = Math.hypot(p[0] - positions[v], p[1] - positions[v + 1], p[2] - positions[v + 2]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    assert.ok(bestDistance < 1e-6, `hull vertex ${v / 3} is ${bestDistance} from every input point`);
    keep.add(best);
  }
  return [...keep].sort((a, b) => a - b).map((i) => input[i]);
}

const hulls = [],
  report = [];
for (const name of ['UpperArm', 'Forearm']) {
  const input = [...groups.get(name).values()],
    reduced = hullCorners(input);
  for (let sample = 0; sample < 512; sample++) {
    const direction = [Math.sin(sample * 1.7), Math.cos(sample * 0.71), Math.sin(sample * 0.37)],
      support = (points) =>
        Math.max(...points.map((p) => p[0] * direction[0] + p[1] * direction[1] + p[2] * direction[2]));
    assert.ok(Math.abs(support(input) - support(reduced)) < 1e-9, 'Hull reduction changed a support plane');
  }
  hulls.push(reduced);
  report.push({ name, input: input.length, hull: reduced.length });
}
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source =
  '// Generated from all actual UpperArm-influenced GLB vertices, including mounted parts and blended sleeves.\n' +
  '// Per-influence convex hull union conservatively contains every linearly skinned vertex.\n' +
  `// Source: examples/assets/skinning-ik.glb, SHA256 ${sha256}.\n` +
  '// Hull corners from @margoengine/geometry convexGeometry (scripts/extract-skinning-ik-head-arm.js).\n' +
  '// The maximum stored weight-sum error is ' +
  maxWeightSumError.toExponential(3) +
  '; the query adds a 100um numerical reserve.\n' +
  'export const armHeadHulls: readonly (readonly (readonly [number, number, number])[])[] = [\n' +
  hulls
    .map((hull) => '  [\n' + hull.map((point) => '    [' + point.join(', ') + '],').join('\n') + '\n  ],')
    .join('\n') +
  '\n];\n';
await writeFile('examples/skinning-ik/arm-head-shape.ts', source);
console.log(JSON.stringify({ sha256, selectedVertices, maxWeightSumError, groups: report }));
