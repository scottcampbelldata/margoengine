import test from 'node:test';
import assert from 'node:assert/strict';
import { AccumulatedShadows } from '../dist/accumulate.js';
import { ContactShadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { rasterContains } from './raster-reference.mjs';

test('independent raster oracle applies specified coordinate snapping and top-left ties', () => {
  assert(rasterContains(1.5,1.5,1.5001,1.5001,2.5001,2.5001),'a left/top edge rounds onto the sample');
  assert(!rasterContains(2.5,2.5,1.5001,1.5001,2.5001,2.5001),'a right/bottom edge on the sample is excluded');
  assert(!rasterContains(1.5,1.5,1.503,1.503,2.503,2.503),'an edge beyond one subpixel does not cover the sample');
});

const identity = () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
test('contact and accumulated effects keep distinct frame-graph registrations', () => {
  const h = optionalGPU();
  const contact = ContactShadows.attach(h.engine, {resolution:16});
  const accumulated = AccumulatedShadows.attach(h.engine, {resolution:16,frames:1});
  h.context.camera.position = [0,5,4];
  try {
    h.engine.frameGraph.execute(h.context);
    assert.equal(contact.stats.updates,1);
    assert.equal(accumulated.samples,1);
    accumulated.dispose();
    h.engine.frameGraph.execute(h.context);
    assert.equal(contact.stats.updates,2,'removing accumulation leaves contact rendering');
  } finally { accumulated.dispose(); contact.dispose(); }
});
function scene(options = {}) {
  const h = optionalGPU(), engine = h.engine;
  const value = AccumulatedShadows.attach(engine, {resolution: 16, ...options});
  const node = {id: 0,engine,matrix:identity(),check(){}};
  const vertex = engine.gpu.createBuffer({size: 72,usage:GPUBufferUsage.VERTEX});
  const index = engine.gpu.createBuffer({size:12,usage:GPUBufferUsage.INDEX});
  const remove = value.add({shadowPrimitives:[{node,vertex,index,count:3,stride:24}]});
  h.context.camera.position = [0,5,4];
  const frame = () => engine.frameGraph.execute(h.context);
  return {h,engine,value,node,vertex,index,remove,frame};
}

test('accumulation uses binary visibility, a point-light projection and one sample per frame, then holds', () => {
  const s = scene({frames:3,lightRadius:0});
  try {
    s.frame();
    assert.equal(s.value.samples,1);
    const buffer = s.h.resources.find(r => r.size === 144 && r.data);
    const m = new Float32Array(buffer.data,0,16), p = [1,1,0,1];
    const clip = [0,1,2,3].map(r => p.reduce((sum,v,k) => sum + v*m[k*4+r],0));
    assert(Math.abs(clip[0]/clip[3]-4/7) < 1e-7, 'ray from (0,8,0) through (1,1,0) meets floor at x=8/7');
    assert(s.h.pipelines.some(p => p.vertex.buffers && p.vertex.module.code.includes('vec4f(1,0,0,1)')));
    s.frame(); s.frame();
    assert.equal(s.value.samples,3);
    const draws = s.h.counts.draws;
    s.frame();
    assert.equal(s.value.samples,3);
    assert.equal(s.h.counts.draws-draws,1,'only the receiver draws after convergence');
    assert.equal(s.value.stats.updates,3);
    assert.equal(s.value.stats.cacheHits,1);
    const plane = new Float32Array(s.h.resources.find(r => r.size === 112).data);
    assert(Math.abs(plane[26]-1/3) < 1e-7,'sum divided once at receiver');
    s.value.invalidate(); s.frame();
    assert.equal(s.value.samples,1);
    s.node.matrix[12] = 0.5; s.frame();
    assert.equal(s.value.samples,1,'moving a caster clears old history');
    s.value.options.lightRadius = 1; s.frame();
    assert.equal(s.value.samples,1,'changing a light clears old history');
    s.remove(); s.frame();
    assert.equal(s.value.samples,1,'removing a caster clears old history');
    s.value.onDeviceRestored(s.engine); s.frame();
    assert.equal(s.value.samples,1,'replacement resources start fresh');
  } finally { s.value.dispose(); s.value.dispose(); }
  assert(s.h.resources.filter(r => r !== s.vertex && r !== s.index).every(r => r.destroyed));
});

test('invalid, hostile and extreme settings reject before any GPU allocation', () => {
  for (const options of [
    null,[],
    {frames:0},{frames:1025},{frames:NaN},{frames:Infinity},{frames:1.5},
    {lightRadius:-1},{lightRadius:NaN},{lightRadius:1e7},
    {lightPosition:[]},{lightPosition:[0,1,0]},{lightPosition:[0,NaN,0]},
    {lightPosition:[0,8,,]},
    {lightPosition:[0,1e7,0]},{size:1e100},{height:1e-100},
    {blur:1},{static:true},{position:[1e100,0,0]},
  ]) assert.throws(() => new AccumulatedShadows(options), RangeError, JSON.stringify(options));
  for (const options of [{frames:1,lightRadius:0},{frames:1024,size:1e6},{size:1e-6,height:1e-6}]) {
    const s = new AccumulatedShadows(options); s.dispose();
  }
  const s = scene();
  try {
    s.value.options.frames=NaN;
    assert.throws(s.frame, RangeError, 'live settings are checked each frame');
  } finally { s.value.dispose(); }
});

test('native WebGL2 refuses explicitly with a code and help link', () => {
  const s = new AccumulatedShadows();
  assert.throws(() => s.setup({gpu:null}), error => error.code==='unsupported' && /https:\/\/margoengine.com\/errors#/.test(error.message));
  s.dispose();
});

test('disposal removes the owning scene, without removing a same-name plugin in another scene', () => {
  const s = scene();
  let removed;
  s.engine.sceneOf = value => {
    assert.equal(value,s.value);
    return {removePlugin(name){removed=name;}};
  };
  s.engine.removePlugin = () => assert.fail('the default scene is not the owner');
  s.value.dispose();
  assert.equal(removed,'accumulated-shadows');
});
