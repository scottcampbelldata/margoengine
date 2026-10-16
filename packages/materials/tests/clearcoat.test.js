import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {parseGLTF} from '../../gltf-pro/dist/index.js';
import {clearcoat, install} from '../dist/index.js';
import {materialQuad} from '../../../tests/support/materials-fixture.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const baselineShader = '469dd81676967dbfd22118fa85b1cf8b6ff37dc7593e7e7f8130e5626a29f508';

async function scene(definition, images = [], configure = () => {}) {
  const harness = optionalGPU(), store = await TransformStore.create(16), device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192; device.limits.maxUniformBufferBindingSize = 65536;
  const samplers = [], copies = [], createSampler = device.createSampler;
  device.createSampler = descriptor => {samplers.push(descriptor); return createSampler(descriptor);};
  device.queue.copyExternalImageToTexture = (...args) => copies.push(args);
  const engine = new Engine({width: 128, height: 128, clientWidth: 128, clientHeight: 128}, store,
    {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0,0,3], target: [0,0,0]}, null);
  const fixture = materialQuad(definition); configure(fixture.doc);
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, images);
  assert.ok(!(model instanceof Promise), 'Installing material support must preserve synchronous parsing');
  engine.camera.update(1, true); store.tick(false);
  const draws = [], context = {...harness.context, camera: engine.camera, encoder: {beginRenderPass() {
    let pipeline; const groups = new Map();
    return {setPipeline(value) {pipeline = value; groups.clear();}, setBindGroup(index, group) {groups.set(index,group);},
      setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {draws.push({pipeline, groups: new Map(groups)});}, end() {}};
  }}};
  return {...harness, device, engine, model, fixture, samplers, copies, draws,
    draw(mode = 'beauty') {model.draw(context, mode, context.color, context.depth);}};
}

test('clearcoat packs independent factors, defaults to zero, and binds only supplied maps', () => {
  const empty = clearcoat();
  assert.ok(empty.factors instanceof Float32Array);
  assert.deepEqual([...empty.factors], [0,0,1,0]);
  assert.equal(empty.textures?.length ?? 0, 0, 'Missing clearcoat textures must not create dummy texture/sampler bindings');
  const first = {view: {name: 'factor'}, sampler: {name: 'factor'}, texCoord: 1};
  const second = {view: {name: 'roughness'}, sampler: {name: 'roughness'}};
  const third = {view: {name: 'normal'}, sampler: {name: 'normal'}, texCoord: 1, scale: 0.5};
  const extension = clearcoat({factor: 0.75, roughnessFactor: 0.25, clearcoatTexture: first, clearcoatRoughnessTexture: second, clearcoatNormalTexture: third});
  assert.deepEqual([...extension.factors], [0.75,0.25,0.5,0]);
  assert.deepEqual(extension.textures.map(texture => texture.view), [first.view,second.view,third.view]);
  assert.deepEqual(extension.textures.map(texture => texture.sampler), [first.sampler,second.sampler,third.sampler]);
  assert.match(extension.declarations, /materialTexture0[\s\S]*?\.r/);
  assert.match(extension.declarations, /materialTexture1[\s\S]*?\.g/);
  assert.match(extension.declarations, /materialTexture2/);
  assert.notEqual(clearcoat({clearcoatTexture: first}).declarations, clearcoat({clearcoatTexture: {...first,texCoord: 0}}).declarations,
    'UV selection must be part of the extension shader signature');
});

test('clearcoat validates factor ranges and supplied texture interfaces before drawing', () => {
  for (const key of ['factor','roughnessFactor']) for (const value of [NaN,Infinity,-Infinity,-0.01,1.01,'1',null])
    assert.throws(() => clearcoat({[key]: value}), /clearcoat|factor|roughness/i, `${key}=${value}`);
  for (const key of ['clearcoatTexture','clearcoatRoughnessTexture','clearcoatNormalTexture']) {
    for (const value of [{}, {view: {},sampler: {},texCoord: 2}, {view: {},sampler: {},texCoord: -1}])
      assert.throws(() => clearcoat({[key]: value}), /texture|sampler|UV|coordinate|texCoord/i);
  }
  const loaded = clearcoat({clearcoatTexture: {view: {}}});
  assert.match(loaded.declarations,/textureLoad\(materialTexture0/);
  assert.doesNotMatch(loaded.declarations,/materialSampler0/,'Caller views without samplers must not create a sampler interface');
  assert.throws(() => clearcoat({clearcoatNormalTexture: {view: {},sampler: {},scale: NaN}}), /normal|scale/i);
});

test('install on a model without clearcoat preserves its baseline shader, bindings and allocation path', async () => {
  const s = await scene();
  try {
    const before = {...s.counts}, samplers = s.samplers.length, installation = install(s.model);
    assert.equal(s.model.primitives[0].material.extension, undefined);
    assert.equal(s.counts.textures, before.textures); assert.equal(s.counts.buffers,before.buffers); assert.equal(s.samplers.length,samplers);
    s.draw(); assert.equal(digest(s.draws[0].pipeline.vertex.module.code),baselineShader);
    assert.deepEqual([...s.draws[0].groups.keys()],[0,1]);
    installation.dispose(); installation.dispose();
  } finally {s.engine.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('factor-only glTF clearcoat installs synchronously without textures or samplers and uploads group 3', async () => {
  const s = await scene({clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.25});
  try {
    const before = {...s.counts}, samplers = s.samplers.length, installation = install(s.model);
    assert.ok(!(installation instanceof Promise));
    const extension = s.model.primitives[0].material.extension;
    assert.deepEqual([...extension.factors],[0.75,0.25,1,0]);
    assert.equal(s.counts.textures,before.textures); assert.equal(s.samplers.length,samplers);
    s.draw(); const draw = s.draws[0], entries = draw.groups.get(3).entries;
    assert.deepEqual(entries.map(entry => entry.binding),[0]);
    assert.deepEqual([...new Float32Array(entries[0].resource.buffer.data)],[0.75,0.25,1,0]);
    assert.match(draw.pipeline.vertex.module.code,/@group\(3\)/);
    assert.equal(s.counts.buffers,before.buffers+1);
    extension.factors[0] = 0; const count = s.pipelines.length; s.draw();
    assert.equal(s.pipelines.length,count,'Changing coat factors reuses the pipeline');
    assert.equal(new Float32Array(entries[0].resource.buffer.data)[0],0);
    installation.dispose(); s.draw();
    assert.equal(s.model.primitives[0].material.extension,undefined);
    assert.equal(entries[0].resource.buffer.destroyed,true);
    assert.equal(digest(s.draws.at(-1).pipeline.vertex.module.code),baselineShader);
  } finally {s.engine.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('normalized material clearcoat attaches a shared extension and preserves explicit primitive overrides', async () => {
  const s = await scene();
  try {
    const primitive = s.model.primitives[0], override = {wgsl: 's.emissive+=vec3f(0.1);'};
    primitive.material.clearcoat = {factor: 0.5, roughnessFactor: 0.2}; primitive.extension = override;
    const installation = install(s.model);
    assert.equal(primitive.material.extension.factors[0],0.5);
    assert.equal(primitive.extension,override); s.draw();
    assert.match(s.draws[0].pipeline.vertex.module.code,/s\.emissive\+=vec3f\(0\.1\)/);
    assert.ok(!s.draws[0].groups.has(3));
    installation.dispose(); assert.equal(primitive.extension,override);
  } finally {s.engine.dispose();}
});

test('installation restores previous slots while preserving a caller replacement', async () => {
  const s = await scene({clearcoatFactor: 1});
  try {
    const material = s.model.primitives[0].material, previous = {wgsl: 's.emissive+=vec3f(0.01);'};
    material.extension = previous; const first = install(s.model); assert.notEqual(material.extension,previous);
    first.dispose(); assert.equal(material.extension,previous);
    const second = install(s.model), replacement = {wgsl: 's.emissive+=vec3f(0.02);'};
    material.extension = replacement; second.dispose(); assert.equal(material.extension,replacement);
  } finally {s.engine.dispose();}
});

test('glTF maps share linear image uploads and samplers, restore after device loss, and borrow decoded images', async () => {
  let closed = 0;
  const image = {width: 1, height: 1, close() {closed++;}};
  const s = await scene({clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.25,
    clearcoatTexture: {index: 0}, clearcoatRoughnessTexture: {index: 0}, clearcoatNormalTexture: {index: 0, scale: 0.5}}, [image], doc => {
    doc.images = [{uri: 'decoded.png'}]; doc.textures = [{source: 0, sampler: 0}];
    doc.samplers = [{magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33648}];
  });
  try {
    const before = {...s.counts}, samplerCount = s.samplers.length, installation = install(s.model);
    const extension = s.model.primitives[0].material.extension, owned = s.resources.at(-1);
    assert.equal(s.counts.textures,before.textures+1,'Three coat maps share one decoded image upload');
    assert.equal(s.samplers.length,samplerCount+1,'Three coat maps share their glTF sampler');
    assert.equal(owned.format,'rgba8unorm','All clearcoat textures are linear data');
    assert.equal(new Set(extension.textures.map(texture => texture.view)).size,1);
    assert.deepEqual([...extension.factors],[0.75,0.25,0.5,0]);
    assert.deepEqual(s.samplers.at(-1),{addressModeU: 'clamp-to-edge',addressModeV: 'mirror-repeat',magFilter: 'nearest',minFilter: 'nearest',mipmapFilter: 'linear',lodMaxClamp: 0});
    assert.equal(s.copies.length,1); assert.equal(s.copies[0][0].source,image);
    s.draw(); extension.factors[0] = 0.5;
    s.model.onDeviceRestored(s.engine); installation.onDeviceRestored(s.engine);
    assert.equal(owned.destroyed,true); assert.equal(closed,0);
    const restored = s.model.primitives[0].material.extension;
    assert.notEqual(restored.textures[0].view,extension.textures[0].view);
    assert.equal(restored.factors,extension.factors,'Device restoration retains current material factors');
    s.draw(); installation.dispose(); assert.equal(closed,0,'Uninstalling borrows model images without closing them');
    assert.equal(s.model.primitives[0].material.extension,undefined);
  } finally {s.engine.dispose();}
  assert.equal(closed,1,'The model retains sole ownership of its decoded image');
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('caller-owned clearcoat texture views survive uninstall and model disposal', async () => {
  const s = await scene();
  const external = s.device.createTexture({size: [1,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING});
  try {
    s.model.primitives[0].material.clearcoat = {factor: 1,clearcoatNormalTexture: {view: external.createView(),scale: -0.5}};
    const samplerCount = s.samplers.length, installation = install(s.model); s.draw();
    assert.equal(s.samplers.length,samplerCount,'A caller view without a sampler must allocate no sampler');
    installation.dispose(); assert.equal(external.destroyed,false);
    s.engine.dispose(); assert.equal(external.destroyed,false);
  } finally {s.engine.dispose(); external.destroy();}
});

test('model disposal removes the installation and releases its texture resources', async () => {
  const image = {width: 1,height: 1,close() {}};
  const s = await scene({clearcoatFactor: 1,clearcoatTexture: {index: 0}}, [image], doc => {
    doc.images = [{uri: 'decoded.png'}]; doc.textures = [{source: 0}];
  });
  try {
    const installation = install(s.model), texture = s.resources.at(-1); s.draw(); s.model.dispose();
    assert.equal(installation.disposed,true); assert.equal(texture.destroyed,true);
    assert.equal(s.engine.hasPlugin(installation.name),false);
  } finally {s.engine.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('glTF coat texture transforms install through the shared affine block and select UV1',async()=>{
  const transform={offset:[0.25,0.125],scale:[0.5,0.75],texCoord:1},image={width:1,height:1,close(){}};
  const s=await scene({clearcoatFactor:1,clearcoatTexture:{index:0,texCoord:0,extensions:{KHR_texture_transform:transform}}},[image],doc=>{
    doc.images=[{uri:'decoded.png'}];doc.textures=[{source:0}];doc.extensionsRequired=['KHR_texture_transform'];
  });
  try{
    const installation=install(s.model),extension=s.model.primitives[0].material.extension;
    assert.equal(extension.factors.length,12);assert.deepEqual([...extension.factors.slice(4)],[0.5,0,0.25,0,-0,0.75,0.125,0]);
    assert.equal(extension.textures.length,1);assert.match(extension.declarations,/materialUV\(uv\(i,1\.0\)/);
    s.draw();assert.ok(s.draws.at(-1).groups.has(3));installation.dispose();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('a caller-owned clearcoat map validates the UV set selected by its transform',async()=>{
  const s=await scene(undefined,[],doc=>{delete doc.meshes[0].primitives[0].attributes.TEXCOORD_1;});
  try{
    s.model.primitives[0].material.clearcoat={factor:1,clearcoatTexture:{view:{},texCoord:0,transform:{texCoord:1}}};
    const before={...s.counts};assert.throws(()=>install(s.model),/UV|TEXCOORD|coordinate/i);
    assert.equal(s.model.primitives[0].material.extension,undefined);assert.equal(s.counts.textures,before.textures);assert.equal(s.counts.buffers,before.buffers);
  }finally{s.engine.dispose();}
});

test('invalid glTF coat texture references and missing UV sets fail before allocating resources', async () => {
  const malformed=[null,{offset:[0.5]},{offset:[0,NaN]},{scale:Array(2)},{rotation:null},{texCoord:2}];
  for (const map of [{index: 9},{index: 0,texCoord: 2},{index: 0,texCoord: 1},...malformed.map(transform=>({index:0,extensions:{KHR_texture_transform:transform}}))]) {
    const image = {width: 1,height: 1,close() {}}, s = await scene({clearcoatFactor: 1,clearcoatTexture: map}, [image], doc => {
      doc.images = [{uri: 'decoded.png'}]; doc.textures = [{source: 0}];
      delete doc.meshes[0].primitives[0].attributes.TEXCOORD_1;
    });
    try {
      const before = {...s.counts}, samplerCount = s.samplers.length;
      assert.throws(() => install(s.model),/texture|TEXCOORD|coordinate|transform/i);
      assert.equal(s.model.primitives[0].material.extension,undefined);
      assert.equal(s.counts.textures,before.textures); assert.equal(s.samplers.length,samplerCount);
    } finally {s.engine.dispose();}
  }
});

test('clearcoat material metadata rejects invalid values without installing a partial extension', async () => {
  const s = await scene({clearcoatFactor: -1});
  try {assert.throws(() => install(s.model),/clearcoat|factor/i); assert.equal(s.model.primitives[0].material.extension,undefined);}
  finally {s.engine.dispose();}
});

test('the direct-light slot keys its shader and executes before lighting transforms without changing other fragment modes', async () => {
  const s = await scene();
  try {
    const nested = '{let direct=vec3f(1);var color=vec3f(0);_ = direct+color;}';
    s.model.primitives[0].extension = {wgsl: nested,direct: 'direct*=0.5;'}; s.draw();
    const code = s.draws[0].pipeline.vertex.module.code;
    assert.equal(code.split('direct*=0.5;').length-1,1,'The direct hook appears only in the beauty fragment');
    assert.equal(code.split(nested).length-1,3,'The direct hook must preserve nested caller WGSL in every fragment consumer');
    assert.ok(code.indexOf('var direct=') < code.indexOf('direct*=0.5;'));
    assert.ok(code.indexOf('direct*=0.5;') < code.indexOf('var color=direct+ambient(s)'));
    assert.doesNotMatch(code.slice(code.indexOf('@fragment fn gbuffer')),/direct\*=0\.5/);
    s.model.primitives[0].extension.direct = 'direct*=0.25;'; s.draw();
    assert.notEqual(s.draws[0].pipeline,s.draws[1].pipeline,'Direct-light WGSL participates in the pipeline signature');
    s.model.primitives[0].extension.direct = 3;
    assert.throws(() => s.draw(),/extension|WGSL/i);
  } finally {s.engine.dispose();}
});

test('materials remains optional, tree shakable and absent from frozen and glTF module imports', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.name,'@margoengine/materials'); assert.equal(manifest.sideEffects,false);
  assert.ok(manifest.dependencies?.['@margoengine/gltf-pro'] || manifest.peerDependencies?.['@margoengine/gltf-pro']);
  for (const name of ['core','margoengine','gltf-pro']) {
    const source = readFileSync(new URL(`../../${name}/dist/index.js`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/(?:from\s*|import\s*\()["']@margoengine\/materials/);
  }
});
