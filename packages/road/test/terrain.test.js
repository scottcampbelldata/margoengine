import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';
import { bankedRoad } from '../dist/banking.js';
import { fitTerrain } from '../dist/terrain.js';
const mesh=()=>road(new Spline([[0,2,-10],[0,2,10]]),{segments:4,crossSection:[[-3,0],[3,0]]}).geometry;
test('terrain cuts and fills to road height and fades by distance to its footprint',async()=>{
  for(const base of [()=>10,()=>-10]) {
    const height=await fitTerrain(mesh(),{base,shoulder:2,depth:0.25});
    assert.equal(height(0,0),1.75); assert.equal(height(3,0),1.75);
    assert.equal(height(4,0),(1.75+base())/2); assert.equal(height(5,0),base());
    assert.equal(height(0,13),base());
    assert.ok(Math.abs(height(3+Math.SQRT2,10+Math.SQRT2)-base())<1e-10);
  }
  const noShoulder=await fitTerrain(mesh(),{shoulder:0});
  assert.equal(noShoulder(0,0),2); assert.equal(noShoulder(3.01,0),0);
});
test('triangle barycentric heights fit banked grades and root curbs',async()=>{
  const data=await bankedRoad(new Spline([[0,0,-10],[0,4,10]]),{bank:0.2,crossSection:[[-3,0],[3,0]],segments:8});
  const height=await fitTerrain(data.geometry);
  const v=data.geometry.vertices;
  for(let i=0;i<v.length;i+=6) assert.ok(Math.abs(height(v[i],v[i+2])-v[i+1])<1e-5);
  const curbed=road(new Spline([[0,2,-10],[0,2,10]]));
  const h=await fitTerrain(curbed.geometry);
  assert.equal(h(0,0),2); assert.ok(Math.abs(h(3.1,0)-2.15)<1e-6);
});
test('terrain snapshots before loading, owns CPU data, and validates hostile inputs and aborts',async()=>{
  const g=mesh(), pending=fitTerrain(g); g.vertices.fill(0);g.indices.fill(0);
  const height=await pending;assert.equal(height(0,0),2);
  for(const o of [{shoulder:-1},{shoulder:NaN},{shoulder:1e30},{depth:Infinity},{depth:-1},{base:5}]) await assert.rejects(fitTerrain(mesh(),o));
  for(const g of [null,{vertices:[],indices:[]},{vertices:new Float32Array(18).fill(NaN),indices:new Uint32Array([0,1,2])}]) await assert.rejects(fitTerrain(g));
  for(const p of [[NaN,0],[Infinity,0],[1e7,0]]) assert.throws(()=>height(...p),e=>e.code==='failed'&&/https:/.test(e.message));
  const bad=await fitTerrain(mesh(),{base:()=>NaN});assert.throws(()=>bad(0,0));
  await assert.rejects(fitTerrain(mesh(),{signal:AbortSignal.abort()}),{name:'AbortError'});
  const c=new AbortController(),p=fitTerrain(mesh(),{signal:c.signal});c.abort();await assert.rejects(p,{name:'AbortError'});
});
