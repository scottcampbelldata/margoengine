import test from 'node:test';
import assert from 'node:assert/strict';
import { AccumulatedShadows } from '../dist/accumulate.js';
import { ContactShadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { pbrNeutral } from '../../shared/display.js';
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
    const plane = new Float32Array(s.h.resources.find(r => r.size === 160).data);
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
    {frames:0},{frames:1025},{frames:NaN},{frames:-Infinity},{frames:1.5},
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

// drei's AccumulativeShadows renders every frame at once by default (temporal false). Each sample's caster uniforms and
// sum state go through queue.writeBuffer, so samples encoded into one encoder would all read the last values: every
// sample but the last runs in its own encoder, submitted before the next sample's values are written.
test('temporal false takes every sample in the first frame, one submitted encoder per sample but the last', () => {
  const s = scene({frames:4,lightRadius:1,temporal:false}), log = [];
  const gpu = s.engine.gpu, write = gpu.queue.writeBuffer, submit = gpu.queue.submit, encoder = gpu.createCommandEncoder;
  gpu.queue.writeBuffer = (b, ...rest) => {
    if (b.size === 144) log.push('caster');
    if (b.size === 80) log.push('state ' + new Float32Array(rest[1].buffer ?? rest[1])[0]);
    return write(b, ...rest);
  };
  gpu.queue.submit = (list) => { log.push('submit'); return submit(list); };
  gpu.createCommandEncoder = (...a) => { log.push('encoder'); return encoder(...a); };
  try {
    s.frame();
    assert.equal(s.value.samples, 4, 'all four samples in one frame');
    assert.deepEqual(log, [
      'encoder','caster','state 0','submit',
      'encoder','caster','state 1','submit',
      'encoder','caster','state 2','submit',
      'caster','state 3',
    ]);
    log.length = 0; s.frame();
    assert.equal(s.value.samples, 4);
    assert.deepEqual(log, [], 'then it holds');
    s.value.options.temporal = true; s.value.invalidate(); s.frame();
    assert.equal(s.value.samples, 1, 'temporal true: one sample a frame, as before');
  } finally { gpu.queue.writeBuffer = write; gpu.queue.submit = submit; gpu.createCommandEncoder = encoder; s.value.dispose(); }
});

// drei's frames={Infinity} keeps a moving average of `blend` frames that follows moving casters without a reset.
test('blend weighs sample n by 1 / min(n + 1, blend), keeps history through caster motion and stops at frames', () => {
  const s = scene({frames:Infinity,blend:3,lightRadius:1}), weights = [];
  const gpu = s.engine.gpu, write = gpu.queue.writeBuffer;
  gpu.queue.writeBuffer = (b, ...rest) => {
    if (b.size === 80) weights.push(new Float32Array(rest[1].buffer ?? rest[1])[1]);
    return write(b, ...rest);
  };
  try {
    for (let i = 0; i < 5; i++) s.frame();
    assert.deepEqual(weights.map(Math.fround), [1, 1/2, 1/3, 1/3, 1/3].map(Math.fround));
    assert.equal(s.value.samples, 5);
    const plane = new Float32Array(s.h.resources.find(r => r.size === 160).data);
    assert.equal(plane[26], 1, 'the history already holds the average');
    assert(s.h.pipelines.some(p => p.fragment?.module.code.includes('mix(old,value,state.count.y)')));
    s.node.matrix[12] = 0.5; s.frame();
    assert.equal(s.value.samples, 6, 'a moving caster blends in, no reset');
    s.value.options.lightRadius = 2; s.frame();
    assert.equal(s.value.samples, 1, 'a light change restarts');
    s.value.options.frames = 2; s.frame(); s.frame();
    assert.equal(s.value.samples, 2, 'frames caps a blend too (drei limit)');
  } finally { gpu.queue.writeBuffer = write; s.value.dispose(); }
  for (const options of [{frames:Infinity},{blend:0},{blend:1.5},{blend:NaN},{temporal:1}])
    assert.throws(() => new AccumulatedShadows(options), RangeError, JSON.stringify(options));
});

// drei counts rendered frames, each taking every light's `amount` samples: `samples` takes that many per frame.
test('samples takes that many light samples per rendered frame, one submitted encoder each but the last', () => {
  const s = scene({frames:6,samples:3,lightRadius:1,temporal:true}), log = [];
  const gpu = s.engine.gpu, submit = gpu.queue.submit;
  gpu.queue.submit = (list) => { log.push('submit'); return submit(list); };
  try {
    s.frame();
    assert.equal(s.value.samples, 3, 'three samples in the first frame');
    assert.equal(log.length, 2, 'two submitted encoders, the third on the frame encoder');
    s.frame();
    assert.equal(s.value.samples, 6, 'frames 6 done in two rendered frames');
    s.frame();
    assert.equal(s.value.samples, 6, 'then it holds');
    assert.throws(() => { s.value.options.samples = 0; s.frame(); }, RangeError);
  } finally { gpu.queue.submit = submit; s.value.options.samples = 1; s.value.dispose(); }
});

// drei's alphaTest: a caster fragment below it casts nothing, on top of the caster's own cut-out.
test('alphaTest raises every caster cut-out to at least its value', () => {
  const s = scene({frames:2,lightRadius:1,alphaTest:0.65}), cutoffs = [];
  const gpu = s.engine.gpu, write = gpu.queue.writeBuffer;
  gpu.queue.writeBuffer = (b, ...rest) => {
    if (b.size === 144) cutoffs.push(new Float32Array(rest[1].buffer ?? rest[1])[33]);
    return write(b, ...rest);
  };
  try {
    s.frame();
    assert.deepEqual(cutoffs.map(Math.fround), [Math.fround(0.65)]);
    s.value.options.alphaTest = 0; s.value.invalidate(); s.frame();
    assert.equal(cutoffs.at(-1), 0);
    assert.throws(() => { s.value.options.alphaTest = 1.5; s.frame(); }, RangeError);
  } finally { gpu.queue.writeBuffer = write; s.value.options.alphaTest = 0; s.value.dispose(); }
});

// The plane writes its colour as core writes a surface: scaled by colorBlend, tone mapped (or clamped), sRGB encoded.
test('toneMapped and colorBlend shape the plane colour', () => {
  const h = optionalGPU(), contact = ContactShadows.attach(h.engine, {resolution:16,color:[2,0.5,-1]});
  h.context.camera.position = [0,5,4];
  try {
    h.engine.frameGraph.execute(h.context);
    const plane = () => new Float32Array(h.resources.find(r => r.size === 160).data);
    assert.deepEqual([...plane().slice(16,19)], [1,0.5,0], 'clamped to 0..1 by default');
    contact.options.colorBlend = 0.5;
    h.engine.frameGraph.execute(h.context);
    assert.deepEqual([...plane().slice(16,19)], [1,0.25,0], 'colorBlend scales the colour first');
    contact.options.toneMapped = true; contact.options.colorBlend = 2;
    h.engine.frameGraph.execute(h.context);
    const neutral = pbrNeutral([4, 1, 0]);
    assert.deepEqual([...plane().slice(16,19)], neutral.map(Math.fround), 'PBR Neutral of the doubled colour');
    assert(h.pipelines.some(p => p.fragment?.module.code.includes('1.055*pow(c,vec3f(1.0/2.4))')), 'sRGB encoded');
    for (const bad of [{toneMapped:1},{colorBlend:-1},{colorBlend:NaN}])
      assert.throws(() => new ContactShadows(bad), RangeError);
  } finally { contact.dispose(); }
});
