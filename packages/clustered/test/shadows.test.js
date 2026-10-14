import test from 'node:test';
import assert from 'node:assert/strict';
import {Clustered,clusteredSampling} from '../dist/index.js';
import {LocalShadows} from '../dist/shadows.js';
import {wgsl} from '../../core/src/shaders.ts';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

function harness() {
  const h=optionalGPU(),gpu=h.engine.gpu,passes=[];
  globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};globalThis.GPUTextureUsage={...globalThis.GPUTextureUsage,COPY_DST:2,TEXTURE_BINDING:4,RENDER_ATTACHMENT:16};
  gpu.limits.maxTextureDimension2D=8192;gpu.createBindGroupLayout=d=>({...d});gpu.createPipelineLayout=d=>({...d});
  const begin=h.context.encoder.beginRenderPass,drawn=[];
  h.context.encoder.beginRenderPass=d=>{const pass=begin(d),layer=d.depthStencilAttachment.view;passes.push(layer);return {...pass,drawIndexed(count,instances=1){drawn.push([layer,count,instances]);pass.drawIndexed();}};};
  const frame=()=>{passes.length=drawn.length=0;h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
  return {...h,passes,drawn,frame};
}
const node=(engine,id=0)=>({id,engine,matrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),check(){}});
const caster=(engine,extra={})=>({shadowPrimitives:[{node:node(engine),vertex:{},index:{},count:36,stride:80,...extra}]});

test('local shadows: clustered shaders and bindings are unchanged until attached, and restored on dispose',()=>{
  const h=harness(),lights=new Clustered({grid:[2,2,2]});lights.setLights([{position:[0,2,0],range:6}]);h.engine.use(lights);
  h.frame();const plain=h.context.shader,plainBindings=lights.bindings(),hooks=lights.pbr(2);
  assert.ok(!plain.includes('clusterShadow'));assert.equal(clusteredSampling(0),clusteredSampling(0,undefined));
  const shadows=LocalShadows.attach(h.engine,{lights});h.frame();
  assert.match(h.context.shader,/falloff\*cone\*clusterShadow\(light,position,n\);/);assert.match(h.context.shader,/@group\(0\) @binding\(14\) var<uniform> localShadowFrame/);
  assert.deepEqual(lights.bindings().map(e=>e.binding),[4,5,6,7,14,15,16]);assert.equal(lights.bindings(),lights.bindings(),'stable joined bindings');
  const lit=lights.pbr(2);assert.notEqual(lit,hooks);assert.match(lit.declarations,/@group\(2\) @binding\(15\) var localShadowMap:texture_depth_2d_array;/);
  shadows.dispose();h.frame();assert.equal(h.context.shader,plain);assert.equal(lights.bindings(),plainBindings);assert.equal(lights.shadow,undefined);
  lights.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('local shadows: castShadow lights get dense 1-based ordinals in params.z',()=>{
  const lights=new Clustered({grid:[2,2,2]}),data=lights['data'];
  lights.setLights([{position:[0,0,0],range:1,castShadow:true},{position:[0,0,0],range:1},{position:[0,0,0],range:1,direction:[0,-1,0],outerAngle:0.5,castShadow:true}]);
  assert.deepEqual([data[14],data[30],data[46]],[1,0,2]);assert.deepEqual([...data.subarray(40,48)].map(v=>+v.toFixed(4)),[0,-1,0,+Math.cos(0.5).toFixed(4),1,1,2,0]);
  lights.setLights([{position:[0,0,0],range:1}]);assert.equal(data[14],0);
});

test('local shadows: point lights use six layers, spot lights one; maps re-render only for what changed',()=>{
  const h=harness(),lights=Clustered.attach(h.engine,{grid:[2,2,2]}),shadows=LocalShadows.attach(h.engine,{lights,maxLights:2,resolution:64});
  const point={position:[0,3,0],range:10,castShadow:true},spot={position:[4,3,0],range:10,direction:[0,-1,0],outerAngle:0.6,castShadow:true};
  const third={position:[-4,3,0],range:10,castShadow:true},box=caster(h.engine);
  lights.setLights([point,spot,third]);shadows.add(box);
  h.frame();assert.equal(h.passes.length,7,'6 cube faces + 1 spot; the third light is over budget');assert.equal(new Set(h.passes).size,7);
  assert.equal(h.drawn.length,7);
  const frameData=new Float32Array(shadows.bindings()[0].resource.buffer.data);assert.deepEqual([...frameData.subarray(0,4)].map(v=>+v.toFixed(4)),[2,1,1.5,+(1/64).toFixed(4)]);
  assert.deepEqual([...frameData.subarray(4,7)],[0,1,frameData[6]]);assert.deepEqual([...frameData.subarray(8,10)],[6,0]);
  h.frame();assert.equal(h.passes.length,0);assert.equal(shadows.stats.cacheHits,1);
  lights.setLights([point,{...spot,position:[4,3,1]},third]);h.frame();assert.equal(h.passes.length,1,'only the moved spot light');
  box.shadowPrimitives[0].node.matrix[13]=1;h.frame();assert.equal(h.passes.length,7,'a moved caster re-renders every map');
  h.frame();assert.equal(h.passes.length,0);
  const animated=caster(h.engine,{index:{}}),remove=shadows.add(animated,{dynamic:true});h.frame();assert.equal(h.passes.length,7);assert.equal(h.drawn.length,14);
  h.frame();assert.equal(h.passes.length,7,'dynamic casters re-render every frame');remove();h.frame();assert.equal(h.passes.length,7);h.frame();assert.equal(h.passes.length,0);
  h.engine.store.hidden[0]=1;h.frame();assert.equal(h.passes.length,7);assert.equal(h.drawn.length,0,'hidden casters are skipped');h.engine.store.hidden[0]=0;h.frame();assert.equal(h.drawn.length,7);
  lights.setLights([{...spot,castShadow:false},point]);h.frame();assert.equal(h.passes.length,0,'the point light keeps slot 0 and its maps');
  shadows.dispose();lights.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('local shadows: instanced and masked casters choose their pipelines; instance edits re-render',()=>{
  const h=harness(),lights=Clustered.attach(h.engine,{grid:[2,2,2]}),shadows=LocalShadows.attach(h.engine,{lights,resolution:32});
  let pending=false;const instances={count:5,get needsUpdate(){return pending;},upload(){pending=false;return {};}};
  shadows.add(caster(h.engine,{instances,alphaTexture:{},cutoff:0.5}));lights.setLights([{position:[0,2,0],range:5,direction:[0,-1,0],outerAngle:0.4,castShadow:true}]);
  h.frame();assert.deepEqual(h.drawn.map(d=>d.slice(1)),[[36,5]]);
  const pipeline=h.pipelines.at(-1);assert.match(pipeline.vertex.module.code,/@location\(5\) m0:vec4f/);assert.equal(pipeline.fragment.entryPoint,'fragment');assert.equal(pipeline.depthStencil.depthCompare,'greater');
  h.frame();assert.equal(h.passes.length,0);pending=true;h.frame();assert.equal(h.passes.length,1);instances.count=3;h.frame();assert.deepEqual(h.drawn.map(d=>d.slice(1)),[[36,3]]);
  shadows.add(caster(h.engine,{index:{},stride:24}));h.frame();assert.equal(h.pipelines.at(-1).fragment,undefined,'opaque casters draw depth only');
  shadows.dispose();lights.dispose();
});

test('local shadows: light matrices put the light frustum in reversed depth and pick the right cube face',()=>{
  const h=harness(),lights=Clustered.attach(h.engine,{grid:[2,2,2]}),shadows=LocalShadows.attach(h.engine,{lights,resolution:64});
  lights.setLights([{position:[1,2,3],range:8,castShadow:true},{position:[0,5,0],range:10,direction:[0.2,-1,0],outerAngle:0.5,castShadow:true}]);h.frame();
  const v=new Float32Array(shadows.bindings()[0].resource.buffer.data),matrix=l=>v.subarray(4+64+l*16,4+64+l*16+16);
  const project=(m,p)=>{const c=[0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);return [c[0]/c[3]*0.5+0.5,0.5-c[1]/c[3]*0.5,c[2]/c[3],c[3]];};
  const faces=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  faces.forEach((axis,face)=>{
    const near=project(matrix(face),axis.map((a,k)=>[1,2,3][k]+a*0.008)),far=project(matrix(face),axis.map((a,k)=>[1,2,3][k]+a*8)),off=project(matrix(face),axis.map((a,k)=>[1,2,3][k]+a*4+(k===(face<2?1:0)?3.9:0)));
    assert.ok(Math.abs(near[2]-1)<1e-3&&Math.abs(far[2])<1e-4,`face ${face} depth`);assert.ok(Math.abs(near[0]-0.5)<1e-4&&Math.abs(near[1]-0.5)<1e-4);
    assert.ok(off[0]>0&&off[0]<1&&off[1]>0&&off[1]<1,`face ${face} covers 45 degrees off axis`);
  });
  const length=Math.hypot(0.2,-1),dir=[0.2/length,-1/length,0],spot=project(matrix(6),[dir[0]*5,5+dir[1]*5,0]);
  assert.ok(Math.abs(spot[0]-0.5)<1e-4&&Math.abs(spot[1]-0.5)<1e-4&&spot[2]>0&&spot[2]<1);
  assert.deepEqual([...v.subarray(8,11)],[6,0,v[10]]);assert.ok(Math.abs(v[10]-2*Math.tan(0.5)*64/60/64)<1e-6,'texel size per unit distance');
  shadows.dispose();lights.dispose();
});

test('local shadows: options are validated',()=>{
  const lights=new Clustered();
  assert.throws(()=>new LocalShadows({}),/Clustered/);
  for(const bad of [{maxLights:0},{maxLights:17},{resolution:8},{bias:-1},{normalBias:Number.NaN}])assert.throws(()=>new LocalShadows({lights,...bad}),RangeError);
  const shadows=new LocalShadows({lights});assert.throws(()=>shadows.bindings(),/not attached/);shadows[Symbol.dispose]();assert.throws(()=>shadows.add(caster({})),TypeError);
});
