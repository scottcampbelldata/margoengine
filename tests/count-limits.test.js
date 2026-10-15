// HANDOFF 5j limit (1): the per-file node and part caps (glTF, gltf-pro, .margo, OBJ, SurfacePhysics) default to 100,000
// and are options up to core's 8,388,608 entities; the error names the option.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Engine, TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF as parseLight} from '../packages/gltf/dist/index.js';
import {parseGLTF as parsePro} from '../packages/gltf-pro/dist/index.js';
import {decodeMargo, parseMargo} from '../packages/blender/dist/index.js';
import {parseCAD, SurfacePhysics} from '../packages/machinery/dist/index.js';
import {headlessModels} from './support/pbr-snapshot.js';

const headless = async () => new Engine({width: 1, height: 1, clientWidth: 1, clientHeight: 1}, await TransformStore.create(), {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}});
const over = (message, count, name) => new RegExp(`^RangeError: ${message} \\(${count} > 100000; raise the ${name} option\\)$`);
const invalid = name => new RegExp(`${name} must be an integer from 1 to 8388608`);
const N = 100_001;
// One triangle node plus 100,000 empty nodes.
const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
const gltf = () => ({asset: {version: '2.0'}, scenes: [{nodes: [0]}], nodes: [{mesh: 0}, ...Array.from({length: N - 1}, () => ({}))],
  meshes: [{primitives: [{attributes: {POSITION: 0}}]}], accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0]}],
  bufferViews: [{buffer: 0, byteLength: 36}], buffers: [{byteLength: 36, uri: `data:application/octet-stream;base64,${triangle}`}]});

test('glTF (light and gltf-pro): maxNodes', () => headlessModels(async () => {
  for (const parse of [(engine, doc, options) => parseLight(engine, doc, [], options), (engine, doc, options) => parsePro(engine, doc, [], [], {}, options)]) {
    const engine = await headless();
    assert.throws(() => parse(engine, gltf()), e => over('Too many glTF nodes', N, 'maxNodes').test(String(e)));
    assert.throws(() => parse(engine, gltf(), {maxNodes: 8_388_609}), invalid('maxNodes'));
    assert.ok(parse(engine, gltf(), {maxNodes: N}).root, 'loads with the option');
  }
}));

test('.margo (blender): maxNodes on decodeMargo, parseMargo and the gltf-pro model it builds', async () => {
  // The triangle fixture with its JSON section replaced: 100,001 nodes, no texture (parseMargo then decodes no image).
  const source = await readFile(new URL('../packages/blender/tests/fixtures/triangle.margo', import.meta.url)), view = new DataView(source.buffer, source.byteOffset);
  const doc = JSON.parse(source.subarray(view.getUint32(68, true), view.getUint32(68, true) + view.getUint32(72, true)).toString());
  Object.assign(doc, {nodes: [...doc.nodes, ...Array.from({length: N - doc.nodes.length}, () => ({}))], materials: [{}], textures: undefined, images: undefined});
  const json = Buffer.from(JSON.stringify(doc).padEnd(Math.ceil(JSON.stringify(doc).length / 4) * 4)), count = view.getUint32(12, true), first = 64 + 3 * 16;
  const sections = Array.from({length: count}, (_, i) => [view.getUint32(64 + i * 16, true), view.getUint32(68 + i * 16, true), view.getUint32(72 + i * 16, true), view.getUint32(76 + i * 16, true)]).slice(0, 3);
  const out = new Uint8Array(first + json.length + sections.slice(1).reduce((n, s) => n + ((s[2] + 3) & ~3), 0)), w = new DataView(out.buffer);
  out.set(source.subarray(0, 64)); w.setUint32(8, out.length, true); w.setUint32(12, 3, true);
  let at = first;
  sections.forEach(([type, offset, size, flags], i) => {
    const bytes = i ? source.subarray(offset, offset + size) : json;
    w.setUint32(64 + i * 16, type, true); w.setUint32(68 + i * 16, at, true); w.setUint32(72 + i * 16, bytes.length, true); w.setUint32(76 + i * 16, flags, true);
    out.set(bytes, at); at += (bytes.length + 3) & ~3;
  });
  assert.throws(() => decodeMargo(out), e => over('Too many .margo nodes', N, 'maxNodes').test(String(e)));
  assert.equal(decodeMargo(out, {maxNodes: N}).document.nodes.length, N);
  await headlessModels(async () => assert.equal((await parseMargo(await headless(), out, {maxNodes: N})).nodes.length, N));
});

test('OBJ (machinery): maxParts', async () => {
  const obj = 'o p\n'.repeat(N - 1) + 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
  assert.throws(() => parseCAD(null, obj, 'obj'), e => over('OBJ part limit', N, 'maxParts').test(String(e)));
  assert.equal(parseCAD(await headless(), obj, 'obj', {maxParts: N}).meshes.length, 1);
});

test('SurfacePhysics (machinery): maxParts, for parts and for carriers', async () => {
  const many = Array.from({length: N}, () => ({})), one = [{}];
  await assert.rejects(SurfacePhysics.create(many, one), e => over('Too many surface parts', N, 'maxParts').test(String(e)));
  await assert.rejects(SurfacePhysics.create(one, many), e => over('Too many surface carriers', N, 'maxParts').test(String(e)));
  await assert.rejects(SurfacePhysics.create(one, one, {maxParts: 0}), invalid('maxParts'));
  assert.equal((await SurfacePhysics.create(many, one, {maxParts: N})).parts.length, N);
});
