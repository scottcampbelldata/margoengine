import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';
import { bankedRoad } from '../dist/banking.js';

const straight = () => new Spline([[0, 0, 0], [0, 0, 20]]);
const flat = {segments: 4, crossSection: [[-3, 0], [3, 0]]};
test('bank rotates the surface and normals with analytic width and preserves UVs', async () => {
  for (const angle of [-Math.PI / 4, 0, Math.PI / 6, Math.PI / 4]) {
    const base = road(straight(), flat), banked = await bankedRoad(straight(), {...flat, bank: angle});
    const v = banked.geometry.vertices;
    assert.deepEqual(banked.uvs, base.uvs);
    for (let i = 0; i < v.length; i += 12) {
      assert.ok(Math.abs(v[i] + 3 * Math.cos(angle)) < 1e-6);
      assert.ok(Math.abs(v[i + 1] + 3 * Math.sin(angle)) < 1e-6);
      assert.ok(Math.abs(v[i + 3] + Math.sin(angle)) < 1e-6);
      assert.ok(Math.abs(v[i + 4] - Math.cos(angle)) < 1e-6);
      assert.ok(Math.abs(Math.hypot(v[i+6]-v[i],v[i+7]-v[i+1],v[i+8]-v[i+2])-6)<1e-6);
    }
  }
});
test('arc-distance banking transitions, curbs, grades, closed and curved roads retain finite unit normals', async () => {
  const changing = await bankedRoad(straight(), {...flat, bank: [0, 0.4, 0]});
  assert.equal(changing.geometry.vertices[1], 0);
  assert.ok(Math.abs(changing.geometry.vertices[25] + 3 * Math.sin(0.4)) < 1e-6);
  assert.equal(changing.geometry.vertices.at(-5), 0);
  for (const curve of [new Spline([[0,0,0],[20,3,20],[50,0,25]]), new Spline([[0,0,0],[30,0,0],[30,0,30],[0,0,30]],{closed:true})]) {
    const result = await bankedRoad(curve, {bank: [0.1, -0.1, 0.1]});
    const v = result.geometry.vertices;
    for(let i=0;i<v.length;i+=6) {
      assert.ok(Array.from(v.subarray(i,i+6)).every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...v.subarray(i+3,i+6))-1)<1e-6);
    }
    assert.equal(result.section.length,8);
  }
});
test('banking rejects hostile values, collapsed precision, and aborts on both sides of loading', async () => {
  for (const bank of [NaN, Infinity, 1e20, [], [0], [0,NaN], new Array(4098).fill(0)])
    await assert.rejects(bankedRoad(straight(), {bank}),e=>e.code==='failed' && /https:/.test(e.message));
  for (const options of [{segments:0},{width:NaN},{width:1e30},{crossSection:[]},{uvMeters:1e-320}])
    await assert.rejects(bankedRoad(straight(),options));
  await assert.rejects(bankedRoad(straight(), {bank:-Math.PI/4,crossSection:[[-1e6,1e6],[1e6,1e6]]}), /noncollapsed/);
  await assert.rejects(bankedRoad(new Spline([[1e6,0,0],[1e6,0,20]]), {...flat,crossSection:[[-1e-6,0],[1e-6,0]]}), /noncollapsed/);
  await assert.rejects(bankedRoad(straight(),{signal:AbortSignal.abort()}),{name:'AbortError'});
  const controller=new AbortController(); const pending=bankedRoad(straight(),{signal:controller.signal}); controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
test('banked results snapshot before loading and have independent caller-owned CPU data',async()=>{
  const curve=straight(),options={...flat,bank:[0.2,0.2]};
  const promise=bankedRoad(curve,options); options.bank.fill(0); curve.points.fill(99);
  const first=await promise, second=await bankedRoad(straight(),{...flat,bank:0.2});
  assert.deepEqual(first.geometry.vertices,second.geometry.vertices);
  first.geometry.vertices.fill(0); first.uvs.fill(0);
  assert.ok(second.geometry.vertices.some(v=>v!==0)); assert.ok(second.uvs.some(v=>v!==0));
});
