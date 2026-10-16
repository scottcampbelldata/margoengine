import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {parseGLTF} from '../../gltf-pro/dist/index.js';
import {install,transmission as extension} from '../dist/index.js';
import {transmissionQuads} from '../../../tests/support/transmission-fixture.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const baselineShader = '469dd81676967dbfd22118fa85b1cf8b6ff37dc7593e7e7f8130e5626a29f508';
const transmission = (factor = 1, extra = {}) => ({KHR_materials_transmission: {transmissionFactor: factor}, ...extra});

async function scene(extensions, images = [], configure = () => {}) {
  const harness = optionalGPU(), store = await TransformStore.create(32), device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192; device.limits.maxUniformBufferBindingSize = 65536;
  const samplers = [], imageCopies = [], createSampler = device.createSampler;
  device.createSampler = descriptor => {samplers.push(descriptor); return createSampler(descriptor);};
  device.queue.copyExternalImageToTexture = (...args) => imageCopies.push(args);
  const engine = new Engine({width: 128, height: 128, clientWidth: 128, clientHeight: 128}, store,
    {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0,0,3], target: [0,0,0]}, null);
  const fixture = transmissionQuads(extensions); configure(fixture.doc);
  const model = parseGLTF(engine, fixture.doc, fixture.buffers, images);
  assert.ok(!(model instanceof Promise), 'Material installation must preserve synchronous baseline parsing');
  engine.camera.update(1, true); store.tick(false);
  const draws = [], events = [], context = {...harness.context, camera: engine.camera,draw(){}, descriptor: {...harness.context.descriptor,multisample:{count:1}},
    encoder: {copyTextureToTexture(...args) {events.push({copy: args});}, beginRenderPass(descriptor) {
      const record = {descriptor}; events.push(record);
      let pipeline; const groups = new Map();
      return {setPipeline(value) {pipeline = value; groups.clear();}, setBindGroup(index, group) {groups.set(index, group);},
        setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {draws.push({pipeline,groups:new Map(groups),pass:record});},
        draw() {}, end() {record.ended = true;}};
    }}};
  return {...harness,device,engine,model,fixture,samplers,imageCopies,draws,events,context,
    draw(mode = 'beauty') {model.draw(context,mode,context.color,context.depth);},
    frame() {engine.frameGraph.prepare(context);engine.frameGraph.execute(context);}};
}

test('caller transmission packs scalar factors and creates only explicitly supplied resource bindings', () => {
  assert.deepEqual(extension(),{});
  assert.throws(()=>extension({factor:1}),/opaque|color|view|transmission/i);
  const opaqueColor={name:'opaque'},factorMap={view:{name:'factor'},sampler:{},texCoord:1},thicknessMap={view:{name:'thickness'},texCoord:0};
  const value=extension({factor:0.75,ior:1.33,opaqueColor,transmissionTexture:factorMap,
    volume:{thicknessFactor:0.5,thicknessTexture:thicknessMap,attenuationColor:[0.2,0.4,0.6],attenuationDistance:2}});
  assert.deepEqual([...value.factors],[0.75,Math.fround(1.33),0.5,0.5,Math.fround(0.2),Math.fround(0.4),Math.fround(0.6),0]);
  assert.equal(value.textures.length,3);
  assert.deepEqual(value.textures.map(texture=>texture.view),[opaqueColor,factorMap.view,thicknessMap.view]);
  assert.equal(value.textures[2].sampler,undefined);
  assert.match(value.declarations,/materialTexture1[\s\S]*?\.r/);
  assert.match(value.declarations,/materialTexture2[\s\S]*?\.g/);
  assert.equal(value.lighting,false,'First-version transmission must skip cascaded-shadow lighting effects');
  assert.notEqual(extension({factor:1,opaqueColor,transmissionTexture:factorMap}).declarations,
    extension({factor:1,opaqueColor,transmissionTexture:{...factorMap,texCoord:0}}).declarations,'UV selection must participate in the shader signature');
  const unattenuated=extension({factor:1,opaqueColor,volume:{thicknessFactor:1,attenuationDistance:Infinity}});
  assert.equal(unattenuated.factors[3],0,'Infinite attenuation distance uses zero absorption');
  assert.ok([...unattenuated.factors].every(Number.isFinite));
  assert.throws(()=>extension({factor:0,volume:{thicknessFactor:1}}),/KHR_materials_volume requires transmission/);
});

test('transmission factor zero preserves the opaque material, baseline shader, depth and shadow path', async () => {
  const s = await scene(transmission(0));
  try {
    const material = s.model.primitives[1].material, settings = [...material.settings], before = {...s.counts};
    const installation = install(s.model); s.draw();
    assert.deepEqual(material.settings,settings);
    assert.equal(s.model.shadowPrimitives.length,2);
    assert.equal(s.draws[1].pipeline.depthStencil.depthWriteEnabled,true);
    assert.equal(digest(s.draws[1].pipeline.vertex.module.code),baselineShader);
    assert.equal(s.counts.textures,before.textures,'Factor zero must not allocate an opaque scene target');
    installation.dispose();
  } finally {s.engine.dispose();}
  assert.ok(s.resources.every(resource => resource.destroyed));
});

test('IOR metadata without transmission remains synchronous and leaves the opaque fast path intact', async () => {
  const s = await scene({KHR_materials_ior:{ior:1.33}});
  try {
    const before = {...s.counts}, installation = install(s.model); s.draw();
    assert.equal(s.model.primitives[1].material.extension,undefined);
    assert.equal(digest(s.draws[1].pipeline.vertex.module.code),baselineShader);
    assert.equal(s.counts.textures,before.textures);
    installation.dispose();
  } finally {s.engine.dispose();}
});

test('volume without nonzero transmission is rejected before allocation or partial installation', async () => {
  for (const extensions of [{KHR_materials_volume:{thicknessFactor:1}}, transmission(0,{KHR_materials_volume:{thicknessFactor:1}})]) {
    const s = await scene(extensions);
    try {
      const before = {...s.counts}, material = s.model.primitives[1].material, settings = [...material.settings];
      assert.throws(() => install(s.model),/KHR_materials_volume requires transmission/);
      assert.equal(material.extension,undefined); assert.deepEqual(material.settings,settings);
      assert.equal(s.counts.buffers,before.buffers); assert.equal(s.counts.textures,before.textures);
    } finally {s.engine.dispose();}
  }
});

test('invalid transmission, IOR and volume metadata fail before installing resources', async () => {
  const invalid = [transmission(-0.01),transmission(1.01),transmission(NaN),transmission(Infinity),
    transmission(1,{KHR_materials_ior:{ior:0.99}}),transmission(1,{KHR_materials_ior:{ior:NaN}}),
    transmission(1,{KHR_materials_volume:{thicknessFactor:-1}}),transmission(1,{KHR_materials_volume:{attenuationDistance:0}}),
    transmission(1,{KHR_materials_volume:{attenuationColor:[1,1]}}),transmission(1,{KHR_materials_volume:{attenuationColor:[-1,0,0]}})];
  for (const extensions of invalid) {
    const s = await scene(extensions);
    try {
      const before = {...s.counts}; assert.throws(() => install(s.model),/transmission|IOR|ior|volume|attenuation|thickness/i);
      assert.equal(s.model.primitives[1].material.extension,undefined); assert.equal(s.counts.textures,before.textures);
    } finally {s.engine.dispose();}
  }
});

test('transmission and thickness metadata validate texture references and required UV sets before upload', async () => {
  const malformed=[null,{offset:[0.5]},{offset:[0,NaN]},{scale:Array(2)},{rotation:null},{texCoord:2}];
  for (const field of ['transmissionTexture','thicknessTexture']) for (const map of [{index:9},{index:0,texCoord:2},{index:0,texCoord:1},...malformed.map(transform=>({index:0,extensions:{KHR_texture_transform:transform}}))]) {
    const extensions = transmission(1,field==='thicknessTexture'?{KHR_materials_volume:{thicknessFactor:1,[field]:map}}:{});
    if(field==='transmissionTexture')extensions.KHR_materials_transmission[field]=map;
    const image = {width:1,height:1,close(){}}, s = await scene(extensions,[image],doc => {
      doc.images=[{uri:'decoded.png'}]; doc.textures=[{source:0}]; delete doc.meshes[1].primitives[0].attributes.TEXCOORD_1;
    });
    try {
      const before={...s.counts}; assert.throws(()=>install(s.model),/texture|TEXCOORD|coordinate|transform/i);
      assert.equal(s.model.primitives[1].material.extension,undefined); assert.equal(s.counts.textures,before.textures);
    } finally {s.engine.dispose();}
  }
});

test('transmission and thickness glTF texture transforms append affine rows and select UV1',async()=>{
  for(const field of ['transmissionTexture','thicknessTexture']){
    const map={index:0,texCoord:0,extensions:{KHR_texture_transform:{offset:[0.25,0.125],scale:[0.5,0.75],texCoord:1}}};
    const definitions=transmission(1,field==='thicknessTexture'?{KHR_materials_volume:{thicknessFactor:1,[field]:map}}:{});
    if(field==='transmissionTexture')definitions.KHR_materials_transmission[field]=map;
    const image={width:1,height:1,close(){}},s=await scene(definitions,[image],doc=>{
      doc.images=[{uri:'decoded.png'}];doc.textures=[{source:0}];doc.extensionsRequired=['KHR_texture_transform'];
    });
    try{
      const installation=install(s.model),extension=s.model.primitives[1].material.extension;
      assert.equal(extension.factors.length,16);assert.deepEqual([...extension.factors.slice(8)],[0.5,0,0.25,0,-0,0.75,0.125,0]);
      assert.equal(extension.textures.length,2);assert.match(extension.declarations,/materialUV\(uv\(i,1\.0\)/);
      s.frame();assert.ok(s.draws.at(-1).groups.has(3));installation.dispose();
    }finally{s.engine.dispose();}
    assert.ok(s.resources.every(resource=>resource.destroyed));
  }
});

test('caller-owned transmission and thickness maps validate transform-selected UV1 before allocating capture resources',async()=>{
  for(const field of ['transmissionTexture','thicknessTexture']){
    const s=await scene(transmission(1),[],doc=>{delete doc.meshes[1].primitives[0].attributes.TEXCOORD_1;});
    try{
      const material=s.model.primitives[1].material,map={view:{},texCoord:0,transform:{texCoord:1}};
      material.transmission={factor:1,...(field==='transmissionTexture'?{transmissionTexture:map}:{})};
      if(field==='thicknessTexture')material.volume={thicknessFactor:1,thicknessTexture:map};
      const before={...s.counts};assert.throws(()=>install(s.model),/UV|TEXCOORD|coordinate/i);
      assert.equal(material.extension,undefined);assert.equal(s.counts.textures,before.textures);assert.equal(s.counts.buffers,before.buffers);
      assert.equal(s.engine.hasPlugin('materials:opaque-color'),false);
    }finally{s.engine.dispose();}
  }
});

test('transmission installs a shared opaque copy, blends without depth writes or shadows, then restores material state', async () => {
  const s=await scene(transmission(0.75,{KHR_materials_ior:{ior:1.33}}));
  try {
    const material=s.model.primitives[1].material,settings=[...material.settings],previous={wgsl:'s.emissive+=vec3f(0.01);'};
    material.extension=previous;
    const removeLighting=s.model.addLighting({shader(code){return code.replace('direct+ambient(s)','direct*0.5+ambient(s)');},bindings(){return [];}});
    const installation=install(s.model);
    assert.equal(material.settings[0],2);assert.equal(material.extension.lighting,false);
    assert.equal(s.model.shadowPrimitives.length,1);assert.ok(s.engine.hasPlugin('materials:opaque-color'));
    s.frame();assert.equal(s.draws.length,2);
    assert.match(s.draws[0].pipeline.vertex.module.code,/direct\*0\.5\+ambient\(s\)/);
    assert.doesNotMatch(s.draws[1].pipeline.vertex.module.code,/direct\*0\.5\+ambient\(s\)/,'Transmission must skip installed shadow effects');
    assert.ok(s.draws[1].pipeline.fragment.targets[0].blend);assert.equal(s.draws[1].pipeline.depthStencil.depthWriteEnabled,false);
    assert.ok(s.draws[1].groups.has(3));
    const extensionBuffer=s.draws[1].groups.get(3).entries[0].resource.buffer;
    installation.dispose();installation.dispose();assert.equal(material.extension,previous);assert.deepEqual(material.settings,settings);
    assert.equal(s.engine.hasPlugin('materials:opaque-color'),false);assert.equal(s.model.shadowPrimitives.length,2);
    s.draw();assert.equal(extensionBuffer.destroyed,true);removeLighting();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('transmission and volume share linear image uploads and preserve caller-owned texture views', async () => {
  const image={width:1,height:1,close(){}},s=await scene({KHR_materials_transmission:{transmissionFactor:1,transmissionTexture:{index:0}},
    KHR_materials_volume:{thicknessFactor:0.5,thicknessTexture:{index:0},attenuationDistance:1}},[image],doc=>{
    doc.images=[{uri:'decoded.png'}];doc.textures=[{source:0,sampler:0}];doc.samplers=[{magFilter:9728,minFilter:9728}];
  });
  try {
    const imageCopies=s.imageCopies.length,samplers=s.samplers.length,installation=install(s.model),material=s.model.primitives[1].material;
    assert.equal(s.imageCopies.length,imageCopies+1,'Transmission and volume data maps must share one decoded-image upload');
    assert.equal(s.samplers.length,samplers+1,'The shared maps require one glTF sampler');
    assert.equal(material.extension.textures[1].view,material.extension.textures[2].view);
    const oldViews=material.extension.textures.slice(1).map(texture=>texture.view);
    assert.ok(oldViews.every(view=>view.texture.format==='rgba8unorm'));
    installation.onDeviceRestored(s.engine);
    assert.ok(oldViews.every(view=>view.texture.destroyed));
    assert.notEqual(material.extension.textures[1].view,oldViews[0]);
    installation.dispose();
    const caller=s.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});
    material.transmission={factor:1,transmissionTexture:{view:caller.createView()}};
    delete material.extensions.KHR_materials_volume;delete material.volume;
    const callerInstallation=install(s.model);callerInstallation.dispose();s.model.destroy();assert.equal(caller.destroyed,false);caller.destroy();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('clearcoat coexists with transmission and volume in a single isolated extension slot', async () => {
  const s=await scene(transmission(0.75,{KHR_materials_ior:{ior:1.5},KHR_materials_volume:{thicknessFactor:1,attenuationColor:[1,0.5,0.2],attenuationDistance:2},
    KHR_materials_clearcoat:{clearcoatFactor:0.4,clearcoatRoughnessFactor:0.1}}));
  try {
    const installation=install(s.model),value=s.model.primitives[1].material.extension;
    assert.equal(value.factors.length,12,'Clearcoat and transmission factors share one packed extension block');
    assert.match(value.declarations,/materialClearcoat/);assert.match(value.declarations,/transmission/i);
    s.frame();assert.equal(s.draws[1].groups.get(3).entries.filter(entry=>'buffer' in entry.resource).length,1);
    installation.dispose();assert.equal(s.model.primitives[1].material.extension,undefined);
  }finally{s.engine.dispose();}
});

test('the opaque snapshot is shared across models and all opaque draws precede every transmissive draw', async () => {
  const s=await scene(transmission(1));let second;
  try {
    const firstInstallation=install(s.model),fixture=transmissionQuads(transmission(1));
    second=parseGLTF(s.engine,fixture.doc,fixture.buffers);s.engine.store.tick(false);
    const secondInstallation=install(second);s.frame();
    assert.equal(s.draws.length,4);
    assert.deepEqual(s.draws.map(draw=>draw.pipeline.depthStencil.depthWriteEnabled),[true,true,false,false],
      'A transmissive primitive sampled before another model had rendered its opaque primitive');
    firstInstallation.dispose();assert.ok(s.engine.hasPlugin('materials:opaque-color'),'One installation must not release another model\'s snapshot');
    secondInstallation.dispose();assert.equal(s.engine.hasPlugin('materials:opaque-color'),false);
  }finally{second?.destroy();s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('scene snapshot resources survive unchanged frames and replace cleanly on resize, HDR, and MSAA switches', async () => {
  const s=await scene(transmission(1));
  try {
    const installation=install(s.model),start=s.resources.length,originalColor=s.context.color,originalDepth=s.context.depth;
    s.frame();const first=s.resources.slice(start).filter(resource=>resource.createView);
    assert.ok(first.length>=2,'Transmission needs a separate opaque snapshot and scene color');
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);
    const textures=s.counts.textures;s.frame();assert.equal(s.counts.textures,textures,'An unchanged frame must reuse scene targets');
    s.context.width=256;s.context.height=192;s.frame();assert.ok(first.every(texture=>texture.destroyed),'Resize leaked the previous snapshot');
    const resized=s.resources.filter(resource=>resource.createView&&!resource.destroyed&&resource.width===256);
    assert.ok(resized.length>=2);
    s.context.format='rgba16float';s.frame();assert.ok(resized.every(texture=>texture.destroyed),'An HDR format change leaked the previous snapshot');
    const hdr=s.resources.filter(resource=>resource.createView&&!resource.destroyed&&resource.width===256);
    assert.ok(hdr.every(texture=>texture.format==='rgba16float'));
    s.context.descriptor={...s.context.descriptor,multisample:{count:4}};s.frame();
    assert.ok(hdr.every(texture=>texture.destroyed),'An MSAA change leaked the previous snapshot');
    assert.ok(s.resources.some(resource=>resource.createView&&!resource.destroyed&&resource.sampleCount===4));
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);
    installation.dispose();assert.ok(s.resources.filter(resource=>resource.createView&&resource.width===256).every(texture=>texture.destroyed));
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('a failed snapshot resize releases partial replacements and preserves the previous capture for retry', async () => {
  const s=await scene(transmission(1));
  try {
    const installation=install(s.model);s.frame();
    const originalColor=s.context.color,originalDepth=s.context.depth,width=s.context.width;
    const previous=s.resources.filter(resource=>resource.createView&&!resource.destroyed&&resource.width===width);
    const createTexture=s.device.createTexture,failure=new Error('injected snapshot resize failure');let allocations=0;
    s.context.width=width*2;const start=s.resources.length;
    s.device.createTexture=descriptor=>{if(++allocations===2)throw failure;return createTexture(descriptor);};
    assert.throws(()=>s.frame(),error=>error===failure);
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);
    assert.ok(s.resources.slice(start).every(resource=>resource.destroyed),'A partial replacement texture leaked');
    assert.ok(previous.every(resource=>!resource.destroyed),'A failed replacement destroyed the usable capture');
    s.device.createTexture=createTexture;s.context.width=width;
    const textures=s.counts.textures;s.frame();assert.equal(s.counts.textures,textures,'Retry should reuse the preserved capture');
    installation.dispose();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('a deferred transmission draw failure restores MSAA context and recovers on the next frame', async () => {
  const s=await scene(transmission(1));
  try {
    const installation=install(s.model),originalColor=s.context.color,originalDepth=s.context.depth;
    s.context.descriptor={...s.context.descriptor,multisample:{count:4}};const originalDescriptor=s.context.descriptor;
    const beginRenderPass=s.context.encoder.beginRenderPass,failure=new Error('injected transmission draw failure');let failed=false;
    s.context.encoder.beginRenderPass=descriptor=>{
      const pass=beginRenderPass(descriptor),setPipeline=pass.setPipeline;
      pass.setPipeline=pipeline=>{if(!failed&&pipeline.fragment?.targets[0]?.blend){failed=true;throw failure;}setPipeline(pipeline);};
      return pass;
    };
    assert.throws(()=>s.frame(),error=>error===failure);assert.equal(failed,true);
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);assert.equal(s.context.descriptor,originalDescriptor);
    s.context.encoder.beginRenderPass=beginRenderPass;s.frame();
    assert.deepEqual(s.draws.slice(-2).map(draw=>draw.pipeline.depthStencil.depthWriteEnabled),[true,false]);
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);assert.equal(s.context.descriptor,originalDescriptor);
    installation.dispose();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('device recovery retires an unfinished opaque frame without using its old encoder', async () => {
  const s=await scene(transmission(1));
  try {
    let capture;const use=s.engine.use.bind(s.engine);
    s.engine.use=plugin=>{if(plugin.name==='materials:opaque-color')capture=plugin;return use(plugin);};
    const installation=install(s.model),originalColor=s.context.color,originalDepth=s.context.depth;
    s.context.descriptor={...s.context.descriptor,multisample:{count:4}};const originalDescriptor=s.context.descriptor;
    const beginRenderPass=s.context.encoder.beginRenderPass,failure=new Error('injected opaque draw failure');
    s.context.encoder.beginRenderPass=descriptor=>{
      const pass=beginRenderPass(descriptor);pass.setPipeline=()=>{throw failure;};return pass;
    };
    assert.throws(()=>s.frame(),error=>error===failure);
    assert.notEqual(s.context.color,originalColor,'The failed opaque draw should leave an unfinished capture');
    s.context.encoder.beginRenderPass=()=>{throw new Error('A lost-device encoder must never be reused');};
    assert.doesNotThrow(()=>capture.onDeviceRestored(s.engine));
    assert.equal(s.context.color,originalColor);assert.equal(s.context.depth,originalDepth);assert.equal(s.context.descriptor,originalDescriptor);
    s.context.encoder.beginRenderPass=beginRenderPass;s.frame();
    assert.deepEqual(s.draws.slice(-2).map(draw=>draw.pipeline.depthStencil.depthWriteEnabled),[true,false]);
    installation.dispose();
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});
