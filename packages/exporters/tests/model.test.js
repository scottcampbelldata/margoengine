// exportModel round trips: export a gltf-pro model, re-import it with gltf-pro and compare node trees, decoded accessors
// (byte for byte where the export is lossless), materials, images and animation poses sampled at several times; every
// output also goes through the Khronos glTF-Validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {parseGLTF, parseGLTFAsync} from '@margoengine/gltf-pro';
import {instancing} from '@margoengine/gltf-pro/instancing';
import {Animation} from '@margoengine/animation';
import {Material, Texture, createMesh, createInstancedMesh} from '@margoengine/materials';
import {exportModel} from '../dist/model.js';
import {headless, headlessModels} from '../../../tests/support/pbr-snapshot.js';
import {bigGLB} from '../../../tests/support/big-glb.js';
import {instancedGLTF} from '../../../tests/support/instanced-gltf.js';
import {readGLB, validate, validator} from './helpers.js';

const asset = name => readFile(new URL(`../../../examples/assets/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const needsValidator = validator ? {} : {skip: 'gltf-validator not installed'};
const bytes = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const same = (a, b, label) => assert.ok(Buffer.compare(bytes(a), bytes(b)) === 0, `${label} differs`);
const close = (a, b, epsilon, label) => {
  assert.equal(a.length, b.length, `${label} length`);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i]-b[i]) <= epsilon, `${label}[${i}]: ${a[i]} vs ${b[i]}`);
};
const issues = report => {const out = {}; for (const m of report.messages) out[m.code] = (out[m.code] ?? 0)+1; return out;};
/** The output adds no validator error or warning that the source file did not already have. */
async function assertNoNewIssues(output, source) {
  const now = await validate(output), before = source ? await validate(source) : {messages: []};
  assert.equal(now.errors, 0, JSON.stringify(now.messages.slice(0, 5), null, 1));
  const allowed = issues(before);
  for (const [code, count] of Object.entries(issues(now))) assert.ok(count <= (allowed[code] ?? 0), `new validator issue ${code} x${count}`);
  return now;
}
const reimport = (glb, decoders = {}) => headless().then(engine => parseGLTFAsync(engine, glb, {decoders}));
const docImage = (model, i) => model.asset.view(model.asset.doc.images[i].bufferView);

/** Node tree, transforms, meshes/skins, every decoded accessor, packed vertices, materials and images. */
function assertSameModel(a, b) {
  const da = a.asset.doc, db = b.asset.doc, sa = a.root.engine.store.transforms, sb = b.root.engine.store.transforms;
  assert.equal(db.nodes.length, da.nodes.length);
  da.nodes.forEach((n, i) => {
    const m = db.nodes[i];
    assert.equal(b.nodes[i].name, a.nodes[i].name);
    assert.deepEqual(m.children ?? [], n.children ?? [], `node ${i} children`);
    assert.equal(m.mesh === undefined, n.mesh === undefined, `node ${i} mesh`);
    assert.equal(m.skin === undefined, n.skin === undefined, `node ${i} skin`);
    if (n.skin !== undefined) {
      assert.deepEqual(db.skins[m.skin].joints, da.skins[n.skin].joints, `skin ${n.skin} joints`);
      same(b.asset.accessor(db.skins[m.skin].inverseBindMatrices), a.asset.accessor(da.skins[n.skin].inverseBindMatrices), `skin ${n.skin} inverse bind matrices`);
    }
    for (const k of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz']) assert.equal(sb[k][b.nodes[i].id], sa[k][a.nodes[i].id], `node ${i} ${k}`);
  });
  assert.equal(b.primitives.length, a.primitives.length);
  a.primitives.forEach((p, i) => {
    const q = b.primitives[i], label = `primitive ${i}`;
    assert.equal(q.nodeIndex, p.nodeIndex);
    same(q.vertices, p.vertices, `${label} packed vertices`); same(q.indices, p.indices, `${label} indices`);
    assert.deepEqual(Object.keys(q.definition.attributes).sort(), Object.keys(p.definition.attributes).sort());
    for (const [name, id] of Object.entries(p.definition.attributes)) {
      const x = a.asset.accessor(id), y = b.asset.accessor(q.definition.attributes[name]);
      if (!name.startsWith('WEIGHTS_')) {same(y, x, `${label} ${name}`); continue;}
      // Weights are written normalized (gltf-pro divides by the sum when skinning).
      for (let v = 0; v < x.length; v += 4) {const s = x[v]+x[v+1]+x[v+2]+x[v+3]; for (let k = 0; k < 4; k++) assert.ok(Math.abs(y[v+k]-x[v+k]/s) < 1e-6, `${label} weight ${v+k}`);}
    }
    (p.definition.targets ?? []).forEach((t, k) => {for (const [name, id] of Object.entries(t)) same(b.asset.accessor(q.definition.targets[k][name]), a.asset.accessor(id), `${label} target ${k} ${name}`);});
    same(q.weights, p.weights, `${label} morph weights`); assert.deepEqual(q.targetNames, p.targetNames);
    const ma = p.material, mb = q.material;
    for (const key of ['base', 'factors', 'emission', 'settings', 'uvt', 'ext']) close(mb[key], ma[key], 1e-6, `${label} material ${key}`);
    assert.deepEqual(mb.physical, ma.physical); assert.equal(mb.name, ma.name);
    ma.maps.forEach((map, k) => {
      assert.equal(!!mb.maps[k], !!map, `${label} map ${k}`);
      if (!map) return;
      assert.equal(mb.maps[k].texCoord ?? 0, map.texCoord ?? 0);
      const ta = da.textures[map.index], tb = db.textures[mb.maps[k].index];
      same(docImage(b, tb.source), docImage(a, ta.source), `${label} map ${k} image`);
      assert.equal(db.images[tb.source].mimeType, da.images[ta.source].mimeType);
      assert.deepEqual(db.samplers?.[tb.sampler] ?? {}, da.samplers?.[ta.sampler] ?? {});
    });
  });
}

/** Every node's world matrix and every primitive's morph weights after `seek(time)` on both models. */
function assertSamePose(a, b, clip, time) {
  for (const x of [a, b]) {x.animation.play(clip).seek(time); x.model.root.engine.store.tick(false);}
  a.model.nodes.forEach((node, i) => close(b.model.nodes[i].matrix, node.matrix, 2e-5, `${clip} t=${time} node ${i}`));
  a.model.primitives.forEach((p, i) => close(b.model.primitives[i].weights, p.weights, 1e-6, `${clip} t=${time} weights ${i}`));
}

for (const [file, animated] of [['damaged-helmet.glb', false], ['robot-expressive.glb', true]]) {
  test(`exportModel round trip: ${file}`, needsValidator, () => headlessModels(async () => {
    const source = await asset(file), model = await parseGLTFAsync(await headless(), source.slice());
    const animation = animated ? new Animation(model) : null;
    const glb = await exportModel(model, {binary: true, animations: animation ? [animation] : []});
    await assertNoNewIssues(glb, source);
    const copy = await reimport(glb);
    assertSameModel(model, copy);
    if (!animated) return;
    const copyAnimation = new Animation(copy);
    assert.deepEqual(copyAnimation.clips.map(c => c.name), animation.clips.map(c => c.name));
    animation.clips.forEach((clip, c) => {
      const back = copyAnimation.clips[c];
      assert.equal(back.duration, clip.duration);
      clip.tracks.forEach((t, k) => {same(back.tracks[k].times, t.times, `${clip.name} times`); same(back.tracks[k].values, t.values, `${clip.name} values`);});
      for (const f of [0, 0.13, 0.5, 0.77, 0.999]) assertSamePose({model, animation}, {model: copy, animation: copyAnimation}, clip.name, clip.duration*f);
    });
    // The pose, morph weights and visibility at export time are the file's rest state.
    animation.play('Wave').seek(0.6); animation.setMorph(model.primitives.find(p => p.weights.length).nodeIndex, 1, 0.75);
    model.nodes[0].visible = true;
    const posed = await reimport(await exportModel(model, {binary: true}));
    model.root.engine.store.tick(false); posed.root.engine.store.tick(false);
    model.nodes.forEach((node, i) => close(posed.nodes[i].matrix, node.matrix, 1e-6, `posed node ${i}`));
    model.primitives.forEach((p, i) => same(posed.primitives[i].weights, p.weights, `posed weights ${i}`));
  }));
}

test('exportModel: onlyVisible drops hidden subtrees and their channels; a hidden joint is an error', () => headlessModels(async () => {
  const model = await parseGLTFAsync(await headless(), await asset('robot-expressive.glb')), animation = new Animation(model), doc = model.asset.doc;
  const skinned = new Set(doc.skins.flatMap(s => s.joints)), meshNode = doc.nodes.findIndex((n, i) => n.mesh !== undefined && n.skin === undefined && !skinned.has(i));
  const joint = doc.skins[0].joints.at(-1);
  model.nodes[meshNode].visible = false;
  const {json} = readGLB(await exportModel(model, {binary: true, animations: [animation]}));
  const named = nodes => nodes.filter(n => n.name === model.nodes[meshNode].name).length;
  assert.equal(named(json.nodes), named(doc.nodes)-1, 'hidden node left out');
  assert.equal(json.nodes.length, doc.nodes.length-1-(doc.nodes[meshNode].children?.length ?? 0));
  assert.ok(json.animations.every(a => a.channels.every(c => c.target.node < json.nodes.length)));
  assert.equal(readGLB(await exportModel(model, {binary: true, onlyVisible: false})).json.nodes.length, doc.nodes.length);
  model.nodes[joint].visible = false;
  await assert.rejects(exportModel(model), {name: 'RangeError', message: /skin joint is hidden/});
  model.nodes[joint].visible = true;
  await assert.rejects(exportModel([]), TypeError);
  await assert.rejects(exportModel(model, {maxTextureSize: 0}), RangeError);
  await assert.rejects(exportModel(model, {animations: [{model: await parseGLTFAsync(await headless(), await asset('robot-expressive.glb')), clips: []}]}), /among the exported models/);
}));

test('exportModel: EXT_mesh_gpu_instancing round trip (generated grids, 50 instances each)', needsValidator, () => headlessModels(async () => {
  const source = bigGLB({segments: 16, meshes: 2, instances: 50}), model = await parseGLTFAsync(await headless(), source, {decoders: {instancing}});
  model.primitives[0].instances.setColorAt(3, [1, 0.5, 0.25]);
  model.primitives[1].instances.count = 20;
  const glb = await exportModel(model, {binary: true}), {json} = readGLB(glb);
  await assertNoNewIssues(glb);
  assert.deepEqual(json.extensionsUsed, ['EXT_mesh_gpu_instancing']);
  assert.ok(json.nodes[1].extensions.EXT_mesh_gpu_instancing.attributes._COLOR_0 !== undefined, 'tints as _COLOR_0');
  const copy = await reimport(glb, {instancing});
  assertSameModel(model, copy);
  model.primitives.forEach((p, i) => {
    const a = p.instances, b = copy.primitives[i].instances;
    assert.equal(b.count, a.count);
    for (let k = 0; k < a.count; k++) close(b.getMatrixAt(k), a.getMatrixAt(k), 1e-6, `primitive ${i} instance ${k}`);
  });
}));

/** RGBA8 rows back out of an exportModel PNG (filter types None and Sub). */
function decodePNG(png) {
  const view = new DataView(png.buffer, png.byteOffset), idat = [];
  let width = 0, height = 0;
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at), type = new TextDecoder().decode(png.subarray(at+4, at+8));
    if (type === 'IHDR') {width = view.getUint32(at+8); height = view.getUint32(at+12); assert.deepEqual([...png.subarray(at+16, at+21)], [8, 6, 0, 0, 0]);}
    if (type === 'IDAT') idat.push(png.subarray(at+8, at+8+length));
    at += length+12;
  }
  const rows = inflateSync(Buffer.concat(idat)), out = new Uint8Array(width*height*4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width*4; x++) {
    const filter = rows[y*(width*4+1)], value = rows[y*(width*4+1)+1+x];
    out[y*width*4+x] = filter === 1 && x >= 4 ? value+out[y*width*4+x-4] : value;
  }
  return {width, height, data: out};
}

test('exportModel: @margoengine/materials meshes with raw textures, UV transform, alpha modes and instances', needsValidator, () => headlessModels(async () => {
  const engine = await headless(), pixels = (w, h, seed) => ({width: w, height: h, data: Uint8Array.from({length: w*h*4}, (_, i) => (i*seed+7*(i >> 2))%256)});
  const base = new Texture(pixels(5, 3, 13), {wrapS: 'repeat', wrapT: 'mirror'}), normal = new Texture(pixels(4, 4, 31), {magFilter: 'nearest', minFilter: 'nearest'});
  const quad = {positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, -1], colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 1, 1, 1, 1], indices: [0, 1, 2, 0, 2, 3]};
  const textured = new Material({color: [0.8, 0.4, 0.2], opacity: 0.6, transparent: true, roughness: 0.3, metalness: 0.7, emissive: [0.1, 0.2, 0], map: base, normalMap: normal, normalScale: 0.5, aoMap: base, aoMapIntensity: 0.25, doubleSided: true, uvTransform: {offset: [0.25, 0.5], scale: [2, 0.5], rotation: 0.3}});
  const masked = new Material({shading: 'basic', color: '#336699', alphaTest: 0.4});
  const a = createMesh(engine, quad, textured), b = createInstancedMesh(engine, quad, masked, 3);
  a.root.setPosition([1, 2, 3]).setScale([2, 2, 2]);
  b.instances.setMatrixAt(1, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]).setColorAt(2, [0.2, 0.4, 0.6]);
  assert.equal(a.material, textured);
  const glb = await exportModel([a, b], {binary: true}), {json} = readGLB(glb);
  await assertNoNewIssues(glb);
  assert.deepEqual(json.extensionsUsed.sort(), ['EXT_mesh_gpu_instancing', 'KHR_materials_unlit', 'KHR_texture_transform']);
  assert.deepEqual(json.samplers, [{magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 33648}, {magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071}]);
  assert.equal(json.images.length, 2, 'one image per Texture');
  const copy = await reimport(glb, {instancing});
  // Raw images are written row 0 first (no flip), losslessly.
  for (const [i, texture] of [[0, base], [1, normal]]) assert.deepEqual(decodePNG(docImage(copy, json.textures[i].source)), {...texture.source, data: Uint8Array.from(texture.source.data)});
  // Two models -> two wrapped scene roots (a has a root transform), materials from the live Material values.
  assert.equal(copy.primitives.length, 2);
  const [p, q] = copy.primitives;
  for (const [x, m] of [[p, a.primitives[0]], [q, b.primitives[0]]]) {
    for (const key of ['base', 'factors', 'emission']) close(x.material[key], m.material[key], 1e-6, key);
    // UV transforms travel with textures: the map, normal and occlusion slots of `textured`.
    for (const slot of m === a.primitives[0] ? [0, 2, 3] : [0, 1, 2, 3, 4]) close(x.material.uvt.slice(slot*8, slot*8+8), m.material.uvt.slice(slot*8, slot*8+8), 1e-6, `uvt ${slot}`);
    // alphaCutoff is written for MASK only; BLEND reads back the default 0.5.
    close(x.material.settings, m.material.settings.map((v, i) => i === 1 && m.material.settings[0] !== 1 ? 0.5 : v), 0, 'settings');
    // Packed vertices equal, except UV1: packGeometry copies UV0 there and only TEXCOORD_0 is written.
    close(x.vertices, m.vertices.map((v, i) => i%20 === 14 || i%20 === 15 ? 0 : v), 0, 'vertices'); same(x.indices, m.indices, 'indices');
  }
  assert.equal(q.material.ext[0], 1, 'basic shading is KHR_materials_unlit');
  copy.root.engine.store.tick(false); engine.store.tick(false);
  close(p.node.matrix, a.primitives[0].node.matrix, 1e-6, 'world matrix');
  for (let k = 0; k < 3; k++) close(q.instances.getMatrixAt(k), b.instances.getMatrixAt(k), 1e-6, `instance ${k}`);
  // Without OffscreenCanvas (Node) a texture larger than maxTextureSize cannot be resized.
  await assert.rejects(exportModel(a, {maxTextureSize: 4}), /OffscreenCanvas/);
}));

test('exportModel: .gltf output, external images kept with embedImages false, and image bytes reused', needsValidator, () => headlessModels(async () => {
  // An external image: only its decoded pixels were kept, which only a canvas can encode again.
  const image = 'textures/checker.png', {doc, buffers} = instancedGLTF([{t: [0, 0, 0]}], {instanced: false, image});
  const model = parseGLTF(await headless(), doc, buffers, [{width: 4, height: 4, close() {}}]);
  const helmet = await parseGLTFAsync(await headless(), await asset('damaged-helmet.glb'));
  const result = await exportModel(helmet, {embed: false, binUri: 'helmet.bin'});
  assert.equal(result.binUri, 'helmet.bin'); assert.ok(result.bin.length > 3_000_000);
  const report = await validate(result.text, {'helmet.bin': result.bin});
  assert.equal(report.errors, 0);
  const embedded = await exportModel(helmet);
  assert.match(embedded.json.buffers[0].uri, /^data:application\/octet-stream;base64,/);
  const {json} = await exportModel(model, {embedImages: false});
  assert.deepEqual(json.images, [{uri: image}]);
  await assert.rejects(exportModel(model), /OffscreenCanvas/);
}));
