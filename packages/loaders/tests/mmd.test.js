// PMD, PMX and VMD files assembled in the test from the public layouts of the three formats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePMD, parsePMX, parseMMD, parseVMD, sampleVMDBone, vmdBezier } from '../dist/mmd.js';
import { LoaderError } from '../dist/common.js';

const isError = (code) => (e) => e instanceof LoaderError && e.format === 'MMD' && e.code === code;
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} against ${b}`);

class W {
  parts = [];
  u8(...v) {
    this.parts.push(Uint8Array.from(v));
    return this;
  }
  u16(v) {
    return this.u8(v & 255, v >> 8);
  }
  u32(v) {
    return this.u8(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  }
  i32(v) {
    return this.u32(v >>> 0);
  }
  f32(...v) {
    for (const x of v) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, x, true);
      this.parts.push(b);
    }
    return this;
  }
  fixed(n, s) {
    const b = new Uint8Array(n);
    b.set([...s].map((c) => c.charCodeAt(0)));
    this.parts.push(b);
    return this;
  }
  /** PMX text, UTF-16LE. */
  text(s) {
    const b = new Uint8Array(s.length * 2);
    [...s].forEach((c, i) => {
      b[i * 2] = c.charCodeAt(0) & 255;
      b[i * 2 + 1] = c.charCodeAt(0) >> 8;
    });
    return this.i32(b.length).raw(b);
  }
  raw(b) {
    this.parts.push(b);
    return this;
  }
  bytes() {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function pmx({ weightType = 0, edit } = {}) {
  const w = new W();
  w.fixed(4, 'PMX ').f32(2).u8(8, 0, 0, 1, 1, 1, 1, 1, 1); // UTF-16, no extra UV, every index 1 byte
  w.text('Tester').text('Tester EN').text('a model').text('a model EN');
  w.i32(3);
  const vertex = (x, type) => {
    w.f32(x, 0, 1, 0, 0, 1, 0.5, 0.25);
    w.u8(type);
    if (type === 0) w.u8(0);
    else if (type === 1 || type === 3) {
      w.u8(0, 1).f32(0.75);
      if (type === 3) w.f32(1, 2, 3, 4, 5, 6, 7, 8, 9);
    } else w.u8(0, 1, 0, 0).f32(0.5, 0.25, 0.25, 0);
    w.f32(1); // edge scale
  };
  vertex(0, 0);
  vertex(10, weightType || 1);
  vertex(20, 3);
  w.i32(3).u8(0, 1, 2); // one triangle
  w.i32(1).text('tex/skin.png');
  // material: names, diffuse, specular, power, ambient, flags (double sided + edge), edge colour, size, tex, sphere, mode, shared toon
  w.i32(1).text('skin').text('skin EN').f32(1, 0.5, 0.5, 1, 0.1, 0.1, 0.1, 5, 0.2, 0.2, 0.2).u8(1 | 16);
  w.f32(0, 0, 0, 1, 1.5).u8(0, 255, 0, 1, 3).text('memo').i32(3);
  // bones
  w.i32(2);
  w.text('root').text('root EN').f32(0, 0, 0).u8(255).i32(0).u16(1 | 2 | 4 | 8 | 16).u8(1);
  w.text('arm').text('arm EN').f32(10, 0, 10).u8(0).i32(1).u16(2 | 8 | 0x20 | 0x100).f32(0, 1, 0);
  w.u8(0).f32(0.5); // inherit from root at 0.5
  w.u8(0).i32(4).f32(0.5).i32(1).u8(0).u8(1).f32(-1, -1, -1, 1, 1, 1); // IK on root with one limited link
  // morphs: a vertex morph and a group morph
  w.i32(2);
  w.text('smile').text('smile EN').u8(3, 1).i32(1).u8(1).f32(1, 2, 3);
  w.text('grin').text('grin EN').u8(3, 0).i32(1).u8(0).f32(0.5);
  w.i32(0); // display frames
  w.i32(1).text('body').text('body EN');
  // rigid body: bone, group, mask, shape(capsule), size, position, rotation, mass, damping x2, restitution, friction, mode
  w.u8(0).u8(3).u16(0xfffe).u8(2).f32(1, 2, 3, 10, 0, 5, 0.1, 0.2, 0.3, 2, 0.5, 0.6, 0.1, 0.9).u8(1);
  w.i32(1).text('joint').text('joint EN').u8(0, 0, 0).f32(1, 2, 3, 0, 0, 0, -1, -1, -1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 5, 5, 5, 0, 0, 0);
  const out = w.bytes();
  return edit ? edit(out) : out;
}

test('a PMX model: vertices, weights, material, bones, morphs, rigid body and joint', () => {
  const m = parsePMX(pmx());
  assert.equal(m.format, 'PMX');
  assert.equal(m.version, 2);
  assert.equal(m.name, 'Tester');
  assert.equal(m.commentEnglish, 'a model EN');
  const g = m.geometry;
  assert.equal(g.positions.length, 9);
  near(g.positions[3], 10 * 0.08); // 10 MMD units at 8 cm
  assert.deepEqual([...g.indices], [0, 2, 1]); // winding swapped for the mirrored Z
  assert.equal(g.normals[2], -1); // normal (0,0,1) mirrored
  near(g.positions[2], -1 * 0.08);
  assert.deepEqual([...g.groups[0].properties ? [g.groups[0].properties.materialIndex] : []], [0]);
  assert.equal(g.groups[0].count, 3);
  // weights: BDEF1, BDEF2 at 0.75, SDEF at 0.75
  assert.deepEqual([...m.weights.slice(0, 4)], [1, 0, 0, 0]);
  assert.deepEqual([...m.joints.slice(4, 6)], [0, 1]);
  assert.deepEqual([...m.weights.slice(4, 6)], [0.75, 0.25]);
  assert.deepEqual([...m.sdef.vertices], [2]);
  near(m.sdef.data[2], -3 * 0.08); // C z mirrored and scaled
  const mat = m.materials[0];
  assert.equal(mat.name, 'skin');
  assert.equal(mat.texture, 'tex/skin.png');
  assert.equal(mat.doubleSided, true);
  assert.equal(mat.edge, true);
  assert.equal(mat.toon, 3);
  assert.equal(mat.edgeSize, 1.5);
  assert.equal(m.textures.length, 1);
  assert.equal(m.bones.length, 2);
  assert.equal(m.bones[1].parent, 0);
  assert.equal(m.bones[1].inherit, 0);
  assert.equal(m.bones[1].inheritRotation, true);
  assert.equal(m.bones[1].inheritRate, 0.5);
  assert.deepEqual(m.bones[1].ik.links[0].limit.max, [1, 1, 1]);
  near(m.bones[1].position[2], -10 * 0.08);
  assert.equal(m.bones[0].tail, 1);
  assert.deepEqual(m.bones[1].tailOffset.map((v) => Math.round(v * 1e6) / 1e6), [0, 0.08, 0]);
  assert.equal(m.morphs[0].type, 'vertex');
  assert.deepEqual(m.morphs[0].offsets[0].offset.map((v) => Math.round(v * 1e6) / 1e6), [0.08, 0.16, -0.24]);
  assert.equal(m.morphs[1].type, 'group');
  assert.deepEqual(m.morphs[1].offsets[0], { morph: 0, rate: 0.5 });
  const body = m.rigidBodies[0];
  assert.equal(body.shape, 'capsule');
  assert.equal(body.mode, 'physics');
  assert.equal(body.group, 3);
  near(body.position[2], -5 * 0.08);
  near(body.rotation[0], -0.1);
  assert.equal(m.joints_[0].bodyA, 0);
  assert.equal(m.joints_.length, 1);
  assert.equal(parseMMD(pmx()).format, 'PMX');
  // Left-handed numbers when asked.
  const raw = parsePMX(pmx(), { rightHanded: false, scale: 1 });
  assert.deepEqual([...raw.geometry.indices], [0, 1, 2]);
  assert.equal(raw.geometry.positions[3], 10);
});

test('PMX hostile input throws coded errors', () => {
  assert.throws(() => parsePMX(new Uint8Array(40)), isError('header'));
  assert.throws(() => parsePMX(pmx().slice(0, 100)), isError('truncated'));
  assert.throws(() => parsePMX(pmx().slice(0, 300)), isError('truncated'));
  assert.throws(() => parsePMX(pmx(), { maxVertices: 2 }), isError('limit'));
  assert.throws(() => parsePMX(pmx(), { maxTriangles: 0 }), isError('limit'));
  assert.throws(() => parsePMX(pmx(), { scale: -1 }), isError('range'));
  const edit = (f) => pmx({ edit: (b) => (f(b), b) });
  assert.throws(() => parsePMX(edit((b) => new DataView(b.buffer).setFloat32(4, 9, true))), isError('unsupported'));
  assert.throws(() => parsePMX(edit((b) => (b[9] = 3))), isError('header')); // text encoding
  assert.throws(() => parsePMX(edit((b) => (b[10] = 9))), isError('header')); // 9 extra UV sets
  assert.throws(() => parsePMX(edit((b) => (b[11] = 9))), isError('header')); // vertex index size 9
  assert.throws(() => parsePMX(edit((b) => (b[12] = 3))), isError('header')); // index size 3
  // A vertex count that claims far more than the file holds.
  const huge = pmx();
  const at = 17 + 16 + 22 + 18 + 24; // the header and the four texts
  new DataView(huge.buffer).setInt32(at, 0x7fffffff, true);
  assert.throws(() => parsePMX(huge, { maxVertices: 0x7fffffff }), isError('truncated'));
  new DataView(huge.buffer).setInt32(at, -5, true);
  assert.throws(() => parsePMX(huge), isError('syntax'));
});

function pmd() {
  const w = new W();
  w.fixed(3, 'Pmd').f32(1).fixed(20, 'Old model').fixed(256, 'comment');
  w.u32(3);
  const vertex = (x, b0, b1, wt) => w.f32(x, 0, 1, 0, 0, 1, 0.5, 0.25).u16(b0).u16(b1).u8(wt, 0);
  vertex(0, 0, 0, 100);
  vertex(10, 0, 1, 25);
  vertex(20, 1, 0, 50);
  w.u32(3).u16(0).u16(1).u16(2);
  w.u32(1).f32(1, 1, 1, 0.5, 5, 0.1, 0.1, 0.1, 0.2, 0.2, 0.2).u8(2, 1).u32(3).fixed(20, 'skin.bmp*env.spa');
  w.u16(2);
  w.fixed(20, 'root').u16(0xffff).u16(1).u8(1).u16(0).f32(0, 0, 0);
  w.fixed(20, 'arm').u16(0).u16(0).u8(0).u16(0).f32(10, 0, 10);
  w.u16(1).u16(1).u16(0).u8(1).u16(5).f32(0.5).u16(0); // IK of bone 1 targeting 0 with one link
  w.u16(1).fixed(20, 'smile').u32(1).u8(2).u32(1).f32(1, 2, 3);
  w.u8(0).u8(0).u32(0);
  w.u8(1).fixed(20, 'English').fixed(256, 'english comment').fixed(20, 'root_en').fixed(20, 'arm_en').fixed(0, '');
  w.raw(new Uint8Array(1000));
  w.u32(1).fixed(20, 'body').u16(0).u8(2).u16(1).u8(0).f32(1, 1, 1, 0, 0, 10, 0, 0, 0, 1, 0.5, 0.5, 0, 1).u8(0);
  w.u32(1).fixed(20, 'joint').u32(0).u32(0).f32(0, 0, 0, 0, 0, 0, -1, -1, -1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  return w.bytes();
}

test('a PMD model', () => {
  const m = parsePMD(pmd());
  assert.equal(m.format, 'PMD');
  assert.equal(m.name, 'Old model');
  assert.equal(m.nameEnglish, 'English');
  assert.equal(m.geometry.positions.length, 9);
  assert.deepEqual([...m.geometry.indices], [0, 2, 1]);
  assert.deepEqual([...m.weights.slice(4, 6)], [0.25, 0.75]);
  assert.deepEqual([...m.joints.slice(8, 10)], [1, 0]);
  const mat = m.materials[0];
  assert.equal(mat.texture, 'skin.bmp');
  assert.equal(mat.sphere, 'env.spa');
  assert.equal(mat.sphereMode, 2);
  assert.equal(mat.toon, 2);
  assert.equal(mat.doubleSided, true); // alpha 0.5
  assert.equal(mat.triangles, 1);
  assert.deepEqual(
    m.bones.map((b) => [b.name, b.nameEnglish, b.parent]),
    [
      ['root', 'root_en', -1],
      ['arm', 'arm_en', 0],
    ],
  );
  assert.equal(m.bones[1].ik.target, 0);
  assert.equal(m.bones[1].ik.iterations, 5);
  assert.equal(m.morphs[0].name, 'smile');
  assert.deepEqual(m.morphs[0].offsets[0].offset.map((v) => Math.round(v * 1e6) / 1e6), [0.08, 0.16, -0.24]);
  assert.equal(m.rigidBodies[0].shape, 'sphere');
  assert.equal(m.rigidBodies[0].name, 'body');
  assert.equal(m.joints_[0].name, 'joint');
  assert.equal(parseMMD(pmd()).format, 'PMD');
  assert.throws(() => parsePMD(pmd().slice(0, 400)), isError('truncated'));
  assert.throws(() => parsePMD(new Uint8Array(300)), isError('header'));
  assert.throws(() => parseMMD(new Uint8Array(30)), isError('header'));
  const bad = pmd();
  bad[283 + 4 + 38 * 3 + 4 + 5] = 0xff; // a face index past the vertices
  assert.throws(() => parsePMD(bad), isError('range'));
  const huge = pmd();
  new DataView(huge.buffer).setUint32(283, 0xffffffff, true);
  assert.throws(() => parsePMD(huge), isError('limit'));
  new DataView(huge.buffer).setUint32(283, 5000000, true);
  assert.throws(() => parsePMD(huge), isError('truncated'));
});

function vmd({ short = false } = {}) {
  const w = new W();
  w.fixed(30, 'Vocaloid Motion Data 0002').fixed(20, 'Tester');
  const ease = new Uint8Array(64).fill(0);
  for (let k = 0; k < 4; k++) ease.set([20, 20, 107, 107], 0), (ease[k] = 20), (ease[4 + k] = 20), (ease[8 + k] = 107), (ease[12 + k] = 107);
  w.u32(3);
  w.fixed(15, 'arm').u32(10).f32(10, 0, 0, 0, 0, 0, 1).raw(ease);
  w.fixed(15, 'arm').u32(0).f32(0, 0, 0, 0, 0, 0, 1).raw(ease); // out of order on purpose
  w.fixed(15, 'leg').u32(5).f32(0, 1, 2, 0, 0, 0, 1).raw(ease);
  if (short) return w.bytes();
  w.u32(1).fixed(15, 'smile').u32(4).f32(0.5);
  w.u32(1).u32(30).f32(-30, 0, 10, 20, 0.1, 0.2, 0.3).raw(new Uint8Array(24)).u32(45).u8(0);
  w.u32(1).u32(0).f32(0.5, 0.5, 0.5, -0.5, -1, 0.5);
  w.u32(1).u32(2).u8(1).f32(8);
  w.u32(1).u32(9).u8(1).u32(1).fixed(20, 'ik_left').u8(0);
  return w.bytes();
}

test('a VMD motion: bone, morph, camera, light, shadow and IK keys', () => {
  const v = parseVMD(vmd(), { scale: 1 });
  assert.equal(v.modelName, 'Tester');
  assert.equal(v.fps, 30);
  assert.deepEqual(v.bones.map((b) => b.name).sort(), ['arm', 'leg']);
  const arm = v.bones.find((b) => b.name === 'arm');
  assert.deepEqual([...arm.frames], [0, 10]); // sorted
  assert.deepEqual([...arm.positions], [0, 0, 0, 10, 0, 0]);
  assert.equal(v.bones.find((b) => b.name === 'leg').positions[2], -2); // Z mirrored
  assert.equal(arm.interpolation.length, 128);
  assert.deepEqual([...v.morphs[0].weights], [0.5]);
  assert.equal(v.camera.frames[0], 30);
  near(v.camera.distance[0], -30);
  near(v.camera.fov[0], (45 * Math.PI) / 180);
  assert.equal(v.camera.perspective[0], 1);
  assert.deepEqual([...v.camera.position], [0, 10, -20]);
  near(v.camera.rotation[0], -0.1);
  assert.equal(v.lights[0].position[2], -0.5);
  assert.equal(v.shadows[0].mode, 1);
  assert.deepEqual(v.ik[0].states, [{ name: 'ik_left', enabled: false }]);
  assert.equal(v.duration, 30);
  // Halfway between frames 0 and 10 with a linear ease: x = 5.
  near(sampleVMDBone(arm, 5).position[0], 5, 1e-3);
  assert.deepEqual(sampleVMDBone(arm, -3).position, [0, 0, 0]);
  assert.deepEqual(sampleVMDBone(arm, 99).position, [10, 0, 0]);
  near(vmdBezier(20, 20, 107, 107, 0.5), 0.5, 1e-6);
  assert.equal(vmdBezier(20, 20, 107, 107, 0), 0);
  // A file that ends after the bone keys (old exporters) still parses.
  assert.equal(parseVMD(vmd({ short: true })).camera, undefined);
  assert.throws(() => parseVMD(new Uint8Array(100)), isError('header'));
  assert.throws(() => parseVMD(vmd().slice(0, 100)), isError('truncated'));
  assert.throws(() => parseVMD(vmd(), { maxKeys: 1 }), isError('limit'));
  const huge = vmd();
  new DataView(huge.buffer).setUint32(50, 0xffffffff, true);
  assert.throws(() => parseVMD(huge), isError('limit'));
  assert.throws(() => parseVMD(huge, { maxKeys: 0xffffffff }), isError('truncated'));
});
