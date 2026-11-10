import assert from 'node:assert/strict';
import test from 'node:test';
import {CellLocator,probeGrid,plotOverLine,integrateGrid,resampleDataset,resampleToImage,probeOperator} from '../dist/probe.js';
import {FilterPipeline} from '../dist/pipeline.js';
const near=(a,b,e=1e-11)=>assert.ok(Math.abs(a-b)<=e,`${a} vs ${b}`);
const tet={points:[0,0,0,1,0,0,0,1,0,0,0,1],connectivity:[0,1,2,3],offsets:[4],types:[10],pointData:[0,1,2,3],cellData:[7],pointArrays:{vec:[0,0,0,1,0,0,0,1,0,0,0,1]},cellArrays:{vec:[5,9]},sourceCells:[41]};
const hex=(warp=false)=>{const uvw=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];return {points:uvw.flatMap(([u,v,w])=>[u,v,w*(warp?1+0.5*u:1)]),connectivity:[0,1,2,3,4,5,6,7],offsets:[8],types:[12],pointData:uvw.map(([u,v,w])=>u*v*w)};};
test('tetra barycentric interpolation retains named vector tuples, cell tuples and original IDs',async()=>{
  using locator=await CellLocator.create(tet);const p=[0.1,0.2,0.3],r=locator.probe(p);near(r.pointData,1.4);assert.deepEqual([...r.pointArrays.vec],p);assert.deepEqual([...r.cellArrays.vec],[5,9]);assert.equal(r.cellData,7);assert.equal(r.sourceCell,41);
  assert.equal(locator.probe([0.9,0.9,0.9]),null);near(locator.probe([1,0,0]).pointData,1);
});
test('true trilinear hexahedron sampling differs from pulling-linear interpolation and inverts distorted mapping',async()=>{
  for(const warp of [false,true]){using locator=await CellLocator.create(hex(warp));for(const [u,v,w]of [[0.25,0.5,0.75],[0.9,0.1,0.4],[0,1,1]])near(locator.probe([u,v,w*(warp?1+0.5*u:1)]).pointData,u*v*w);assert.equal(locator.probe([1.1,0.5,0.5]),null);}
});
test('regular image path uses exact signed bounds and bilinear/trilinear sample order',async()=>{
  const image={dims:[3,3,3],bounds:[2,0,-1,1,4,6],pointData:Float64Array.from({length:27},(_,i)=>{const x=2-i%3,y=-1+Math.floor(i/3)%3,z=4+Math.floor(i/9);return 2*x-3*y+4*z;})};
  using l=await CellLocator.create(image);near(l.probe([1.2,0.3,4.6]).pointData,2.4-0.9+18.4);assert.equal(l.probe([1,0,7]),null);
  const planar={dims:[2,2,1],bounds:[0,1,0,1,0,0],pointData:[0,1,2,3]};near((await probeGrid(planar,[0.25,0.5,0])).pointData,1.25);assert.equal(await probeGrid(planar,[0.25,0.5,0.1]),null);
  assert.equal((await probeGrid({dims:[3,2,2],bounds:[0,2,0,1,0,1],cellData:[7,9]},[1,0.5,0.5])).cellData,7);
});
test('surface, wedge, pyramid and line cells retain affine fields and locator boundary ordering',async()=>{
  const cases=[{points:[0,0,0,1,0,0,1,1,0,0,1,0],type:9,p:[0.2,0.3,0]},
    {points:[0,0,0,1,0,0,0,1,0,0,0,1,1,0,1,0,1,1],type:13,p:[0.2,0.3,0.4]},
    {points:[0,0,0,1,0,0,1,1,0,0,1,0,0.5,0.5,1],type:14,p:[0.5,0.5,0.4]},
    {points:[0,0,0,2,0,0],type:3,p:[0.3,0,0]}];
  for(const c of cases){const n=c.points.length/3,g={points:c.points,types:[c.type],connectivity:Array.from({length:n},(_,i)=>i),offsets:[n],pointData:Array.from({length:n},(_,i)=>c.points[3*i]+2*c.points[3*i+1]+3*c.points[3*i+2])};const r=await probeGrid(g,c.p);assert.ok(r);near(r.pointData,c.p[0]+2*c.p[1]+3*c.p[2]);}
  using locator=await CellLocator.create({...tet,connectivity:[0,1,2,3,0,1,2,3],offsets:[4,8],types:[10,10],cellData:[7,9],cellArrays:{},sourceCells:[41,42]});assert.equal(locator.probe([0.2,0.2,0.2]).cell,0);
});
test('owned snapshots survive mutations and disposed locators reject',async()=>{
  const g={...tet,points:[...tet.points],pointData:[...tet.pointData]};const l=await CellLocator.create(g);g.points.fill(0);g.pointData.fill(99);near(l.probe([0.1,0.2,0.3]).pointData,1.4);l.dispose();l.dispose();assert.throws(()=>l.probe([0,0,0]),/disposed/);
});
test('polyline profile samples arc length across unequal segments, with explicit missing masks',async()=>{
  using l=await CellLocator.create({dims:[4,4,1],bounds:[0,3,0,3,0,0],pointData:Array.from({length:16},(_,i)=>i%4+2*Math.floor(i/4))});
  const r=await plotOverLine(l,[0,0,0,1,0,0,1,3,0],{samples:5});assert.deepEqual([...r.distance],[0,1,2,3,4]);assert.deepEqual([...r.pointData],[0,1,3,5,7]);assert.deepEqual([...r.valid],[1,1,1,1,1]);
  const missing=await plotOverLine(l,[-1,0,0,1,0,0],{samples:3});assert.deepEqual([...missing.valid],[0,1,1]);assert.ok(Number.isNaN(missing.pointData[0]));assert.equal(missing.cells[0],-1);
});
test('exact physical lengths, areas, tetra volumes and their linear field integrals',async()=>{
  const l=await integrateGrid({points:[0,0,0,2,0,0,2,3,0],connectivity:[0,1,1,2],offsets:[2,4],types:[3,3],pointData:[0,2,2]});near(l.length.measure,5);near(l.length.pointData,8);near(l.volume.measure,0);
  const a=await integrateGrid({points:tet.points.slice(0,9),connectivity:[0,1,2],offsets:[3],types:[5],pointData:[0,1,2]});near(a.area.measure,0.5);near(a.area.pointData,0.5);
  const v=await integrateGrid(tet);near(v.volume.measure,1/6);near(v.volume.pointData,0.25);near(v.volume.cellData,7/6);near(v.volume.cellArrays.vec[0],5/6);near(v.volume.cellArrays.vec[1],1.5);
});
test('Gaussian hexa integration exactly integrates trilinear fields and varying physical Jacobians',async()=>{
  const a=await integrateGrid(hex());near(a.volume.measure,1);near(a.volume.pointData,1/8);
  const b=await integrateGrid(hex(true));near(b.volume.measure,1.25);near(b.volume.pointData,1/6);
});
test('resampling retains target geometry and arrays, keeps cell samples separate and masks outside points',async()=>{
  using l=await CellLocator.create({...tet,pointArrays:{...tet.pointArrays,'cell:vec':[1,2,3,4]}});
  const target={points:[0.1,0.2,0.3,2,2,2],connectivity:[0,1],offsets:[2],types:[3],cellData:[99],sourceCells:[21]};const r=await resampleDataset(l,target);near(r.grid.pointData[0],1.4);assert.ok(Number.isNaN(r.grid.pointData[1]));assert.deepEqual([...r.valid],[1,0]);assert.equal(r.grid.cellData[0],99);assert.equal(r.sampledCellData[0],7);assert.deepEqual([...r.sampledCellArrays.vec.slice(0,2)],[5,9]);assert.ok(r.grid.pointArrays['cell:vec']);target.points.fill(88);target.sourceCells[0]=999;assert.equal(r.grid.points[0],0.1);assert.equal(r.grid.sourceCells[0],21);
  const image=await resampleToImage(l,[3,3,3],[0,1,0,1,0,1]);assert.deepEqual(image.grid.dims,[3,3,3]);assert.equal(image.valid[0],1);assert.equal(image.valid[26],0);
});
test('pipeline executes lazy locator operations; cancellation and malformed data reject',async()=>{
  using graph=new FilterPipeline({source:{kind:'source',execute:()=>tet},probe:probeOperator()});graph.add({id:'s',type:'source'}).add({id:'p',type:'probe',inputs:['s'],params:{operation:'probe',position:[0.1,0.2,0.3]}});near((await graph.run('p')).pointData,1.4);
  const c=new AbortController(),reason={stop:true};c.abort(reason);await assert.rejects(CellLocator.create(tet,{signal:c.signal}),e=>e===reason);await assert.rejects(integrateGrid(tet,{signal:c.signal}),e=>e===reason);
  await assert.rejects(CellLocator.create({...tet,pointArrays:{bad:[1]}}));await assert.rejects(CellLocator.create({...tet,pointData:[1]}));using l=await CellLocator.create(tet);await assert.rejects(plotOverLine(l,[0,0,0,0,0,0]));assert.throws(()=>l.probe([NaN,0,0]));
  const empty=await integrateGrid({points:[],connectivity:[],offsets:[],types:[],pointData:[]});assert.equal(empty.volume.measure,0);assert.equal(empty.volume.pointData,0);
});
