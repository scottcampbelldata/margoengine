import test from 'node:test';
import assert from 'node:assert/strict';
import { CurvedText, PathText, curvePoint } from '@margoengine/text/curve';
import { Text, Font, TextRenderer } from '../dist/index.js';
const font=Object.assign(Object.create(Font.prototype),{revision:0,advance:s=>s.length*0.5,kerning:()=>0,metrics:()=>({ascent:0.8,descent:0.2})});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} vs ${b}`);
test('cylinder preserves arc distance and Y for signed radii, flat and small angles',()=>{
 for(const r of [1,-1,3,-3]) for(const a of [-2,-0.1,0,0.5,2]) {
  const [x,y,z]=curvePoint(r*a,0.7,r);
  close(x*x+(z-r)**2,r*r);close(y,0.7);
  close(Math.atan2(x/r,1-z/r)*r,r*a);
 }
 assert.deepEqual(curvePoint(2,3,Infinity),[2,3,0]);
 assert.ok(curvePoint(1,0,1e15)[2]>0);
 assert.throws(()=>curvePoint(0,0,0),RangeError);
});
test('CurvedText retains source layout, updates bend uniforms and unprojects hit tests',()=>{
 const t=new CurvedText({text:'abc',font,curveRadius:2});
 assert.ok(t instanceof Text);
 assert.equal(t.layout.curveRadius,2);assert.equal(t.layout.curveSegments,8);
 const p=curvePoint(0.6,-0.5,2);assert.equal(t.hitTestSurface(...p),t.hitTest(0.6,-0.5));
 t.curveRadius=-2;t.curveSegments=32;
 assert.equal(t.layout.curveRadius,-2);assert.equal(t.layout.curveSegments,32);
 t.curveSegments=0;assert.throws(()=>t.layout,RangeError);
});
const path={length:10,sample:d=>({position:[d,0,0],tangent:[1,0,0],normal:[0,1,0]})};
test('path placement preserves advances, baseline, wrapping, transforms and source options',()=>{
 const options={text:'ab\ncd',font,path,startOffset:1,position:[2,3,4]};
 const p=new PathText(options);
 assert.equal(p.texts.length,4);
 close(p.texts[0].matrix[12],3);close(p.texts[1].matrix[12],3.5);
 close(p.texts[2].matrix[13],p.texts[0].matrix[13]-1.2);
 close(p.texts[0].matrix[14],4);
 p.update({text:'x'});assert.equal(options.text,'ab\ncd');assert.equal(p.texts.length,1);
 p.dispose();assert.throws(()=>p.update(),e=>e.code==='disposed');p.dispose();
});
test('path frames are orthogonalized, closed distances wrap and outside glyphs hide',()=>{
 let sampled;
 const p=new PathText({text:'ab',font,startOffset:11,closed:true,path:{length:1,sample:d=>(sampled=d,{position:[0,0,0],tangent:[2,0,0],normal:[1,2,0]})}});
 close(sampled,0.75);assert.deepEqual([...p.texts[0].matrix.slice(0,3)],[1,0,0]);
 p.update({closed:false});assert.equal(p.texts.length,0);
 p.dispose();
 assert.throws(()=>new PathText({text:'a',font,path:{length:1,sample:()=>({position:[0,0,0],tangent:[1,0,0],normal:[1,0,0]})}}),e=>e.code==='failed');
});
test('renderer membership survives rebuilds and disposal releases every glyph',()=>{
 const r=new TextRenderer(),p=new PathText({text:'abc',font,path}).addTo(r);
 assert.equal(r.texts.size,3);p.update({text:'ab'});assert.equal(r.texts.size,2);
 p.removeFrom(r);assert.equal(r.texts.size,0);p.addTo(r);p.dispose();assert.equal(r.texts.size,0);
});
