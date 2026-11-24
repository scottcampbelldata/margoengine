import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { repairRoad } from '../dist/repair.js';
const curve=()=>new Spline([[-2,0,-8],[-2,0,8],[0,0,9],[2,0,8],[2,0,-8]]);
test('spline repair samples a hairpin and preserves a closed courtyard hole',async()=>{
  const result=await repairRoad(curve(),{width:8});assert.ok(result.area>100);
  assert.ok(result.geometry.indices.length>0);
  const loop=new Spline([[-10,3,-10],[10,3,-10],[10,3,10],[-10,3,10]],{closed:true});
  const closed=await repairRoad(loop,{width:2});
  assert.ok(closed.area>100 && closed.area<300);
  for(let i=1;i<closed.geometry.vertices.length;i+=6)assert.equal(closed.geometry.vertices[i],3);
});
test('repair rejects hostile settings and grades, snapshots before loading and checks cancellation',async()=>{
  for(const options of [{width:0},{width:NaN},{width:1e20},{segments:0},{segments:4096},{segments:NaN},{uvMeters:0}])await assert.rejects(repairRoad(curve(),options));
  await assert.rejects(repairRoad(new Spline([[0,0,0],[0,1,10]])),e=>e.code==='unsupported'&&/https:/.test(e.message));
  await assert.rejects(repairRoad(curve(),{signal:AbortSignal.abort()}),{name:'AbortError'});
  const c=new AbortController(),p=repairRoad(curve(),{signal:c.signal});c.abort();await assert.rejects(p,{name:'AbortError'});
  const spline=curve(),pending=repairRoad(spline,{width:8});spline.points.fill(99);
  assert.deepEqual((await pending).geometry.vertices,(await repairRoad(curve(),{width:8})).geometry.vertices);
});
