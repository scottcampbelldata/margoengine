// DirectX .x files written by hand from the public format reference: a text file, and the same scene as binary tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseX } from '../dist/xfile.js';
import { LoaderError } from '../dist/common.js';

const isError = (code) => (e) => e instanceof LoaderError && e.format === 'X' && e.code === code;
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} against ${b}`);

const TEXT = `xof 0302txt 0032
// a quad and a triangle, skinned to Root, in a two-frame hierarchy
template Unknown { <12345678-1234-1234-1234-123456789abc> DWORD a; }
Material Mat0 { 1.0;0.5;0.25;1.0;; 32.0; 1.0;1.0;1.0;; 0.0;0.0;0.0;;
  TextureFilename { "wall.png"; } }
Frame Root {
  FrameTransformMatrix { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,5,1;; }
  Frame Child {
    FrameTransformMatrix { 1,0,0,0, 0,1,0,0, 0,0,1,0, 2,0,0,1;; }
    Mesh Quad {
      4; 0;0;0;, 1;0;0;, 1;1;0;, 0;1;0;;
      2; 4;0,1,2,3;, 3;0,2,3;;
      MeshNormals { 2; 0;0;-1;, 0;1;0;;  2; 4;0,0,0,0;, 3;1,1,1;; }
      MeshTextureCoords { 4; 0;0;, 1;0;, 1;1;, 0;1;; }
      MeshMaterialList { 2; 2; 1,0;; { Mat0 } Material Plain { 0.0;1.0;0.0;1.0;; 1.0; 0.0;0.0;0.0;; 0.0;0.0;0.0;; } }
      XSkinMeshHeader { 2; 2; 1; }
      SkinWeights { "Root"; 3; 0,1,2; 1.0,0.75,0.5; 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-5,1;; }
      SkinWeights { "Child"; 2; 1,2; 0.25,0.5; 1,0,0,0, 0,1,0,0, 0,0,1,0, -2,0,0,1;; }
    }
  }
}
AnimTicksPerSecond { 30; }
AnimationSet Walk {
  Animation { { Child }
    AnimationKey { 2; 2; 0;3;0,0,0;;, 30;3;0,2,1;;; }
    AnimationKey { 0; 2; 0;4;1,0,0,0;;, 60;4;0.7071068,0,0.7071068,0;;; }
  }
}
`;

test('a text file: frames, mesh, normals, materials, skin and animation', () => {
  const x = parseX(TEXT);
  assert.equal(x.format, 'text');
  assert.deepEqual(
    x.frames.map((f) => [f.name, f.parent]),
    [
      ['Root', -1],
      ['Child', 0],
    ],
  );
  // Z mirrored: the root sits 5 along -Z, the child 2 along X from it.
  assert.deepEqual(x.frames[0].matrix.slice(12, 15), [0, 0, -5]);
  assert.deepEqual(x.frames[1].world.slice(12, 15), [2, 0, -5]);
  assert.deepEqual(x.frames[1].meshes, [0]);
  const mesh = x.meshes[0];
  assert.equal(mesh.name, 'Quad');
  // The quad fans into two triangles, the triangle is one: three triangles, sorted by material (0 first).
  assert.equal(mesh.geometry.indices.length, 9);
  assert.deepEqual(
    mesh.geometry.groups.map((g) => [g.properties.materialIndex, g.start, g.count]),
    [
      [0, 0, 3],
      [1, 3, 6],
    ],
  );
  // Quad corners use normal 0 and the triangle uses normal 1: vertices 0, 2, 3 are used by both, so they split.
  assert.equal(mesh.geometry.positions.length / 3, 4 + 3);
  const source = [...mesh.geometry.attributes.sourceVertex];
  const v1 = source.indexOf(1) * 4;
  const n1 = source.indexOf(1) * 3;
  assert.deepEqual([...mesh.geometry.normals.slice(n1, n1 + 3)], [0, 0, 1]); // the quad's normal (0,0,-1) mirrored
  assert.equal(mesh.geometry.uvs.length, (4 + 3) * 2);
  assert.equal(mesh.materials[0].name, 'Mat0');
  assert.equal(mesh.materials[0].texture, 'wall.png');
  assert.deepEqual(mesh.materials[0].color, [1, 0.5, 0.25, 1]);
  assert.equal(mesh.materials[1].name, 'Plain');
  assert.equal(x.materials.length, 2); // Mat0 at the top and through the list is one material
  assert.equal(x.materials[0], mesh.materials[0]);
  // Skin: vertex 1 has Root 0.75 and Child 0.25.
  assert.deepEqual([...mesh.joints.slice(v1, v1 + 2)], [0, 1]);
  assert.deepEqual([...mesh.weights.slice(v1, v1 + 2)], [0.75, 0.25]);
  assert.equal(mesh.bones[0].name, 'Root');
  assert.equal(mesh.bones[0].frame, 0);
  assert.equal(mesh.bones[1].frame, 1);
  assert.equal(mesh.bones[0].inverseBind[14], 5);
  // Animation: ticks 30 a second, so tick 30 is 1 second.
  const walk = x.animationSets[0];
  assert.equal(walk.name, 'Walk');
  assert.equal(walk.duration, 2);
  const a = walk.animations[0];
  assert.equal(a.frame, 'Child');
  assert.deepEqual([...a.position.times], [0, 1]);
  assert.deepEqual([...a.position.values], [0, 0, 0, 0, 2, -1]);
  // w, x, y, z = (0.7071, 0, 0.7071, 0) becomes x, y, z, w = (-0, -0.7071, 0, 0.7071)
  near(a.rotation.values[4], 0);
  near(a.rotation.values[5], -0.7071068);
  near(a.rotation.values[7], 0.7071068);
  assert.equal(a.rotation.values[3], 1);
});

test('rightHanded false keeps the left-handed numbers and the winding', () => {
  const x = parseX(TEXT, { rightHanded: false });
  assert.deepEqual(x.frames[0].matrix.slice(12, 15), [0, 0, 5]);
  assert.deepEqual([...x.meshes[0].geometry.indices.slice(0, 3)].length, 3);
  const flipped = parseX(TEXT).meshes[0].geometry.indices;
  const kept = x.meshes[0].geometry.indices;
  // Each triangle swaps its last two corners.
  assert.equal(flipped[1], kept[2]);
  assert.equal(flipped[2], kept[1]);
});

// Binary token stream: the same kind of data as a minimal mesh, with 32 or 64-bit floats.
function binary(floatSize) {
  const parts = [];
  const u16 = (n) => parts.push(Uint8Array.of(n & 255, n >> 8));
  const u32 = (n) => parts.push(Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255));
  const name = (s) => {
    u16(1);
    u32(s.length);
    parts.push(new TextEncoder().encode(s));
  };
  const ints = (list) => {
    u16(6);
    u32(list.length);
    list.forEach(u32);
  };
  const floats = (list) => {
    u16(7);
    u32(list.length);
    for (const f of list) {
      const b = new Uint8Array(floatSize);
      new DataView(b.buffer)[floatSize === 4 ? 'setFloat32' : 'setFloat64'](0, f, true);
      parts.push(b);
    }
  };
  const open = () => u16(10),
    close = () => u16(11),
    semi = () => u16(20);
  name('Mesh');
  name('Tri');
  open();
  ints([3]);
  floats([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  ints([1, 3, 0, 1, 2]);
  name('MeshTextureCoords');
  open();
  ints([3]);
  floats([0, 0, 1, 0, 0, 1]);
  close();
  name('MeshMaterialList');
  open();
  ints([1, 1, 0]);
  name('Material');
  name('Gold');
  open();
  floats([1, 0.8, 0, 1, 10, 1, 1, 1, 0, 0, 0]);
  name('TextureFilename');
  open();
  u16(2);
  u32(5);
  parts.push(new TextEncoder().encode('g.png'));
  semi();
  close();
  close();
  close();
  close();
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(16 + body);
  out.set(new TextEncoder().encode(`xof 0303bin 00${floatSize === 4 ? 32 : 64}`));
  let at = 16;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test('binary files, 32 and 64-bit floats', () => {
  for (const size of [4, 8]) {
    const x = parseX(binary(size));
    assert.equal(x.format, 'binary');
    assert.equal(x.meshes.length, 1);
    assert.equal(x.meshes[0].geometry.positions.length, 9);
    assert.deepEqual([...x.meshes[0].geometry.indices], [0, 2, 1]);
    assert.deepEqual([...x.meshes[0].geometry.uvs], [0, 0, 1, 0, 0, 1]);
    assert.equal(x.frames.length, 1); // a mesh outside any frame gets one
    assert.equal(x.materials[0].name, 'Gold');
    assert.equal(x.materials[0].texture, 'g.png');
  }
});

test('hostile files throw coded errors and never allocate from a bare count', () => {
  const head = (kind = 'txt ', floats = '0032') => `xof 0302${kind}${floats}\n`;
  assert.throws(() => parseX('short'), isError('truncated'));
  assert.throws(() => parseX('abcd0302txt 0032'), isError('header'));
  assert.throws(() => parseX('xof 0302txt 0016'), isError('header'));
  assert.throws(() => parseX('xof 0302xyz 0032'), isError('header'));
  assert.throws(() => parseX('xof 0302tzip0032'), isError('unsupported'));
  assert.throws(() => parseX(head() + 'Mesh M { 4000000000; 0;0;0; }'), isError('truncated'));
  assert.throws(() => parseX(head() + 'Mesh M { 1; 0;0;0;; 1; 3;0,1,2;; }'), isError('range'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 3;0,1,9;; }'), isError('range'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 2;0,1;; }'), isError('syntax'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 3;0,1,2;; '), isError('truncated'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 3;0,1,2;; MeshTextureCoords { 2; 0;0;,1;1;; } }'), isError('syntax'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 3;0,1,2;; }', { maxVertices: 2 }), isError('limit'));
  assert.throws(() => parseX(head() + 'Mesh M { 3; 0;0;0;,1;0;0;,0;1;0;; 1; 3;0,1,2;; }', { maxTriangles: 0 }), isError('limit'));
  assert.throws(() => parseX(head() + 'Frame F { '.repeat(300) + '}'.repeat(300), { maxDepth: 16 }), isError('limit'));
  assert.throws(() => parseX(head() + 'Frame F { } '.repeat(10), { maxNodes: 5 }), isError('limit'));
  assert.throws(() => parseX(head() + 'Frame F { FrameTransformMatrix { 1,2,3; } }'), isError('truncated'));
  assert.throws(() => parseX(head() + 'Mesh M { x }'), isError('syntax'));
  assert.throws(() => parseX(head() + '"stray"'), isError('syntax'));
  assert.throws(() => parseX(head() + 'Mesh M { 1;'.padEnd(5000, '0') , { maxVertices: -1 }), isError('range'));
  // Binary: a list that announces more floats than the file holds.
  const b = binary(4);
  const cut = b.slice(0, 40);
  assert.throws(() => parseX(cut), isError('truncated'));
  const huge = new Uint8Array(16 + 6);
  huge.set(new TextEncoder().encode('xof 0302bin 0032'));
  huge.set([7, 0, 255, 255, 255, 127], 16);
  assert.throws(() => parseX(huge), isError('truncated'));
});
