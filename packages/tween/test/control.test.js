import test from 'node:test';
import assert from 'node:assert/strict';
import { TweenControl } from '../dist/control.js';

test('auto overwrite replaces x while the original y keeps its own clock', async () => {
  const control = new TweenControl(), target = {x:0,y:0};
  const first = control.to(target,{x:10,y:20},{duration:2});
  control.update(0.5);
  const next = control.to(target,{x:100},{duration:1});
  assert.deepEqual(first.keys,['y']);
  control.update(1);
  assert.equal(target.x,100);
  assert.equal(target.y,15);
  await next;
  control.update(0.5);
  await first;
  assert.equal(target.y,20);
  assert.deepEqual(control.getTweensOf(target),[]);
});

test('kill by key includes delayed and paused work; pause affects just one group', async () => {
  const control = new TweenControl(), a = {x:0,y:0}, b = {x:0};
  const first = control.to(a,{x:10,y:20},{duration:1,delay:1}).pause();
  const other = control.to(b,{x:5},{duration:1});
  assert.equal(control.killTweensOf(a,['x']),1);
  control.update(1);
  await other;
  assert.deepEqual(a,{x:0,y:0});
  first.play();
  control.update(1.5);
  assert.deepEqual(a,{x:0,y:10});
  control.update(0.5);
  await first;
  assert.equal(a.y,20);
});

test('global and local speed multiply and zero holds even zero-duration work', async () => {
  const control = new TweenControl(), a={x:0}, b={x:0};
  const first = control.to(a,{x:10},{duration:2});
  const second = control.to(b,{x:20},{duration:2});
  control.timeScale=2;
  first.speed=0.5;
  control.update(0.5);
  assert.equal(a.x,2.5);
  assert.equal(b.x,10);
  control.timeScale=0;
  control.update(1);
  assert.equal(a.x,2.5);
  control.timeScale=2;
  control.update(1.5);
  await Promise.all([first,second]);
  assert.equal(a.x,10);
  assert.equal(b.x,20);
});

test('all overwrite and explicit kill reject wholly removed work; invalid inputs do not replace', async () => {
  const control=new TweenControl(), target={x:0,y:0};
  const first=control.to(target,{x:10,y:20},{duration:1});
  assert.throws(()=>control.to(target,{x:NaN},{duration:1}),RangeError);
  control.update(0.5);
  assert.deepEqual(target,{x:5,y:10});
  const rejected=assert.rejects(first.finished,{name:'AbortError'});
  const next=control.to(target,{x:100},{duration:1,overwrite:'all'});
  await rejected;
  const killed=assert.rejects(next.finished,{name:'AbortError'});
  assert.equal(control.killTweensOf(target),1);
  await killed;
});

test('abort reason reaches the group, completion observes final values once', async () => {
  const control=new TweenControl(), target={x:0,y:0}, controller=new AbortController();
  const move=control.to(target,{x:10,y:20},{duration:1,signal:controller.signal});
  const reason=new Error('abort');
  const rejected=assert.rejects(move.finished,(error)=>error===reason);
  control.update(0.5);
  controller.abort(reason);
  control.update(1);
  await rejected;
  assert.deepEqual(target,{x:5,y:10});
  let calls=0;
  const done=control.to(target,{x:10,y:20},{duration:1,onComplete:()=>{calls++;assert.deepEqual(target,{x:10,y:20});}});
  control.update(1);
  await done;
  assert.equal(calls,1);
});

test('repeat callbacks run once for the group after all target values are written', async () => {
  const control=new TweenControl(), target={x:0,y:0};
  let calls=0;
  const move=control.to(target,{x:10,y:20},{duration:1,repeat:1,onRepeat:()=>{
    calls++; assert.deepEqual(target,{x:5,y:10});
  }});
  control.update(1.5);
  assert.equal(calls,1);
  control.update(0.5);
  await move;
  assert.equal(calls,1);
});

test('cancellation in repeat suppresses completion and invalid callback options are atomic', async () => {
  const control=new TweenControl(), target={x:0,y:0};
  let completed=0, move;
  move=control.to(target,{x:10,y:20},{duration:1,repeat:1,onRepeat:()=>move.cancel(),onComplete:()=>completed++});
  const rejected=assert.rejects(move.finished,{name:'AbortError'});
  control.update(2);
  await rejected;
  assert.equal(completed,0);
  const before={...target};
  assert.throws(()=>control.to(target,{x:0},{duration:1,onComplete:42}),TypeError);
  assert.deepEqual(target,before);
});
