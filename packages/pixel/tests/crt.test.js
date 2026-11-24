// Node checks of @margoengine/pixel/crt: defaults and option errors. The look itself is proved by crt-check.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRT } from '../dist/crt.js';
import { crtSignal } from './crt-signal-reference.js';

test('the defaults are the documented ones and every look setting is a field', () => {
  const crt = new CRT({ source: {} });
  assert.deepEqual(
    [crt.curvature, crt.scanlines, crt.mask, crt.glow, crt.brightness, crt.fit],
    [0.08, 0.5, 0.2, 0.25, 1.2, 'contain'],
  );
  crt.scanlines = 1;
  assert.equal(crt.scanlines, 1);
});

test('composite defaults are disabled and live offsets pack independently in source pixels',()=>{
  const crt=new CRT({source:{}});
  assert.deepEqual([crt.colorBleed,crt.chromaticOffset,crt.redOffset,crt.greenOffset,crt.blueOffset],[0,0,0,0,0]);
  crt.colorBleed=0.75;crt.chromaticOffset=[0.5,-1];crt.redOffset=2;crt.greenOffset=[-3,1];crt.blueOffset=[0,2];
  const buffer=new ArrayBuffer(80);crt.fill(buffer,[0,0,100,80]);
  assert.deepEqual([...new Float32Array(buffer).slice(9,18)],[0.75,0.5,-1,2,0,-3,1,0,2]);
  for(const key of ['chromaticOffset','redOffset','greenOffset','blueOffset'])for(const value of [Infinity,NaN,33,[-33,0],[0,Infinity],[0]])
    assert.throws(()=>new CRT({source:{},[key]:value}),RangeError);
  assert.throws(()=>new CRT({source:{},colorBleed:1.01}),RangeError);
  crt.redOffset=Infinity;assert.throws(()=>crt.fill(buffer,[0,0,100,80]),RangeError);
});

test('YIQ bleed keeps gray edges sharp and constant colours exact, and preserves luma before gamut clipping',()=>{
  const gray=(x)=>{const v=x<0?0.1:0.9;return [v,v,v,1];};
  for(const x of [-4,-1,0,1,4])crtSignal(gray,{colorBleed:1})(x,0).forEach((v,k)=>assert.ok(Math.abs(v-gray(x)[k])<1e-9));
  const flat=()=>[0.2,0.3,0.4,0.5];
  crtSignal(flat,{colorBleed:1})(0,0).forEach((v,k)=>assert.ok(Math.abs(v-flat()[k])<1e-9));
  const edge=(x)=>x<0?[0.45,0.5,0.55,1]:[0.55,0.5,0.45,1];
  const bled=crtSignal(edge,{colorBleed:1});
  for(const x of [-2,-1,0,1,2]){
    const luma=c=>c[0]*0.299+c[1]*0.587+c[2]*0.114;
    assert.ok(Math.abs(luma(bled(x,0))-luma(edge(x)))<1e-9);
  }
  assert.notDeepEqual(bled(0,0),edge(0));
});

test('fractional and independent RGB shifts are analytic and keep alpha premultiplied',()=>{
  const ramp=(x,y)=>[0.2+x/100,0.3+y/100,0.4+x/100,1];
  const c=crtSignal(ramp,{chromaticOffset:[0.5,0.25],greenOffset:[0,2]})(0,0);
  assert.ok(Math.abs(c[0]-0.205)<1e-12);assert.ok(Math.abs(c[1]-0.32)<1e-12);assert.ok(Math.abs(c[2]-0.395)<1e-12);
  const transparent=(x,y)=>x+y<0?[0,0,0,0]:[0.2,0.1,0.3,0.5];
  const signal=crtSignal(transparent,{colorBleed:1,chromaticOffset:[1.5,-0.5]});
  for(let x=-3;x<=3;x++)for(let y=-3;y<=3;y++){
    const c=signal(x,y);assert.ok(c.slice(0,3).every(v=>v>=0&&v<=c[3]));
  }
});

test('settings out of range and a missing source are refused', () => {
  assert.throws(() => new CRT({}), TypeError);
  for (const [key, value] of [
    ['curvature', 0.6],
    ['scanlines', -0.1],
    ['mask', 2],
    ['glow', Number.NaN],
    ['brightness', 5],
  ])
    assert.throws(() => new CRT({ source: {}, [key]: value }), new RegExp(`CRT ${key} must be between`));
});
