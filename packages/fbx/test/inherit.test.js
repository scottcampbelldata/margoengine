// Inherit types: a real Maya file that mixes them under uneven animated scale, against the frames Maya wrote, then the
// formula on hand-written files whose results were worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertFBX } from '../dist/index.js';
import { animationLayers } from '../dist/layers.js';
import { assertFrame, farthest, posed } from './frame-truth.js';
import { readGLB } from './native-scene-helper.js';

const real = (name) => readFileSync(new URL(`./fixtures/real/${name}`, import.meta.url)),
  encode = (text) => new TextEncoder().encode(text);

// One triangle on the last of a chain; each entry is a node's inherit type and its properties.
const chain = (...nodes) =>
  encode(`; FBX 7.4.0 project file
FBXHeaderExtension: { FBXVersion: 7400 }
Objects: {
 Geometry: 10, "Geometry::G", "Mesh" {
  Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
  PolygonVertexIndex: *3 { a: 0,1,-3 }
 }${nodes
   .map(
     ([type, props], i) => `
 Model: ${i + 1}, "Model::N${i}", "${i === nodes.length - 1 ? 'Mesh' : 'Null'}" { Properties70: {
  P: "InheritType", "enum", "", "", ${type}
  ${props}
 } }`,
   )
   .join('')}
}
Connections: {${nodes
    .map(
      (_, i) => `
 C: "OO",${i + 1},${i}`,
    )
    .join('')}
 C: "OO",10,${nodes.length}
}
`);
const lcl = (name, ...v) => `P: "Lcl ${name}", "Lcl ${name}", "", "A", ${v.join(',')}`;

test('real Maya file: inherit types 1 and 2 mixed under uneven animated scale match every frame Maya wrote', async () => {
  const buffer = await convertFBX(real('maya_mixed_inherit_mode_7700_ascii.fbx'), { extensions: [animationLayers] });
  // The OBJ frames hold six decimals. Without the right bind matrix frame 0 is 10 cm off, without the clamp frame 5 is
  // 0.46 cm off, and with the SDK order for type 2 frame 7 is 15 cm off.
  for (let frame = 0; frame < 8; frame++)
    assertFrame(buffer, frame / 24, real(`maya_mixed_inherit_mode_${frame}.obj`).toString(), 0.001, `frame ${frame}`);
});

test('real Maya file: every rotation order matches the frame Maya wrote', async () => {
  const buffer = await convertFBX(real('maya_rotation_order_7500_binary.fbx'), { extensions: [animationLayers] });
  assertFrame(buffer, 0, real('maya_rotation_order.obj').toString(), 0.001, 'rotation orders');
});

test("type 2 takes the parent's own scale away before the child's rotation, and keeps it on the translation", async () => {
  const buffer = await convertFBX(
    chain([1, lcl('Scaling', 2, 1, 1)], [2, `${lcl('Translation', 1, 0, 0)}\n${lcl('Rotation', 0, 0, 90)}`]),
  );
  // S(2,1,1) T(1,0,0) S^-1 Rz(90) on the triangle: its corners go to (2,0), (2,1) and (1,0).
  const want = [
    [2, 0, 0],
    [2, 1, 0],
    [1, 0, 0],
  ];
  assert.ok(farthest(posed(buffer, 0), want) < 1e-6);
});

test('type 0 below a sheared parent keeps its world on an empty parent of the hierarchy', async () => {
  const buffer = await convertFBX(
    chain([1, lcl('Scaling', 2, 1, 1)], [1, lcl('Rotation', 0, 0, 45)], [0, lcl('Translation', 1, 0, 0)]),
  );
  // The parent's columns are (2c, c) and (-2c, c) at 45 degrees. The triangle starts at the first, and its edges are the
  // parent's rotation, the first column made unit, times each column's length, which is the first column and its normal.
  const c = Math.SQRT1_2,
    want = [
      [2 * c, c, 0],
      [4 * c, 2 * c, 0],
      [c, 3 * c, 0],
    ];
  assert.ok(farthest(posed(buffer, 0), want) < 1e-6);
  const { doc } = readGLB(buffer);
  assert.equal(doc.scenes[0].nodes.length, 1);
  assert.equal(doc.nodes[doc.scenes[0].nodes[0]].name, 'N0 group');
});

test('an inherit type that does not exist is refused by name', async () => {
  await assert.rejects(convertFBX(chain([1, ''], [3, ''])), /unsupported InheritType 3 on N1/);
});
