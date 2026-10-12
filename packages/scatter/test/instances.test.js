import test from 'node:test';
import assert from 'node:assert/strict';
import {PbrMaterial} from '@margoengine/core';
import {ScatterInstances} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {wgsl} from '../../core/src/shaders.ts';

function batch() {
  const vertices = new Float32Array(60);
  vertices[3] = vertices[23] = vertices[43] = 1;
  vertices[20] = vertices[41] = 1;
  for (let i = 0; i < 3; i++) {vertices[i*20+6] = 1; vertices[i*20+8] = 1; vertices[i*20+11] = 1; vertices.fill(1,i*20+16,i*20+20);}
  return {name: 'cedar', vertices, indices: new Uint32Array([0,1,2]), transforms: new Float32Array([2,0,0,0,0,2,0,0,0,0,2,0,3,4,5,1]), material: new PbrMaterial({color:[0.38,0.28,0.2],roughness:0.85})};
}

test('fixed PBR scatter uploads once, uses flat transforms and indirect draws in all four shadow cascades', () => {
  const h = optionalGPU(); h.engine.lighting = {direction:new Float32Array([-1,0.1,0,1]),radiance:new Float32Array([1,0.8,0.54,0.18])};
  let generated = 0;
  const scatter = new ScatterInstances(()=>{generated++; return [batch()];}); h.engine.use(scatter); h.frame();
  const created = {...h.counts}, array = scatter.batches;
  for (let i = 0; i < 600; i++) h.frame();
  assert.equal(generated,1); assert.equal(h.counts.buffers,created.buffers); assert.equal(h.counts.groups,created.groups);
  assert.equal(scatter.batches,array); assert.deepEqual(scatter.batches,[{name:'cedar',vertices:3,indices:3,instances:1}]);
  const instance = h.resources.find(r=>r.size===128&&r.usage===40), values = new Float32Array(instance.data);
  assert.deepEqual(Array.from(values.subarray(12,16)),[3,4,5,1]); assert.equal(values[20],Math.fround(0.85));
  assert.equal(values[23],-1,'Fixed instances must not inherit a core mesh ID');
  const pass = h.context.encoder.beginRenderPass({}), indirect = h.counts.indirect;
  for (let cascade = 0; cascade < 4; cascade++) scatter.drawShadow({context:h.context,pass,matrix:h.context.camera.matrix,cascade});
  assert.equal(h.counts.indirect-indirect,4);
  scatter.onDeviceRestored(h.engine); assert.equal(generated,2); h.frame();
  scatter.dispose(); assert.ok(h.resources.every(r=>r.destroyed));
});

test('fixed PBR scatter multiplies baked vertex occlusion without replacing shadow lighting', () => {
  const h = optionalGPU(); h.engine.lighting = {direction:new Float32Array([-1,0.13,0,1]),radiance:new Float32Array([1,0.8,0.54,0.18])};
  h.context.shader = wgsl.replace('let linear=direct*','let linear=direct*0.75*');
  h.context.bindings = [{binding:1,resource:{buffer:{}}}];
  const b = batch(); b.vertices.fill(0.25,16,19);
  const scatter = new ScatterInstances(()=>[b]); h.engine.use(scatter); h.engine.frameGraph.execute(h.context);
  const render = h.pipelines.find(p=>p.fragment), code = render.vertex.module.code;
  assert.match(code,/@location\(8\) vertexColor:vec4f/); assert.match(code,/o.color=i.color.rgb\*i.vertexColor.rgb;/);
  assert.match(code,/let linear=direct\*0\.75\*/);
  assert.deepEqual(render.vertex.buffers[0].attributes[2],{shaderLocation:8,offset:64,format:'float32x4'});
  const vertex = h.resources.find(r=>r.size===240);
  assert.deepEqual(Array.from(new Float32Array(vertex.data).subarray(16,20)),[0.25,0.25,0.25,1]);
  assert.ok(h.groups.some(g=>g.entries.some(e=>e.resource===h.context.bindings[0].resource)));
  const created = {...h.counts}; for (let i = 0; i < 600; i++) h.engine.frameGraph.execute(h.context);
  assert.equal(h.counts.buffers,created.buffers); assert.equal(h.counts.groups,created.groups); scatter.dispose();
});

test('fixed scatter rejects malformed geometry/transforms and rolls back partial GPU uploads', () => {
  for (const mutate of [b=>b.vertices[0]=NaN,b=>b.indices[2]=3,b=>b.transforms[15]=0,b=>b.transforms[0]=0,b=>b.transforms=new Float32Array(17),b=>b.emissive=[-1,0,0],b=>b.emissive=[NaN,0,0],b=>b.emissive=[1,,0],b=>b.emissive=[1,2],b=>b.emissive=[1e40,0,0]]) {
    const h = optionalGPU(), bad = batch(); mutate(bad);
    assert.throws(()=>h.engine.use(new ScatterInstances(()=>[batch(),bad])),/batch|transforms|emission/);
    assert.ok(h.resources.every(r=>r.destroyed));
  }
});

test('HDR batch emission survives occlusion, direct shadows and device restoration',()=>{
  const h=optionalGPU();h.engine.lighting={direction:new Float32Array([0,1,0,0.6]),radiance:new Float32Array([0.25,0.45,0.75,0.09])};
  h.context.shader=wgsl.replace('let linear=direct*','let linear=direct*0.25*');
  const b=batch();b.emissive=[3,2.16,0.9];b.vertices.fill(0.2,16,19);
  const scatter=new ScatterInstances(()=>[b,batch()]);h.engine.use(scatter);h.engine.frameGraph.execute(h.context);
  const uploads=()=>h.resources.filter(r=>!r.destroyed&&r.size===128&&r.usage===40);
  assert.deepEqual(Array.from(new Float32Array(uploads()[0].data).subarray(24,27)),b.emissive.map(Math.fround));
  assert.deepEqual(Array.from(new Float32Array(uploads()[1].data).subarray(24,27)),[0,0,0]);
  const render=h.pipelines.find(p=>p.fragment),code=render.vertex.module.code;
  assert.match(code,/let linear=direct\*0\.25\*[^;]+\+i.emissive;/);
  assert.match(code,/o.emissive=i.emissive/);assert.match(code,/@location\(4\) emissive:vec3f/);
  assert.equal(render.vertex.buffers[1].arrayStride,128);
  scatter.onDeviceRestored(h.engine);assert.deepEqual(Array.from(new Float32Array(uploads()[0].data).subarray(24,27)),b.emissive.map(Math.fround));
  scatter.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});

test('wind uploads a single clock to the color pass and every shadow cascade, with bounded validation',()=>{
  const h=optionalGPU();h.engine.lighting={direction:new Float32Array([0,1,0,1]),radiance:new Float32Array([1,1,1,0.1])};
  const b=batch();b.wind=[1,0.35,0.1];const scatter=new ScatterInstances(()=>[b]);h.engine.use(scatter);h.frame();
  const instance=h.resources.find(r=>r.size===128&&r.usage===40);
  assert.deepEqual(Array.from(new Float32Array(instance.data).subarray(28,31)),[1/Math.hypot(1,0.35),0.35/Math.hypot(1,0.35),0.1].map(Math.fround));
  const uniform=h.resources.find(r=>r.size===128&&r.usage===72),time=new Float32Array(uniform.data)[28];assert.ok(time>0);
  const pass=h.context.encoder.beginRenderPass({});for(let cascade=0;cascade<4;cascade++)scatter.drawShadow({context:h.context,pass,matrix:h.context.camera.matrix,cascade});
  for(const shadow of h.resources.filter(r=>r.size===80))assert.equal(new Float32Array(shadow.data)[16],time);
  for(const delta of [-1,NaN,Infinity])assert.throws(()=>scatter.onPreUpdate(delta),/delta/);
  scatter.dispose();
  for(const wind of [[0,0,0.1],[1,0,-1],[1,0,1.1],[1,0,NaN],[1e40,0,0.1],[1e-50,0,0.1]]){const bad=batch();bad.wind=wind;assert.throws(()=>new ScatterInstances(()=>[bad]).setup(h.engine),/wind/);}
});
