import assert from 'node:assert/strict';
import test from 'node:test';
import { MultiGoalIKSolver } from '../dist/multi-goal.js';

const near=(a,b,e=1e-5)=>assert.ok(Math.abs(a-b)<=e,`${a} vs ${b}`);
const distance=(a,b)=>Math.hypot(...a.map((v,k)=>v-b[k]));
const z=angle=>[0,0,Math.sin(angle/2),Math.cos(angle/2)];
const frame=(joint,position=[0,0,0])=>({joint,position});
const revolute=(parent=-1,position=[0,0,0],value=0)=>({type:'revolute',parent,position,value});
const slider=(axis,parent=-1,position=[0,0,0])=>({type:'prismatic',axis,parent,position,min:-4,max:4});
const solved=r=>{
  assert.equal(r.resolved,true,JSON.stringify(r));
  assert.equal(r.status,'converged');
  for(const e of [...r.goals,...r.loops]) { assert.ok(e.position<=1e-5); assert.ok(e.orientation<=1e-5); }
  assert.ok(r.values.every(Number.isFinite));
  return r;
};

test('shared ancestors satisfy simultaneous branch goals, independent of goal order',()=>{
  const solver=new MultiGoalIKSolver([slider([1,0,0]),slider([0,1,0],0,[0,1,0]),slider([0,0,1],0,[0,-1,0])]);
  const goals=[{frame:frame(1),position:[1,2,0]},{frame:frame(2),position:[1,-1,2]}];
  const a=solved(solver.solve({goals})), b=solved(solver.solve({goals:[...goals].reverse()}));
  a.values.forEach((v,k)=>near(v,b.values[k]));
  a.values.forEach((v,k)=>near(v,[1,1,2][k]));
});

test('conflicting weighted goals return the least-squares compromise without claiming success',()=>{
  const solver=new MultiGoalIKSolver([slider([1,0,0])]);
  const r=solver.solve({goals:[{frame:frame(0),position:[0,0,0]},{frame:frame(0),position:[2,0,0],positionWeight:3}]});
  assert.equal(r.resolved,false);
  assert.equal(r.status,'stalled');
  near(r.values[0],1.5,1e-6);
  near(r.objective,3,1e-8);
});

test('mixed revolute/prismatic joints use local axes after rest orientation',()=>{
  const solver=new MultiGoalIKSolver([
    {type:'fixed',position:[2,3,4],rotation:z(Math.PI/2)},
    {...slider([1,0,0],0),rotation:z(-Math.PI/2),min:0,max:3},
    revolute(1,[1,0,0]),
  ]);
  const r=solved(solver.solve({goals:[{frame:frame(2,[1,0,0]),position:[4,4,4],rotation:z(Math.PI/2)}]}));
  near(r.values[1],1);
  near(r.values[2],Math.PI/2);
});

test('five-bar closed chain follows multiple goals while both independently computed tips coincide',()=>{
  const joints=[revolute(-1,[-1,0,0],0.7),revolute(0,[1,0,0],0.7),revolute(-1,[1,0,0],2.4),revolute(2,[1,0,0],-0.7)];
  const solver=new MultiGoalIKSolver(joints,{candidates:8,iterations:256});
  for(const target of [[0,1.2,0],[0.25,1,0],[-0.3,0.8,0]]) {
    const r=solved(solver.solve({goals:[{frame:frame(1,[1,0,0]),position:target},{frame:frame(3,[1,0,0]),position:target}],loops:[{a:frame(1,[1,0,0]),b:frame(3,[1,0,0])}]}));
    const [a,b,c,d]=r.values;
    const left=[-1+Math.cos(a)+Math.cos(a+b),Math.sin(a)+Math.sin(a+b),0];
    const right=[1+Math.cos(c)+Math.cos(c+d),Math.sin(c)+Math.sin(c+d),0];
    assert.ok(distance(left,right)<=1e-5);
    assert.ok(distance(left,target)<=1e-5);
    assert.ok(distance(right,target)<=1e-5);
  }
});

test('two loops, mixed joints and a world pin are optimized together',()=>{
  const solver=new MultiGoalIKSolver([
    slider([1,0,0]),slider([0,1,0],0),
    slider([1,0,0],-1,[2,0,0]),slider([0,1,0],2),
    slider([1,0,0],-1,[-2,0,0]),slider([0,1,0],4),
  ]);
  const r=solved(solver.solve({loops:[
    {a:frame(1),b:frame(3)}, {a:frame(3),b:frame(5)},
    {a:frame(5),b:frame(-1,[0.5,1,0])},
  ]}));
  for(const i of [1,3,5]) assert.ok(distance(r.poses[i].position,[0.5,1,0])<=1e-5);
});

test('full pose closures and six scalar DOFs support spatial transforms',()=>{
  const joints=[slider([1,0,0]),slider([0,1,0],0),slider([0,0,1],1),
    {...revolute(2),axis:[1,0,0]}, {...revolute(3),axis:[0,1,0]}, revolute(4)];
  const solver=new MultiGoalIKSolver(joints);
  const known=[0.4,-0.3,0.8,0.7,-0.5,1.2], target=solver.evaluate(known,frame(5,[0.2,0.3,0.1]))[0];
  const r=solved(solver.solve({loops:[{a:frame(5,[0.2,0.3,0.1]),b:{joint:-1,...target},orientation:true}]}));
  assert.ok(distance(r.poses[2].position,known.slice(0,3))<=1e-5);
});

test('orientation only, quaternion antipodes and exact pi rotation stay finite',()=>{
  const solver=new MultiGoalIKSolver([revolute()]);
  for(const angle of [Math.PI,-Math.PI,Math.PI-1e-6,0.9]) {
    for(const sign of [1,-1]) {
      const rotation=z(angle).map(v=>v*sign);
      const r=solved(solver.solve({goals:[{frame:frame(0),rotation}]}));
      near(Math.cos(r.values[0]),Math.cos(angle));
      near(Math.sin(r.values[0]),Math.sin(angle));
    }
  }
});

test('masks constrain selected channels and report physical errors independently of weights',()=>{
  const solver=new MultiGoalIKSolver([slider([1,0,0]),revolute(0)]);
  const r=solved(solver.solve({goals:[{frame:frame(1),position:[1,999,999],positionAxes:[true,false,false],rotation:z(0.8),orientationAxes:[false,false,true],positionWeight:1e-8}]}));
  near(r.values[0],1); near(r.values[1],0.8);
  const failed=solver.solve({goals:[{frame:frame(1),position:[9,0,0],positionWeight:1e-12}]});
  assert.equal(failed.resolved,false);
  assert.ok(failed.goals[0].position>1);
});

test('joint limits stay hard, equal bounds lock joints and active bound re-solves other DOFs',()=>{
  const solver=new MultiGoalIKSolver([
    {...slider([1,0,0]),min:0,max:0.2},slider([1,1,0],0),
    {...revolute(1),min:0.3,max:0.3,value:0.3},
  ]);
  const r=solved(solver.solve({goals:[{frame:frame(2),position:[1,1,0]}]}));
  near(r.values[0],0); near(r.values[1],Math.SQRT2); near(r.values[2],0.3);
  const impossible=solver.solve({goals:[{frame:frame(0),position:[3,0,0]}]});
  assert.equal(impossible.resolved,false); near(impossible.values[0],0.2);
});

test('unreachable singular chains and conflicting closures remain bounded without false success',()=>{
  const solver=new MultiGoalIKSolver([revolute(),revolute(0,[1,0,0])]);
  const r=solver.solve({goals:[{frame:frame(1,[1,0,0]),position:[5,0,0]}]});
  assert.equal(r.resolved,false); near(r.objective,9);
  const conflict=solver.solve({loops:[{a:frame(0),b:frame(-1,[1,0,0])}]});
  assert.equal(conflict.resolved,false); near(conflict.loops[0].position,1);
});

test('deterministic seeds escape the straight chain stationary point',()=>{
  const solver=new MultiGoalIKSolver([revolute(),revolute(0,[1,0,0]),revolute(1,[1,0,0])]);
  const request={goals:[{frame:frame(2,[1,0,0]),position:[1,0,0]}]};
  const r=solved(solver.solve(request));
  assert.ok(r.candidates>1);
  assert.deepEqual(r,solver.solve(request));
});

test('unordered topology, warm starts, fixed-only and empty requests have owned deterministic outputs',()=>{
  const joints=[{type:'fixed',parent:1,position:[1,0,0]},revolute()];
  const solver=new MultiGoalIKSolver(joints);
  joints[0].position[0]=999;
  const request={values:[0,0.2],goals:[{frame:frame(0),position:[0,1,0]}]};
  const before=structuredClone(request), r=solved(solver.solve(request));
  assert.deepEqual(request,before);
  const warm=solved(solver.solve({...request,values:r.values}));
  assert.equal(warm.iterations,0);
  r.values[1]=999; r.poses[0].position[0]=999;
  assert.ok(distance(solver.evaluate([0,Math.PI/2])[0].position,[0,1,0])<1e-10);
  assert.equal(solver.solve().resolved,true);
  const fixed=new MultiGoalIKSolver([{type:'fixed'}]);
  assert.equal(fixed.solve({goals:[{frame:frame(0),position:[1,0,0]}]}).resolved,false);
});

test('iteration budget is explicit and cancellation propagates its reason',()=>{
  const solver=new MultiGoalIKSolver([slider([1,0,0])],{iterations:1,candidates:1,maxStep:0.01});
  const r=solver.solve({goals:[{frame:frame(0),position:[1,0,0]}]});
  assert.equal(r.status,'iteration-limit'); assert.equal(r.iterations,1);
  const controller=new AbortController(), reason=new Error('cancelled'); controller.abort(reason);
  assert.throws(()=>solver.solve({signal:controller.signal}),e=>e===reason);
});

test('implicit numerical scalar envelope remains valid for warm starts and forward evaluation',()=>{
  const solver=new MultiGoalIKSolver([{type:'prismatic',axis:[1,0,0],position:[-1e6,0,0],value:1e6}]);
  const r=solver.solve({goals:[{frame:frame(0),position:[1,0,0]}]});
  assert.equal(r.resolved,false);
  assert.equal(r.values[0],1e6);
  assert.doesNotThrow(()=>solver.evaluate(r.values));
  assert.doesNotThrow(()=>solver.solve({values:r.values}));
});

test('malformed data rejects rather than returning nonfinite or silently unconstrained results',()=>{
  for(const joints of [[],[{type:'bad'}],[revolute(0)],[revolute(1),revolute(0)],
    [{type:'revolute',axis:[0,0,0]}],[{type:'prismatic',min:1,max:0}],
    [{type:'fixed',value:1}],[{type:'fixed',rotation:[0,0,0,0]}],[{type:'fixed',position:[NaN,0,0]}]]) assert.throws(()=>new MultiGoalIKSolver(joints),/valid bounded IK data/);
  for(const options of [{iterations:0},{candidates:65},{damping:0},{maxStep:NaN},{positionTolerance:0},{orientationTolerance:Infinity}]) assert.throws(()=>new MultiGoalIKSolver([revolute()],options));
  const solver=new MultiGoalIKSolver([slider([1,0,0])]);
  for(const request of [{values:[]},{values:[5]},{goals:[{frame:frame(2),position:[0,0,0]}]},
    {goals:[{frame:frame(0)}]},{goals:[{frame:frame(0),position:[0,0,0],positionWeight:-1}]},
    {goals:[{frame:frame(0),position:[0,0,0],positionAxes:[false,false,false]}]},
    {goals:[{frame:frame(0),rotation:[Infinity,0,0,1]}]},
    {loops:[{a:frame(0),b:frame(-1),position:false}]},
    {loops:[{a:frame(0),b:frame(-1),orientation:'yes'}]}]) assert.throws(()=>solver.solve(request));
  assert.throws(()=>solver.evaluate([NaN]));
});
