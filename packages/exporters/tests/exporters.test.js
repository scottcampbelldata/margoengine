import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {Geometry, PbrMaterial, box} from '@margoengine/core/extension';
import {parseGLTF} from '@margoengine/gltf';
import {GLTFAsset, PBRModel} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import * as exporters from '../dist/index.js';
import {exportGLB, exportGLTF, exportOBJ, exportPLY, exportSTL} from '../dist/index.js';
import {accessor, headlessEngine, parseASCIISTL, parseMTL, parseOBJ, parsePLY, readGLB, transformPoint, validate, validator} from './helpers.js';

const fixture = async name => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));

test('engine exports reject missing mesh geometry and preserve intentionally empty data scenes', async () => {
  const engine = await headlessEngine();
  try {
    const node = engine.createMesh();
    assert.throws(() => exportGLTF(engine, {root: node}), /no supported mesh geometry/);
    assert.throws(() => exportGLB(engine), /no supported mesh geometry/);
    assert.deepEqual(exportGLTF({nodes: []}).json.scenes, [{}]);
    node.visible = false;
    assert.equal(exportGLTF(engine, {root: node}).json.meshes, undefined);
  } finally {engine.dispose();}
});

test('non-finite alpha cutoffs reject instead of serializing as JSON null', () => {
  const geometry = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
  for (const alphaCutoff of [Infinity, -Infinity, NaN]) {
    const scene = {nodes: [{geometry, material: {alphaMode: 'MASK', alphaCutoff}}]};
    assert.throws(() => exportGLB(scene), RangeError);
    assert.throws(() => exportGLTF(scene), RangeError);
  }
  for (const alphaCutoff of [0, 0.5, 2]) {
    const scene = {nodes: [{geometry, material: {alphaMode: 'MASK', alphaCutoff}}]};
    assert.equal(readGLB(exportGLB(scene)).json.materials[0].alphaCutoff, alphaCutoff);
    assert.equal(exportGLTF(scene).json.materials[0].alphaCutoff, alphaCutoff);
  }
});
const close = (a, b, epsilon = 1e-5, label = 'value') => {
  assert.equal(a.length, b.length, `${label} length`);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i]-b[i]) <= epsilon, `${label}[${i}]: ${a[i]} vs ${b[i]}`);
};
const needsValidator = validator ? {} : {skip: 'gltf-validator not installed in MARGOENGINE_EXPORTERS_TOOLS'};
async function assertValid(data, resources) {
  const result = await validate(data, resources);
  assert.equal(result.errors, 0, JSON.stringify(result.messages, null, 1));
  assert.equal(result.warnings, 0, JSON.stringify(result.messages, null, 1));
  return result;
}
function assertAligned(json, bin) {
  for (const view of json.bufferViews ?? []) assert.equal((view.byteOffset ?? 0)%4, 0, 'bufferView offset aligned');
  assert.equal(json.buffers[0].byteLength%4, 0, 'buffer length aligned');
  if (bin) assert.equal(bin.length, json.buffers[0].byteLength);
}

/** Parented meshes with shared geometry, two materials and one hidden mesh. */
async function buildScene() {
  const engine = await headlessEngine();
  const cube = box(1, 2, 3), red = new PbrMaterial({color: '#ff0000', roughness: 0.25, metalness: 1}), blue = new PbrMaterial({color: [0, 0.2, 0.9], roughness: 0.75, doubleSided: false});
  const base = engine.createMesh().setGeometry(cube).setMaterial(red).setPosition([1, 2, 3]).setRotation([0.3, -0.4, 0.5]).setScale([2, 2, 2]);
  base.name = 'base';
  const arm = engine.createMesh(base).setGeometry(cube).setMaterial(blue).setPosition([0, 1.5, 0]).setQuaternion([0, 0.38268343, 0, 0.92387953]).setScale([1, 0.5, -1]);
  arm.name = 'arm';
  const pivot = engine.createMesh(arm).setPosition([0.25, 0, 0]);
  pivot.name = 'pivot';
  const hand = engine.createMesh(pivot).setGeometry(cube).setMaterial(red).setScale([0.5, 0.5, 0.5]);
  hand.name = 'hand';
  const hidden = engine.createMesh(base).setGeometry(box()).setMaterial(blue).setPosition([5, 0, 0]);
  hidden.name = 'hidden';
  hidden.visible = false;
  const other = engine.createMesh().setGeometry(cube).setMaterial(blue).setPosition([-4, 0, 0]);
  other.name = 'other';
  return {engine, cube, red, blue, base, arm, pivot, hand, hidden, other};
}

test('public API exposes exporter functions and module evaluation is SSR-safe', () => {
  assert.deepEqual(Object.keys(exporters).sort(), ['exportGLB', 'exportGLTF', 'exportModel', 'exportOBJ', 'exportPLY', 'exportSTL', 'exportUSDZ']);
  // A fresh process where touching any browser or GPU global throws, then import and export.
  const script = `for (const name of ['window', 'document', 'navigator', 'Worker', 'GPUBufferUsage', 'requestAnimationFrame']) Object.defineProperty(globalThis, name, {get() {throw new Error('touched ' + name);}, configurable: true});
    const m = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const geometry = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
    const scene = {nodes: [{geometry}]};
    m.exportGLB(scene); m.exportGLTF(scene); m.exportSTL(scene); m.exportOBJ(scene); m.exportPLY(scene);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {stdio: 'pipe'});
});

test('GLB of an engine hierarchy: dedup, transforms, min/max, alignment, Khronos validator', needsValidator, async () => {
  const {engine, cube, base, arm, hand, other} = await buildScene();
  const glb = exportGLB(engine, {generator: 'exporter tests'});
  assert.equal(glb.length%4, 0);
  await assertValid(glb);
  const {json, bin, jsonLength} = readGLB(glb);
  assert.equal(jsonLength%4, 0);
  assertAligned(json, bin);
  assert.equal(json.asset.generator, 'exporter tests');
  assert.deepEqual(json.nodes.map(n => n.name), ['base', 'arm', 'pivot', 'hand', 'other']);
  assert.deepEqual(json.scenes[0].nodes, [0, 4]);
  assert.deepEqual(json.nodes[0].children, [1]);
  // One geometry shared by four meshes and two materials: one set of accessors, two glTF meshes.
  assert.equal(json.accessors.length, 3);
  assert.equal(json.meshes.length, 2);
  assert.equal(json.materials.length, 2);
  assert.equal(json.nodes[0].mesh, json.nodes[3].mesh);
  assert.equal(json.nodes[1].mesh, json.nodes[4].mesh);
  assert.equal(json.accessors[2].componentType, 5123);
  assert.deepEqual(json.accessors[0].min, [-0.5, -1, -1.5]);
  assert.deepEqual(json.accessors[0].max, [0.5, 1, 1.5]);
  close(json.nodes[0].translation, [1, 2, 3]);
  close(json.nodes[0].scale, [2, 2, 2]);
  close(json.nodes[1].scale, [1, 0.5, -1]);
  close(json.nodes[1].rotation, [0, 0.38268343, 0, 0.92387953]);
  assert.equal(json.nodes[2].mesh, undefined);
  const red = json.materials[json.meshes[json.nodes[0].mesh].primitives[0].material];
  assert.deepEqual(red.pbrMetallicRoughness, {baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 0.25});
  assert.equal(red.doubleSided, true);
  const blue = json.materials[json.meshes[json.nodes[1].mesh].primitives[0].material];
  close(blue.pbrMetallicRoughness.baseColorFactor, [0, 0.2, 0.9, 1], 1e-7);
  assert.equal(blue.doubleSided, undefined);
  // Vertex data is the core geometry, de-interleaved.
  const positions = accessor(json, bin, 0), normals = accessor(json, bin, 1), indices = accessor(json, bin, 2);
  for (let i = 0; i < 24; i++) {close(positions.subarray(i*3, i*3+3), cube.vertices.subarray(i*6, i*6+3), 0); close(normals.subarray(i*3, i*3+3), cube.vertices.subarray(i*6+3, i*6+6), 0);}
  assert.deepEqual(Array.from(indices), Array.from(cube.indices));

  // Re-import with @margoengine/gltf into a second engine and compare kernel world matrices.
  const target = await headlessEngine();
  const model = parseGLTF(target, glb);
  engine.store.tick(false); target.store.tick(false);
  assert.equal(model.meshes.length, 4);
  const expected = [base, arm, hand, other].map(m => engine.store.matrices.subarray(m.id*16, m.id*16+16));
  const actual = model.meshes.map(m => target.store.matrices.subarray(m.id*16, m.id*16+16));
  for (const want of expected) assert.ok(actual.some(got => got.every((v, i) => Math.abs(v-want[i]) < 1e-5)), 'world matrix survives the round trip');
  for (const mesh of model.meshes) assert.deepEqual(Array.from(mesh.geometry.vertices), Array.from(cube.vertices));
  const names = model.nodes.map(n => n.name).sort();
  assert.deepEqual(names, ['arm', 'base', 'hand', 'other', 'pivot']);
});

test('only visible, root mesh, flatten and invisible export', needsValidator, async () => {
  const {engine, base, arm, hand, hidden, other} = await buildScene();
  const all = readGLB(exportGLB(engine, {onlyVisible: false})).json;
  assert.ok(all.nodes.some(n => n.name === 'hidden'));
  assert.ok(!readGLB(exportGLB(engine)).json.nodes.some(n => n.name === 'hidden'));

  const subtree = exportGLB(engine, {root: arm});
  await assertValid(subtree);
  const sub = readGLB(subtree).json;
  assert.deepEqual(sub.nodes.map(n => n.name), ['arm', 'pivot', 'hand']);
  close(sub.nodes[0].translation, [0, 1.5, 0]);
  assert.equal(readGLB(exportGLB(engine, {root: hidden})).json.nodes, undefined);
  assert.throws(() => exportGLB(engine, {root: {}}), /live mesh/);

  // Flattened world transforms match the Wasm kernel's world matrices.
  const flat = exportGLB(engine, {flatten: true});
  await assertValid(flat);
  const {json} = readGLB(flat);
  engine.store.tick(false);
  assert.deepEqual(json.nodes.map(n => n.name), ['base', 'arm', 'hand', 'other']);
  assert.ok(json.nodes.every(n => !n.children));
  const target = await headlessEngine();
  const model = parseGLTF(target, flat);
  target.store.tick(false);
  [base, arm, hand, other].forEach((mesh, i) => {
    const want = engine.store.matrices.subarray(mesh.id*16, mesh.id*16+16);
    const node = model.nodes.find(n => n.name === json.nodes[i].name), got = target.store.matrices.subarray(node.id*16, node.id*16+16);
    close(got, want, 1e-5, json.nodes[i].name);
  });
  base.visible = false;
  const empty = exportGLB(engine);
  await assertValid(empty);
  assert.deepEqual(readGLB(empty).json.nodes.map(n => n.name), ['other']);
});

test('flatten bakes sheared world transforms into vertices with flipped winding for mirrors', needsValidator, async () => {
  const geometry = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
  const s = Math.SQRT1_2;
  const scene = {nodes: [{name: 'parent', scale: [3, 1, -1], children: [{name: 'child', rotation: [0, 0, Math.sin(Math.PI/8), Math.cos(Math.PI/8)], geometry}]}]};
  const glb = exportGLB(scene, {flatten: true});
  await assertValid(glb);
  const {json, bin} = readGLB(glb);
  assert.equal(json.nodes.length, 1);
  assert.equal(json.nodes[0].scale, undefined);
  const p = accessor(json, bin, 0), n = accessor(json, bin, 1), idx = accessor(json, bin, 2);
  // child world = scale(3,1,-1) * rotZ(45deg): vertex (1,0,0) -> (3s, s, 0).
  close(p, [0, 0, 0, 3*s, s, 0, -3*s, s, 0], 1e-6);
  close(n.subarray(0, 3), [0, 0, -1], 1e-6);
  assert.deepEqual(Array.from(idx), [0, 2, 1]);
});

test('geometry data with UVs, tangents, colors and a real PNG texture (Khronos BoxTextured)', needsValidator, async () => {
  const source = readGLB(await fixture('BoxTextured.glb')), primitive = source.json.meshes[0].primitives[0];
  const positions = accessor(source.json, source.bin, primitive.attributes.POSITION), normals = accessor(source.json, source.bin, primitive.attributes.NORMAL);
  const uvs = accessor(source.json, source.bin, primitive.attributes.TEXCOORD_0), indices = accessor(source.json, source.bin, primitive.indices);
  const view = source.json.bufferViews[source.json.images[0].bufferView], image = source.bin.slice(view.byteOffset, view.byteOffset+view.byteLength);
  const count = positions.length/3;
  const tangents = Array.from({length: count}, (_, i) => [normals[i*3+2] || normals[i*3+1], 0, -normals[i*3] || 0.5, i%2 ? -1 : 1]).flat();
  const colors = Array.from({length: count*4}, (_, i) => (i%4 === 3 ? 1 : (i%7)/7));
  const textured = {positions, normals, uvs, tangents, colors, indices};
  const texture = {image, mimeType: 'image/png', name: 'CesiumLogoFlat'};
  const material = {name: 'Textured', color: [1, 1, 1], roughness: 0.6, metalness: 0, baseColorTexture: texture, normalTexture: texture, emissive: [0.1, 0, 0]};
  const scene = {nodes: [{name: 'a', geometry: textured, material, translation: [1, 0, 0]}, {name: 'b', geometry: textured, material, translation: [-1, 0, 0]}]};

  for (const glb of [exportGLB(scene), exportGLB(scene, {flatten: true})]) {
    await assertValid(glb);
    const {json, bin} = readGLB(glb);
    assertAligned(json, bin);
    assert.equal(json.images.length, 1);
    assert.equal(json.textures.length, 1);
    assert.equal(json.meshes.length, 1);
    const attributes = json.meshes[0].primitives[0].attributes;
    assert.deepEqual(Object.keys(attributes).sort(), ['COLOR_0', 'NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0']);
    assert.deepEqual(Array.from(accessor(json, bin, attributes.TEXCOORD_0)), Array.from(uvs));
    assert.deepEqual(accessor(json, bin, attributes.TANGENT).filter((_, i) => i%4 === 3).map(Math.abs), new Float32Array(count).fill(1));
    const imageView = json.bufferViews[json.images[0].bufferView];
    assert.deepEqual(bin.subarray(imageView.byteOffset, imageView.byteOffset+imageView.byteLength), image);
    assert.equal(json.materials[0].normalTexture.index, json.materials[0].pbrMetallicRoughness.baseColorTexture.index);
  }

  // .gltf with an embedded data URI, and with a separate .bin
  const embedded = exportGLTF(scene);
  assert.equal(embedded.bin, null);
  assert.match(embedded.json.buffers[0].uri, /^data:application\/octet-stream;base64,/);
  await assertValid(embedded.text);
  const separate = exportGLTF(scene, {embed: false, binUri: 'box textured.bin'});
  assert.equal(separate.binUri, 'box%20textured.bin');
  assert.equal(separate.bin.length, separate.json.buffers[0].byteLength);
  assertAligned(separate.json, separate.bin);
  await assertValid(separate.text, {'box%20textured.bin': separate.bin, 'box textured.bin': separate.bin});
  const fromUri = Uint8Array.from(atob(embedded.json.buffers[0].uri.split(',')[1]), c => c.charCodeAt(0));
  assert.deepEqual(fromUri, separate.bin);
  assert.deepEqual(readGLB(exportGLB(scene)).bin, separate.bin);
});

test('Khronos Box.glb survives import, export and re-import', needsValidator, async () => {
  const engine = await headlessEngine(), original = parseGLTF(engine, await fixture('Box.glb'));
  const glb = exportGLB(engine);
  await assertValid(glb);
  const {json} = readGLB(glb);
  close(json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.8, 0, 0, 1], 1e-7);
  assert.equal(json.materials[0].pbrMetallicRoughness.metallicFactor, 0);
  const target = await headlessEngine(), copy = parseGLTF(target, glb);
  engine.store.tick(false); target.store.tick(false);
  assert.equal(copy.meshes.length, 1);
  assert.deepEqual(Array.from(copy.meshes[0].geometry.vertices), Array.from(original.meshes[0].geometry.vertices));
  assert.deepEqual(Array.from(copy.meshes[0].geometry.indices), Array.from(original.meshes[0].geometry.indices));
  close(target.store.matrices.subarray(copy.meshes[0].id*16, copy.meshes[0].id*16+16), engine.store.matrices.subarray(original.meshes[0].id*16, original.meshes[0].id*16+16), 1e-6);
  assert.deepEqual(Array.from(copy.meshes[0].material.data), Array.from(original.meshes[0].material.data));
});

test('large geometry switches to 32-bit indices and normals are normalized', needsValidator, async () => {
  const count = 70_002, positions = new Float32Array(count*3), normals = new Float32Array(count*3), indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {positions.set([i%3, Math.floor(i/3)%7, i/1000], i*3); normals.set([0, 0, i%2 ? 5 : 0], i*3); indices[i] = count-1-i;}
  // Two corner orders keep every triangle non-degenerate enough for the validator.
  for (let i = 0; i < count; i += 3) positions.set([0, 0, i, 1, 0, i, 0, 1, i], i*3);
  const glb = exportGLB({nodes: [{geometry: {positions, normals, indices}}]});
  await assertValid(glb);
  const {json, bin} = readGLB(glb);
  assert.equal(json.accessors[2].componentType, 5125);
  const n = accessor(json, bin, 1);
  for (let i = 0; i < count; i++) assert.ok(Math.abs(Math.hypot(n[i*3], n[i*3+1], n[i*3+2])-1) < 1e-6);
  assert.equal(json.meshes[0].primitives[0].material, undefined);
});

test('input validation', async () => {
  const good = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
  const bad = [
    [{nodes: [{geometry: {...good, indices: [0, 1, 3]}}]}, /Index exceeds/],
    [{nodes: [{geometry: {...good, indices: [0, 1]}}]}, /complete triangles/],
    [{nodes: [{geometry: {...good, positions: [0, 0, NaN, 1, 0, 0, 0, 1, 0]}}]}, /finite/],
    [{nodes: [{geometry: {...good, normals: [0, 0, 1]}}]}, /Normals needs 9/],
    [{nodes: [{geometry: {...good, uvs: [0, 0]}}]}, /UVs needs 6/],
    [{nodes: [{geometry: {...good, colors: [2, 0, 0, 0, 0, 0, 0, 0, 0]}}]}, /Colors must be in/],
    [{nodes: [{geometry: {...good, tangents: new Array(12).fill(0)}}]}, /Tangents must be nonzero/],
    [{nodes: [{geometry: good, material: {color: [1.5, 0, 0]}}]}, /\[0, 1\]/],
    [{nodes: [{geometry: good, material: {baseColorTexture: {image: new Uint8Array(16), mimeType: 'image/png'}}}]}, /PNG or JPEG/],
    [{nodes: [{geometry: good, material: {baseColorTexture: {image: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0), mimeType: 'image/png'}}}]}, /need geometry with uvs/],
    [{nodes: [{geometry: good, scale: [1, 0, 1]}]}, /Scale must be nonzero/],
    [{nodes: [{geometry: good, rotation: [0, 0, 0, 0]}]}, /Quaternion must be nonzero/],
    [{nodes: [{material: {}}]}, /needs geometry/],
    [{nodes: 'x'}, /Expected a Margo Engine engine/],
    [null, /Expected a Margo Engine engine/],
  ];
  for (const [scene, pattern] of bad) assert.throws(() => exportGLB(scene), pattern);
  const shared = {geometry: good};
  assert.throws(() => exportGLB({nodes: [shared, shared]}), /appears twice/);
  assert.throws(() => exportGLTF({nodes: [{geometry: good}]}, {embed: false, binUri: 'https://x/y.bin'}), /relative/);
  assert.throws(() => exportGLB({nodes: []}, {flatten: 1}), /flatten/);
  assert.throws(() => exportSTL({nodes: []}, {name: 'solid x'}), /solid/);
  const engine = await headlessEngine();
  engine.dispose();
  assert.throws(() => exportGLB(engine), /disposed/);
});

test('STL binary is byte-exact: 80-byte header, count, 50-byte records', async () => {
  const geometry = {positions: [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4], normals: new Array(12).fill(0).map((_, i) => i%3 === 2 ? 1 : 0), indices: [0, 1, 2, 0, 2, 3]};
  const scene = {nodes: [{translation: [1, 1, 1], children: [{geometry}]}]};
  const stl = exportSTL(scene);
  assert.ok(stl instanceof Uint8Array);
  assert.equal(stl.length, 84+2*50);
  const header = new TextDecoder().decode(stl.subarray(0, 80));
  assert.equal(header.replace(/\0+$/, ''), 'Margo Engine binary STL');
  assert.ok(stl.subarray('Margo Engine binary STL'.length, 80).every(b => b === 0));
  const view = new DataView(stl.buffer);
  assert.equal(view.getUint32(80, true), 2);
  const record = i => Array.from({length: 12}, (_, k) => view.getFloat32(84+i*50+k*4, true));
  assert.deepEqual(record(0), [0, 0, 1, 1, 1, 1, 3, 1, 1, 1, 4, 1]);
  assert.deepEqual(record(1), [1, 0, 0, 1, 1, 1, 1, 4, 1, 1, 1, 5]);
  assert.equal(view.getUint16(84+48, true), 0);
  assert.equal(view.getUint16(84+98, true), 0);

  // ASCII parses back to the same triangles, and a mirrored transform keeps faces outward.
  const ascii = exportSTL(scene, {binary: false, name: 'my part'});
  const facets = parseASCIISTL(ascii);
  assert.match(ascii, /^solid my_part\n/);
  assert.deepEqual(facets.map(f => [...f.normal, ...f.vertices.flat()]), [record(0), record(1)]);
  const mirrored = new DataView(exportSTL({nodes: [{scale: [1, 1, -1], geometry: box()}]}).buffer);
  for (let i = 0; i < 12; i++) {
    const n = [0, 1, 2].map(k => mirrored.getFloat32(84+i*50+k*4, true)), a = [0, 1, 2].map(k => mirrored.getFloat32(84+i*50+12+k*4, true));
    assert.ok(n[0]*a[0]+n[1]*a[1]+n[2]*a[2] > 0, 'face normal points outward');
  }
});

test('STL and PLY and OBJ of an engine scene agree with kernel world matrices', async () => {
  const {engine, cube, base, arm, hand, other} = await buildScene();
  engine.store.tick(false);
  const meshes = [base, arm, hand, other], world = meshes.map(m => Array.from(engine.store.matrices.subarray(m.id*16, m.id*16+16)));
  const expected = world.flatMap(m => Array.from({length: 24}, (_, i) => transformPoint(m, cube.vertices.subarray(i*6, i*6+3))));

  const stl = new DataView(exportSTL(engine).buffer);
  assert.equal(stl.getUint32(80, true), 48);
  for (let t = 0; t < 48; t++) {
    const mesh = Math.floor(t/12), tri = t%12, corners = [0, 1, 2].map(k => cube.indices[tri*3+k]);
    const flip = mesh === 1 || mesh === 2; // arm has scale z -1, hand inherits it
    const order = flip ? [corners[0], corners[2], corners[1]] : corners;
    order.forEach((v, k) => close([0, 1, 2].map(c => stl.getFloat32(84+t*50+12+k*12+c*4, true)), expected[mesh*24+v], 1e-4, `stl ${t}`));
  }

  for (const binary of [false, true]) {
    const ply = parsePLY(exportPLY(engine, {binary, colors: true}));
    assert.equal(ply.format, binary ? 'binary_little_endian' : 'ascii');
    assert.equal(ply.elements.vertex.length, 96);
    assert.equal(ply.elements.face.length, 48);
    ply.elements.vertex.forEach((v, i) => {
      close([v.x, v.y, v.z], expected[i], 1e-4, 'ply vertex');
      assert.ok(Math.abs(Math.hypot(v.nx, v.ny, v.nz)-1) < 1e-5);
    });
    assert.deepEqual([ply.elements.vertex[0].red, ply.elements.vertex[0].green, ply.elements.vertex[0].blue], [255, 0, 0]);
    assert.deepEqual([ply.elements.vertex[24].red, ply.elements.vertex[24].green, ply.elements.vertex[24].blue], [0, 124, 243]);
    assert.ok(ply.elements.face.every(f => f.vertex_indices.length === 3 && f.vertex_indices.every(i => i < 96)));
    assert.deepEqual(ply.elements.face[12].vertex_indices, [24+cube.indices[0], 24+cube.indices[2], 24+cube.indices[1]]);
  }
  assert.ok(!('red' in parsePLY(exportPLY(engine)).elements.vertex[0]));

  const {obj, mtl} = exportOBJ(engine, {materials: true, mtlName: 'robot.mtl'});
  const parsed = parseOBJ(obj), materials = parseMTL(mtl);
  assert.equal(parsed.mtllib, 'robot.mtl');
  assert.deepEqual(parsed.groups.map(g => g.name), ['base', 'arm', 'hand', 'other']);
  assert.deepEqual(parsed.groups.map(g => g.material), ['material_0', 'material_1', 'material_0', 'material_1']);
  assert.deepEqual(materials.material_0.Kd, [1, 0, 0]);
  close(materials.material_1.Kd, [0, 0.48453, 0.95468], 1e-4);
  assert.deepEqual(materials.material_0.Pr, [0.25]);
  assert.deepEqual(materials.material_0.Pm, [1]);
  assert.equal(parsed.v.length, 96);
  parsed.v.forEach((v, i) => close(v, expected[i], 1e-4, 'obj vertex'));
  for (const [g, group] of parsed.groups.entries()) {
    assert.equal(group.faces.length, 12);
    for (const face of group.faces) for (const corner of face) {
      assert.ok(corner.v >= 1+g*24 && corner.v <= 24+g*24, '1-based indices inside the group');
      assert.equal(corner.n, corner.v);
      assert.equal(corner.t, null);
    }
  }
  assert.equal(exportOBJ(engine).mtl, null);
});

test('OBJ writes flipped v texture coordinates and vertex colors; PLY uses vertex colors', () => {
  const geometry = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 2, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0.25, 0, 1], colors: [1, 0, 0, 0, 1, 0, 0, 0, 0.5], indices: [0, 1, 2]};
  const scene = {nodes: [{name: 'tri one', geometry, material: {name: 'paint coat', color: [0.5, 0.5, 0.5]}}, {name: 'tri one', geometry}]};
  const {obj, mtl} = exportOBJ(scene, {materials: true, colors: true});
  const parsed = parseOBJ(obj);
  assert.deepEqual(parsed.groups.map(g => g.name), ['tri_one', 'tri_one_2']);
  assert.deepEqual(parsed.groups.map(g => g.material), ['paint_coat', null]);
  assert.deepEqual(parsed.vt.slice(0, 3), [[0, 1], [1, 0.75], [0, 0]]);
  assert.deepEqual(parsed.v[0], [0, 0, 0, 1, 0, 0]);
  close(parsed.v[2].slice(3), [0, 0, 0.7353569], 1e-6);
  assert.deepEqual(parsed.vn[0], [0, 0, 1]);
  assert.deepEqual(parsed.groups[1].faces[0].map(c => [c.v, c.t, c.n]), [[4, 4, 4], [5, 5, 5], [6, 6, 6]]);
  close(parseMTL(mtl).paint_coat.Kd, [0.7353569, 0.7353569, 0.7353569], 1e-6);
  const ply = parsePLY(exportPLY(scene, {colors: true, binary: true}));
  assert.deepEqual(ply.elements.vertex.slice(0, 3).map(v => [v.red, v.green, v.blue]), [[255, 0, 0], [0, 255, 0], [0, 0, 188]]);
  assert.deepEqual(ply.elements.face[1].vertex_indices, [3, 4, 5]);
});

test('core Geometry and PbrMaterial can be overridden with richer data for engine export', needsValidator, async () => {
  const engine = await headlessEngine(), geometry = box(), material = new PbrMaterial({color: '#808080'});
  engine.createMesh().setGeometry(geometry).setMaterial(material);
  const count = geometry.vertices.length/6, positions = [], normals = [];
  for (let i = 0; i < count; i++) {positions.push(...geometry.vertices.subarray(i*6, i*6+3)); normals.push(...geometry.vertices.subarray(i*6+3, i*6+6));}
  const rich = {positions, normals, uvs: new Array(count*2).fill(0.5), indices: geometry.indices};
  const glb = exportGLB(engine, {geometryData: new Map([[geometry, rich]]), materialData: new WeakMap([[material, {name: 'grey', color: [0.2, 0.2, 0.2], emissive: [0, 0, 1]}]])});
  await assertValid(glb);
  const {json} = readGLB(glb);
  assert.ok('TEXCOORD_0' in json.meshes[0].primitives[0].attributes);
  assert.equal(json.materials[0].name, 'grey');
  assert.deepEqual(json.materials[0].emissiveFactor, [0, 0, 1]);
  assert.ok(new Geometry(positions, normals, geometry.indices));
});

function deformationScene() {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const tip = {name: 'tip', translation: [0, 1, 0]}, joint = {name: 'joint', children: [tip]};
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1], indices: [0, 1, 2],
    joints: [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], weights: [1, 3, 0, 0, 1, 3, 0, 0, 1, 3, 0, 0],
    morphs: [{name: 'raise', positions: [0, 0, 0, 0, 0, 0.5, 0, 0, 0], normals: new Array(9).fill(0), tangents: new Array(9).fill(0)}],
  };
  const inverseTip = identity.slice(); inverseTip[13] = -1;
  const skin = {name: 'arm', joints: [joint, tip], inverseBindMatrices: [...identity, ...inverseTip]};
  const mesh = {name: 'mesh', geometry, skin, morphWeights: [0.25]};
  const move = {node: tip, path: 'translation', times: [0, 1], values: [0, 1, 0, 2, 1, 0]};
  const scene = {nodes: [mesh, joint], animations: [{name: 'Move', channels: [move, {node: mesh, path: 'weights', interpolation: 'STEP', times: [0, 1], values: [0.25, 0.75]}]}]};
  return {scene, mesh, tip, joint, geometry, skin, move};
}

test('data scenes export skins, morph targets and animation compatible with the optional animation package', needsValidator, async () => {
  const {scene, skin} = deformationScene(), glb = exportGLB(scene);
  await assertValid(glb);
  const {json, bin} = readGLB(glb), primitive = json.meshes[0].primitives[0];
  assertAligned(json, bin);
  assert.deepEqual(json.skins[0].joints, [1, 2]);
  assert.equal(json.nodes[0].skin, 0);
  assert.equal(json.accessors[primitive.attributes.JOINTS_0].componentType, 5123);
  assert.equal(json.accessors[primitive.attributes.WEIGHTS_0].componentType, 5126);
  close(accessor(json, bin, primitive.attributes.WEIGHTS_0), [0.25, 0.75, 0, 0, 0.25, 0.75, 0, 0, 0.25, 0.75, 0, 0], 0);
  close(accessor(json, bin, json.skins[0].inverseBindMatrices), skin.inverseBindMatrices, 0);
  assert.deepEqual(json.nodes[0].weights, [0.25]);
  assert.deepEqual(json.meshes[0].extras.targetNames, ['raise']);
  close(accessor(json, bin, primitive.targets[0].POSITION), [0, 0, 0, 0, 0, 0.5, 0, 0, 0], 0);
  assert.equal(json.accessors[primitive.targets[0].TANGENT].type, 'VEC3');
  assert.deepEqual(json.animations[0].channels.map(channel => channel.target), [{node: 2, path: 'translation'}, {node: 0, path: 'weights'}]);
  const sampler = json.animations[0].samplers[0];
  close(accessor(json, bin, sampler.input), [0, 1], 0);
  close(accessor(json, bin, sampler.output), [0, 1, 0, 2, 1, 0], 0);
  for (const id of [sampler.input, sampler.output, json.skins[0].inverseBindMatrices]) assert.equal(json.bufferViews[json.accessors[id].bufferView].target, undefined);

  const engine = await headlessEngine(), model = new PBRModel(engine, new GLTFAsset(json, [bin]));
  const animation = new Animation(model, {loop: false});
  animation.play('Move').seek(0.5);
  close([engine.store.transforms.x[model.nodes[2].id], engine.store.transforms.y[model.nodes[2].id]], [1, 1], 0);
  close(model.primitives[0].weights, [0.25], 0);
  animation.seek(1);
  close(model.primitives[0].weights, [0.75], 0);
  animation.dispose(); model.dispose(); engine.dispose();

  const separate = exportGLTF(scene, {embed: false});
  await assertValid(separate.text, {[separate.binUri]: separate.bin});
  assert.deepEqual(separate.bin, bin);
});

test('cubic rotation and morph channels preserve value/tangent arity and Float32 timing', needsValidator, async () => {
  const {scene, mesh, tip} = deformationScene(), q = Math.SQRT1_2;
  const rotation = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, q, q, 0, 0, 0, 0];
  scene.animations = [{channels: [
    {node: tip, path: 'rotation', interpolation: 'CUBICSPLINE', times: [0, 1], values: rotation},
    {node: mesh, path: 'weights', interpolation: 'CUBICSPLINE', times: [0, 1], values: [0, 0.25, 0, 0, 0.75, 0]},
    {node: tip, path: 'scale', interpolation: 'LINEAR', times: [0, 1], values: [1, 1, 1, 2, 2, 2]},
  ]}];
  const glb = exportGLB(scene);
  await assertValid(glb);
  const {json, bin} = readGLB(glb), samplers = json.animations[0].samplers;
  assert.equal(json.accessors[samplers[0].output].type, 'VEC4');
  assert.equal(json.accessors[samplers[0].output].count, 6);
  assert.equal(json.accessors[samplers[1].output].type, 'SCALAR');
  assert.equal(json.accessors[samplers[1].output].count, 6);
  close(accessor(json, bin, samplers[0].output), rotation, 1e-7);
  assert.equal(samplers[0].interpolation, 'CUBICSPLINE');
});

test('morph animation packs all target weights per key and keeps per-instance defaults', needsValidator, async () => {
  const {scene, mesh, geometry} = deformationScene();
  geometry.morphs.push({name: 'slide', positions: [0.5, 0, 0, 0, 0, 0, 0, 0, 0]});
  mesh.morphWeights = [0.25, 0.5];
  const instance = {...mesh, name: 'instance', morphWeights: [0.75, 0]};
  scene.nodes.push(instance);
  scene.animations = [{channels: [{node: mesh, path: 'weights', times: [0, 1], values: [0.25, 0.5, 0.75, 1]}]}];
  const glb = exportGLB(scene);
  await assertValid(glb);
  const {json, bin} = readGLB(glb), sampler = json.animations[0].samplers[0];
  assert.equal(json.meshes.length, 1);
  assert.equal(json.skins.length, 1);
  assert.deepEqual(json.nodes[0].weights, [0.25, 0.5]);
  assert.deepEqual(json.nodes[3].weights, [0.75, 0]);
  assert.equal(json.accessors[sampler.output].type, 'SCALAR');
  assert.equal(json.accessors[sampler.output].count, 4);
  close(accessor(json, bin, sampler.output), [0.25, 0.5, 0.75, 1], 0);
});

test('deformation export rejects invalid weights, references, morphs and animation data', () => {
  const checks = [
    [data => {delete data.geometry.weights;}, /required together/],
    [data => {data.geometry.joints[0] = 0.5;}, /16-bit/],
    [data => {data.geometry.joints[0] = 65536;}, /16-bit/],
    [data => {data.geometry.joints[0] = 2;}, /exceeds skin/],
    [data => {data.geometry.weights[0] = -1;}, /nonnegative/],
    [data => {data.geometry.weights.fill(0);}, /positive sum/],
    [data => {delete data.mesh.skin;}, /need a skin/],
    [data => {delete data.geometry.joints; delete data.geometry.weights;}, /needs joint/],
    [data => {data.skin.joints = [data.joint, data.joint];}, /distinct/],
    [data => {data.skin.joints[1] = {};}, /not an exported/],
    [data => {data.joint.children = []; data.scene.nodes.push(data.tip);}, /common hierarchy root/],
    [data => {data.tip.visible = false;}, /not an exported/],
    [data => {data.skin.inverseBindMatrices.pop();}, /needs 32/],
    [data => {data.skin.inverseBindMatrices[3] = 1;}, /affine/],
    [data => {data.geometry.morphs[0].positions.pop();}, /Morph positions/],
    [data => {delete data.geometry.tangents;}, /need base tangents/],
    [data => {data.mesh.morphWeights = [0, 1];}, /Morph weights/],
    [data => {data.move.node = {};}, /not an exported/],
    [data => {data.move.times = [0, 0];}, /strictly increasing/],
    [data => {data.move.times = [-1, 1];}, /nonnegative/],
    [data => {data.move.times = [1, 1+Number.EPSILON];}, /strictly increasing/],
    [data => {data.move.values.pop();}, /Animation values/],
    [data => {data.move.values[0] = Infinity;}, /finite/],
    [data => {data.move.path = 'rotation'; data.move.values = [0, 0, 0, 1, 0, 0, 0, 2];}, /unit quaternions/],
    [data => {data.move.interpolation = 'BEZIER';}, /interpolation/],
    [data => {data.move.interpolation = 'CUBICSPLINE'; data.move.times = [0];}, /at least two keys/],
    [data => {data.scene.animations[0].channels.push({...data.move});}, /Duplicate/],
    [data => {data.scene.animations[0].channels = [];}, /nonempty channels/],
    [data => {delete data.geometry.morphs; delete data.mesh.morphWeights;}, /weights need morph/],
    [data => {data.scene.animations = {};}, /Animations must be an array/],
  ];
  for (const [change, pattern] of checks) {
    const data = deformationScene(); change(data);
    assert.throws(() => exportGLB(data.scene), pattern);
  }
  assert.throws(() => exportGLB(deformationScene().scene, {flatten: true}), /Flatten does not support/);
  const {scene, tip} = deformationScene(); tip.visible = false;
  assert.doesNotThrow(() => exportGLB(scene, {onlyVisible: false}));
});
