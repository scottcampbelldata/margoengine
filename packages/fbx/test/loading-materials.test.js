import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {convertFBX, parseFBX, loadFBX} from '../dist/index.js';
import {rigFixture, readGLB} from './native-scene-helper.js';

const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
if (!bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', {configurable: true, writable: true, value: async () => {throw new Error('Unexpected image decode');}});
after(() => {if (bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor); else delete globalThis.createImageBitmap;});

// Real 1x1 RGBA PNG and white JPEG, encoded once for deterministic offline fixtures.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z', 'base64');
const scalar = (name, value) => `P: "${name}", "double", "Number", "", ${value}`;
const color = (name, values) => `P: "${name}", "ColorRGB", "Color", "", ${values.join(',')}`;
const quote = value => JSON.stringify(value);
const close = (actual, expected) => {assert.equal(actual.length, expected.length); for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i]-expected[i]) < 1e-6, `${actual[i]} != ${expected[i]}`);};

function fixture({properties = '', materialIndex = 0, textures = []} = {}) {
  const objects = [`Material: 100, "Material::Surface", "Phong" {\n ShadingModel: "phong"\n Properties70: {\n ${properties}\n }\n}`];
  const connections = ['C: "OO",100,2'];
  for (let i = 0; i < textures.length; i++) {
    const {bytes, path, slot = 'DiffuseColor', additionalSlot} = textures[i], texture = 200+i, video = 300+i;
    objects.push(`Texture: ${texture}, "Texture::Map${i}", "" {\n ${path === undefined ? '' : `RelativeFilename: ${quote(path)}`}\n}\nVideo: ${video}, "Video::Image${i}", "Clip" {\n ${bytes ? `Content: "${Buffer.from(bytes).toString('base64')}"` : ''}\n}`);
    connections.push(`C: "OP",${texture},100,"${slot}"`, `C: "OO",${video},${texture}`);
    if (additionalSlot) connections.push(`C: "OP",${texture},100,"${additionalSlot}"`);
  }
  const source = rigFixture({skin: false, morph: false, animation: false, geometric: [0,0,0], meshTranslation: [0,0,0], extraModel: objects.join('\n'), extraConnections: connections.join('\n')});
  return new TextEncoder().encode(source.replace('PolygonVertexIndex: *3 {', `LayerElementUV: 0 {\n MappingInformationType: "ByVertice"\n ReferenceInformationType: "Direct"\n UV: *6 { a: 0,0,1,0,0,1 }\n}\nLayerElementMaterial: 0 {\n MappingInformationType: "AllSame"\n ReferenceInformationType: "IndexToDirect"\n Materials: *1 { a: ${materialIndex} }\n}\nPolygonVertexIndex: *3 {`));
}

function embeddedImage(result, index = 0) {
  const {doc, bin} = readGLB(result), image = doc.images[index], view = doc.bufferViews[image.bufferView];
  return {doc, image, bytes: bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0)+view.byteLength)};
}

function redirectedResponse(bytes, url, status = 200) {
  const response = new Response(bytes, {status}); Object.defineProperty(response, 'url', {value: url}); return response;
}

test('native Phong properties become dielectric PBR with opacity taking precedence', async () => {
  const result = await convertFBX(fixture({properties: [color('DiffuseColor', [.8,.6,.4]), scalar('DiffuseFactor', .5), color('EmissiveColor', [.2,.3,.4]), scalar('EmissiveFactor', .5), scalar('Opacity', .25), scalar('TransparencyFactor', .9), scalar('Shininess', 10)].join('\n')}));
  const {doc} = readGLB(result), material = doc.materials[doc.meshes[0].primitives[0].material], pbr = material.pbrMetallicRoughness;
  close(pbr.baseColorFactor, [.4,.3,.2,.25]); close(material.emissiveFactor, [.1,.15,.2]);
  assert.equal(pbr.metallicFactor, 0); assert.ok(Math.abs(pbr.roughnessFactor-Math.sqrt(2/12)) < 1e-7); assert.equal(material.alphaMode, 'BLEND');
});

test('TransparencyFactor supplies alpha and shininess respects roughness limits', async () => {
  for (const [properties, alpha, roughness] of [
    [[scalar('TransparencyFactor', .6), scalar('Shininess', 0)].join('\n'), .4, 1],
    [[scalar('Opacity', 1), scalar('TransparencyFactor', 1), scalar('Shininess', 1e12)].join('\n'), 1, .045],
  ]) {
    const {doc} = readGLB(await convertFBX(fixture({properties}))), material = doc.materials[0];
    assert.ok(Math.abs(material.pbrMetallicRoughness.baseColorFactor[3]-alpha) < 1e-7);
    assert.ok(Math.abs(material.pbrMetallicRoughness.roughnessFactor-roughness) < 1e-7);
    assert.equal(material.alphaMode ?? 'OPAQUE', alpha < 1 ? 'BLEND' : 'OPAQUE');
  }
});

test('unassigned material -1 uses the default without fetching connected unused textures', async t => {
  let fetched = 0; t.mock.method(globalThis, 'fetch', async () => {fetched++; throw new Error('unused texture fetched');});
  const {doc} = readGLB(await convertFBX(fixture({materialIndex: -1, properties: color('DiffuseColor', [1,0,0]), textures: [{path: 'unused.png'}]}), {resourcePath: 'https://assets.example/models/'}));
  assert.equal(doc.meshes[0].primitives[0].material, undefined); assert.equal(doc.materials, undefined); assert.equal(doc.images, undefined); assert.equal(fetched, 0);
});

test('embedded PNG and JPEG retain exact bytes and MIME types in the GLB', async t => {
  t.mock.method(globalThis, 'fetch', async () => {throw new Error('embedded image must not fetch');});
  for (const [bytes, mimeType] of [[PNG, 'image/png'], [JPEG, 'image/jpeg']]) {
    const output = embeddedImage(await convertFBX(fixture({textures: [{bytes}]})));
    assert.equal(output.image.mimeType, mimeType); assert.deepEqual(output.bytes, new Uint8Array(bytes));
    const primitive = output.doc.meshes[0].primitives[0]; assert.ok(primitive.attributes.TEXCOORD_0 !== undefined);
    assert.ok(output.doc.materials[primitive.material].pbrMetallicRoughness.baseColorTexture);
  }
});

test('one native texture shared by diffuse and normal slots writes one image', async () => {
  const {doc} = readGLB(await convertFBX(fixture({textures: [{bytes: PNG, additionalSlot: 'NormalMap'}]})));
  assert.equal(doc.images.length, 1); assert.equal(doc.textures.length, 1);
  assert.equal(doc.materials[0].pbrMetallicRoughness.baseColorTexture.index, doc.materials[0].normalTexture.index);
});

test('external PNG and JPEG resolve relative paths and pass the abort signal to fetch', async t => {
  const controller = new AbortController(), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([String(url), options.signal]); return new Response(String(url).endsWith('.jpg') ? JPEG : PNG);
  });
  const result = await convertFBX(fixture({textures: [{path: 'textures\\albedo.png'}, {path: '../normals/normal.jpg', slot: 'NormalMap'}]}), {resourcePath: 'https://assets.example/models/robot/', allowedURLs: ['https://assets.example/models/normals/'], signal: controller.signal});
  assert.deepEqual(calls.map(([url]) => url), ['https://assets.example/models/robot/textures/albedo.png', 'https://assets.example/models/normals/normal.jpg']);
  assert.ok(calls.every(([, signal]) => signal === controller.signal));
  assert.equal(embeddedImage(result, 0).image.mimeType, 'image/png'); assert.deepEqual(embeddedImage(result, 0).bytes, new Uint8Array(PNG));
  assert.equal(embeddedImage(result, 1).image.mimeType, 'image/jpeg'); assert.deepEqual(embeddedImage(result, 1).bytes, new Uint8Array(JPEG));
});

test('native texture loading rejects HTTP failures and non-HTTP resources', async t => {
  let requests = 0; t.mock.method(globalThis, 'fetch', async () => {requests++; return new Response('missing', {status: 404});});
  await assert.rejects(convertFBX(fixture({textures: [{path: 'missing.png'}]}), {resourcePath: 'https://assets.example/'}), /FBX texture request failed: HTTP 404/);
  assert.equal(requests, 1);
  await assert.rejects(convertFBX(fixture({textures: [{path: 'file:///private/image.png'}]}), {resourcePath: 'https://assets.example/'}), /HTTP\(S\)/);
  await assert.rejects(convertFBX(fixture(), {resourcePath: 'file:///private/'}), /HTTP\(S\)/);
  await assert.rejects(loadFBX({}, 'file:///private/model.fbx'), /HTTP\(S\)/);
  assert.equal(requests, 1);
});

test('loadFBX resolves textures from the final response URL or explicit resourcePath and cleans aborted images', async t => {
  const modelURL = 'https://origin.example/robot.fbx', finalURL = 'https://cdn.example/releases/v2/robot.fbx';
  const input = fixture({textures: [{path: 'textures/albedo.png'}]});
  for (const resourcePath of [undefined, 'https://overrides.example/maps/']) {
    const controller = new AbortController(), reason = new Error('stop after native image decode'), calls = [], decoded = [], closed = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push([String(url), options.signal]); return String(url) === modelURL ? redirectedResponse(input, finalURL) : new Response(PNG);
    });
    t.mock.method(globalThis, 'createImageBitmap', async (blob, options) => {
      decoded.push({type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()), options}); controller.abort(reason);
      return {width: 1, height: 1, close() {closed.push(true);}};
    });
    await assert.rejects(loadFBX({}, modelURL, {signal: controller.signal, ...(resourcePath ? {resourcePath} : {})}), error => error === reason);
    assert.deepEqual(calls.map(([url]) => url), [modelURL, (resourcePath ?? 'https://cdn.example/releases/v2/')+'textures/albedo.png']);
    assert.ok(calls.every(([, signal]) => signal === controller.signal)); assert.equal(decoded.length, 1); assert.equal(closed.length, 1);
    assert.equal(decoded[0].type, 'image/png'); assert.deepEqual(decoded[0].bytes, new Uint8Array(PNG));
    assert.deepEqual(decoded[0].options, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
    t.mock.restoreAll();
  }
});

test('HTTP model failures and cancellation during texture fetching stop before decoding', async t => {
  let decoded = 0; t.mock.method(globalThis, 'createImageBitmap', async () => {decoded++; throw new Error('unexpected decode');});
  t.mock.method(globalThis, 'fetch', async () => new Response('gone', {status: 410}));
  await assert.rejects(loadFBX({}, 'https://assets.example/gone.fbx'), /FBX request failed: HTTP 410/);
  const controller = new AbortController(), reason = new Error('cancel texture request');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.signal, controller.signal); controller.abort(reason); return new Response(PNG);
  });
  await assert.rejects(convertFBX(fixture({textures: [{path: 'albedo.png'}]}), {resourcePath: 'https://assets.example/', signal: controller.signal}), error => error === reason);
  assert.equal(decoded, 0);
});

test('a later image decode failure closes earlier decoded native images', async t => {
  const reason = new Error('JPEG decoding failed'); let decoded = 0, closed = 0;
  t.mock.method(globalThis, 'createImageBitmap', async blob => {
    decoded++; if (decoded === 2) {assert.equal(blob.type, 'image/jpeg'); throw reason;}
    assert.equal(blob.type, 'image/png'); return {width: 1, height: 1, close() {closed++;}};
  });
  await assert.rejects(parseFBX({}, fixture({textures: [{bytes: PNG}, {bytes: JPEG, slot: 'NormalMap'}]})), error => error === reason);
  assert.equal(decoded, 2); assert.equal(closed, 1);
});


test('model texture paths stay inside their directory unless explicitly allowed', async t => {
  let requests=0; t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(PNG);});
  const input=fixture({textures:[{path:'../private/image.png'}]});
  await assert.rejects(convertFBX(input,{resourcePath:'https://assets.example/models/robot/'}),/allowedURLs/);
  assert.equal(requests,0);
  await convertFBX(input,{resourcePath:'https://assets.example/models/robot/',allowedURLs:['https://assets.example/models/private/']});
  assert.equal(requests,1);
});
