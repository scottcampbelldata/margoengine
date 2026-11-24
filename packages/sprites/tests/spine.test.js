import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadSpineJSON, parseSpineJSON, serializeSpineJSON, SpineAttachment, SpineMesh } from '../dist/spine.js';
import { Skeleton2D, SkinnedMesh, SkeletalLayer } from '../dist/skeletal.js';

const close = (actual, expected, epsilon = 1e-7) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < epsilon, `${i}: ${v} != ${expected[i]}`));
};
const region = { width: 10, height: 10 };
const mesh = { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 2, 0, 0, 2] };
const base = (attachment = region) => ({
  skeleton: { spine: '3.8.99' },
  bones: [{ name: 'root' }],
  slots: [{ name: 'image', bone: 'root', attachment: 'a' }],
  skins: [{ name: 'default', attachments: { image: { a: structuredClone(attachment) } } }],
  animations: { idle: {} },
});
test('imported rigs and every mesh retain job 2 runtime identities and layer ownership', () => {
  const asset = parseSpineJSON(base()),
    rig = asset.createSkeleton();
  assert.ok(rig instanceof Skeleton2D);
  const a = rig.getAttachment('image');
  assert.ok(a instanceof SpineAttachment);
  assert.ok(a.mesh instanceof SpineMesh);
  assert.ok(a.mesh instanceof SkinnedMesh);
  close(a.mesh.deform(), [-5, 5, 5, 5, 5, -5, -5, -5]);
  const layer = new SkeletalLayer({ atlas: { width: 1, height: 1, data: new Uint8Array(4) } });
  layer.addSkeleton(rig);
  assert.equal(a.mesh.owner, layer);
  layer.dispose();
  assert.equal(a.mesh.owner, undefined);
  const other = asset.createSkeleton();
  rig.bone('root').x = 7;
  rig.update();
  assert.equal(other.bone('root').x, 0);
  assert.notEqual(other.getAttachment('image').mesh, a.mesh);
});
test('unweighted and arbitrarily weighted vertices retain their separate bone-local bind positions', () => {
  const data = base(mesh);
  data.bones.push({ name: 'tip', parent: 'root', x: 10 });
  const vertices = [];
  for (let i = 0; i < 3; i++) vertices.push(5, 0, 1, 2, 0.2, 1, 4, 5, 0.2, 0, 1, 2, 0.2, 1, 4, 5, 0.2, 0, 1, 2, 0.2);
  data.skins[0].attachments.image.a.vertices = vertices;
  const rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  close(rig.getAttachment('image').worldVertices(), [6.2, 3.2, 6.2, 3.2, 6.2, 3.2]);
  rig.bone('tip').x = 20;
  rig.update();
  close(rig.getAttachment('image').mesh.deform(), [10.2, 3.2, 10.2, 3.2, 10.2, 3.2]);
  const unweighted = parseSpineJSON(base(mesh)).createSkeleton({ scale: 2 });
  unweighted.bone('root').x = 3;
  unweighted.update();
  close(unweighted.getAttachment('image').worldVertices(), [3, 0, 7, 0, 3, -4]);
});
test('bone-space bind positions support zero-scale setup bones without inverse bind matrices', () => {
  const data = base(mesh);
  data.bones[0].scaleX = 0;
  const rig = parseSpineJSON(data).createSkeleton();
  close(rig.getAttachment('image').mesh.deform(), [0, 0, 0, 0, 0, -2]);
  rig.bone('root').scaleX = 1;
  rig.update();
  close(rig.getAttachment('image').mesh.deform(), [0, 0, 2, 0, 0, -2]);
  const skeleton = new Skeleton2D([{ name: 'root', scaleX: 0 }]);
  const options = {
    skeleton,
    positions: [0, 0, 0, 0, 0, 0],
    uvs: [0, 0, 0, 0, 0, 0],
    indices: [0, 1, 2],
    joints: new Array(12).fill(0),
    weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    jointPositions: Array.from({ length: 24 }, (_, i) => (i % 8 === 0 ? 2 : 0)),
  };
  const m = new SkinnedMesh(options);
  close(m.deform(), [0, 0, 0, 0, 0, 0]);
  skeleton.bone('root').scaleX = 1;
  skeleton.update();
  close(m.deform(), [2, 0, 2, 0, 2, 0]);
  assert.throws(() => new SkinnedMesh({ ...options, jointPositions: [1] }), RangeError);
});
test('skins select attachments with default fallback and skin bone activation', () => {
  const data = base();
  data.bones.push({ name: 'optional', parent: 'root', skin: true });
  data.slots.push({ name: 'extra', bone: 'optional', attachment: 'a' });
  data.skins[0].attachments.extra = { a: region };
  data.skins.push({
    name: 'blue',
    bones: ['optional'],
    attachments: { image: { a: { ...region, color: '0000ffff' } } },
  });
  const rig = parseSpineJSON(data).createSkeleton();
  assert.equal(rig.getAttachment('extra').mesh.visible, false);
  rig.setSkin('blue');
  assert.equal(rig.getAttachment('image').mesh.tint, 0x0000ff);
  assert.equal(rig.getAttachment('extra').mesh.visible, true);
  assert.throws(() => rig.setSkin('missing'), { code: 'failed' });
  const old = base();
  old.skins = { default: old.skins[0].attachments };
  assert.ok(parseSpineJSON(old).createSkeleton().getAttachment('image'));
});
test('linked meshes resolve other skins, retain geometry, and inherit deforms only when requested', () => {
  const data = base(mesh);
  data.skins[0].attachments.image.b = { type: 'linkedmesh', parent: 'a' };
  data.skins[0].attachments.image.c = { type: 'linkedmesh', parent: 'a', deform: false };
  data.animations.idle = {
    deform: { default: { image: { a: [{ vertices: [4, 2] }, { time: 1, vertices: [8, 6] }] } } },
  };
  const rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 0.5, { loop: false });
  close(rig.getAttachment('image', 'a').worldVertices(), [6, -4, 2, 0, 0, -2]);
  close(rig.getAttachment('image', 'b').worldVertices(), [6, -4, 2, 0, 0, -2]);
  close(rig.getAttachment('image', 'c').worldVertices(), [0, 0, 2, 0, 0, -2]);
  rig.pose('idle', 0, { loop: false });
  assert.equal(rig.getAttachment('image', 'b').deformation[0], 4);
});
test('normalized and absolute Bezier controls interpolate every channel, including overshoot and crossed handles', () => {
  const data = base();
  data.animations.idle = {
    bones: {
      root: {
        translate: [
          { x: 0, y: 0, curve: [0, 0, 1, 0] },
          { time: 2, x: 8, y: 16 },
        ],
      },
    },
  };
  let rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 1, { loop: false });
  close([rig.bone('root').x, rig.bone('root').y], [1, -2]);
  data.skeleton.spine = '4.2.0';
  data.animations.idle = {
    bones: {
      root: {
        translate: [{ curve: [0, 0, 2, 0, 0, 0, 2, 0] }, { time: 2, x: 8, y: 16 }],
        rotate: [{ value: 350 }, { time: 2, value: 710 }],
      },
    },
  };
  rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 1, { loop: false });
  close([rig.bone('root').x, rig.bone('root').y, rig.bone('root').rotation], [1, -2, (-530 * Math.PI) / 180]);
  data.animations.idle.bones.root.rotate = [{ curve: [1.5, 0, 0.5, 10] }, { time: 2, value: 10 }];
  rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 1, { loop: false });
  assert.ok(Number.isFinite(rig.bone('root').rotation));
});
test('stepped attachment/draw keys and split transform channels reset correctly on backward seeks', () => {
  const data = base();
  data.skeleton.spine = '4.2.0';
  data.slots.push({ name: 'back', bone: 'root' });
  data.skins[0].attachments.image.b = { ...region, color: '0000ffff' };
  data.animations.idle = {
    bones: { root: { translatex: [{ value: 10 }, { time: 2, value: 20 }], sheary: [{ value: 20 }] } },
    slots: { image: { attachment: [{ time: 1, name: 'b' }, { time: 2 }] } },
    drawOrder: [{ time: 1, offsets: [{ slot: 'image', offset: 1 }] }],
  };
  const rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 1.5, { loop: false });
  assert.equal(rig.getAttachment('image').mesh.tint, 0x0000ff);
  assert.equal(rig.bone('root').x, 17.5);
  assert.equal(rig.drawOrder[0].name, 'back');
  rig.pose('idle', 2, { loop: false });
  assert.equal(rig.getAttachment('image'), undefined);
  rig.pose('idle', 0, { loop: false });
  assert.equal(rig.slotStates.get('image').attachment, 'a');
  assert.equal(rig.drawOrder[0].name, 'image');
});
test('slot colors, dark tint, alpha and blend modes map to the rig meshes', () => {
  const data = base();
  data.slots[0].blend = 'multiply';
  data.animations.idle = {
    slots: {
      image: {
        twoColor: [
          { light: 'ff0000ff', dark: '000000' },
          { time: 1, light: '0000ff7f', dark: '00ff00' },
        ],
      },
    },
  };
  const rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 0.5, { loop: false });
  const m = rig.getAttachment('image').mesh;
  assert.equal(m.tint, 0x800080);
  assert.equal(m.darkTint, 0x008000);
  assert.equal(m.blendMode, 'multiply');
  assert.ok(m.alpha < 0.76 && m.alpha > 0.74);
});
test('single/two bone IK, animated mixes and ordered transform constraints affect the job 2 rig', () => {
  const data = base();
  data.bones = [
    { name: 'root', length: 5 },
    { name: 'tip', parent: 'root', x: 5, length: 3 },
    { name: 'target', x: 4, y: 2 },
    { name: 'copy' },
  ];
  data.ik = [{ name: 'arm', order: 0, bones: ['root', 'tip'], target: 'target' }];
  data.transform = [
    { name: 'follow', order: 1, bones: ['copy'], target: 'tip', rotateMix: 0, scaleMix: 0, shearMix: 0 },
  ];
  data.animations.idle = { ik: { arm: [{ mix: 0 }, { time: 1, mix: 1 }] } };
  const rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  rig.pose('idle', 1, { loop: false });
  const b = rig.bone('tip');
  close([b.world[4] + b.world[0] * 3, b.world[5] + b.world[1] * 3], [4, 2]);
  close([rig.bone('copy').world[4], rig.bone('copy').world[5]], [b.world[4], b.world[5]]);
  rig.pose('idle', 0, { loop: false });
  assert.equal(rig.bone('tip').rotation, 0);
  const one = base();
  one.bones.push({ name: 'target', y: 5 });
  one.ik = [{ name: 'aim', bones: ['root'], target: 'target' }];
  close(parseSpineJSON(one).createSkeleton({ yDown: false }).bone('root').world.slice(0, 2), [0, 1]);
});
test('local relative transform constraints and modern property mappings evaluate without physics', () => {
  const data = base();
  data.bones.push({ name: 'source', x: 4, rotation: 30 }, { name: 'copy', x: 2 });
  data.transform = [{ name: 't', bones: ['copy'], target: 'source', local: true, relative: true, x: 1 }];
  let rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  close([rig.bone('copy').x, rig.bone('copy').rotation], [7, Math.PI / 6]);
  delete data.transform;
  data.constraints = [
    {
      type: 'transform',
      name: 't',
      source: 'source',
      bones: ['copy'],
      localSource: true,
      localTarget: true,
      properties: { x: { offset: 2, to: { y: { scale: 3, offset: 1 } } } },
    },
  ];
  rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  close([rig.bone('copy').x, rig.bone('copy').y], [2, 7]);
});
test('path constraints support cubic positions, spacing, chain scale and out-of-range extension', () => {
  const data = base();
  data.bones.push({ name: 'follower', length: 2 });
  data.slots.push({ name: 'path', bone: 'root', attachment: 'p' });
  data.skins[0].attachments.path = {
    p: { type: 'path', vertexCount: 6, vertices: [-1, 0, 0, 0, 10 / 3, 0, 20 / 3, 0, 10, 0, 11, 0], lengths: [10] },
  };
  data.path = [
    {
      name: 'p',
      bones: ['follower'],
      target: 'path',
      position: 0.5,
      spacingMode: 'fixed',
      spacing: 4,
      rotateMode: 'chainScale',
    },
  ];
  data.animations.idle = { path: { p: { position: [{ position: 0.5 }, { time: 1, position: 1.5 }] } } };
  const rig = parseSpineJSON(data).createSkeleton({ yDown: false });
  close([rig.bone('follower').world[4], rig.bone('follower').scaleX], [5, 2]);
  rig.pose('idle', 1, { loop: false });
  close([rig.bone('follower').world[4], rig.bone('follower').scaleX], [15, 2]);
});
test('bounds, points and concave clipping preserve geometry and inclusive clipping end slots', () => {
  const data = base();
  data.slots.unshift({ name: 'clip', bone: 'root', attachment: 'c' });
  data.slots.push({ name: 'after', bone: 'root', attachment: 'a' });
  data.skins[0].attachments.clip = {
    c: { type: 'clipping', end: 'image', vertexCount: 6, vertices: [0, 0, 4, 0, 4, 2, 2, 2, 2, 4, 0, 4] },
    b: { type: 'boundingbox', vertexCount: 3, vertices: [0, 0, 1, 0, 0, 1] },
    p: { type: 'point', x: 2, y: 3, rotation: 45 },
  };
  data.skins[0].attachments.after = { a: region };
  const rig = parseSpineJSON(data).createSkeleton({ yDown: false }),
    m = rig.getAttachment('image').mesh,
    p = m.deform();
  let area = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [...m.indices.slice(i, i + 3)].map((n) => [p[n * 2], p[n * 2 + 1]]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(area - 12) < 1e-8);
  assert.equal(rig.getAttachment('after').mesh.vertexCount, 4);
  assert.equal(rig.getAttachment('clip', 'b').mesh, undefined);
  close(rig.getAttachment('clip', 'p').worldVertices(), [2, 3]);
  assert.ok(Math.abs(rig.getAttachment('clip', 'p').pointRotation - Math.PI / 4) < 1e-9);
});
test('image sequences, modern attachment deform timelines, rotated trim and frame seeks', () => {
  const data = base(mesh);
  data.skeleton.spine = '4.2.0';
  data.skins[0].attachments.image.a.sequence = { count: 3, start: 1, digits: 2 };
  data.animations.idle = {
    attachments: {
      default: {
        image: {
          a: {
            deform: [{ vertices: [1, 2] }, { time: 2, vertices: [3, 4] }],
            sequence: [{ mode: 'loop', delay: 0.25 }],
          },
        },
      },
    },
  };
  const regions = Object.fromEntries([1, 2, 3].map((i) => [`a0${i}`, { x: i * 10, y: 0, width: 2, height: 2 }]));
  const rig = parseSpineJSON(data).createSkeleton({ regions });
  rig.pose('idle', 0.5, { loop: false });
  assert.equal(rig.getAttachment('image').sequenceIndex, 2);
  assert.equal(rig.getAttachment('image').mesh.uvs[0], 30);
  close(rig.getAttachment('image').deformation.slice(0, 2), [1.5, -2.5]);
  rig.pose('idle', 0, { loop: false });
  assert.equal(rig.getAttachment('image').sequenceIndex, 0);
  const trimmed = parseSpineJSON(base()).createSkeleton({
    regions: {
      a: {
        x: 20,
        y: 30,
        width: 6,
        height: 4,
        rotation: 90,
        originalWidth: 10,
        originalHeight: 10,
        offsetX: 2,
        offsetY: 3,
      },
    },
  });
  close(trimmed.getAttachment('image').worldVertices(), [-3, 2, 1, 2, 1, -4, -3, -4]);
  close(trimmed.getAttachment('image').mesh.uvs, [26, 34, 26, 30, 20, 30, 20, 34]);
});
test('events apply definition defaults, include loop crossings, and do not fire during backward seeks', () => {
  const data = base();
  data.events = { hit: { int: 7, float: 2, string: 'hi', audio: 'hit.wav', volume: 0.5 } };
  data.animations.idle = { events: [{ name: 'hit' }, { time: 1, name: 'hit', int: 8 }] };
  const rig = parseSpineJSON(data).createSkeleton();
  const events = rig.eventsBetween('idle', -1, 2.1);
  assert.deepEqual(
    events.map((e) => [e.time, e.int]),
    [
      [0, 7],
      [1, 8],
      [1, 7],
      [2, 8],
      [2, 7],
    ],
  );
  assert.equal(events[0].volume, 0.5);
  assert.equal(events[0].audio, 'hit.wav');
  assert.deepEqual(rig.eventsBetween('idle', 2, 0), []);
  assert.equal(rig.eventsBetween('idle', -1, 2, false).length, 2);
  assert.throws(() => rig.eventsBetween('idle', -1, 20000), { code: 'failed' });
});
test('physics definitions and timelines validate, warn once per named constraint, round-trip, and never simulate', (t) => {
  const warnings = t.mock.method(console, 'warn', () => {}),
    data = base();
  data.physics = [
    { name: 'hair', bone: 'root', inertia: 0.5, strength: 20, damping: 0.9, mass: 2, fps: 60 },
    { name: 'coat', bone: 'root', windGlobal: true },
  ];
  data.animations.idle = {
    bones: { root: { translate: [{ x: 1 }, { time: 1, x: 3 }] } },
    physics: { hair: { inertia: [{ value: 1 }], reset: [{ time: 0.5 }] }, '': { wind: [{ value: 3 }] } },
  };
  data.skeleton.custom = { ignoredMetadata: ['kept', 3] };
  const asset = parseSpineJSON(data);
  assert.deepEqual(JSON.parse(serializeSpineJSON(asset)), data);
  assert.deepEqual(JSON.parse(JSON.stringify(asset)), data);
  assert.deepEqual(
    asset.warnings.map((w) => w.constraint),
    ['hair', 'coat'],
  );
  assert.equal(warnings.mock.callCount(), 2);
  const rig = asset.createSkeleton();
  for (const time of [0.5, 0.1, 0.9, 0.5]) {
    rig.pose('idle', time, { loop: false });
    assert.equal(rig.bone('root').x, 1 + 2 * time);
  }
  assert.equal(warnings.mock.callCount(), 2);
  const modern = base();
  modern.constraints = data.physics.map((c) => ({ ...c, type: 'physics' }));
  assert.equal(parseSpineJSON(modern).warnings.length, 2);
  const invalid = structuredClone(data);
  invalid.physics[0].mass = -1;
  assert.throws(() => parseSpineJSON(invalid), { code: 'failed' });
});
test('all inheritance modes and shear remain finite with reflected anisotropic ancestors', () => {
  for (const transform of ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection']) {
    const data = base();
    data.bones = [
      { name: 'root', rotation: 35, scaleX: -2, scaleY: 3 },
      { name: 'child', parent: 'root', x: 2, rotation: 20, shearY: 15, transform },
    ];
    data.slots[0].bone = 'child';
    const rig = parseSpineJSON(data).createSkeleton({ yDown: false }),
      b = rig.bone('child');
    assert.ok([...b.world].every(Number.isFinite));
    if (transform.startsWith('noScale')) {
      assert.ok(Math.abs(Math.hypot(b.world[0], b.world[1]) - 1) < 1e-10);
      assert.ok(Math.abs(Math.hypot(b.world[2], b.world[3]) - 1) < 1e-10);
    }
    if (transform === 'onlyTranslation')
      close(b.world.slice(0, 2), [Math.cos((20 * Math.PI) / 180), Math.sin((20 * Math.PI) / 180)]);
  }
});
test('modern unified constraint timelines and animation sliders sample without replacing unrelated pose channels', () => {
  const data = base();
  data.skeleton.spine = '4.3.0';
  data.bones.push({ name: 'control', x: 0.5 });
  data.constraints = [{ type: 'slider', name: 'control-slider', animation: 'shape', bone: 'control', property: 'x', local: true, mix: 0.5 }];
  data.animations.shape = { bones: { root: { translatex: [{ value: 4 }, { time: 1, value: 12 }] } } };
  data.animations.idle = { bones: { root: { translatey: [{ value: 3 }, { time: 1, value: 5 }] } }, constraints: { 'control-slider': { mix: [{ value: 0 }, { time: 1, value: 1 }] } } };
  const rig = parseSpineJSON(data).createSkeleton();
  rig.pose('idle', 0.5, { loop: false });
  close([rig.bone('root').x, rig.bone('root').y], [4, -4]);
  rig.pose('idle', 0, { loop: false }); close([rig.bone('root').x, rig.bone('root').y], [0, -3]);
  rig.pose('idle', 1, { loop: false }); close([rig.bone('root').x, rig.bone('root').y], [8, -5]);
});
test('malformed references, arrays, curves and resource limits reject with a coded help-linked error', () => {
  const changes = [
    (d) => d.bones.push({ name: 'root' }),
    (d) => (d.slots[0].bone = 'missing'),
    (d) => (d.skins[0].attachments.image.a = { ...mesh, triangles: [0, 1, 99] }),
    (d) => (d.skins[0].attachments.image.a = { ...mesh, vertices: [1, 0, 0, 0, 0] }),
    (d) => (d.skins[0].attachments.image.a = { type: 'linkedmesh', parent: 'a' }),
    (d) => (d.animations.idle = { bones: { root: { translate: [{ x: 'bad' }] } } }),
    (d) => (d.animations.idle = { bones: { root: { rotate: [{ curve: [0, 1, 2] }] } } }),
    (d) => (d.animations.idle = { events: [{ name: 'missing' }] }),
    (d) => (d.animations.idle = { drawOrder: [{ offsets: [{ slot: 'image', offset: 2 }] }] }),
    (d) => (d.animations.idle = { deform: { default: { image: { a: [{ offset: 100, vertices: [1] }] } } } }),
  ];
  for (const change of changes) {
    const data = base();
    change(data);
    assert.throws(
      () => parseSpineJSON(data),
      (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#'),
    );
  }
  assert.throws(() => parseSpineJSON('{'), { code: 'failed' });
  assert.throws(() => parseSpineJSON(base(), { maxValues: 3 }), { code: 'failed' });
  const data = base(mesh);
  assert.throws(() => parseSpineJSON(data, { maxVertices: 2 }), { code: 'failed' });
  data.bones[0].x = Infinity;
  assert.throws(() => parseSpineJSON(data), { code: 'failed' });
  const reason = new Error('cancel');
  assert.throws(
    () => parseSpineJSON(base(), { signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
});
test('fetch loading forwards cancellation and rejects HTTP errors', async (t) => {
  let received;
  const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    received = options.signal;
    return new Response(JSON.stringify(base()));
  });
  const controller = new AbortController();
  assert.ok(await loadSpineJSON('https://example.test/rig.json', { signal: controller.signal }));
  assert.equal(received, controller.signal);
  mock.mock.mockImplementation(async () => new Response('', { status: 404 }));
  await assert.rejects(loadSpineJSON('https://example.test/missing'), { code: 'failed' });
});
test('openly licensed trees parse and animate independently, with exact document round-trips', () => {
  for (const name of ['tree1', 'tree2', 'tree3']) {
    const text = readFileSync(new URL(`./fixtures/trees/${name}.json`, import.meta.url), 'utf8'),
      asset = parseSpineJSON(text),
      rig = asset.createSkeleton();
    assert.deepEqual(JSON.parse(serializeSpineJSON(asset)), JSON.parse(text));
    assert.equal(asset.animations.get('animation').duration, 3.9333);
    const before = [...rig.getAttachment(rig.slots.find((s) => s.mesh)?.name).worldVertices()];
    rig.pose('animation', 1.9666, { loop: false });
    const after = [...rig.getAttachment(rig.slots.find((s) => s.mesh)?.name).worldVertices()];
    assert.notDeepEqual(after, before);
    assert.ok(after.every(Number.isFinite));
    rig.pose('animation', 0, { loop: false });
    close(rig.getAttachment(rig.slots.find((s) => s.mesh)?.name).worldVertices(), before);
  }
});
