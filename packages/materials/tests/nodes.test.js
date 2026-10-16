import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Engine,TransformStore} from '../../core/dist/extension.js';
import {parseGLTF} from '../../gltf-pro/dist/index.js';
import {nodeMaterial,installNodeMaterial,clearcoat,transmission} from '../dist/index.js';
import {materialQuad} from '../../../tests/support/materials-fixture.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const color=(value=[0.08,0.08,0.08,1])=>({type:'color',value});
const scalar=value=>({type:'scalar',value});
const emit=(value=color(),extra={})=>({type:'emit',color:value,...extra});
const graph=(output=emit(),...nodes)=>({nodes:[output,...nodes]});
const source=extension=>[extension.declarations,extension.wgsl,extension.direct,extension.output].filter(Boolean).join('\n');
const digest=value=>createHash('sha256').update(value).digest('hex');

async function scene() {
  const harness=optionalGPU(),store=await TransformStore.create(32),device=harness.engine.gpu;
  device.limits.maxTextureDimension2D=8192;device.limits.maxUniformBufferBindingSize=65536;
  const engine=new Engine({width:128,height:128,clientWidth:128,clientHeight:128},store,
    {backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}},{position:[0,0,3],target:[0,0,0]},null);
  const fixture=materialQuad(),model=parseGLTF(engine,fixture.doc,fixture.buffers);
  engine.camera.update(1,true);store.tick(false);
  const draws=[],context={...harness.context,camera:engine.camera,draw(){},descriptor:{...harness.context.descriptor,multisample:{count:1}},encoder:{beginRenderPass(){
    let pipeline;const groups=new Map();
    return {setPipeline(value){pipeline=value;groups.clear();},setBindGroup(index,group){groups.set(index,group);},setVertexBuffer(){},setIndexBuffer(){},
      drawIndexed(){draws.push({pipeline,groups:new Map(groups)});},draw(){},end(){}};
  }}};
  return {...harness,device,engine,model,draws,context,draw(){model.draw(context,'beauty',context.color,context.depth);},frame(){engine.frameGraph.prepare(context);engine.frameGraph.execute(context);}};
}

test('color into emit compiles a lit PBR surface and packed finite vec4 factors without resources',()=>{
  const value=nodeMaterial(graph(emit(color([0.2,0.4,0.6,0.8]))));
  assert.ok(value.factors instanceof Float32Array);assert.equal(value.factors.length%4,0);
  for(const n of [0.2,0.4,0.6,0.8])assert.ok(value.factors.includes(Math.fround(n)));
  assert.equal(value.textures?.length??0,0);assert.match(value.wgsl,/s\.base\s*=/);
  assert.match(value.wgsl,/s\.roughness\s*=\s*1(?:\.0)?\s*;/);assert.match(value.wgsl,/s\.metal\s*=\s*0(?:\.0)?\s*;/);
  assert.match(value.wgsl,/s\.emissive\s*=\s*vec3f\(0(?:\.0)?\)/);
  assert.equal(value.output,undefined,'emit uses the ordinary PBR lighting and output path');
});

test('the graph requires exactly one emit, including disconnected explicit roots',()=>{
  for(const invalid of [{nodes:[]},{nodes:[color()]},{nodes:[emit(),emit()]}])assert.throws(()=>nodeMaterial(invalid),/emit|graph/i);
  const value=color(),output=emit(value);assert.doesNotThrow(()=>nodeMaterial({nodes:[value,output]}));
});

test('graphs reject self-cycles and indirect cycles before compiling',()=>{
  const self={type:'mul',a:scalar(1),b:null};self.b=self;
  assert.throws(()=>nodeMaterial(graph(emit(self))),/cycl/i);
  const a={type:'add',a:color(),b:null},b={type:'mul',a, b:scalar(0.5)};a.b=b;
  assert.throws(()=>nodeMaterial(graph(emit(a))),/cycl/i);
});

test('disconnected invalid nodes and disconnected cycles cannot bypass validation',()=>{
  const cycle={type:'add',a:scalar(1),b:null};cycle.b=cycle;
  assert.throws(()=>nodeMaterial(graph(emit(),cycle)),/cycl/i);
  assert.throws(()=>nodeMaterial(graph(emit(),{type:'attribute',name:'CUSTOM_0'})),/node|attribute|unsupported/i);
});

test('the closed graph schema rejects arbitrary WGSL, custom attributes, and unknown fields',()=>{
  for(const node of [{type:'wgsl',source:'s.base=vec4f(1);'},{type:'attribute',name:'COLOR_1'},{type:'color',value:[1,1,1,1],wgsl:'discard;'},
    {type:'texture',texture:{view:{}},attribute:'CUSTOM_0'}])assert.throws(()=>nodeMaterial(graph(emit(),node)),/node|field|WGSL|attribute|unsupported/i);
  assert.throws(()=>nodeMaterial({...graph(),wgsl:'discard;'}),/graph|field|WGSL|unsupported/i);
});

test('constant nodes reject nonfinite or malformed scalar and color values',()=>{
  for(const value of [NaN,Infinity,-Infinity,1e39,'1',null])assert.throws(()=>nodeMaterial(graph(emit(),scalar(value))),/scalar|finite|value|number/i);
  for(const value of [[1,1,1],[1,1,1,1,1],Array(4),[1,NaN,1,1],[1,Infinity,1,1],'white',null])
    assert.throws(()=>nodeMaterial(graph(emit(color(value)))),/color|finite|value|vec4/i);
});

test('scalar and vector arithmetic compiles component-wise with shared references',()=>{
  const c=color([0.2,0.4,0.6,1]),half=scalar(0.5),product={type:'mul',a:c,b:half};
  const sum={type:'add',a:product,b:scalar(0.1)},mixed={type:'mix',a:sum,b:c,factor:half};
  const extension=nodeMaterial(graph(emit(mixed),c,half));
  assert.match(extension.wgsl,/mix\(/);assert.match(extension.wgsl,/\*/);assert.match(extension.wgsl,/\+/);
  assert.ok(extension.factors.every(Number.isFinite));
});

test('emit and material modifiers reject mismatched node output types',()=>{
  for(const output of [emit(scalar(1)),emit(color(),{normal:scalar(1)}),emit(color(),{metalRough:color()}),
    emit(color(),{clearcoat:scalar(1)}),emit(color(),{transmission:color()})])
    assert.throws(()=>nodeMaterial(graph(output)),/type|vec4|normal|metal|clearcoat|transmission|node/i);
  assert.throws(()=>nodeMaterial(graph(emit({type:'mul',a:color(),b:{type:'clearcoat',factor:scalar(1)}}))),/type|value|node|clearcoat/i);
});

test('texture nodes bind caller views and optional samplers with UV selection in the shader key',()=>{
  const view={},sampler={},sample={type:'texture',texture:{view,sampler},texCoord:0};
  const zero=nodeMaterial(graph(emit(sample))),one=nodeMaterial(graph(emit({...sample,texCoord:1})));
  assert.equal(zero.textures[0].view,view);assert.equal(zero.textures[0].sampler,sampler);
  assert.match(source(zero),/textureSample\(/);assert.notEqual(source(zero),source(one));
  const loaded=nodeMaterial(graph(emit({type:'texture',texture:{view},texCoord:1})));
  assert.equal(loaded.textures[0].sampler,undefined);assert.match(source(loaded),/textureLoad\(/);assert.doesNotMatch(source(loaded),/materialSampler/);
  for(const texCoord of [-1,2,0.5,'0'])assert.throws(()=>nodeMaterial(graph(emit({...sample,texCoord}))),/UV|coord|texture/i);
  assert.throws(()=>nodeMaterial(graph(emit({type:'texture',texture:{}}))),/texture|view/i);
});

test('normalMap and metalRough reuse the existing surface normal and PBR channels',()=>{
  const map={type:'texture',texture:{view:{}},texCoord:1};
  const extension=nodeMaterial(graph(emit(color(),{normal:{type:'normalMap',texture:map,scale:scalar(0.5),texCoord:1},
    metalRough:{type:'metalRough',texture:map,roughness:scalar(0.75),metal:scalar(0.25)}})));
  assert.match(extension.wgsl,/s\.n\s*=/);assert.match(extension.wgsl,/s\.roughness\s*=/);assert.match(extension.wgsl,/s\.metal\s*=/);
  assert.match(source(extension),/\.g\b/);assert.match(source(extension),/\.b\b/);
  assert.match(source(extension),/dpdx\(/);assert.match(source(extension),/dpdy\(/);
  assert.throws(()=>nodeMaterial(graph(emit(color(),{normal:{type:'normalMap',texture:scalar(1)}}))),/type|vec4|normal|texture/i);
});

test('clearcoat nodes compile the shared dielectric GGX lobe and retain factor-zero guards',()=>{
  const node={type:'clearcoat',factor:scalar(1),roughness:scalar(0.05)},extension=nodeMaterial(graph(emit(color(),{clearcoat:node})));
  const shared=source(clearcoat({factor:1,roughnessFactor:0.05}));
  for(const term of ['3.14159265','pow(1-vh,5.0)','4*nl*nv','0.04'])assert.ok(source(extension).includes(term)&&shared.includes(term));
  assert.match(extension.direct,/if\(/);assert.ok(extension.factors.includes(Math.fround(0.05)));
  assert.doesNotThrow(()=>nodeMaterial(graph(emit(color(),{clearcoat:{...node,factor:scalar(0)}}))));
});

test('transmission nodes require capture only for positive factors and share the screen-space path',()=>{
  const output=factor=>emit(color(),{transmission:{type:'transmission',factor:scalar(factor),ior:scalar(1)}});
  assert.doesNotThrow(()=>nodeMaterial(graph(output(0))));
  assert.throws(()=>nodeMaterial(graph(output(1))),/opaque|capture|color|view|transmission/i);
  const view={},extension=nodeMaterial(graph(output(1)),{opaqueColor:view}),shared=transmission({factor:1,ior:1,opaqueColor:view});
  assert.equal(extension.lighting,false);assert.ok(extension.textures.some(texture=>texture.view===view));
  for(const term of ['refract(','textureLoad(','materialTransmission'])assert.ok(source(extension).includes(term)&&source(shared).includes(term),term);
});

test('transmission arithmetic retains the capture when JavaScript and WGSL rounding disagree',()=>{
  // The graph's double-precision result is zero, while its uploaded f32 operands yield two.
  const factor={type:'add',a:scalar(16777218),b:{type:'mul',a:{type:'add',a:scalar(16777217),b:scalar(1)},b:scalar(-1)}};
  assert.equal(16777218+(16777217+1)*-1,0);
  assert.equal(Math.fround(Math.fround(16777218)+Math.fround(Math.fround(Math.fround(16777217)+1)*-1)),2);
  const value=graph(emit(color(),{transmission:{type:'transmission',factor,ior:scalar(1)}}));
  assert.throws(()=>nodeMaterial(value),/opaque|capture|color|view|transmission/i);
  const opaqueColor={},extension=nodeMaterial(value,{opaqueColor});
  assert.equal(extension.lighting,false);assert.ok(extension.textures.some(texture=>texture.view===opaqueColor));
  assert.ok(extension.factors.includes(16777216),'Uniform constants use their actual f32 value');
  assert.match(extension.output,/materialTransmission\(/);
});

test('transmission graph validates volume requirements and glTF-compatible attenuation values',()=>{
  const tx={type:'transmission',factor:scalar(0),volume:{thickness:scalar(1)}};
  assert.throws(()=>nodeMaterial(graph(emit(color(),{transmission:tx}))),/volume.*transmission|transmission.*volume/i);
  const view={};
  for(const attenuationDistance of [0,-1,NaN])assert.throws(()=>nodeMaterial(graph(emit(color(),{transmission:{...tx,factor:scalar(1),volume:{attenuationDistance}}})),{opaqueColor:view}),/distance|volume|attenuation/i);
});

test('compiled and baseline materials have isolated pipelines and mutable factor buffers',async()=>{
  const s=await scene();
  try{
    s.draw();const baseline=s.draws.at(-1);assert.equal(digest(baseline.pipeline.vertex.module.code),'1920d3bb180dbf0fa32fe4d373a3c03bdfccbdc834fb02a26fcb1b8dfeeffa5b');
    const extension=nodeMaterial(graph());s.model.primitives[0].extension=extension;s.draw();const extended=s.draws.at(-1);
    assert.notEqual(extended.pipeline,baseline.pipeline);assert.deepEqual([...baseline.groups.keys()],[0,1]);assert.ok(extended.groups.has(3));
    const count=s.pipelines.length;extension.factors[0]=0.75;s.draw();assert.equal(s.pipelines.length,count);
    const uniform=extended.groups.get(3).entries.find(entry=>entry.binding===0).resource.buffer;
    assert.equal(new Float32Array(uniform.data)[0],0.75);
    s.model.primitives[0].extension=nodeMaterial(graph(emit({type:'mul',a:color(),b:scalar(0.5)})));s.draw();assert.notEqual(s.draws.at(-1).pipeline,extended.pipeline);
    delete s.model.primitives[0].extension;s.draw();assert.equal(s.draws.at(-1).pipeline,baseline.pipeline);
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('node installation is synchronous, restores slots and blend mode, and releases capture on disposal',async()=>{
  const s=await scene();
  try{
    const primitive=s.model.primitives[0],previous={wgsl:'s.occlusion*=0.5;'};primitive.extension=previous;
    const before={...s.counts},installation=installNodeMaterial(s.model,graph());
    assert.ok(!(installation instanceof Promise));assert.equal(s.counts.textures,before.textures);assert.equal(primitive.material.settings[0],0);
    assert.notEqual(primitive.extension,previous);s.draw();installation.dispose();installation.dispose();assert.equal(primitive.extension,previous);
    const tx=installNodeMaterial(s.model,graph(emit(color(),{transmission:{type:'transmission',factor:scalar(1),ior:scalar(1)}})));
    assert.equal(primitive.material.settings[0],2);assert.equal(s.engine.hasPlugin('materials:opaque-color'),true);
    s.frame();tx.dispose();assert.equal(primitive.material.settings[0],0);assert.equal(primitive.extension,previous);assert.equal(s.engine.hasPlugin('materials:opaque-color'),false);
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('disposing a partially replaced graph preserves a shared material blend mode',async()=>{
  const s=await scene();
  try{
    const first=s.model.primitives[0],previous={wgsl:'s.occlusion*=0.5;'},second={...first,extension:previous};
    s.model.primitives.push(second);assert.equal(first.material,second.material);
    const installation=installNodeMaterial(s.model,graph(emit(color(),{transmission:{type:'transmission',factor:scalar(1),ior:scalar(1)}})));
    assert.equal(first.extension,second.extension);assert.equal(first.material.settings[0],2);
    const replacement={wgsl:'s.emissive+=vec3f(0.1);'};first.extension=replacement;installation.dispose();
    assert.equal(first.extension,replacement);assert.equal(second.extension,previous);
    assert.equal(first.material.settings[0],2,'A caller replacement still uses the same shared material');
    assert.equal(s.engine.hasPlugin('materials:opaque-color'),false);
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('model disposal cleans node installation but preserves caller-owned graph textures',async()=>{
  const s=await scene(),owned=s.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});
  try{
    const installation=installNodeMaterial(s.model,graph(emit({type:'texture',texture:{view:owned.createView()}})));s.draw();s.model.destroy();
    assert.equal(installation.disposed,true);assert.equal(owned.destroyed,false);
  }finally{s.engine.dispose();owned.destroy();}
});

test('invalid node installations leave existing material state and resource counts unchanged',async()=>{
  const s=await scene();
  try{
    const primitive=s.model.primitives[0],previous={};primitive.extension=previous;const before={...s.counts};
    assert.throws(()=>installNodeMaterial(s.model,graph(emit(),{type:'attribute',name:'CUSTOM_0'})),/node|attribute|unsupported/i);
    assert.equal(primitive.extension,previous);assert.equal(primitive.material.settings[0],0);
    assert.equal(s.counts.textures,before.textures);assert.equal(s.counts.buffers,before.buffers);
  }finally{s.engine.dispose();}
});
