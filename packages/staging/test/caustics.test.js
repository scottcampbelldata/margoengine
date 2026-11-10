import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductCaustics } from '../dist/caustics.js';
const geometry=()=>({positions:new Float32Array([-1,1,-1,1,1,-1,0,1,1]),indices:new Uint32Array([0,2,1])});
test('caustics validates complete optical/floor settings and snapshots CPU source arrays',()=>{
 const g=geometry(),c=new ProductCaustics({geometry:g});g.positions[0]=9;g.indices[0]=2;
 assert.equal(c.options.geometry.positions[0],-1);assert.equal(c.options.geometry.indices[0],0);
 assert.deepEqual(c.stats,{updates:0,photonsPerUpdate:16384,resolution:128});c.dispose();c.dispose();
 assert.throws(()=>c.invalidate(),{code:'disposed'});
 for(const extra of [{ior:0},{ior:NaN},{backsideIOR:4},{frames:0},{photonSide:513},{resolution:0},
  {size:[1,,]},{size:.001},{height:0},{maxEvents:33},{lightDirection:[1,0,0]},
  {lightPosition:[0,3,0]},{color:[1,NaN,0]},{intensity:-1},{worldRadius:-1}])
  assert.throws(()=>new ProductCaustics({geometry:geometry(),...extra}),RangeError);
 for(const g of [{positions:new Float32Array([NaN,0,0]),indices:new Uint32Array([0,0,0])},
  {...geometry(),indices:new Uint32Array([0,1,9])},{...geometry(),normals:new Float32Array(2)}])
  assert.throws(()=>new ProductCaustics({geometry:g}),TypeError);
});
test('caustic preparation aborts before engine access and disposed updates reject',async()=>{
 await assert.rejects(ProductCaustics.attach({}, {geometry:geometry(),signal:AbortSignal.abort()}),{name:'AbortError'});
 const c=new ProductCaustics({geometry:geometry(),frames:Infinity});c.dispose();
 await assert.rejects(c.setGeometry(geometry()),{code:'disposed'});
});
