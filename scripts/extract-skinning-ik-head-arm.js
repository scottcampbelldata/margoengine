// node scripts/extract-skinning-ik-head-arm.js (requires built gltf-pro and development dependencies).
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';

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
      for (let k = 0; k < 4; k++) {
        if (weights[vertex * 4 + k] === 0) continue;
        const slot = joints[vertex * 4 + k],
          name = doc.nodes[skin.joints[slot]].name,
          offset = slot * 16,
          x = positions[vertex * 3],
          y = positions[vertex * 3 + 1],
          z = positions[vertex * 3 + 2],
          point = [
            binds[offset] * x + binds[offset + 4] * y + binds[offset + 8] * z + binds[offset + 12],
            binds[offset + 1] * x + binds[offset + 5] * y + binds[offset + 9] * z + binds[offset + 13],
            binds[offset + 2] * x + binds[offset + 6] * y + binds[offset + 10] * z + binds[offset + 14],
          ];
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
const hulls = [],
  report = [];
for (const name of ['UpperArm', 'Forearm']) {
  const input = [...groups.get(name).values()],
    hull = new ConvexHull().setFromPoints(input.map((p) => new Vector3(...p))),
    vertices = new Set();
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      vertices.add(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  const reduced = [...vertices].map((point) => point.toArray());
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
