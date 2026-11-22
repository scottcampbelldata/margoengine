// @margoengine/humans: addPerson picks the looks by material name, plays the clips through an Animator with
// cross-fades, seeks as a pure function of time and takes everything off again. The frame against the hand-wired one is
// test/person-still.mjs (GPU).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf/dist/pbr.js';
import { addPerson, eyeLidMargin, personEye, personMaterials } from '../dist/index.js';
import { figure } from './figure.js';

test('the cast files get skin, eyes and strand hair on the materials named for them', () => {
  // Daniels' materials (blender-library station-daniels-v2.glb): no beard, a moustache, clothes that stay plain.
  const daniels = [
    'Brows',
    'EyeL',
    'EyeR',
    'Cap',
    'Teeth',
    'Tongue',
    'Skin',
    'Hair',
    'Lashes',
    'Moustache',
    'Shoes',
    'Suit',
    'Trousers',
  ];
  assert.deepEqual(personMaterials(daniels), {
    Skin: 'skin',
    EyeL: 'eyes',
    EyeR: 'eyes',
    Hair: 'hair',
    Brows: 'hair',
    Lashes: 'hair',
    Moustache: 'hair',
  });
  assert.deepEqual(personMaterials(daniels, { hair: false, eyes: false }), { Skin: 'skin' });
  assert.deepEqual(personMaterials(['Body_Skin', 'Iris'], { materials: { skin: ['Body_Skin'], eyes: ['Iris'] } }), {
    Body_Skin: 'skin',
    Iris: 'eyes',
  });
  assert.throws(() => personMaterials('Skin'), TypeError);
  assert.throws(() => personMaterials(['Skin'], { materials: { skin: 'Skin' } }), TypeError);
});

// A two-bone figure with one triangle and two clips (the Animator behaviour runs on a GPU in test/person-still.mjs).
async function scene(t) {
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    { doc, buffers } = figure(),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers));
  t.after(() => {
    model.dispose();
    engine.dispose();
  });
  return { engine, model };
}

test('addPerson checks its options before it changes anything', async (t) => {
  const { engine, model } = await scene(t);
  await assert.rejects(addPerson(engine, {}), TypeError);
  await assert.rejects(addPerson(engine, model, { clip: 'run' }), RangeError);
  await assert.rejects(addPerson(engine, model, { fade: -1 }), RangeError);
  await assert.rejects(addPerson(engine, model, { skinning: 'smooth' }), TypeError);
  await assert.rejects(addPerson(engine, model, { shadows: {} }), TypeError);
  await assert.rejects(addPerson(engine, model, { materials: { hair: 'Hair' } }), TypeError);
  await assert.rejects(addPerson(engine, model, { materials: { shells: 'Std_Cornea_L' } }), TypeError);
  assert.equal(engine.plugins.size, 0, 'nothing was attached');
});

test('Character Creator names get their looks, and a skinned CC eyeball is fitted and follows its joint', async (t) => {
  const cc = [
    'Std_Skin_Head',
    'Std_Skin_Body',
    'Std_Eye_R',
    'Std_Cornea_R',
    'Std_Tearline_R',
    'Std_Eye_Occlusion_R',
    'Boxers',
  ];
  assert.deepEqual(personMaterials(cc), {
    Std_Skin_Head: 'skin',
    Std_Skin_Body: 'skin',
    Std_Eye_R: 'eyes',
  });
  assert.deepEqual(personMaterials(cc, { eyes: false }), { Std_Skin_Head: 'skin', Std_Skin_Body: 'skin' });
  // A CC-like eyeball: a UV sphere of radius 0.012 m at (0.03, 1.6, 0.07), its map's middle at the front (+z), the
  // iris rim 0.123 from the middle at 25 degrees off the axis, every vertex weighted to the 'eye' joint (node 1).
  const centre = [0.03, 1.6, 0.07],
    radius = 0.012,
    positions = [],
    uvs = [],
    indices = [];
  const rings = 18,
    segments = 24,
    // Polar angle to map radius, as CC lays it out: 25 degrees reaches 0.123, 90 degrees reaches 0.5.
    rho = (a) => (a <= 25 ? (0.123 * a) / 25 : 0.123 + ((0.5 - 0.123) * (a - 25)) / 155);
  for (let r = 0; r <= rings; r++) {
    const a = (180 * r) / rings;
    for (let s = 0; s <= segments; s++) {
      const b = (2 * Math.PI * s) / segments,
        th = (a * Math.PI) / 180;
      positions.push(
        centre[0] + radius * Math.sin(th) * Math.cos(b),
        centre[1] + radius * Math.sin(th) * Math.sin(b),
        centre[2] + radius * Math.cos(th),
      );
      uvs.push(0.5 + rho(a) * Math.cos(b), 0.5 + rho(a) * Math.sin(b));
    }
  }
  // A ring at exactly 25 degrees so the fit sees the rim.
  for (let s = 0; s < segments; s++) {
    const b = (2 * Math.PI * s) / segments,
      th = (25 * Math.PI) / 180;
    positions.push(
      centre[0] + radius * Math.sin(th) * Math.cos(b),
      centre[1] + radius * Math.sin(th) * Math.sin(b),
      centre[2] + radius * Math.cos(th),
    );
    uvs.push(0.5 + 0.123 * Math.cos(b), 0.5 + 0.123 * Math.sin(b));
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
    }
  const count = positions.length / 3,
    buffers = [],
    bufferViews = [],
    accessors = [];
  const add = (data, type, componentType = 5126, extra = {}) => {
    buffers.push(new Uint8Array(data.buffer));
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: buffers.length - 1,
      componentType,
      count: data.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type],
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const low = [0, 1, 2].map((i) => centre[i] - radius),
    high = [0, 1, 2].map((i) => centre[i] + radius);
  const attributes = {
    POSITION: add(new Float32Array(positions), 'VEC3', 5126, { min: low, max: high }),
    TEXCOORD_0: add(new Float32Array(uvs), 'VEC2'),
    JOINTS_0: add(
      new Uint16Array(count * 4).map((_, k) => (k % 4 ? 0 : 1)),
      'VEC4',
      5123,
    ),
    WEIGHTS_0: add(
      new Float32Array(count * 4).map((_, k) => (k % 4 ? 0 : 1)),
      'VEC4',
    ),
  };
  // The eye joint sits at the eyeball's centre; its inverse bind matrix undoes that.
  const ibm = add(
    new Float32Array([
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      -centre[0],
      -centre[1],
      -centre[2],
      1,
    ]),
    'MAT4',
  );
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 3] }],
    nodes: [
      { name: 'root' },
      { name: 'CC_Base_R_Eye', translation: centre, children: [] },
      {},
      { name: 'CC_Base_Eye', mesh: 0, skin: 0 },
    ],
    skins: [{ joints: [0, 1], inverseBindMatrices: ibm }],
    meshes: [{ primitives: [{ attributes, indices: add(new Uint32Array(indices), 'SCALAR', 5125), material: 0 }] }],
    materials: [{ name: 'Std_Eye_R' }],
    accessors,
    bufferViews,
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
  };
  const store = await TransformStore.create(64),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, buffers));
  t.after(() => {
    model.dispose();
    engine.dispose();
  });
  const fit = await personEye(model, model.primitives[0]);
  fit.center.forEach((v, i) => assert.ok(Math.abs(v - centre[i]) < 1e-6, `centre ${fit.center}`));
  fit.axis.forEach((v, i) => assert.ok(Math.abs(v - [0, 0, 1][i]) < 1e-6, `axis ${fit.axis}`));
  assert.ok(Math.abs(fit.irisRadius - Math.sin((25 * Math.PI) / 180)) < 0.02, `iris radius ${fit.irisRadius}`);
  // At rest the joint's skin matrix is the identity; turned 90 degrees about y and lifted, it carries the eye along.
  engine.store.tick(false);
  const rest = fit.follow();
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((v, i) =>
    assert.ok(Math.abs(rest[i] - v) < 1e-6, `rest ${[...rest]}`),
  );
  const joint = model.nodes[1];
  joint.rotation.set(0, Math.PI / 2, 0);
  joint.position.set(centre[0], centre[1] + 0.05, centre[2]);
  engine.store.tick(false);
  const m = fit.follow(),
    at = [0, 1, 2].map((r) => m[r] * centre[0] + m[4 + r] * centre[1] + m[8 + r] * centre[2] + m[12 + r]),
    look = [0, 1, 2].map((r) => m[8 + r]);
  at.forEach((v, i) =>
    assert.ok(Math.abs(v - [centre[0], centre[1] + 0.05, centre[2]][i]) < 1e-6, `moved centre ${at}`),
  );
  look.forEach((v, i) => assert.ok(Math.abs(v - [1, 0, 0][i]) < 1e-6, `turned axis ${look}`));
  await assert.rejects(personEye(model, {}), TypeError);
});

// The upper lid's margin over an eye, measured on the head's skin seen along the eye's axis: a sheet of skin in front of
// a ball of radius 2 at (1, 2, 3), open below the arc 0.2 + 0.1 s - 0.4 s^2 radii (s radii toward the eye's right, x).
test('eyeLidMargin finds the upper lid margin a head skin leaves over an eye', () => {
  const center = [1, 2, 3],
    radius = 2,
    arc = (s) => 0.2 + 0.1 * s - 0.4 * s * s,
    positions = [],
    indices = [];
  for (let k = 0; k < 160; k++) {
    const s0 = -1 + k / 80,
      s1 = -1 + (k + 1) / 80,
      base = positions.length / 3;
    // A column of skin from the arc up to two radii above the centre, 1.2 radii in front of it.
    for (const [s, h] of [
      [s0, arc(s0)],
      [s1, arc(s1)],
      [s1, 2],
      [s0, 2],
    ])
      positions.push(center[0] + radius * s, center[1] + radius * h, center[2] + 1.2 * radius);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const lid = eyeLidMargin({ center, axis: [0, 0, 1], radius }, { positions, indices });
  // Nine columns from -0.6 to 0.6; at -0.6 the arc is below the axis (the skin hides the axis point), so that one is left out.
  assert.equal(lid.columns, 8);
  assert.ok(
    Math.abs(lid.height - 0.2) < 0.002 && Math.abs(lid.tilt - 0.1) < 0.002 && Math.abs(lid.curve + 0.4) < 0.005,
    JSON.stringify(lid),
  );
  // No skin in front: no lid.
  assert.equal(eyeLidMargin({ center, axis: [0, 0, 1], radius }, { positions: [], indices: [] }), undefined);
});

test('eyeLidMargin finds the lower lid margin under the eye the same way', () => {
  const center = [1, 2, 3],
    radius = 2,
    upperArc = (s) => 0.2 - 0.4 * s * s,
    lowerArc = (s) => -0.42 - 0.05 * s + 0.3 * s * s,
    positions = [],
    indices = [];
  for (let k = 0; k < 160; k++) {
    const s0 = -1 + k / 80,
      s1 = -1 + (k + 1) / 80;
    // Skin above the upper arc and below the lower one, 1.2 radii in front of the centre.
    for (const quad of [
      [
        [s0, upperArc(s0)],
        [s1, upperArc(s1)],
        [s1, 2],
        [s0, 2],
      ],
      [
        [s0, -2],
        [s1, -2],
        [s1, lowerArc(s1)],
        [s0, lowerArc(s0)],
      ],
    ]) {
      const base = positions.length / 3;
      for (const [s, h] of quad)
        positions.push(center[0] + radius * s, center[1] + radius * h, center[2] + 1.2 * radius);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const lid = eyeLidMargin({ center, axis: [0, 0, 1], radius }, { positions, indices });
  assert.ok(Math.abs(lid.height - 0.2) < 0.002 && Math.abs(lid.curve + 0.4) < 0.005, JSON.stringify(lid));
  const { lower } = lid;
  assert.equal(lower.columns, 9);
  assert.ok(
    Math.abs(lower.height + 0.42) < 0.002 && Math.abs(lower.tilt + 0.05) < 0.002 && Math.abs(lower.curve - 0.3) < 0.005,
    JSON.stringify(lower),
  );
});
