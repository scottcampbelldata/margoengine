// Regenerate the checked-in desktop Earth and phone assets and the demo helmet GLBs with installed sharp.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import sharp from 'sharp';
import validator from 'gltf-validator';
import {MeshoptSimplifier} from 'meshoptimizer';

const earth='packages/creative/examples/earth/assets/';
for(const [source,target,lossless,desktopTarget] of [
  ['earth-day.jpg','earth-day-mobile.webp',false,null],
  ['2k_earth_nightmap.jpg','earth-night-mobile.webp',false,'earth-night.webp'],
  ['2k_earth_clouds.jpg','earth-clouds-mobile.webp',false,'earth-clouds.webp'],
  ['earth-normal.png','earth-normal-mobile.webp',true,'earth-normal.webp'],
  ['earth-specular-roughness.png','earth-specular-mobile.webp',true,'earth-specular.webp'],
]) {
  await sharp(earth+source).resize(1024,512).webp({quality:85,lossless}).toFile(earth+target);
  const metadata=await sharp(earth+target).metadata();
  assert.equal(metadata.width,1024);assert.equal(metadata.height,512);
  if(desktopTarget) {
    // Data maps use raw channels; ICC conversion can alter them.
    const input=await readFile(earth+source),desktop=await sharp(input,{ignoreIcc:true}).webp({quality:95,lossless,effort:6}).toBuffer();
    const before=await sharp(input,{ignoreIcc:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true}),after=await sharp(desktop).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(before.info.width,2048);assert.equal(before.info.height,1024);
    assert.equal(after.info.width,before.info.width);assert.equal(after.info.height,before.info.height);
    assert.ok(desktop.length<input.length,'Desktop derivative must be smaller');
    if(lossless)assert.deepEqual(after.data,before.data,'Data-map pixels must be unchanged');
    else {
      let squaredError=0;for(let i=0;i<before.data.length;i++)if(i%4!==3)squaredError+=(before.data[i]-after.data[i])**2;
      const mse=squaredError/(before.info.width*before.info.height*3);
      assert.ok(mse===0||10*Math.log10(255**2/mse)>=40,'Color-map PSNR must remain at least 40 dB');
    }
    await writeFile(earth+desktopTarget,desktop);
  }
}

// Packs a .gltf with external files (one buffer, no animation) into a web GLB: JPEG textures fitted to maxSize (colour
// maps at quality[0], data maps at quality[1], 4:4:4), duplicate vertices welded, normals/tangents/UVs quantized
// (KHR_mesh_quantization) and, for ratio < 1, every primitive simplified by meshoptimizer (normal/UV-aware, error <= 0.005).
async function packGLTF(source, target, {maxSize, ratio = 1, quality = [85, 90]}) {
  const doc = JSON.parse(await readFile(source, 'utf8')), dir = dirname(source);
  assert.equal(doc.buffers.length, 1); assert.ok(!doc.animations && !doc.skins);
  const bin = await readFile(join(dir, doc.buffers[0].uri)), views = [], chunks = [], accessors = [];
  let offset = 0, triangles = 0, maxError = 0, quantized = false;
  const push = (bytes, target, byteStride) => {
    views.push({buffer: 0, byteOffset: offset, byteLength: bytes.length, ...target && {target}, ...byteStride && {byteStride}});
    chunks.push(bytes, Buffer.alloc((4 - bytes.length % 4) % 4)); offset += Math.ceil(bytes.length / 4) * 4;
    return views.length - 1;
  };
  const read = id => {
    const a = doc.accessors[id], v = doc.bufferViews[a.bufferView], width = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
    assert.ok(!a.sparse && !a.normalized);
    const size = a.componentType === 5123 ? 2 : 4, stride = v.byteStride ?? width * size, start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), copy = new ArrayBuffer(a.count * width * size);
    for (let i = 0; i < a.count; i++) new Uint8Array(copy, i * width * size, width * size).set(bin.subarray(start + i * stride, start + i * stride + width * size));
    return {width, type: a.type, data: a.componentType === 5126 ? new Float32Array(copy) : a.componentType === 5125 ? new Uint32Array(copy) : new Uint32Array(new Uint16Array(copy))};
  };
  await MeshoptSimplifier.ready;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4); assert.ok(!primitive.targets);
    const names = Object.keys(primitive.attributes), attrs = names.map(name => read(primitive.attributes[name])), tangent = names.indexOf('TANGENT'), normal = names.indexOf('NORMAL');
    const count = attrs[0].data.length / attrs[0].width, source = primitive.indices === undefined ? Uint32Array.from({length: count}, (_, i) => i) : read(primitive.indices).data;
    // Weld duplicates (some exporters write every corner as its own vertex, with per-face tangents): the key is every
    // attribute but the tangent's direction; welded tangents are summed, then made orthonormal to the normal.
    const keys = new Map(), weld = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const key = attrs.map((a, k) => k === tangent ? a.data[i * 4 + 3] : a.data.subarray(i * a.width, i * a.width + a.width).join()).join('|');
      weld[i] = keys.get(key) ?? keys.set(key, keys.size).get(key);
    }
    let indices = Uint32Array.from(source, i => weld[i]);
    const welded = attrs.map((a, k) => {
      const out = new Float32Array(keys.size * a.width);
      for (let i = 0; i < count; i++) if (k === tangent) for (let c = 0; c < 4; c++) out[weld[i] * 4 + c] += c < 3 ? a.data[i * 4 + c] : 0; else out.set(a.data.subarray(i * a.width, i * a.width + a.width), weld[i] * a.width);
      return out;
    });
    if (tangent >= 0) for (let i = 0; i < count; i++) {
      const j = weld[i], t = welded[tangent], n = welded[normal];
      if (t[j * 4 + 3]) continue; // done (the source w of every welded corner is the same: it is in the key)
      const d = t[j * 4] * n[j * 3] + t[j * 4 + 1] * n[j * 3 + 1] + t[j * 4 + 2] * n[j * 3 + 2];
      for (let c = 0; c < 3; c++) t[j * 4 + c] -= d * n[j * 3 + c];
      const length = Math.hypot(t[j * 4], t[j * 4 + 1], t[j * 4 + 2]); assert.ok(length > 1e-6, 'degenerate welded tangent');
      for (let c = 0; c < 3; c++) t[j * 4 + c] /= length;
      t[j * 4 + 3] = attrs[tangent].data[i * 4 + 3];
    }
    if (ratio < 1) {
      const p = welded[names.indexOf('POSITION')], n = welded[names.indexOf('NORMAL')], uv = welded[names.indexOf('TEXCOORD_0')], extra = new Float32Array(keys.size * 5);
      for (let i = 0; i < keys.size; i++) { extra.set(n.subarray(i * 3, i * 3 + 3), i * 5); extra.set(uv.subarray(i * 2, i * 2 + 2), i * 5 + 3); }
      const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(indices, p, 3, extra, 5, [0.1, 0.1, 0.1, 1, 1], null, Math.floor(indices.length * ratio / 3) * 3, 0.005);
      indices = simplified; maxError = Math.max(maxError, error);
    }
    const [remap, vertexCount] = MeshoptSimplifier.compactMesh(indices);
    primitive.attributes = Object.fromEntries(names.map((name, k) => {
      const {width, type} = attrs[k], data = new Float32Array(vertexCount * width);
      for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) data.set(welded[k].subarray(i * width, i * width + width), remap[i] * width);
      // KHR_mesh_quantization: unit normals/tangents as normalized bytes (padded to 4), [0,1] UVs as normalized shorts.
      const unit = name === 'NORMAL' || name === 'TANGENT', uv = name.startsWith('TEXCOORD_') && data.every(v => v >= 0 && v <= 1);
      let bytes = Buffer.from(data.buffer), componentType = 5126;
      if (unit) { const q = new Int8Array(vertexCount * 4); for (let i = 0; i < vertexCount; i++) for (let c = 0; c < width; c++) q[i * 4 + c] = Math.round(data[i * width + c] * 127); bytes = Buffer.from(q.buffer); componentType = 5120; }
      if (uv) { bytes = Buffer.from(Uint16Array.from(data, v => Math.round(v * 65535)).buffer); componentType = 5123; }
      if (unit || uv) quantized = true;
      const accessor = {bufferView: push(bytes, 34962, unit && width === 3 ? 4 : undefined), componentType, count: vertexCount, type, ...(unit || uv) && {normalized: true}};
      if (name === 'POSITION') { accessor.min = [0, 1, 2].map(axis => data.filter((_, i) => i % 3 === axis).reduce((a, b) => Math.min(a, b))); accessor.max = [0, 1, 2].map(axis => data.filter((_, i) => i % 3 === axis).reduce((a, b) => Math.max(a, b))); }
      return [name, accessors.push(accessor) - 1];
    }));
    const small = vertexCount < 65536, indexData = small ? new Uint16Array(indices) : indices;
    primitive.indices = accessors.push({bufferView: push(Buffer.from(indexData.buffer, indexData.byteOffset, indexData.byteLength), 34963), componentType: small ? 5123 : 5125, count: indices.length, type: 'SCALAR'}) - 1;
    triangles += indices.length / 3;
  }
  const color = new Set(doc.materials.flatMap(m => [m.pbrMetallicRoughness?.baseColorTexture, m.emissiveTexture]).filter(Boolean).map(t => doc.textures[t.index].source));
  for (const [i, image] of doc.images.entries()) {
    const bytes = await sharp(await readFile(join(dir, decodeURIComponent(image.uri)))).resize(maxSize, maxSize, {fit: 'inside', withoutEnlargement: true})
      .jpeg({quality: quality[color.has(i) ? 0 : 1], chromaSubsampling: '4:4:4'}).toBuffer();
    doc.images[i] = {bufferView: push(bytes), mimeType: 'image/jpeg', ...image.name && {name: image.name}};
  }
  Object.assign(doc, {accessors, bufferViews: views, buffers: [{byteLength: offset}]});
  if (quantized) for (const key of ['extensionsUsed', 'extensionsRequired']) doc[key] = [...new Set([...doc[key] ?? [], 'KHR_mesh_quantization'])];
  const json = Buffer.from(JSON.stringify(doc)), padding = Buffer.alloc((4 - json.length % 4) % 4, 0x20), header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + padding.length + offset, 8);
  header.writeUInt32LE(json.length + padding.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(offset, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, json, padding, binHeader, ...chunks]), report = await validator.validateBytes(new Uint8Array(glb));
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
  await writeFile(target, glb);
  return {bytes: glb.length, triangles, simplificationError: maxError, validationErrors: report.issues.numErrors, warnings: report.issues.numWarnings};
}

// Demo helmet: Khronos FlightHelmet (CC0). Desktop: full mesh, 1024-pixel maps; phone: 512-pixel maps, ~22% of the triangles.
const helmet='examples/assets/khronos/FlightHelmet/FlightHelmet.gltf';
const desktop=await packGLTF(helmet,'examples/assets/flight-helmet.glb',{maxSize:1024});
const mobile=await packGLTF(helmet,'examples/assets/flight-helmet-mobile.glb',{maxSize:512,ratio:0.2,quality:[80,85]});
assert.ok(mobile.bytes<desktop.bytes/4,'Phone model must be at least 75% smaller');
for(const r of [desktop,mobile])assert.equal(r.warnings,0);
console.log(JSON.stringify({helmetDesktop:desktop.bytes,helmetMobile:mobile.bytes,triangles:[desktop.triangles,mobile.triangles],simplificationError:mobile.simplificationError,validationErrors:desktop.validationErrors+mobile.validationErrors}));
