import test from 'node:test';
import assert from 'node:assert/strict';
import validator from 'gltf-validator';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { Animation } from '@margoengine/animation';
import { headlessEngine } from '../../exporters/tests/helpers.js';
import { convertFBX } from '../dist/index.js';
import { identity, rigFixture, readGLB, transformAnimationFixture } from './native-scene-helper.js';

const bytes = (source) => new TextEncoder().encode(source);
const close = (actual, expected, epsilon = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon, `${i}: ${value} != ${expected[i]}`));
};
async function valid(buffer) {
  const report = await validator.validateBytes(new Uint8Array(buffer));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
  // This fixture intentionally retains a translated mesh node to test mesh-local bind
  // cancellation. glTF warns that this transform itself does not move the skinned mesh.
  for (const issue of report.issues.messages.filter((issue) => issue.severity === 1))
    assert.equal(issue.code, 'NODE_SKINNED_MESH_LOCAL_TRANSFORMS');
}

test('native rig preserves mesh bind space, geometric offsets, morphs and timed skeletal motion', async () => {
  const buffer = await convertFBX(bytes(rigFixture()));
  await valid(buffer);
  const { doc, bin, accessor } = readGLB(buffer),
    meshIndex = doc.nodes.findIndex((node) => node.name === 'Mesh'),
    tipIndex = doc.nodes.findIndex((node) => node.name === 'Tip'),
    mesh = doc.nodes[meshIndex],
    primitive = doc.meshes[mesh.mesh].primitives[0],
    skin = doc.skins[mesh.skin];
  close(accessor(primitive.attributes.POSITION), [3, 0, 0, 4, 0, 0, 3, 1, 0]);
  close(accessor(primitive.attributes.WEIGHTS_0), [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0]);
  close(accessor(primitive.targets[0].POSITION), [0, 0, 0, 0, 0.5, 0, 0, 0, 0]);
  assert.deepEqual(mesh.weights, [0.5]);
  assert.deepEqual(doc.meshes[mesh.mesh].extras.targetNames, ['Raise']);
  const ibm = accessor(skin.inverseBindMatrices);
  assert.equal(ibm[12], 2);
  assert.equal(ibm[28], 1);
  const engine = await headlessEngine(),
    model = new PBRModel(engine, new GLTFAsset(doc, [bin])),
    animation = new Animation(model, { loop: false });
  engine.store.tick(false);
  const meshWorld = model.nodes[meshIndex].matrix,
    tipWorld = model.nodes[tipIndex].matrix;
  assert.equal(
    -meshWorld[12] + tipWorld[12] + ibm[28],
    0,
    'bind palette is identity even with mesh/geometric translations',
  );
  animation.play('Move').seek(0.5);
  engine.store.tick(false);
  assert.equal(model.nodes[tipIndex].matrix[12], 1.5);
  assert.equal(
    -model.nodes[meshIndex].matrix[12] + model.nodes[tipIndex].matrix[12] + ibm[28],
    0.5,
    'tip influence moves half a unit at midpoint',
  );
  close(model.primitives[0].weights, [0.75]);
  animation.dispose();
  model.dispose();
  engine.dispose();
});

test('native coordinate conversion scales geometry, morphs, node translations and bind matrices consistently', async () => {
  const buffer = await convertFBX(bytes(rigFixture({ units: 1 })));
  await valid(buffer);
  const { doc, accessor } = readGLB(buffer),
    mesh = doc.nodes.find((node) => node.name === 'Mesh'),
    primitive = doc.meshes[mesh.mesh].primitives[0];
  close(mesh.translation, [0.02, 0, 0]);
  close(accessor(primitive.attributes.POSITION), [0.03, 0, 0, 0.04, 0, 0, 0.03, 0.01, 0]);
  close(accessor(primitive.targets[0].POSITION), [0, 0, 0, 0, 0.005, 0, 0, 0, 0]);
  const ibm = accessor(doc.skins[mesh.skin].inverseBindMatrices);
  assert.ok(Math.abs(ibm[12] - 0.02) < 1e-7);
  assert.ok(Math.abs(ibm[28] - 0.01) < 1e-7);
});

test('native skin keeps the four strongest control-point influences and normalizes them', async () => {
  const bind = identity.slice();
  bind[12] = 2;
  const extraModel = [0.3, 0.4, 0.5]
    .map(
      (weight, index) =>
        `Model: ${5 + index}, "Model::Joint${index + 2}", "LimbNode" {\n}\n Deformer: ${13 + index}, "SubDeformer::Joint${index + 2}", "Cluster" {\n Mode: "Normalize"\n Indexes: *3 {\n a: 0,1,2\n}\n Weights: *3 {\n a: ${weight},${weight},${weight}\n}\n Transform: *16 {\n a: ${bind.join(',')}\n}\n TransformLink: *16 {\n a: ${identity.join(',')}\n}\n}`,
    )
    .join('\n');
  const extraConnections = [0, 1, 2]
    .map((index) => `C: "OO",${5 + index},3\n C: "OO",${13 + index},10\n C: "OO",${5 + index},${13 + index}`)
    .join('\n');
  const source = rigFixture({ morph: false, animation: false, extraModel, extraConnections })
    .replace('a: 0.5,0.5,0.5', 'a: 0.1,0.1,0.1')
    .replace('a: 0.5,0.5,0.5', 'a: 0.2,0.2,0.2');
  const buffer = await convertFBX(bytes(source));
  await valid(buffer);
  const { doc, accessor } = readGLB(buffer),
    primitive = doc.meshes[0].primitives[0],
    joints = accessor(primitive.attributes.JOINTS_0),
    weights = accessor(primitive.attributes.WEIGHTS_0);
  for (let vertex = 0; vertex < 3; vertex++) {
    close(joints.subarray(vertex * 4, vertex * 4 + 4), [4, 3, 2, 1], 0);
    close(weights.subarray(vertex * 4, vertex * 4 + 4), [0.5 / 1.4, 0.4 / 1.4, 0.3 / 1.4, 0.2 / 1.4]);
  }
});

test('native UV seams copy skin influences and morph deltas from the original control point', async () => {
  const polygons =
    'PolygonVertexIndex: *6 {\n a: 0,1,-3,0,2,-4\n}\n LayerElementUV: 0 {\n MappingInformationType: "ByPolygonVertex"\n ReferenceInformationType: "Direct"\n UV: *12 {\n a: 0,0,1,0,1,1,0.5,0,1,1,0,1\n}\n}';
  const source = rigFixture({ animation: false })
    .replace('Vertices: *9 {\n a: 0,0,0,1,0,0,0,1,0\n}', 'Vertices: *12 {\n a: 0,0,0,1,0,0,1,1,0,0,1,0\n}')
    .replace('PolygonVertexIndex: *3 {\n a: 0,1,-3\n}', polygons)
    .replaceAll('Indexes: *3 {\n a: 0,1,2\n}', 'Indexes: *4 {\n a: 0,1,2,3\n}')
    .replace('Weights: *3 {\n a: 0.5,0.5,0.5\n}', 'Weights: *4 {\n a: 0.8,0.7,0.6,0.5\n}')
    .replace('Weights: *3 {\n a: 0.5,0.5,0.5\n}', 'Weights: *4 {\n a: 0.2,0.3,0.4,0.5\n}')
    .replace('Indexes: *1 {\n a: 1\n}', 'Indexes: *1 {\n a: 0\n}');
  const buffer = await convertFBX(bytes(source));
  await valid(buffer);
  const { doc, accessor } = readGLB(buffer),
    primitive = doc.meshes[0].primitives[0],
    positions = accessor(primitive.attributes.POSITION),
    uvs = accessor(primitive.attributes.TEXCOORD_0),
    joints = accessor(primitive.attributes.JOINTS_0),
    weights = accessor(primitive.attributes.WEIGHTS_0),
    deltas = accessor(primitive.targets[0].POSITION);
  const seam = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const x = positions[vertex * 3] - 3,
      y = positions[vertex * 3 + 1],
      rootWeight = x === 0 ? (y === 0 ? 0.8 : 0.5) : y === 0 ? 0.7 : 0.6;
    close(weights.subarray(vertex * 4, vertex * 4 + 4), [rootWeight, 1 - rootWeight, 0, 0]);
    close(joints.subarray(vertex * 4, vertex * 4 + 4), [0, 1, 0, 0], 0);
    close(deltas.subarray(vertex * 3, vertex * 3 + 3), x === 0 && y === 0 ? [0, 0.5, 0] : [0, 0, 0]);
    if (x === 0 && y === 0) seam.push(vertex);
  }
  assert.equal(seam.length, 2);
  assert.notEqual(uvs[seam[0] * 2], uvs[seam[1] * 2], 'one source control point has two UVs');
});

test('native scene rejects unsupported inheritance, missing bind data and progressive morphs', async () => {
  const source = rigFixture();
  const cases = [
    [
      source.replace('Model: 3, "Model::Root", "LimbNode" {', 'Model: 3, "Model::Root", "LimbNode" {\n InheritType: 2'),
      /InheritType/,
    ],
    [source.replace('TransformLink: *16', 'MissingTransformLink: *16'), /bind matrix/i],
    [source.replace('a: 100\n', 'a: 50\n'), /progressive morph/i],
    [source.replace('Mode: "Normalize"', 'Mode: "Additive"'), /cluster mode/i],
    [source.replace('Mode: "Normalize"', 'Mode: "TotalOne"'), /cluster mode/i],
    [source.replace('a: 4,4\n', 'a: 8,8\n'), /cubic animation/i],
    [source.replace('a: 4,4\n', 'a: 258,258\n'), /constant-next/i],
    [
      source.replace(
        'AnimationLayer: 31, "AnimLayer::Base", "" {',
        'AnimationLayer: 31, "AnimLayer::Base", "" {\n BlendMode: 1',
      ),
      /layer mode/i,
    ],
    [
      source.replace('C: "OP",32,4,"Lcl Translation"', 'C: "OP",32,3,"Lcl Scaling"'),
      /animated nonuniform parent scale/i,
    ],
  ];
  for (const [fixture, pattern] of cases) await assert.rejects(convertFBX(bytes(fixture)), pattern);
});

async function animatedModel(source) {
  const buffer = await convertFBX(bytes(source));
  await valid(buffer);
  const { doc, bin, accessor } = readGLB(buffer),
    engine = await headlessEngine(),
    model = new PBRModel(engine, new GLTFAsset(doc, [bin])),
    animation = new Animation(model, { loop: false }),
    node = model.nodes[doc.nodes.findIndex((node) => node.name === 'Mesh')];
  animation.play('Transform');
  return {
    doc,
    accessor,
    sample(time) {
      animation.seek(time);
      engine.store.tick(false);
      return node.matrix;
    },
    dispose() {
      animation.dispose();
      model.dispose();
      engine.dispose();
    },
  };
}

test('native transform baking preserves complete positive and negative spins between Euler keys', async () => {
  for (const turns of [360, -720]) {
    const result = await animatedModel(
      transformAnimationFixture({ curves: [{ axis: 'Z', times: [0, 1], values: [0, turns] }] }),
    );
    try {
      const sampler = result.doc.animations[0].samplers[0];
      assert.ok(result.accessor(sampler.input).length >= 9, 'spin has enough samples to preserve its path');
      for (const t of [0.0625, 0.173, 0.25, 0.371, 0.5, 0.625, 0.827, 0.9375]) {
        const matrix = result.sample(t),
          angle = (turns * t * Math.PI) / 180,
          c = Math.cos(angle),
          s = Math.sin(angle);
        close([matrix[0], matrix[1], matrix[4], matrix[5]], [c, s, -s, c], 1.1e-4);
      }
    } finally {
      result.dispose();
    }
  }
});

test('native transform baking follows simultaneous Euler axes and circular rotation-pivot motion', async () => {
  const pivot = [0.2, 0.3, 0],
    result = await animatedModel(
      transformAnimationFixture({
        pivot,
        curves: [
          { axis: 'X', times: [0, 1], values: [0, 90] },
          { axis: 'Y', times: [0, 1], values: [0, 90] },
        ],
      }),
    );
  try {
    const paths = result.doc.animations[0].channels.map((channel) => channel.target.path);
    assert.ok(paths.includes('translation'));
    assert.ok(paths.includes('rotation'));
    for (const time of [0.031, 0.173, 0.371, 0.567, 0.827, 0.973]) {
      const angle = (time * Math.PI) / 2,
        c = Math.cos(angle),
        s = Math.sin(angle),
        matrix = result.sample(time);
      // FBX fixed-axis XYZ applies Rx first, then Ry. Expected R = Ry * Rx.
      close(
        [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]],
        [c, 0, -s, s * s, c, c * s, s * c, -s, c * c],
        1.1e-4,
      );
      close(
        [matrix[12], matrix[13], matrix[14]],
        [pivot[0] - (c * pivot[0] + s * s * pivot[1]), pivot[1] - c * pivot[1], s * pivot[0] - c * s * pivot[1]],
        2e-5,
      );
    }
  } finally {
    result.dispose();
  }
});

test('native animation unions axis keys and interpolates each axis at the other axis times', async () => {
  const result = await animatedModel(
    transformAnimationFixture({
      path: 'Lcl Translation',
      curves: [
        { axis: 'X', times: [0, 1], values: [0, 2] },
        { axis: 'Y', times: [0, 0.5, 1], values: [0, 1, 0] },
      ],
    }),
  );
  try {
    const sampler = result.doc.animations[0].samplers[0];
    close(result.accessor(sampler.input), [0, 0.5, 1]);
    close(result.accessor(sampler.output), [0, 0, 0, 1, 1, 0, 2, 0, 0]);
    for (const time of [0.25, 0.75]) {
      const matrix = result.sample(time);
      close([matrix[12], matrix[13], matrix[14]], [time * 2, 0.5, 0]);
    }
  } finally {
    result.dispose();
  }
});

test('native right-handed Y-up and Blender Z-up axis metadata preserve handedness and winding', async () => {
  // Blender's first-party RIGHT_HAND_AXES table identifies these exact serialized
  // tuples: ('Y','-Z') => Up Y+, Front Z+, Coord X+; ('Z','Y') => Up Z+, Front Y-, Coord X+.
  for (const [up, front, frontSign, positions, normal] of [
    [1, 2, 1, [0, 0, 2, 1, 0, 2, 0, 1, 2], [0, 0, 1]],
    [2, 1, -1, [0, 2, 0, 1, 2, 0, 0, 2, -1], [0, 1, 0]],
  ]) {
    const settings = `P: "UpAxis", "int", "Integer", "", ${up}\n P: "UpAxisSign", "int", "Integer", "", 1\n P: "FrontAxis", "int", "Integer", "", ${front}\n P: "FrontAxisSign", "int", "Integer", "", ${frontSign}\n P: "CoordAxis", "int", "Integer", "", 0\n P: "CoordAxisSign", "int", "Integer", "", 1`;
    const fixture = rigFixture({
      units: 100,
      skin: false,
      morph: false,
      animation: false,
      meshTranslation: [0, 0, 0],
      geometric: [0, 0, 0],
    })
      .replace(
        'P: "UnitScaleFactor", "double", "Number", "", 100',
        `P: "UnitScaleFactor", "double", "Number", "", 100\n ${settings}`,
      )
      .replace('a: 0,0,0,1,0,0,0,1,0', 'a: 0,0,2,1,0,2,0,1,2');
    const buffer = await convertFBX(bytes(fixture));
    await valid(buffer);
    const { doc, accessor } = readGLB(buffer),
      primitive = doc.meshes[0].primitives[0];
    close(accessor(primitive.attributes.POSITION), positions);
    close(accessor(primitive.attributes.NORMAL), [...normal, ...normal, ...normal]);
    close(accessor(primitive.indices), [0, 1, 2], 0);
  }
});
