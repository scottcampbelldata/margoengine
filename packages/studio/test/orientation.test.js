import test from 'node:test';
import assert from 'node:assert/strict';
import {ContactShadows} from '../dist/index.js';
import {AccumulatedShadows} from '../dist/accumulate.js';

const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const apply=(m,p)=>[0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);
const close=(a,b)=>a.forEach((v,i)=>assert(Math.abs(v-b[i])<2e-5,`${a} != ${b}`));
const directions=[[0,1,0],[0,0,1],[1,0,0],[0,-1,0],[0,0,-1],[-1,0,0],[1,2,-3],[Number.MAX_VALUE,Number.MAX_VALUE,0],[Number.MIN_VALUE,0,0],[1,1e-14,0]];

test('receiver projection, lifted corners and bounds fit use the same arbitrary-up frame',()=>{
  for(const up of directions){
    const effect=new ContactShadows({up,position:[1,-2,3],size:[4,6],height:2});
    const s=effect.settings(),p=[1,-2,3];
    for(const a of [s.u,s.normal,s.v]) close([dot(a,a)],[1]);
    close([dot(s.u,s.normal),dot(s.u,s.v),dot(s.v,s.normal)],[0,0,0]);
    const world=(x,h,z)=>p.map((v,i)=>v+s.u[i]*x+s.normal[i]*h+s.v[i]*z);
    const m=effect.projection(s);
    close(apply(m,world(-2,0,-3)),[-1,-1,0,1]);
    close(apply(m,world(2,2,3)),[1,1,1,1]);
    const bounds=[-2,-1,-3,4,5,6];
    effect.fit(bounds,1);
    const f=effect.settings(),fit=effect.projection(f);
    let min=Infinity,max=-Infinity;
    for(let k=0;k<8;k++){
      const corner=[0,1,2].map(i=>bounds[i+((k>>i)&1)*3]);
      const clip=apply(fit,corner);
      assert(clip[0]>=-1.00001&&clip[0]<=1.00001&&clip[1]>=-1.00001&&clip[1]<=1.00001);
      min=Math.min(min,clip[2]);max=Math.max(max,clip[2]);
    }
    close([min,max],[0,1]);
    effect.dispose();effect.dispose();
  }
});

test('point-light projection agrees with independent world ray-plane intersection for every up axis',()=>{
  for(const up of directions){
    const effect=new AccumulatedShadows({up,lightRadius:0,position:[0,0,0],size:[4,6],height:2});
    const s=effect.settings(),light=s.normal.map(v=>v*8);
    const point=s.u.map((v,i)=>v*0.4+s.v[i]*0.6+s.normal[i]*1.3);
    const t=-dot(s.normal,light)/dot(s.normal,point.map((v,i)=>v-light[i]));
    const hit=light.map((v,i)=>v+t*(point[i]-v));
    const q=apply(effect.projection(s),point);
    close([q[0]/q[3],q[1]/q[3]],[dot(s.u,hit)/2,dot(s.v,hit)/3]);
    effect.dispose();
  }
});

test('zero and malformed directions reject before allocating; live direction and light edits are validated',()=>{
  for(const up of [[0,0,0],[NaN,1,0],[0,Infinity,0],[],[1,2],[1,,0],null])
    assert.throws(()=>new ContactShadows({up}),RangeError);
  const effect=new AccumulatedShadows({up:[0,0,1]});
  effect.options.lightPosition=[0,8,0];
  assert.throws(()=>effect.changed([],effect.settings()),RangeError);
  effect.dispose();
});

test('native preview refusal and malformed receiver directions include actionable help links',()=>{
  const effect=new ContactShadows();
  assert.throws(()=>effect.setup({gpu:null}),e=>e.code==='unsupported'&&e.message.includes('https://margoengine.com/errors#unsupported'));
  effect.dispose();
  assert.throws(()=>new ContactShadows({up:[NaN,0,1]}),e=>e instanceof RangeError&&e.message.includes('https://margoengine.com/errors#arguments'));
});
