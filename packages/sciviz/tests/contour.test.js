import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { contourGrid, contourOperator } from '../dist/contour.js';
import { FilterPipeline } from '../dist/pipeline.js';
import { readBumpSlice } from '../../../examples/sciviz-contour-data.ts';

const tet = {points:[0,0,0,1,0,0,0,1,0,0,0,1],connectivity:[0,1,2,3],offsets:[4],types:[10],pointData:[0,1,2,3]};
const close=(a,b)=>assert.ok(Math.abs(a-b)<2e-6,`${a} != ${b}`);
test('all marching tetrahedron sign cases have analytical counts, level positions and gradient normals',async()=>{
  for(let mask=0;mask<16;mask++){
    const grid={...tet,pointData:Array.from({length:4},(_,i)=>(mask>>i)&1)},r=await contourGrid(grid,[0.5]);
    const n=grid.pointData.reduce((a,b)=>a+b,0);assert.equal(r.triangles.cells.length,n===0||n===4?0:n===2?2:1);
    for(let i=0;i<r.triangles.positions.length;i+=3){const p=r.triangles.positions.subarray(i,i+3);
      close(grid.pointData[0]+p[0]*(grid.pointData[1]-grid.pointData[0])+p[1]*(grid.pointData[2]-grid.pointData[0])+p[2]*(grid.pointData[3]-grid.pointData[0]),0.5);}
  }
  const r=await contourGrid(tet,[0.4,1.2,2.5]);assert.ok(r.triangleLevels.includes(2));
  for(let i=0;i<r.triangles.positions.length;i+=3){const p=r.triangles.positions.subarray(i,i+3);close(p[0]+2*p[1]+3*p[2],r.triangles.values[i/3]);
    for(let k=0;k<3;k++)close(r.triangles.normals[i+k],[1,2,3][k]/Math.sqrt(14));}
});
const cube=(x=0)=>[x,0,0,x+1,0,0,x+1,1,0,x,1,0,x,0,1,x+1,0,1,x+1,1,1,x,1,1];
test('hexahedra, wedge and pyramid reproduce affine fields and exact volume section areas',async()=>{
  const cases=[{points:cube(),types:[12],expected:1},{points:[0,0,0,1,0,0,0,1,0,0,0,1,1,0,1,0,1,1],types:[13],expected:0.5},
    {points:[0,0,0,1,0,0,1,1,0,0,1,0,0.5,0.5,1],types:[14],expected:0.25}];
  for(const c of cases){const n=c.points.length/3,r=await contourGrid({...c,connectivity:Array.from({length:n},(_,i)=>i),offsets:[n],pointData:Array.from({length:n},(_,i)=>c.points[3*i+2])},[0.5]);
    let area=0;const p=r.triangles.positions;
    for(let i=0;i<p.length;i+=9)area+=Math.abs((p[i+3]-p[i])*(p[i+7]-p[i+1])-(p[i+4]-p[i+1])*(p[i+6]-p[i]))/2;
    close(area,c.expected);assert.ok(r.triangles.normals.every((v,i)=>Math.abs(v-(i%3===2?1:0))<1e-6));}
});
test('shared hexahedron faces have identical segment endpoints under different local numbering',async()=>{
  const points=[...cube(),2,0,0,2,1,0,2,0,1,2,1,1],connectivity=[0,1,2,3,4,5,6,7,1,8,9,2,5,10,11,6];
  const r=await contourGrid({points,connectivity,offsets:[8,16],types:[12,12],pointData:Array.from({length:12},(_,i)=>points[3*i+1]+2*points[3*i+2])},[1.3]);
  const byCell=[new Set(),new Set()];const p=r.triangles.positions;
  for(let i=0;i<p.length;i+=3)if(p[i]===1)byCell[r.triangles.cells[Math.floor(i/9)]].add(`${p[i+1]},${p[i+2]}`);
  assert.ok(byCell[0].size>=2);assert.deepEqual(byCell[0],byCell[1]);
});
test('surface triangles and quads give isolines; equality removes collapsed and duplicate primitives',async()=>{
  const g={points:[0,0,0,1,0,0,1,1,0,0,1,0],connectivity:[0,1,2,3],offsets:[4],types:[9],pointData:[0,1,2,1]};
  const r=await contourGrid(g,[0,1,2]);assert.equal(r.triangles.cells.length,0);assert.equal(r.lines.cells.length,2);
  for(let i=0;i<r.lines.positions.length;i+=3)close(r.lines.positions[i]+r.lines.positions[i+1],1);
  assert.equal((await contourGrid({...tet,pointData:[0,0,0,0]},[0])).triangles.cells.length,0);
  const duplicate={...tet,connectivity:[0,1,2,3,0,2,1,3],offsets:[4,8],types:[10,10]};
  assert.equal((await contourGrid(duplicate,[1])).triangles.cells.length,(await contourGrid(tet,[1])).triangles.cells.length);
});
test('pipeline filter reruns contours with serializable levels',async()=>{
  using p=new FilterPipeline({grid:{kind:'source',execute:()=>tet},contour:contourOperator()});
  p.add({id:'g',type:'grid'}).add({id:'c',type:'contour',inputs:['g'],params:{levels:[0.5]}});
  assert.equal((await p.run('c')).triangles.cells.length,1);p.setParams('c',{levels:[1.5]});assert.equal((await p.run('c')).triangles.cells.length,2);
});
test('rejects malformed, missing, degenerate, nonfinite inputs and preserves cancellation reasons',async()=>{
  for(const grid of [{...tet,pointData:undefined},{...tet,pointData:[0,1,2,Infinity]},{...tet,connectivity:[0,0,2,3]},{...tet,points:new Array(12).fill(0)}])await assert.rejects(contourGrid(grid,[1]));
  const c=new AbortController(),reason={stop:true};c.abort(reason);await assert.rejects(contourGrid(tet,[1],{signal:c.signal}),e=>e===reason);
  const running=new AbortController();setTimeout(()=>running.abort(reason),0);const result=contourGrid(tet,[1],{signal:running.signal});await assert.rejects(result,e=>e===reason);
  assert.equal((await contourGrid(tet,[])).triangles.positions.length,0);
});
test('NASA original bytes and full quad solution remain reproducible',()=>{
  const bytes=readFileSync(new URL('../../../examples/assets/sciviz/contour/bump.dat',import.meta.url));
  const source=JSON.parse(readFileSync(new URL('../../../examples/assets/sciviz/contour/source.json',import.meta.url)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);assert.match(bytes.toString(),/Nodes=20449, Elements=20166/);
  const grid=readBumpSlice(bytes.toString());assert.equal(grid.types.length,20166);assert.ok(grid.types.includes(5));
  assert.equal(grid.connectivity.length,grid.types.reduce((n,t)=>n+(t===5?3:4),0));
});
