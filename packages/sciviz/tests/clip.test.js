import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { clipGrid, thresholdGrid, isoVolume, imageGrid, extractSubset, clipOperator, connectivityGrid } from '../dist/clip.js';
import { FilterPipeline } from '../dist/pipeline.js';

const cube={points:[0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1],connectivity:[0,1,2,3,4,5,6,7],offsets:[8],types:[12],pointData:[0,1,1,0,0,1,1,0],cellData:[7],
  pointArrays:{affine:[2,5,9,6,7,10,14,11],vec:[0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1]},cellArrays:{pair:[11,13]}};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} vs ${b}`);
const volume=g=>{
  let sum=0,start=0;
  for(let c=0;c<g.types.length;c++){
    assert.equal(g.types[c],10);const ids=Array.from(g.connectivity).slice(start,g.offsets[c]);start=g.offsets[c];const p=ids.map(id=>Array.from(g.points).slice(3*id,3*id+3));
    const [a,b,d]=[1,2,3].map(i=>p[i].map((v,k)=>v-p[0][k]));sum+=Math.abs(a[0]*(b[1]*d[2]-b[2]*d[1])-a[1]*(b[0]*d[2]-b[2]*d[0])+a[2]*(b[0]*d[1]-b[1]*d[0]))/6;
  }return sum;
};
test('plane clip and its complement conserve exact cell volume and interpolate every tuple',async()=>{
  for(const x of [0,0.1,0.5,0.91,1]){
    const a=await clipGrid(cube,{kind:'plane',normal:[1,0,0],offset:-x}),b=await clipGrid(cube,{kind:'plane',normal:[1,0,0],offset:-x},{invert:true});
    near(volume(a),1-x);near(volume(b),x);
    for(let i=0;i<a.points.length/3;i++){const [x,y,z]=a.points.slice(3*i,3*i+3);near(a.pointData[i],x);near(a.pointArrays.affine[i],2+3*x+4*y+5*z);assert.deepEqual([...a.pointArrays.vec.slice(3*i,3*i+3)],[x,y,z]);}
    assert.ok([...a.cellData].every(x=>x===7));assert.deepEqual([...a.cellArrays.pair],Array.from({length:a.types.length},()=>[11,13]).flat());assert.ok([...a.sourceCells].every(x=>x===0));
  }
});
test('all tetrahedron clip cases conserve total volume and have no zero-volume output',async()=>{
  const t={points:[0,0,0,1,0,0,0,1,0,0,0,1],connectivity:[0,1,2,3],offsets:[4],types:[10]};
  for(let mask=0;mask<16;mask++){
    const grid={...t,pointData:Array.from({length:4},(_,i)=>(mask>>i)&1)};
    const a=await clipGrid(grid,{kind:'scalar',value:0.5}),b=await clipGrid(grid,{kind:'scalar',value:0.5},{invert:true});near(volume(a)+volume(b),1/6);
    const inside=grid.pointData.reduce((a,b)=>a+b,0),fraction=[0,1/8,1/2,7/8,1][inside];near(volume(a),fraction/6);
  }
});
test('box clip intersects interior boxes even when no original vertex is retained; complement disjoint',async()=>{
  const bounds=[0.2,0.8,0.3,0.7,0.1,0.9],shape={kind:'box',bounds};
  const a=await clipGrid(cube,shape),b=await clipGrid(cube,shape,{invert:true});near(volume(a),0.6*0.4*0.8);near(volume(a)+volume(b),1);
  const whole=await clipGrid(cube,shape,{crinkle:true});assert.deepEqual([...whole.types],[12]);assert.equal(whole.points.length,24);
});
test('iso-volume retains exact scalar interval with source arrays and provenance',async()=>{
  const r=await isoVolume(cube,[0.2,0.7]);near(volume(r),0.5);assert.ok([...r.pointData].every(v=>v>=0.2-1e-15&&v<=0.7+1e-15));
  const t=await isoVolume({...cube,pointArrays:{...cube.pointArrays,range:cube.pointData}},[0.1,0.4],{array:'range'});near(volume(t),0.3);
});
test('sphere samples its implicit field and crinkle preserves unsplit original cells',async()=>{
  const shape={kind:'sphere',center:[0,0,0],radius:0.5},a=await clipGrid(cube,shape),b=await clipGrid(cube,shape,{invert:true});near(volume(a)+volume(b),1);
  const r=await clipGrid(cube,{kind:'plane',normal:[1,0,0],offset:-0.5},{crinkle:true});assert.deepEqual([...r.types],[12]);assert.deepEqual([...r.pointData],cube.pointData);
});
test('inclusive cell threshold, all/any point threshold, inversion, compaction and missing values',async()=>{
  const image={dims:[3,2,2],bounds:[0,2,0,1,0,1],pointData:Array.from({length:12},(_,i)=>i%3),cellData:[3,7],pointArrays:{v:Array.from({length:24},(_,i)=>i)},cellArrays:{v:[1,2,3,4]}};
  const a=await thresholdGrid(image,[6,8],{association:'cell'});assert.equal(a.types.length,1);assert.deepEqual([...a.sourceCells],[1]);assert.deepEqual([...a.cellArrays.v],[3,4]);assert.equal(a.pointArrays.v.length,16);
  assert.equal((await thresholdGrid(image,[1,2])).types.length,1);assert.equal((await thresholdGrid(image,[1,1],{mode:'any'})).types.length,2);
  assert.equal((await thresholdGrid({...cube,pointData:[NaN,...cube.pointData.slice(1)]},[0,1])).types.length,0);
  const inverted=await thresholdGrid(image,[6,8],{association:'cell',invert:true});assert.deepEqual([...inverted.sourceCells],[0]);
});
test('threshold selects multi-component tuples by component, magnitude, all or any, with one-sided ranges',async()=>{
  // Two cells of a 3x2x1 image; cell vectors (3,4) |5| and (1,-1) |sqrt 2|; point vectors x = i, y = -i.
  const image={dims:[3,2,1],bounds:[0,2,0,1,0,0],cellArrays:{v:[3,4,1,-1]},pointArrays:{p:Array.from({length:12},(_,i)=>i%2?-(i>>1):i>>1)}};
  const ids=async(range,options)=>[...(await thresholdGrid(image,range,{association:'cell',array:'v',...options})).sourceCells];
  assert.deepEqual(await ids([4.9,5.1]),[0]);
  assert.deepEqual(await ids([Math.SQRT2-1e-12,Math.SQRT2+1e-12],{component:'magnitude'}),[1]);
  assert.deepEqual(await ids([2,Infinity],{component:0}),[0]);
  assert.deepEqual(await ids([-Infinity,0],{component:1}),[1]);
  assert.deepEqual(await ids([0,10],{component:'all'}),[0]);
  assert.deepEqual(await ids([-1,-1],{component:'any'}),[1]);
  assert.deepEqual(await ids([-Infinity,Infinity],{component:'all'}),[0,1]);
  // Point association: point i holds (i, -i); cell 0 uses points 0,1,4,3 and cell 1 points 1,2,5,4.
  const points=async(range,options)=>[...(await thresholdGrid(image,range,{array:'p',...options})).sourceCells];
  assert.deepEqual(await points([0,4],{component:0}),[0]);
  assert.deepEqual(await points([-Infinity,-5],{component:1,mode:'any'}),[1]);
  assert.deepEqual(await points([0,4*Math.SQRT2+1e-9]),[0]);
  for(const component of [2,-1,0.5,'max'])await assert.rejects(ids([0,1],{component}),/component/);
  for(const range of [[NaN,1],[Infinity,Infinity],[-Infinity,-Infinity],[2,1]])await assert.rejects(ids(range),/ordered range/);
});
test('connectivity numbers point-sharing regions by size and extracts all, largest, listed, seeded and closest',async()=>{
  // Ten points on x; lines 0-1, 1-2 (region of 2 cells), 3-4 (1 cell), 5-6, 6-7, 7-8 (3 cells); point 9 unused.
  const g={points:Array.from({length:30},(_,i)=>i%3?0:i/3),connectivity:[0,1,1,2,3,4,5,6,6,7,7,8],offsets:[2,4,6,8,10,12],types:[3,3,3,3,3,3],cellData:[10,11,12,13,14,15]};
  const all=await connectivityGrid(g);
  assert.deepEqual([...all.regionCells],[3,2,1]);assert.deepEqual([...all.cellArrays.regionId],[1,1,2,0,0,0]);assert.deepEqual([...all.sourceCells],[0,1,2,3,4,5]);
  assert.deepEqual([...all.pointArrays.regionId],[1,1,1,2,2,0,0,0,0]);assert.deepEqual([...all.cellData],[10,11,12,13,14,15]);
  assert.deepEqual([...(await connectivityGrid(g,{order:'first'})).cellArrays.regionId],[0,0,1,2,2,2]);
  assert.deepEqual([...(await connectivityGrid(g,{order:'ascending'})).cellArrays.regionId],[1,1,0,2,2,2]);
  const cells=async(o)=>[...(await connectivityGrid(g,o)).sourceCells];
  assert.deepEqual(await cells({extract:'largest'}),[3,4,5]);
  assert.deepEqual(await cells({extract:'largest',order:'ascending'}),[3,4,5]);
  assert.deepEqual(await cells({extract:'regions',regions:[1,2]}),[0,1,2]);
  assert.deepEqual(await cells({extract:'cellSeeded',seeds:[2]}),[2]);
  assert.deepEqual(await cells({extract:'pointSeeded',seeds:[1,8]}),[0,1,3,4,5]);
  assert.deepEqual(await cells({extract:'pointSeeded',seeds:[9]}),[]);
  assert.deepEqual(await cells({extract:'closest',point:[6.2,5,0]}),[3,4,5]);
  assert.deepEqual(await cells({extract:'closest',point:[2.5,0,0]}),[0,1]);
  // Scalar connectivity: points 1, 3 and 4 are out of [0, 1], so cells 0 and 1 separate and cell 2 joins nothing.
  const s=await connectivityGrid({...g,pointData:[0,5,0,5,5,0,0,0,0,0]},{scalarRange:[0,1]});
  assert.deepEqual([...s.regionCells],[3,1,1]);assert.deepEqual([...s.sourceCells],[0,1,3,4,5]);assert.deepEqual([...s.cellArrays.regionId],[1,2,0,0,0]);
  // A structured image is one region; the pipeline operator runs the same filter.
  const image={dims:[3,3,1],bounds:[0,2,0,2,0,0],pointData:Array(9).fill(1)};
  assert.deepEqual([...(await connectivityGrid(image)).regionCells],[4]);
  assert.deepEqual([...(await clipOperator().execute({inputs:[g],params:{operation:'connectivity',options:{extract:'largest'}},time:0,signal:new AbortController().signal})).sourceCells],[3,4,5]);
  assert.deepEqual([...(await clipOperator().execute({inputs:[image],params:{operation:'threshold',range:[null,0.5]},time:0,signal:new AbortController().signal})).sourceCells],[]);
  for(const o of [{extract:'regions',regions:[3]},{extract:'regions'},{extract:'cellSeeded',seeds:[6]},{extract:'pointSeeded',seeds:[-1]},{extract:'closest'},{extract:'closest',point:[NaN,0,0]},{extract:'nope'},{order:'size'},{scalarRange:[1,0]},{scalarRange:[0,1]}])
    await assert.rejects(connectivityGrid(g,o),RangeError,JSON.stringify(o));
  await assert.rejects(connectivityGrid(g,{signal:AbortSignal.abort('stop')}),e=>e==='stop');
});
test('structured subsets honor indices, strides, descending bounds and full tuple arrays',async()=>{
  const d=[5,4,3],image={dims:d,bounds:[4,0,0,6,-1,1],pointData:Array.from({length:60},(_,i)=>i),cellData:Array.from({length:24},(_,i)=>i),pointArrays:{vec:Array.from({length:180},(_,i)=>i)}};
  const s=await extractSubset(image,{ranges:[[1,4],[0,3],[0,2]],strides:[2,2,2]});assert.deepEqual(s.dims,[2,2,2]);assert.deepEqual(s.bounds,[3,1,0,4,-1,1]);assert.deepEqual([...s.pointData],[1,3,11,13,41,43,51,53]);assert.deepEqual([...s.cellData],[1]);assert.equal(s.pointArrays.vec.length,24);
  assert.equal(imageGrid(s).types.length,1);const planar=await extractSubset(image,{ranges:[[0,4],[0,3],[1,1]]});assert.equal(imageGrid(planar).types[0],9);
});
test('surface clipping preserves area and interpolated values',async()=>{
  const grid={points:[0,0,0,1,0,0,1,1,0,0,1,0],connectivity:[0,1,2,3],offsets:[4],types:[9],pointData:[0,1,2,1]};
  const r=await clipGrid(grid,{kind:'plane',normal:[1,0,0],offset:-0.25});let area=0,start=0;
  for(const end of r.offsets){const p=Array.from(r.connectivity.slice(start,end),id=>Array.from(r.points.slice(3*id,3*id+3)));area+=Math.abs((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[2][0]-p[0][0])*(p[1][1]-p[0][1]))/2;start=end;}near(area,0.75);
});
test('curvilinear structured subsets retain exact coordinates and interleaved arrays',async()=>{
  const dims=[4,3,2],points=[],values=[];
  for(let z=0;z<2;z++)for(let y=0;y<3;y++)for(let x=0;x<4;x++){points.push(x,y,z+0.2*x*y);values.push(x+2*y+3*z);}
  const image={dims,bounds:[0,3,0,2,0,2.2],points,pointData:values};
  const s=await extractSubset(image,{ranges:[[1,3],[0,2],[0,1]],strides:[2,2,1]});assert.deepEqual(s.dims,[2,2,2]);
  assert.deepEqual([...s.points],[1,0,0,3,0,0,1,2,0.4,3,2,1.2000000000000002,1,0,1,3,0,1,1,2,1.4,3,2,2.2]);
  assert.deepEqual([...imageGrid(s).points],[...s.points]);
});
test('pipeline adapter and invalid data/cancellation keep exact errors',async()=>{
  using p=new FilterPipeline({source:{kind:'source',execute:()=>cube},clip:clipOperator()});p.add({id:'s',type:'source'}).add({id:'c',type:'clip',inputs:['s'],params:{operation:'clip',shape:{kind:'scalar',value:0.25}}});near(volume(await p.run('c')),0.75);
  const controller=new AbortController(),reason={cancel:true};controller.abort(reason);await assert.rejects(clipGrid(cube,{kind:'scalar',value:0},{signal:controller.signal}),e=>e===reason);
  for(const shape of [{kind:'plane',normal:[0,0,0],offset:0},{kind:'sphere',center:[0,0,0],radius:-1},{kind:'box',bounds:[1,0,0,1,0,1]},{kind:'scalar',value:NaN}])await assert.rejects(clipGrid(cube,shape));
  await assert.rejects(thresholdGrid({...cube,pointArrays:{bad:[1]}},[0,1]));await assert.rejects(extractSubset({dims:[2,2,2],bounds:[0,1,0,1,0,1]},{strides:[0,1,1]}));
  await assert.rejects(thresholdGrid({...cube,pointArrays:{'':cube.pointData}},[0,1]),/nonempty/);
  await assert.rejects(clipGrid({...cube,sourceCells:[-1]},{kind:'scalar',value:0}),/unsigned/);
});
test('TCIA CT samples retain calibrated Hounsfield units and attributed bytes',async()=>{
  const root=new URL('../../../examples/assets/sciviz/clip/',import.meta.url),bytes=readFileSync(new URL('ct-org-0-samples.bin',root)),meta=JSON.parse(readFileSync(new URL('source.json',root)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256);assert.equal(meta.license,'CC BY 3.0');assert.deepEqual(meta.dims,[64,64,19]);
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),pointData=Float64Array.from({length:bytes.length/2},(_,i)=>v.getInt16(2*i,true)*meta.slope+meta.intercept);
  const selected=await thresholdGrid({dims:meta.dims,bounds:meta.bounds,pointData},[300,3000],{mode:'any'});assert.ok(selected.types.length>100);assert.ok(selected.types.length<63*63*18);
});
