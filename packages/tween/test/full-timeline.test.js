import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../dist/full-timeline.js';
const near = (a, b) => assert.ok(Math.abs(a-b) < 1e-10, `${a} vs ${b}`);

test('mixed arrays, paths, custom and scalars share labels and one clock', () => {
  const object = {x: 0}, array = [0, 0], point = [0, 0];
  let progress = 0, calls = 0;
  const timeline = new Timeline().to(object, 'x', 10, {duration: 1})
    .label('next')
    .array(array, [2, 4], {duration: 2, at: 'next'})
    .path(point, (t, out) => { out[0] = t; out[1] = t*t; return out; }, {duration: 2, at: 'next'})
    .custom((t) => { progress = t; }, {duration: 2, at: 'next'})
    .call(() => calls++, 'next+1');
  assert.equal(timeline.duration, 3);
  timeline.seek(2);
  assert.equal(object.x, 10);
  assert.deepEqual(array, [1,2]);
  assert.deepEqual(point, [0.5,0.25]);
  assert.equal(progress, 0.5);
  assert.equal(calls, 0);
  timeline.seek(0);
  assert.equal(object.x, 0);
  assert.deepEqual(array, [0,0]);
  assert.deepEqual(point, [0,0]);
  timeline.play().update(3);
  assert.deepEqual(array, [2,4]);
  assert.equal(calls, 1);
});

test('first seek chains array starts, reverse seeks restore and input arrays are snapshotted', () => {
  const value = [0], end = [10];
  const timeline = new Timeline().array(value, end, {duration: 1}).array(value, [20], {duration: 1});
  end[0] = 100;
  timeline.seek(1.5);
  assert.equal(value[0], 15);
  timeline.seek(0.5);
  assert.equal(value[0], 5);
  timeline.seek(1.5);
  assert.equal(value[0], 15);
});

test('nested timeline clocks multiply once, preserve repeats and callbacks', () => {
  const object = {x: 0};
  let calls = 0;
  const child = new Timeline({speed: 2, repeat: 1, yoyo: true})
    .to(object, 'x', 10, {duration: 2}).call(() => calls++, 1);
  const parent = new Timeline({speed: 2}).add(child, 1);
  assert.equal(parent.duration, 3);
  parent.seek(1.5);
  near(object.x, 5);
  assert.equal(calls, 0);
  parent.seek(0).play().update(1.5);
  assert.equal(parent.playing, false);
  assert.equal(object.x, 0);
  assert.equal(calls, 2);
  child.speed = 4;
  assert.equal(parent.duration, 2);
});

test('multi-pass overshoot has identical final values and crossings to split updates', () => {
  const run = (deltas) => {
    const value = {x: 0}, events = [];
    const timeline = new Timeline({repeat: 2, yoyo: true, onComplete: () => events.push('done')})
      .to(value, 'x', 10, {duration: 1}).call(() => events.push('middle'), 0.5).play();
    for (const delta of deltas) timeline.update(delta);
    return {value,events,time: timeline.time,playing: timeline.playing};
  };
  assert.deepEqual(run([3]), run([0.25,0.75,1,1]));
  assert.deepEqual(run([3]).events, ['middle','middle','middle','done']);
});

test('play after completion resets repeats; callbacks are forbidden from editing clocks', async () => {
  const value = {x: 0};
  let calls = 0;
  const timeline = new Timeline({repeat: 1}).to(value,'x',10,{duration:1}).call(() => calls++,0.5).play();
  timeline.update(2);
  timeline.play().update(2);
  assert.equal(calls, 4);
  const bad = new Timeline().call(() => bad.seek(0), 0).play();
  const rejected=assert.rejects(bad.finished,error=>error.code==='state');
  assert.throws(() => bad.update(0), (error) => error.code === 'state');
  await rejected;
});

test('no cycles, dual parents or invalid speeds; infinite children keep running', () => {
  const parent = new Timeline(), child = new Timeline();
  assert.throws(() => parent.add(parent), (error) => error.code === 'state');
  parent.add(child);
  assert.throws(() => child.add(parent), (error) => error.code === 'state');
  assert.throws(() => new Timeline().add(child), (error) => error.code === 'state');
  assert.throws(() => { child.speed = 0; }, RangeError);
  parent.remove(child);
  new Timeline().add(child);
  let progress = 0;
  const infinite = new Timeline({repeat: Infinity}).custom((t) => { progress = t; }, {duration:1});
  const endless = new Timeline().add(infinite).play();
  assert.equal(endless.duration, Infinity);
  endless.update(2.5);
  assert.equal(progress, 0.5);
  assert.equal(endless.playing, true);
});

test('first large seek captures overlapping starts at their entry time', () => {
  const value={x:0};
  const timeline=new Timeline().to(value,'x',10,{duration:2}).to(value,'x',20,{duration:1,at:1});
  timeline.seek(1.5);
  assert.equal(value.x,12.5);
  timeline.seek(0.5);
  assert.equal(value.x,2.5);
  timeline.seek(1.5);
  assert.equal(value.x,12.5);
});

test('nested callbacks are globally ordered and observe their own sample', async () => {
  const value={x:0}, events=[];
  const child=new Timeline({onComplete:()=>events.push(['child-end',value.x])})
    .to(value,'x',10,{duration:1}).call(()=>events.push(['child',value.x]),0.5);
  const parent=new Timeline().add(child,0).call(()=>events.push(['parent',value.x]),0.75).play();
  parent.update(1);
  await Promise.all([child,parent]);
  assert.deepEqual(events,[['child',5],['parent',7.5],['child-end',10]]);
});

test('aborting during a callback suppresses later events and preserves the sample', async () => {
  const controller=new AbortController(), value={x:0}, events=[];
  const timeline=new Timeline({signal:controller.signal,onComplete:()=>events.push('done')})
    .to(value,'x',10,{duration:1}).call(()=>controller.abort('stop'),0.5).call(()=>events.push('late'),0.75).play();
  const rejected=assert.rejects(timeline.finished, reason=>reason==='stop');
  timeline.update(1);
  await rejected;
  assert.equal(value.x,5);
  timeline.update(1);
  assert.equal(value.x,5);
  assert.deepEqual(events,[]);
});

test('nested callback cannot edit its ancestor and errors reject the owning promise', async () => {
  const parent=new Timeline(), child=new Timeline().call(()=>parent.label('bad'),0);
  parent.add(child).play();
  const rejected=assert.rejects(parent.finished,reason=>reason.code==='state');
  assert.throws(()=>parent.update(0),reason=>reason.code==='state');
  await rejected;
});

test('replay renews descendant completion and repeats; seek does not finish', async () => {
  let calls=0;
  const child=new Timeline({repeat:1,onComplete:()=>calls++}).custom(()=>{},{duration:1});
  const parent=new Timeline().add(child).play();
  parent.seek(2);
  let settled=false;
  parent.finished.then(()=>{settled=true;});
  await Promise.resolve();
  assert.equal(settled,false);
  parent.seek(0).update(2);
  await Promise.all([child,parent]);
  const old=child.finished;
  parent.play();
  assert.notEqual(child.finished,old);
  parent.update(2);
  await Promise.all([child,parent]);
  assert.equal(calls,2);
});
