import test from 'node:test';
import assert from 'node:assert/strict';
import {VelocityTracker,inertia} from '../dist/inertia.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} vs ${b}`);

test('recent samples estimate release velocity; stale, equal-time and new drags are handled',()=>{
  const tracker=new VelocityTracker(0.1,4);
  tracker.sample(0,0).sample(1,0.02).sample(2,0.04).sample(3,0.06);
  near(tracker.velocity,50);
  tracker.sample(3,0.06);
  near(tracker.velocity,50);
  assert.equal(tracker.size,4);
  assert.equal(tracker.velocityAt(1),0);
  assert.throws(()=>tracker.sample(4,0.01),RangeError);
  assert.throws(()=>tracker.sample(NaN,0.07),RangeError);
  near(tracker.velocity,50);
  for(let i=7;i<100;i++)tracker.sample(i,i/100);
  assert.ok(tracker.size<=4);
  tracker.reset();assert.equal(tracker.size,0);assert.equal(tracker.velocity,0);
});

test('free decay follows the analytic trajectory and reaches the exact natural endpoint',async()=>{
  const value={x:10},move=inertia(value,'x',{velocity:20,resistance:2});
  assert.equal(move.end,20);
  assert.equal(move.velocity,20);
  move.update(0.5);
  near(value.x,10+10*(1-Math.exp(-1)));
  near(move.velocity,20*Math.exp(-1));
  move.update(10);await move;
  assert.equal(value.x,20);assert.equal(move.velocity,0);
});

test('partitioning elapsed time does not change the physical sample',()=>{
  const a={x:0},b={x:0};
  const first=inertia(a,'x',{velocity:20,resistance:2}),second=inertia(b,'x',{velocity:20,resistance:2});
  first.update(1);second.update(0.25);second.update(0.75);
  assert.equal(a.x,b.x);assert.equal(first.velocity,second.velocity);
  first.update(10);second.update(10);
});

test('a measured release and idle release use caller-supplied timestamps',async()=>{
  const tracker=new VelocityTracker().sample(0,0).sample(10,0.1),value={x:10};
  const move=inertia(value,'x',{velocity:tracker,releaseTime:0.1,resistance:5});
  assert.equal(move.velocity,100);assert.equal(move.end,30);
  move.update(10);await move;
  const idle=inertia(value,'x',{velocity:tracker,releaseTime:0.3});
  idle.update(0);await idle;assert.equal(value.x,30);
});

test('hard bounds stop a free throw without crossing the range',async()=>{
  const value={x:0};let completions=0;
  const move=inertia(value,'x',{velocity:100,resistance:2,min:0,max:10,onComplete:()=>completions++});
  move.update(0.5);await move;
  assert.equal(value.x,10);assert.equal(move.velocity,0);
  move.update(100);assert.equal(completions,1);
});

test('numeric, list and function endpoints finish exactly within bounds',async()=>{
  for(const end of [40,[0,20,40],projected=>{assert.equal(projected,35);return 40;}]){
    const value={x:5},move=inertia(value,'x',{velocity:60,resistance:2,min:0,max:40,end});
    assert.equal(move.end,40);
    move.update(0.2);assert.ok(value.x>5&&value.x<40);
    move.update(10);await move;assert.equal(value.x,40);
  }
});

test('bounded spring does not jump to an interior endpoint on first boundary contact',async()=>{
  const value={x:50},move=inertia(value,'x',{velocity:-1000,end:80,min:0,max:100});
  let done=false;move.finished.then(()=>{done=true;});
  move.update(0.1);assert.equal(value.x,0);
  await Promise.resolve();assert.equal(done,false);
  move.update(10);await move;assert.equal(value.x,80);
});

test('optional spring bounce carries velocity outside a bound before settling',async()=>{
  const value={x:0},move=inertia(value,'x',{velocity:80,resistance:8,min:0,max:10,end:10,bounce:0.4});
  move.update(0.2);assert.ok(value.x>10);
  move.update(10);await move;assert.equal(value.x,10);
});

test('pause/speed preserve local time and abort freezes the current sample',async()=>{
  const controller=new AbortController(),reason=new Error('release cancelled'),value={x:0};
  const move=inertia(value,'x',{velocity:20,resistance:2,signal:controller.signal});
  const rejected=assert.rejects(move.finished,error=>error===reason);
  move.pause().update(1);assert.equal(value.x,0);
  assert.throws(()=>move.update(NaN),RangeError);
  move.speed=2;move.play().update(0.25);
  near(value.x,10*(1-Math.exp(-1)));
  controller.abort(reason);const held=value.x;move.update(10);
  await rejected;assert.equal(value.x,held);
});

test('preabort and callback errors reject without hidden writes or completion',async()=>{
  const controller=new AbortController();controller.abort('stop');
  const value={x:0},move=inertia(value,'x',{velocity:20,signal:controller.signal});
  const aborted=assert.rejects(move.finished,error=>error==='stop');move.update(1);await aborted;assert.equal(value.x,0);
  const error=new Error('sample error'),bad=inertia(value,'x',{velocity:20,onUpdate:()=>{throw error;}});
  const failed=assert.rejects(bad.finished,reason=>reason===error);
  assert.throws(()=>bad.update(0.1),reason=>reason===error);await failed;
  let completed=0,cancelled;
  cancelled=inertia(value,'x',{velocity:0,onUpdate:()=>cancelled.cancel(),onComplete:()=>completed++});
  const stopped=assert.rejects(cancelled.finished,{name:'AbortError'});cancelled.update(0);await stopped;assert.equal(completed,0);
});

test('invalid requests are atomic and stored options are stable',async()=>{
  const value={x:1};
  for(const options of [{resistance:0},{velocity:NaN},{min:10,max:0},{end:[]},{end:[Infinity]},{bounce:1},{restSpeed:0},{maxDuration:0},{velocity:1e308,resistance:1e-308}]){
    assert.throws(()=>inertia(value,'x',{velocity:1,...options}),RangeError);assert.equal(value.x,1);
  }
  const options={velocity:20,resistance:2},move=inertia(value,'x',options);
  options.maxDuration=0.001;
  move.update(0.5);assert.ok(value.x<11);
  move.update(10);await move;assert.equal(value.x,11);
});
