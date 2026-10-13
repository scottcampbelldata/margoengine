import test from 'node:test';
import assert from 'node:assert/strict';
import {jitterProjection,halton} from '../packages/taa/dist/index.js';

test('jitter validation allocates no matrix copies and preserves aliased projection math',()=>{
 const matrix=new Float32Array([1,0,0,0,0,1,0,0,.1,.2,1,-1,0,0,.3,0]),output=new Float32Array(16),from=Array.from;let copies=0;
 Array.from=function(...args){copies++;return from.apply(this,args);};
 try {
  for(let frame=0;frame<120;frame++){
   jitterProjection(output,matrix,frame,128,96);const x=2*(halton(frame%8+1,2)-.5)/128,y=-2*(halton(frame%8+1,3)-.5)/96;
   for(let c=0;c<4;c++){assert.equal(output[c*4],Math.fround(matrix[c*4]+x*matrix[c*4+3]));assert.equal(output[c*4+1],Math.fround(matrix[c*4+1]+y*matrix[c*4+3]));}
  }
 } finally {Array.from=from;}
 assert.equal(copies,0,'Jitter validation copied a stable matrix');
 const alias=matrix.slice();jitterProjection(alias,alias,3,128,96);jitterProjection(output,matrix,3,128,96);assert.deepEqual(alias,output);
 for(const [candidate,width,height] of [[matrix,0,96],[matrix,128,NaN],[new Float32Array(15),128,96],[new Float32Array(16).fill(NaN),128,96]]){const before=output.slice();assert.throws(()=>jitterProjection(output,candidate,0,width,height),/projection/);assert.deepEqual(output,before);}
});
