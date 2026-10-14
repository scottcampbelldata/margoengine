import test from 'node:test';
import assert from 'node:assert/strict';
import {Spline} from '../../packages/splines/dist/index.js';
import {NavMesh} from '../../packages/navmesh/dist/index.js';
import {WFC} from '../../packages/wfc/dist/index.js';
import {createWorkload as splines} from './splines.js';
import {createWorkload as navmesh} from './navmesh.js';
import {createWorkload as wfc} from './wfc.js';

test('spline samples and followers exercise all three actual curve types and reuse buffers',()=>{
 const work=splines(96),points=work.points,yaw=work.yaw,curves=work.curves;
 try{
  assert.deepEqual(curves.map(curve=>curve.kind),['catmull-rom','bezier','hermite']);assert.ok(curves.every(curve=>curve instanceof Spline));
  assert.equal(points.length,96*4);const initial=points.slice(),fixed=points.slice(0,48*4);
  for(let i=0;i<10;i++)work.step(0.1);
  assert.equal(work.points,points);assert.equal(work.yaw,yaw);assert.deepEqual(points.slice(0,48*4),fixed);assert.notDeepEqual(points.slice(48*4),initial.slice(48*4));
  const details=work.details();assert.equal(details.followers,48);assert.equal(details.parameterQueries,24);assert.equal(details.tangentQueries,24);assert.equal(details.distanceQueries,48);
  for(let i=0;i<48;i++){
   const expected=curves[i%3].at(Math.floor(i/3)/15,new Float64Array(3));
   for(let axis=0;axis<3;axis++)assert.equal(points[i*4+axis],Math.fround(expected[axis]));
  }
  assert.ok(points.every(Number.isFinite)&&yaw.every(Number.isFinite));
 }finally{work.dispose();}assert.equal(work.curves,null);
});

test('navmesh agents use connected hole-avoiding funnel routes and bounded simultaneous ORCA updates',()=>{
 const work=navmesh(48),points=work.points;
 try{
  assert.ok(work.mesh instanceof NavMesh);assert.equal(work.agents.length,16);assert.equal(work.details().polygons,32);
  assert.equal(work.mesh.locate([0,0,0]),-1);assert.ok(work.paths.some(path=>path.length>2),'Blocked center must require a bent corridor');
  for(const path of work.paths)for(let i=1;i<path.length;i++)for(let t=0;t<=1;t+=0.1)assert.ok(work.mesh.locate(path[i].map((value,axis)=>value*t+path[i-1][axis]*(1-t)))>=0);
  const initial=points.slice(32*4);
  for(let frame=0;frame<12;frame++){
   const previous=work.agents.map(agent=>agent.position.slice());work.step(0.05);
   for(let i=0;i<work.agents.length;i++){
    const a=work.agents[i];assert.ok(Math.hypot(...a.velocity)<=a.maxSpeed+1e-9);assert.ok(Math.hypot(a.position[0]-previous[i][0],a.position[1]-previous[i][1])<=a.maxSpeed*0.05+1e-9);
    assert.ok(work.mesh.locate([a.position[0],0,a.position[1]])>=0);
    assert.equal(points[(i+32)*4],Math.fround(a.position[0]));assert.equal(points[(i+32)*4+2],Math.fround(a.position[1]));
   }
  }
  assert.notDeepEqual(points.slice(32*4),initial);assert.equal(work.details().avoidanceCalls,12*16);assert.ok(work.details().pathQueries>=16+12*4);assert.ok(work.details().neighborPairs>0);assert.equal(work.points,points);
 }finally{work.dispose();}assert.equal(work.mesh,null);assert.equal(work.agents,null);
});

test('WFC generated heights/colors satisfy actual reciprocal rules and pins across deterministic seeds',()=>{
 const work=wfc(),replay=wfc();
 try{
  assert.ok(work.generator instanceof WFC);assert.equal(work.points.length,64*4);assert.deepEqual(work.solution,replay.solution);assert.equal(work.details().generations,1);
  for(let frame=0;frame<22;frame++)work.step(0.1);
  assert.ok(work.details().generations>=3);assert.equal(work.details().constraintViolations,0);assert.notEqual(work.details().seed,replay.details().seed);
  const side=work.details().side;
  for(let z=0;z<side;z++)for(let x=0;x<side;x++){
   const i=x+side*z,tile=work.solution[i];assert.equal(work.points[i*4+3],tile);assert.equal(work.points[i*4+1],Math.fround(0.12+tile*0.22));
   if(x+1<side)assert.ok(work.tiles[tile].neighbors[0].includes(work.solution[i+1]));if(z+1<side)assert.ok(work.tiles[tile].neighbors[4].includes(work.solution[i+side]));
  }
  for(const pin of work.pins)assert.equal(work.solution[pin.position[0]+side*pin.position[2]],pin.tile);
  assert.ok(work.details().lastGenerationCpuMilliseconds>=work.details().lastSolveCpuMilliseconds);
 }finally{work.dispose();replay.dispose();}assert.equal(work.generator,null);assert.equal(work.solution,null);
});

test('new workloads reject invalid scales/times and disposal freezes visible output and counters',()=>{
 for(const[create,count,bad]of[[splines,96,1537],[navmesh,48,161],[wfc,64,1025]]){
  for(const invalid of[0,-1,1.5,NaN,bad])assert.throws(()=>create(invalid));const work=create(count);
  for(const delta of[-1,NaN,Infinity,0.101])assert.throws(()=>work.step(delta),/frame delta/);
  const points=work.points.slice(),details=work.details();work.dispose();work.dispose();work.step(0.1);assert.deepEqual(work.points,points);assert.deepEqual(work.details(),details);
 }
 assert.throws(()=>wfc(64,-1),/seed/);assert.throws(()=>wfc(17),/square/);
});
