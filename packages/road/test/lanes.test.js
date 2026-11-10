import test from 'node:test';import assert from 'node:assert/strict';
import {Spline} from '@margoengine/splines';import {lanes} from '../dist/lanes.js';
const curve=new Spline([[0,0,0],[0,0,30]]);
test('lane widths place exact boundaries; dashes clip at authored distances and junction exclusions',()=>{
 const paint=lanes(curve,{widths:[3,4]},{exclude:[[8,12]],range:[1,28]});assert.equal(paint.length,3);
 assert.deepEqual(paint[1].intervals,[[1,3],[12,12+0],[18,21],[27,28]].filter(([a,b])=>b>a));
 for(const p of paint){const lateral=[-3.5,-0.5,3.5][p.index];for(let i=0;i<p.geometry.vertices.length;i+=6){const v=p.geometry.vertices;assert.ok(Math.abs(Math.abs(v[i]-lateral)-0.075)<1e-6);assert.ok(Math.abs(v[i+1]-0.01)<1e-8);assert.ok(v[i+4]>0);}}
});
test('curves, grade and continuous junction route phase follow independent spline/frame equations',()=>{
 const circle={length:20*Math.PI/2,closed:false,atDistance(s,out){out.set([20*Math.cos(s/20),s/10,20*Math.sin(s/20)]);return out;}};
 for(const m of lanes(circle,{widths:[3,3]},{step:0.3}))for(let i=0;i<m.geometry.vertices.length;i+=6){const v=m.geometry.vertices,radius=Math.hypot(v[i],v[i+2]),expected=20+[-3,0,3][m.index];assert.ok(Math.abs(Math.abs(radius-expected)-0.075)<3e-6);}
 const c=new Spline([[0,0,0],[6,1,10],[0,2,20]],{divisions:4096});
 const paint=lanes(c,{widths:[3,3]},{elevation:(x,z)=>z*0.1});
 for(const m of paint)for(let i=0;i<m.geometry.vertices.length;i+=6){const v=m.geometry.vertices;assert.ok(Math.abs(v[i+1]-v[i+2]*0.1-0.01)<3e-7);assert.ok(Number.isFinite(v[i+3]+v[i+4]+v[i+5]));}
 const a=lanes(curve,{widths:[3,3],lines:[{style:'none'},{phase:5},{style:'none'}]});
 const b=lanes(new Spline([[0,0,30],[10,0,40]]),{widths:[3,3],lines:[{style:'none'},{phase:35},{style:'none'}]});
 assert.deepEqual(a[0].intervals.slice(-1),[[22,25]]);assert.deepEqual(b[0].intervals[0],[1,4]);
});
test('all arrow turns, reversed arrows, closed seams, ownership and cancellation',()=>{
 for(const turn of ['straight','left','right','straight-left','straight-right'])for(const reverse of [false,true]){
 const marks=lanes(curve,{widths:[3,3],arrows:[{lane:1,distance:15,turn,reverse}]});const arrow=marks.at(-1);assert.equal(arrow.kind,'arrow');assert.ok(arrow.geometry.indices.length>30);assert.deepEqual(arrow.intervals,[[13,17]]);
 }
 const loop=new Spline([[0,0,0],[20,0,0],[20,0,20],[0,0,20]],{closed:true});const m=lanes(loop,{widths:[3],lines:[{style:'solid'},{style:'none'}]})[0],v=m.geometry.vertices;assert.deepEqual(Array.from(v.subarray(0,3)),Array.from(v.subarray(v.length-30,v.length-27)));
 const first=lanes(curve,{widths:[3]});first[0].color[0]=0;assert.deepEqual(lanes(curve,{widths:[3]})[0].color,[1,1,1]);
 const reason=new Error('cancel');assert.throws(()=>lanes(curve,{widths:[3]},{signal:AbortSignal.abort(reason)}),e=>e===reason);
});
test('bad layouts and unrepresentable work reject; junction exclusion suppresses entire arrows',()=>{
 assert.equal(lanes(curve,{widths:[3],arrows:[{lane:0,distance:15}]},{exclude:[[12,18]]}).filter(m=>m.kind==='arrow').length,0);
 for(const layout of [{widths:[]},{widths:[NaN]},{widths:[3],lines:[]},{widths:[3],arrows:[{lane:9,distance:10}]},{widths:[3],lines:[{style:'invalid'},{}]}])assert.throws(()=>lanes(curve,layout));
 assert.throws(()=>lanes(new Spline([[0,0,0],[0,0,100]]),{widths:[3]},{step:0.001}));assert.throws(()=>lanes(new Spline([[0,0,0],[0,10,0]]),{widths:[3]}));
});
