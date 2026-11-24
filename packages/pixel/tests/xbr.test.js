import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PixelScale } from '../dist/scale.js';
import { xbrCell } from './xbr-reference.js';
const white=[255,255,255,255],black=[0,0,0,255];
test('xbr3 and xbr4 are live optional scale filters, with room-based fallback',()=>{
  for(const factor of [3,4]) {
    const pass=new PixelScale({source:{},filter:`xbr${factor}`});
    const buffer=new ArrayBuffer(32);
    pass.fill(buffer,[0,0,7*factor,5*factor],{width:7,height:5});
    assert.equal(new Int32Array(buffer)[5],factor);
    pass.fill(buffer,[0,0,7*factor-1,5*factor],{width:7,height:5});
    assert.equal(new Int32Array(buffer)[5],1);
  }
});
test('edge-directed 3x/4x reconstruction smooths a half-plane, preserves flat fills, isolated pixels and checkerboards',()=>{
  for(const factor of [3,4])for(let y=0;y<factor;y++)for(let x=0;x<factor;x++){
    const q=[(x+0.5)/factor,(y+0.5)/factor,factor];
    assert.deepEqual(xbrCell(()=>white,0,0,...q),white);
    assert.deepEqual(xbrCell((a,b)=>a===0&&b===0?white:black,0,0,...q),white);
    assert.deepEqual(xbrCell((a,b)=>(a+b)%2===0?white:black,0,0,...q),white);
  }
  const plane=(x,y)=>x+y>=1?white:black;
  assert.deepEqual(xbrCell(plane,0,0,5/6,5/6,3),white);
  assert.deepEqual(xbrCell(plane,0,0,1/6,1/6,3),black);
  assert.deepEqual(xbrCell(plane,0,0,7/8,7/8,4),white);
});
test('four rotated hypotheses preserve reflection symmetry and premultiplied alpha',()=>{
  const art=(x,y)=>x+2*y>=1?[70,20,80,128]:[0,0,0,0];
  for(const factor of [3,4])for(let y=0;y<factor;y++)for(let x=0;x<factor;x++){
    const qx=(x+0.5)/factor,qy=(y+0.5)/factor;
    const a=xbrCell(art,0,0,qx,qy,factor),b=xbrCell((x,y)=>art(-x,y),0,0,1-qx,qy,factor);
    a.forEach((v,k)=>assert.ok(Math.abs(v-b[k])<1e-9));
    assert.ok(a.slice(0,3).every(v=>v>=0&&v<=a[3]));
  }
});
