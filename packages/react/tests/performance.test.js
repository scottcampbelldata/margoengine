import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceController } from '@margoengine/react/performance';
import { advanceFrames, bridgeFrames, frameOutput, FrameCallbacks, subscribeFrame, xrFrameScope } from '../dist/frame-priority.js';

function samples(controller, ms, windows = 1) { for(let i = 0; i < windows; i++) controller.sample(ms); }
test('measured frame windows lower and restore quality, publish averages and preserve a deadband', () => {
  const events = [], controller = new PerformanceController({ ms: 10, iterations: 2, step: 0.5, onChange: state => events.push(state.factor) });
  let renders = 0; const unsubscribe = controller.subscribe(() => renders++);
  samples(controller, 50, 2); assert.equal(controller.state.factor, 0.5); assert.equal(controller.state.fps, 20);
  samples(controller, 50, 2); assert.equal(controller.state.factor, 0);
  samples(controller, 18, 2); assert.equal(controller.state.factor, 0);
  samples(controller, 10, 2); assert.equal(controller.state.factor, 0.5);
  samples(controller, 10, 2); assert.equal(controller.state.factor, 1);
  assert.deepEqual(events, [0.5, 0, 0.5, 1]); assert.equal(renders, 10);
  assert.equal(controller.state.flips, 1); assert.equal(controller.state.refreshrate, 100);
  assert.equal(Object.isFrozen(controller.state.frames), true);
  unsubscribe(); controller.dispose(); assert.throws(() => controller.sample(10), {code: 'disposed'});
});
test('averages use total elapsed time, threshold counts windows, invalid samples and idle gaps do not regress quality', () => {
  const c = new PerformanceController({ ms: 100, iterations: 2, threshold: 1, step: 0.5 });
  const initial = c.state;
  for(const value of [NaN, Infinity, 0, -1]) c.sample(value);
  assert.equal(c.state, initial);
  c.sample(25); c.sample(75); assert.equal(c.state.fps, 20); assert.equal(c.state.factor, 1);
  c.clear(); for(let i=0;i<10;i++)c.sample(10);
  assert.equal(c.state.factor, 1); assert.deepEqual(c.state.averages, [100]);
  for(let i=0;i<10;i++)c.sample(10);
  assert.equal(c.state.factor, 1);
  c.reset(); assert.equal(c.state.fps, 0); assert.deepEqual(c.state.frames, []);
});
test('quality can recover at a sustained 60 Hz and fallback is stable after direction reversals', () => {
  const c = new PerformanceController({ ms: 10, iterations: 1, step: 1, flipflops: 0, fallbackFactor: 0.25 });
  const seen=[]; c.observe({onDecline:s=>seen.push(['down',s.factor]),onFallback:s=>seen.push(['fallback',s.factor])});
  c.sample(50); c.sample(1000/60);
  assert.equal(c.state.factor, 0.25); assert.equal(c.state.fallback, true);
  samples(c, 10, 10); assert.deepEqual(seen, [['down', 0], ['fallback', 0.25]]);
  c.reset(); assert.equal(c.state.fallback, false);
  const recovery = new PerformanceController({ms:10,iterations:1,factor:0,step:1}); recovery.sample(1000/60);
  assert.equal(recovery.state.factor,1);
});
test('active frames above 250 milliseconds are measured, while explicit idle reset discards stale windows', () => {
  const c=new PerformanceController({ms:250,iterations:1,step:1});c.sample(500);
  assert.equal(c.state.factor,0);assert.equal(c.state.fps,2);
  c.clear();c.sample(1000/60);assert.equal(c.state.factor,0);
});
test('configuration rejects invalid factors, windows, steps and bounds with coded diagnostics', () => {
  for(const options of [{ms:0},{iterations:1.5},{threshold:0},{factor:2},{step:0},{flipflops:-1},{fallbackFactor:NaN}])
    assert.throws(()=>new PerformanceController(options), RangeError);
  assert.throws(()=>new PerformanceController({ms:1,iterations:1,bounds:()=>[60,50]}).sample(10),RangeError);
});
test('presentation follows frame ownership and manual XR targets, never running on a suppressed automatic draw', () => {
  const draws=[], engine={ render(options){draws.push(options?.tag??'draw')},onFrame(){return()=>{}} }, frames={callbacks:new FrameCallbacks(),elapsed:0};
  const release=bridgeFrames(engine,frames), releaseOutput=frameOutput(frames,(options,render)=>{draws.push('present');render(options)});
  const remove=subscribeFrame(frames,()=>{},1);
  advanceFrames(frames,engine,0.016,true); engine.render(); assert.deepEqual(draws,[]);
  remove(); advanceFrames(frames,engine,0.016,true); engine.render(); assert.deepEqual(draws,['present','draw']);
  draws.length=0;
  xrFrameScope(frames,()=>engine.render({views:[],tag:'eyes'}),()=>engine.render());
  assert.deepEqual(draws,['present','eyes']);
  releaseOutput(); release();
});
test('presentation ownership reports coded missing-Canvas and duplicate-owner errors with a recovery action',()=>{
 const frames={callbacks:new FrameCallbacks(),elapsed:0},engine={render(){},onFrame(){return()=>{}}};
 assert.throws(()=>frameOutput(frames,()=>{}),{code:'state'});
 const release=bridgeFrames(engine,frames),stop=frameOutput(frames,()=>{});
 assert.throws(()=>frameOutput(frames,()=>{}),{code:'attached'});
 stop();frameOutput(frames,()=>{})();release();
});
