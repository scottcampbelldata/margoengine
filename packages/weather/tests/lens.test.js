import test from 'node:test';
import assert from 'node:assert/strict';
import { LensDrops, lensField, lensWGSL } from '../dist/lens.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('attach owns the HDR stack and detaches both registrations on disposal', async () => {
  const gpu = optionalGPU();
  const engine = new Engine({ width: 8, height: 8 }, await TransformStore.create(16),
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} }, undefined, null);
  try {
    const lens = await LensDrops.attach(engine, { wetness: 0.4 });
    assert.equal(engine.hasPlugin('post:stack'), true);
    assert.equal(engine.hasPlugin(lens.name), true);
    lens[Symbol.dispose]();
    lens.dispose();
    assert.equal(engine.hasPlugin('post:stack'), false);
    assert.equal(engine.hasPlugin(lens.name), false);
    await assert.rejects(LensDrops.attach(engine, {}, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(engine.hasPlugin('post:stack'), false);
  } finally { engine.dispose(); gpu.cleanup(); }
});

test('the lens field is finite, deterministic, dry at zero wetness, and changes with seed and travel',()=>{
 let drops=0,streaks=0,moved=0,seeded=0;
 for(let y=0;y<1;y+=0.017)for(let x=0;x<1.5;x+=0.023){
  const a=lensField(x,y,2,{wetness:1});
  assert.deepEqual(a,lensField(x,y,2,{wetness:1}));
  assert.ok(a.every(Number.isFinite));assert.ok(a[2]>=0&&a[2]<=1);
  assert.deepEqual(lensField(x,y,2,{wetness:0}),[0,0,0]);
  if(a[2]>0.1)drops++;
  if(a[2]!==lensField(x,y,2,{wetness:1,streaks:0})[2])streaks++;
  if(a[2]!==lensField(x,y,3,{wetness:1})[2])moved++;
  if(a[2]!==lensField(x,y,2,{wetness:1,seed:4})[2])seeded++;
 }
 assert.ok(drops>100&&streaks>50&&moved>100&&seeded>100);
 assert.match(lensWGSL,/fn lens_field/);
});

test('sources and enablement control the field, with validated settings',()=>{
 assert.deepEqual(lensField(0.1,0.2,3,{enabled:false}),[0,0,0]);
 assert.deepEqual(lensField(0.1,0.2,3,{weather:{wetness:0},wetness:1}),[0,0,0]);
 for(const options of [null,{radius:0},{speed:-1},{wetness:2},{seed:0.5},{time:Infinity},{enabled:1},{weather:null},{weather:{wetness:NaN}}])
  assert.throws(()=>new LensDrops(options));
 assert.throws(()=>lensField(Infinity,0,0),RangeError);
 assert.throws(()=>new LensDrops().onPreUpdate(-1),RangeError);
});

test('PostStack owns joining, restoration and disposal',()=>{
 const effect=new LensDrops();
 assert.throws(()=>effect.setup({}),{code:'state'});
 const stage=effect.joinStack({});assert.equal(stage.kind,'hdr');
 assert.throws(()=>effect.joinStack({}),{code:'attached'});
 let freed=0;
 const engine={gpu:{createBuffer:()=>({destroy(){freed++;}}),createSampler:()=>({})},sceneOf(){return {removePlugin(){}};}};
 effect.setup(engine);effect.onDeviceRestored(engine);assert.equal(freed,1);
 effect.dispose();effect.dispose();assert.equal(freed,2);
 assert.throws(()=>effect.onPreUpdate(0),{code:'disposed'});
});
