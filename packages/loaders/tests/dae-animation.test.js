import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoaderError,
  bindDAESkin,
  daeKeyframeClip,
  daeNodeNames,
  flattenDAE,
  morphDAE,
  parseDAE,
  poseDAE,
  sampleDAESampler,
} from '../dist/index.js';

const close = (actual, expected, label, epsilon = 1e-5) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < epsilon, `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
};
const rejects = (fn, code, pattern) =>
  assert.throws(
    fn,
    (error) => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)),
  );
const floats = (id, values, stride = 1, param = 'X') =>
  `<source id="${id}"><float_array id="${id}-a" count="${values.length}">${values.join(' ')}</float_array>` +
  `<technique_common><accessor source="#${id}-a" count="${values.length / stride}" stride="${stride}">` +
  `<param name="${param}" type="float"/></accessor></technique_common></source>`;
const xyz = (id, values) =>
  `<source id="${id}"><float_array id="${id}-a" count="${values.length}">${values.join(' ')}</float_array>` +
  `<technique_common><accessor source="#${id}-a" count="${values.length / 3}" stride="3">` +
  '<param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor>' +
  '</technique_common></source>';
const names = (id, values, type = 'Name_array', param = 'JOINT') =>
  `<source id="${id}"><${type} id="${id}-a" count="${values.length}">${values.join(' ')}</${type}>` +
  `<technique_common><accessor source="#${id}-a" count="${values.length}"><param name="${param}" type="name"/>` +
  '</accessor></technique_common></source>';
const sampler = (id, times, values, stride, interpolation, extra = '') =>
  floats(`${id}-in`, times, 1, 'TIME') +
  floats(`${id}-out`, values, stride) +
  names(`${id}-interp`, interpolation, 'Name_array', 'INTERPOLATION') +
  extra +
  `<sampler id="${id}"><input semantic="INPUT" source="#${id}-in"/><input semantic="OUTPUT" source="#${id}-out"/>` +
  `<input semantic="INTERPOLATION" source="#${id}-interp"/>` +
  (extra
    ? `<input semantic="IN_TANGENT" source="#${id}-intan"/><input semantic="OUT_TANGENT" source="#${id}-outtan"/>`
    : '') +
  '</sampler>';
const document = (asset, body) =>
  `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">` +
  `<asset>${asset}</asset>${body}<scene><instance_visual_scene url="#scene"/></scene></COLLADA>`;
const YUP = '<unit meter="1"/><up_axis>Y_UP</up_axis>';

// A bar of six positions two units tall, skinned to two joints: the root at the origin and the tip one unit up,
// bent 90 degrees about Z between t = 0 and t = 1. Position 3 has five influences (cut to the strongest four).
const skinned = (asset = YUP, joints = names('joints', ['J0', 'J1']), extra = '') =>
  document(
    asset,
    `<library_geometries><geometry id="bar"><mesh>
      ${xyz('bar-p', [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0, 1, 2, 0])}
      ${xyz('bar-n', [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])}
      <vertices id="bar-v"><input semantic="POSITION" source="#bar-p"/><input semantic="NORMAL" source="#bar-n"/></vertices>
      <triangles count="4"><input semantic="VERTEX" source="#bar-v" offset="0"/><p>0 1 3 0 3 2 2 3 5 2 5 4</p></triangles>
    </mesh></geometry></library_geometries>
    <library_controllers><controller id="bar-skin" name="BarSkin"><skin source="#bar">
      <bind_shape_matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</bind_shape_matrix>
      ${joints}
      ${floats('binds', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1], 16, 'TRANSFORM')}
      ${floats('w', [1, 0.5, 0.4, 0.1, 0.05], 1, 'WEIGHT')}
      <joints><input semantic="JOINT" source="#joints"/><input semantic="INV_BIND_MATRIX" source="#binds"/></joints>
      <vertex_weights count="6">
        <input semantic="JOINT" source="#joints" offset="0"/><input semantic="WEIGHT" source="#w" offset="1"/>
        <vcount>1 1 2 5 1 1</vcount>
        <v>0 0 0 0 0 1 1 1 0 2 1 2 0 3 1 4 0 4 1 0 1 0</v>
      </vertex_weights>
    </skin></controller></library_controllers>
    <library_animations><animation id="bend">
      ${sampler('bend-s', [0, 1], [0, 90], 1, ['LINEAR', 'LINEAR'])}
      <channel source="#bend-s" target="tip/rz.ANGLE"/>
    </animation></library_animations>
    <library_visual_scenes><visual_scene id="scene">
      <node id="root" sid="J0" name="Root" type="JOINT">
        <node id="tip" sid="J1" name="Tip" type="JOINT"><translate sid="t">0 1 0</translate><rotate sid="rz">0 0 1 0</rotate></node>
      </node>
      <node id="bar-node"><instance_controller url="#bar-skin"><skeleton>#root</skeleton></instance_controller></node>
      ${extra}
    </visual_scene></library_visual_scenes>`,
  );

// Posed positions by position index at t = 1 and t = 0.5, worked out by hand: the tip joint turns the points above
// y = 1 about (0, 1); position 3 blends the root (0.5 / 0.95) and the tip (0.45 / 0.95).
const POSED_1 = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0.5 / 0.95, (0.5 + 0.45 * 2) / 0.95, 0],
  [-1, 1, 0],
  [-1, 2, 0],
];
const s = Math.SQRT1_2;
const POSED_HALF = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [(0.5 + 0.45 * s) / 0.95, (0.5 + 0.45 * (1 + s)) / 0.95, 0],
  [-s, 1 + s, 0],
  [s - s, 1 + 2 * s, 0],
];
const byCorner = (geometry, posed) => [...geometry.positionIndices].flatMap((p) => posed[p]);

test('DAE skin: joints, inverse bind matrices and four normalised influences per position', () => {
  const dae = parseDAE(skinned());
  assert.deepEqual(dae.warnings, []);
  assert.equal(dae.skins.length, 1);
  const [skin] = dae.skins;
  assert.equal(skin.id, 'bar-skin');
  assert.equal(skin.name, 'BarSkin');
  assert.equal(skin.geometry, 0);
  assert.deepEqual(skin.joints, ['J0', 'J1']);
  close(
    skin.inverseBindMatrices,
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1],
    'ibm',
  );
  close(skin.bindShapeMatrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'bind shape');
  assert.deepEqual([...skin.vertexJoints.subarray(8, 16)], [0, 1, 0, 0, 0, 1, 0, 1]);
  close(
    skin.vertexWeights.subarray(8, 16),
    [0.5, 0.5, 0, 0, 0.4 / 0.95, 0.4 / 0.95, 0.1 / 0.95, 0.05 / 0.95],
    'weights',
  );
  close(skin.vertexWeights.subarray(0, 4), [1, 0, 0, 0], 'p0');
  const [root, rig] = dae.nodes;
  assert.equal(root.sid, 'J0');
  assert.deepEqual(rig.instances[0].skin, 0);
  assert.equal(rig.instances[0].geometry, 0);
  assert.deepEqual(rig.instances[0].joints, [root, root.children[0]]);
  assert.deepEqual(root.children[0].transforms, [
    { type: 'translate', sid: 't', values: [0, 1, 0] },
    { type: 'rotate', sid: 'rz', values: [0, 0, 1, 0] },
  ]);
  // IDREF_array joints are node ids.
  const idref = parseDAE(skinned(YUP, names('joints', ['root', 'tip'], 'IDREF_array')));
  assert.deepEqual(idref.nodes[1].instances[0].joints, [idref.nodes[0], idref.nodes[0].children[0]]);
});

test('DAE skin: posed vertices at keyframes through poseDAE and flattenDAE', () => {
  const dae = parseDAE(skinned()),
    mesh = dae.geometries[0];
  assert.deepEqual([...mesh.positionIndices], [0, 1, 3, 2, 5, 4]);
  close(flattenDAE(dae).positions, mesh.positions, 'rest');
  close(flattenDAE(dae, poseDAE(dae, 1)).positions, byCorner(mesh, POSED_1), 't = 1');
  close(flattenDAE(dae, poseDAE(dae, 0.5)).positions, byCorner(mesh, POSED_HALF), 't = 0.5');
  // Held after the last key.
  close(flattenDAE(dae, poseDAE(dae, 9)).positions, byCorner(mesh, POSED_1), 'held');
  const pose = poseDAE(dae, 1),
    tip = dae.nodes[0].children[0];
  close(pose.world.get(tip), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1], 'tip world');
  // A rotated normal follows the blend.
  close(flattenDAE(dae, pose).normals.subarray(0, 3), [0, 0, 1], 'normal');
});

test('DAE skin: bindDAESkin and daeKeyframeClip feed the animation Skeleton and Skin', async (t) => {
  const dae = parseDAE(skinned()),
    binding = bindDAESkin(dae);
  assert.equal(binding.node, dae.nodes[1]);
  assert.deepEqual(
    binding.bones.map((b) => [b.name, b.parent]),
    [
      ['root', -1],
      ['tip', 0],
    ],
  );
  close(binding.bones[1].translation, [0, 1, 0], 'tip translation');
  close(binding.bones[1].rotation, [0, 0, 0, 1], 'tip rotation');
  close(binding.inverseBindMatrices.subarray(16), dae.skins[0].inverseBindMatrices.subarray(16), 'bone ibm');
  // Corner 2 is position 3: bone indices and weights per corner.
  assert.deepEqual([...binding.joints.subarray(8, 12)], [0, 1, 0, 1]);
  close(binding.geometry.positions, dae.geometries[0].positions, 'bind shape geometry');
  assert.equal(binding.geometry.normals.length, binding.geometry.positions.length);
  const clip = daeKeyframeClip(dae);
  assert.deepEqual(
    clip.tracks.map((k) => [k.target, k.path]),
    [
      ['tip', 'translation'],
      ['tip', 'rotation'],
      ['tip', 'scale'],
    ],
  );
  const rotation = clip.tracks[1].keys;
  assert.equal(rotation.length, 31); // 0 to 1 s at 30 fps
  close(rotation[30].value, [0, 0, s, s], 'quaternion at t = 1');
  close(clip.tracks[0].keys[30].value, [0, 1, 0], 'translation at t = 1');
  let animation;
  try {
    animation = await import('../../animation/dist/index.js');
  } catch {
    t.skip('packages/animation is not built');
    return;
  }
  const { Skeleton, Skin, createKeyframeClip, applyKeyframeClip } = animation;
  const skeleton = new Skeleton(binding.bones, binding.inverseBindMatrices),
    skin = new Skin(skeleton, binding.joints, binding.weights),
    keyframes = createKeyframeClip(clip);
  assert.equal(keyframes.duration, 1);
  close(skin.pose(binding.geometry.positions).positions, binding.geometry.positions, 'rest skin');
  applyKeyframeClip(keyframes, skeleton, 1);
  close(skin.pose(binding.geometry.positions).positions, byCorner(dae.geometries[0], POSED_1), 'engine t = 1');
  applyKeyframeClip(keyframes, skeleton, 0.5);
  close(skin.pose(binding.geometry.positions).positions, byCorner(dae.geometries[0], POSED_HALF), 'engine t = 0.5');
});

test('DAE skin: Z_UP centimeters convert joints, inverse binds and animation alike', () => {
  const zup = parseDAE(skinned('<unit meter="0.01"/><up_axis>Z_UP</up_axis>')),
    mesh = zup.geometries[0],
    converted = POSED_1.map(([x, y, z]) => [0.01 * x, 0.01 * z, -0.01 * y]);
  close(flattenDAE(zup, poseDAE(zup, 1)).positions, byCorner(mesh, converted), 'Z-up posed');
  const binding = bindDAESkin(zup);
  close(binding.bones[1].translation, [0, 0, -0.01], 'tip bone in Y-up meters');
  close(binding.inverseBindMatrices.subarray(28, 31), [0, 0, 0.01], 'ibm translation');
});

test('DAE skin: bind-shape joints (-1) and unresolved joints', () => {
  const minus = parseDAE(skinned().replace('<v>0 0 0 0', '<v>-1 0 0 0'));
  assert.equal(minus.skins[0].vertexJoints[0], -1);
  const binding = bindDAESkin(minus);
  assert.deepEqual(
    binding.bones.map((b) => [b.name, b.parent]),
    [
      ['bar-skin', -1],
      ['root', 0],
      ['tip', 1],
    ],
  );
  assert.equal(binding.joints[0], 0); // follows the identity root
  const missing = parseDAE(skinned(YUP, names('joints', ['J0', 'J9'])));
  assert.deepEqual(missing.warnings, ['skin "bar-skin": joint "J9" names no node, so the mesh is not skinned']);
  assert.equal(missing.nodes[1].instances[0].skin, undefined);
  rejects(() => bindDAESkin(missing), 'unsupported', /no skinned instance/);
  rejects(() => parseDAE(skinned().replace('<v>0 0 0 0', '<v>7 0 0 0')), 'range', /joint index 7/);
  rejects(() => parseDAE(skinned().replace('<vcount>1 1 2 5 1 1', '<vcount>1 1 2 5 1')), 'syntax', /vcount/);
});

// A triangle with two morph targets; weight 0 steps 0 -> 1 at t = 1, weight 1 ramps 0 -> 1 over a second.
const morphed = (method, t1, t2) =>
  document(
    YUP,
    `<library_geometries>
      <geometry id="base"><mesh>${xyz('base-p', [0, 0, 0, 1, 0, 0, 0, 1, 0])}
        <vertices id="base-v"><input semantic="POSITION" source="#base-p"/></vertices>
        <triangles count="1"><input semantic="VERTEX" source="#base-v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry>
      <geometry id="t1"><mesh>${xyz('t1-p', t1)}
        <vertices id="t1-v"><input semantic="POSITION" source="#t1-p"/></vertices>
        <triangles count="1"><input semantic="VERTEX" source="#t1-v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry>
      <geometry id="t2"><mesh>${xyz('t2-p', t2)}
        <vertices id="t2-v"><input semantic="POSITION" source="#t2-p"/></vertices>
        <triangles count="1"><input semantic="VERTEX" source="#t2-v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry>
    </library_geometries>
    <library_controllers><controller id="morph" name="Smile"><morph source="#base" method="${method}">
      ${names('morph-targets', ['t1', 't2'], 'IDREF_array', 'MORPH_TARGET')}
      ${floats('morph-weights', [0.5, 0.25], 1, 'MORPH_WEIGHT')}
      <targets><input semantic="MORPH_TARGET" source="#morph-targets"/><input semantic="MORPH_WEIGHT" source="#morph-weights"/></targets>
    </morph></controller></library_controllers>
    <library_animations>
      <animation id="w0">${sampler('w0-s', [0, 1], [0, 1], 1, ['STEP', 'STEP'])}<channel source="#w0-s" target="morph/morph-weights(0)"/></animation>
      <animation id="w1">${sampler('w1-s', [0, 1], [0, 1], 1, ['LINEAR', 'LINEAR'])}<channel source="#w1-s" target="morph-weights(1)"/></animation>
    </library_animations>
    <library_visual_scenes><visual_scene id="scene">
      <node id="face"><translate>0 0 5</translate><instance_controller url="#morph"/></node>
    </visual_scene></library_visual_scenes>`,
  );

test('DAE morph: NORMALIZED and RELATIVE targets, default and animated weights', () => {
  const normalized = parseDAE(morphed('NORMALIZED', [0, 0, 0, 2, 0, 0, 0, 1, 0], [0, 0, 1, 1, 0, 0, 0, 1, 0])),
    relative = parseDAE(morphed('RELATIVE', [0, 0, 0, 1, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0, 0]));
  for (const dae of [normalized, relative]) {
    assert.deepEqual(dae.warnings, []);
    const [morph] = dae.morphs;
    assert.deepEqual(
      [morph.id, morph.name, morph.base, morph.targets, morph.weights, morph.weightsSource],
      ['morph', 'Smile', 0, [1, 2], [0.5, 0.25], 'morph-weights'],
    );
    assert.equal(dae.nodes[0].instances[0].morph, 0);
    // Defaults: (1 - 0.75) base + 0.5 t1 + 0.25 t2, or base + 0.5 t1 + 0.25 t2.
    close(morphDAE(dae, 0).positions, [0, 0, 0.25, 1.5, 0, 0, 0, 1, 0], `${morph.method} defaults`);
    close(morphDAE(dae, 0, [1, 0]).positions, [0, 0, 0, 2, 0, 0, 0, 1, 0], `${morph.method} t1`);
    assert.equal(morphDAE(dae, 0).normals.length, 9);
    // Channels: weight 0 by morph and source sid, weight 1 by the source id alone.
    assert.deepEqual(
      dae.animations.map((a) => a.channels.map((c) => [c.morph, c.index])),
      [[[0, 0]], [[0, 1]]],
    );
    const half = poseDAE(dae, 0.5);
    assert.deepEqual(half.weights, [[0, 0.5]]);
    close(flattenDAE(dae, half).positions, [0, 0, 5.5, 1, 0, 5, 0, 1, 5], `${morph.method} t = 0.5`);
    close(flattenDAE(dae, poseDAE(dae, 1)).positions, [0, 0, 6, 2, 0, 5, 0, 1, 5], `${morph.method} t = 1`);
  }
  const clip = daeKeyframeClip(normalized, { fps: 2 });
  assert.equal(clip.tracks.length, 1);
  assert.deepEqual(
    [clip.tracks[0].target, clip.tracks[0].path, clip.tracks[0].keys.map((k) => [k.time, k.value])],
    [
      'face',
      'weights',
      [
        [0, [0, 0]],
        [0.5, [0, 0.5]],
        [1, [1, 1]],
      ],
    ],
  );
  rejects(
    () => parseDAE(morphed('AVERAGE', [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 0, 1, 0, 0, 0, 1, 0])),
    'syntax',
    /method "AVERAGE"/,
  );
  assert.throws(() => morphDAE(normalized, 0, [1]), RangeError);
});

// Z-up centimeters: nested animations move and turn a box (LINEAR translate, BEZIER rotate.ANGLE); a top-level one
// steps a matrix element and ramps a whole matrix. Clips select the nested move alone and the whole outer animation.
const ANIMATED = document(
  '<unit meter="0.01"/><up_axis>Z_UP</up_axis>',
  `<library_animations>
    <animation id="all">
      <animation id="move">${sampler('move-s', [0, 2], [0, 0, 0, 200, 0, 100], 3, ['LINEAR', 'LINEAR'])}
        <channel source="#move-s" target="box/location"/></animation>
      <animation id="turn">${sampler(
        'turn-s',
        [0, 1],
        [0, 90],
        1,
        ['BEZIER', 'BEZIER'],
        floats('turn-s-intan', [-1 / 3, 0, 2 / 3, 90], 2) + floats('turn-s-outtan', [1 / 3, 0, 4 / 3, 90], 2),
      )}<channel source="#turn-s" target="box/rotZ.ANGLE"/></animation>
    </animation>
    <animation id="mat">
      ${sampler('step-s', [0, 1], [0, 5], 1, ['STEP', 'STEP'])}<channel source="#step-s" target="m/transform(0)(3)"/>
      ${sampler('full-s', [0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 100, 0, 0, 0, 1], 16, ['LINEAR', 'LINEAR'])}
      <channel source="#full-s" target="m2/transform"/>
      ${sampler('bad-s', [0, 1], [0, 1], 1, ['CARDINAL', 'CARDINAL'])}<channel source="#bad-s" target="box/missing.X"/>
    </animation>
  </library_animations>
  <library_animation_clips>
    <animation_clip id="clipMove" start="0" end="2"><instance_animation url="#move"/></animation_clip>
    <animation_clip id="clipAll" name="All" start="0.5"><instance_animation url="#all"/></animation_clip>
  </library_animation_clips>
  <library_visual_scenes><visual_scene id="scene">
    <node id="box"><translate sid="location">0 0 0</translate><rotate sid="rotZ">0 0 1 0</rotate></node>
    <node id="m"><matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix></node>
    <node id="m2"><matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix></node>
  </visual_scene></library_visual_scenes>`,
);

test('DAE animation: nested animations, clips, LINEAR/STEP/BEZIER channels, Z_UP conversion', () => {
  const dae = parseDAE(ANIMATED);
  assert.deepEqual(dae.warnings, [
    'animation "mat" sampler "bad-s": CARDINAL interpolation is sampled as LINEAR',
    'animation "mat" channel "box/missing.X" is not imported: it names no node transform or morph weight it fits',
  ]);
  assert.deepEqual(
    dae.animations.map((a) => [a.id, a.parent, a.channels.map((c) => [c.node, c.transform, c.index])]),
    [
      ['all', -1, []],
      ['move', 0, [['box', 'location', undefined]]],
      ['turn', 0, [['box', 'rotZ', 3]]],
      [
        'mat',
        -1,
        [
          ['m', 'transform', 3],
          ['m2', 'transform', undefined],
        ],
      ],
    ],
  );
  assert.deepEqual(dae.clips, [
    { id: 'clipMove', start: 0, end: 2, animations: [1] },
    { id: 'clipAll', name: 'All', start: 0.5, animations: [0] },
  ]);
  const [box, m, m2] = dae.nodes;
  // t = 1: translate (100, 0, 50) cm Z-up is (1, 0.5, 0) m Y-up; the BEZIER angle at t = 1 is its last key, 90.
  const pose = poseDAE(dae, 1);
  close(pose.local.get(box), [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 1], 'box t = 1');
  close(pose.local.get(m).slice(12, 15), [0.05, 0, 0], 'stepped matrix element at t = 1');
  close(poseDAE(dae, 0.5).local.get(m).slice(12, 15), [0, 0, 0], 'stepped matrix element held at t = 0.5');
  close(poseDAE(dae, 0.5).local.get(m2).slice(12, 15), [0, 0.5, 0], 'whole matrix at t = 0.5');
  // BEZIER with control points at thirds: x(s) = t, so angle = 90 s^2 (3 - 2 s); at t = 0.25 that is 14.0625.
  const turn = dae.animations[2].channels[0].sampler;
  close(sampleDAESampler(turn, 0.25), [14.0625], 'bezier');
  close(sampleDAESampler(turn, 0.25 + 1e-9), [14.0625], 'bezier', 1e-4);
  const angle = (14.0625 * Math.PI) / 180;
  close(poseDAE(dae, 0.25).local.get(box).slice(0, 3), [Math.cos(angle), 0, -Math.sin(angle)], 'turned 14 degrees');
  // Value-only tangents sit at a third of the segment; HERMITE with zero slopes is a smoothstep.
  close(
    sampleDAESampler(
      { ...turn, inTangents: new Float64Array([0, 90]), outTangents: new Float64Array([0, 90]), tangentStride: 1 },
      0.25,
    ),
    [14.0625],
    'bezier 1D',
  );
  close(
    sampleDAESampler(
      {
        ...turn,
        interpolations: ['HERMITE', 'HERMITE'],
        inTangents: new Float64Array([0, 0]),
        outTangents: new Float64Array([0, 0]),
        tangentStride: 1,
      },
      0.25,
    ),
    [14.0625],
    'hermite',
  );
  // Clips: "clipMove" only moves (no turn); "clipAll" starts at 0.5 s and includes the nested animations.
  close(poseDAE(dae, 1, { clip: 0 }).local.get(box), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0.5, 0, 1], 'clip move');
  close(poseDAE(dae, 0.5, { clip: 1 }).local.get(box).slice(12, 15), [1, 0.5, 0], 'clip all from 0.5 s');
  close(poseDAE(dae, 0.5, { clip: 1 }).local.get(m), m.matrix, 'mat is not in clipAll');
  assert.throws(() => poseDAE(dae, 0, { clip: 5 }), RangeError);
  // Keyframe tracks of the clip, timed from its start.
  const clip = daeKeyframeClip(dae, { clip: 1, fps: 4 });
  assert.equal(clip.name, 'All');
  assert.deepEqual(
    clip.tracks.map((k) => [k.target, k.path]),
    [
      ['box', 'translation'],
      ['box', 'rotation'],
      ['box', 'scale'],
    ],
  );
  const translation = clip.tracks[0].keys;
  assert.deepEqual(
    translation.map((k) => k.time),
    [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5],
  );
  close(translation[2].value, [1, 0.5, 0], 'translation at clip time 0.5');
  close(clip.tracks[1].keys[2].value, [0, s, 0, s], 'rotation at clip time 0.5');
  // A matrix element that only steps keeps its keys, held.
  const mat = daeKeyframeClip(dae).tracks.filter((k) => k.target === 'm');
  assert.deepEqual(
    mat[0].keys.map((k) => [k.time, k.interpolation]),
    [
      [0, 'discrete'],
      [1, 'discrete'],
      [2, 'discrete'],
    ],
  );
  assert.deepEqual([...daeNodeNames(dae).values()], ['box', 'm', 'm2']);
});
