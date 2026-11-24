import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompute} from '../../compute/dist/index.js';
import {bfs, shortestPaths, connectedComponents} from '../../compute/dist/graph.js';
import {Spline} from '../../splines/dist/index.js';
import {roadGraph} from '../dist/graph.js';

const curve = length => new Spline([[0,0,0],[length,0,0]]);
async function solve(g, start) {
  const result=await shortestPaths(g,start);
  try { assert.equal(result.negativeCycle,false); return {distances:Array.from(await result.distances.read()),parents:Array.from(await result.predecessors.read())}; }
  finally {result.distances.dispose();result.predecessors.dispose();}
}

test('road arc lengths, directions and traffic reroute by travel time, retaining isolated junctions',async()=>{
  using gpu=await createCompute({backend:'cpu'});
  const roads=[{from:0,to:1,curve:curve(100),speed:10,direction:'forward'},
    {from:0,to:2,curve:curve(60),speed:10}, {from:2,to:1,curve:curve(60),speed:10}];
  using free=roadGraph(gpu,{vertices:4,roads});
  assert.deepEqual(await solve(free,0),{distances:[0,10,6,Infinity],parents:[-1,0,0,-1]});
  using busy=roadGraph(gpu,{vertices:4,roads:[{...roads[0],traffic:2,delay:3},...roads.slice(1)]});
  assert.deepEqual(await solve(busy,0),{distances:[0,12,6,Infinity],parents:[-1,2,0,-1]});
  assert.deepEqual((await solve(free,1)).distances,[12,0,6,Infinity]);
  roads[1].speed=1; roads[0].from=3;
  assert.deepEqual((await solve(free,0)).distances,[0,10,6,Infinity],'input mutations do not change uploaded graph');
  const hops=await bfs(free,0);
  assert.deepEqual(Array.from(await hops.distances.read()),[0,1,1,-1]);
  hops.distances.dispose();hops.predecessors.dispose();
  const components=await connectedComponents(free);
  assert.equal(components.count,2);assert.deepEqual(Array.from(await components.labels.read()),[0,0,0,1]);components.labels.dispose();
});

test('reverse links, parallel minimum costs, self loops, curved arc length and defaults',async()=>{
  using gpu=await createCompute({backend:'cpu'});
  using g=roadGraph(gpu,{vertices:3,roads:[
    {from:1,to:0,curve:curve(10),speed:2,direction:'reverse'},
    {from:0,to:1,curve:curve(10),speed:1,direction:'forward'},
    {from:1,to:1,curve:curve(1)},
  ]});
  assert.deepEqual((await solve(g,0)).distances,[0,5,Infinity]);
  assert.deepEqual((await solve(g,1)).distances,[Infinity,0,Infinity]);
  const bend=new Spline([[0,0,0],[4,3,0],[4,3,8]]);
  using defaults=roadGraph(gpu,{vertices:2,roads:[{from:0,to:1,curve:bend}]});
  assert.equal((await solve(defaults,0)).distances[1],Math.fround(bend.length/(50/3.6)));
  assert.equal((await solve(defaults,1)).distances[0],Math.fround(bend.length/(50/3.6)));
});

test('empty and maximum topology, normal float32 costs, hostile values and abort ownership',async()=>{
  using gpu=await createCompute({backend:'cpu'});
  using empty=roadGraph(gpu,{vertices:0}); assert.equal(empty.nnz,0);assert.deepEqual(empty.shape,[0,0]);
  using isolated=roadGraph(gpu,{vertices:2});assert.deepEqual((await solve(isolated,0)).distances,[0,Infinity]);
  const base={from:0,to:1,curve:curve(1),speed:1};
  const bad=e=>e.code==='failed' && /https:/.test(e.message);
  for(const vertices of [-1,NaN,Infinity,1.5,65537])assert.throws(()=>roadGraph(gpu,{vertices}),bad);
  for(const roads of [null,{},[null],Array(1)])assert.throws(()=>roadGraph(gpu,{vertices:2,roads}),bad);
  for(const change of [{from:-1},{to:2},{from:NaN},{to:0.5},{speed:0},{speed:Infinity},{speed:NaN},{speed:-1},
    {curve:{length:0}},{curve:{length:Infinity}},{curve:{length:NaN}},{curve:null},
    {traffic:0},{traffic:Infinity},{traffic:NaN},{delay:-1},{delay:Infinity},{delay:NaN},{direction:'left'},
    {curve:{length:Number.MIN_VALUE}},{curve:{length:Number.MAX_VALUE}},{speed:Number.MIN_VALUE}])
    assert.throws(()=>roadGraph(gpu,{vertices:2,roads:[{...base,...change}]}),bad);
  using tiny=roadGraph(gpu,{vertices:2,roads:[{...base,curve:{length:2**-126}}]});
  assert.equal((await solve(tiny,0)).distances[1],2**-126);
  using huge=roadGraph(gpu,{vertices:2,roads:[{...base,curve:{length:2**126}}]});
  assert.equal((await solve(huge,0)).distances[1],2**126);
  const many=Array.from({length:65536},(_,i)=>({...base,from:i,to:(i+1)%65536}));
  using maximum=roadGraph(gpu,{vertices:65536,roads:many});assert.equal(maximum.nnz,131072);
  assert.throws(()=>roadGraph(gpu,{vertices:2,roads:[...many,base]}),bad);
  const signal=AbortSignal.abort(new Error('cancel graph'));assert.throws(()=>roadGraph(gpu,{vertices:2,roads:[base],signal}),/cancel graph/);
  const controller=new AbortController();
  assert.throws(()=>roadGraph(gpu,{vertices:2,roads:[{...base,curve:{get length(){controller.abort(new Error('cancel before upload'));return 1;}}}],signal:controller.signal}),/cancel before upload/);
  using alive=roadGraph(gpu,{vertices:2,roads:[base]});alive.dispose();alive.dispose();
  assert.equal(gpu.disposed,false,'graph disposal does not own caller context');
  assert.deepEqual((await solve(isolated,1)).distances,[Infinity,0]);
});
