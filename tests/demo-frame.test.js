import assert from 'node:assert/strict';
import {test} from 'node:test';
import {afterPresented} from '../packages/shared/demo-frame.js';

test('presentation waits for GPU completion and two frames, and cancels pending work', async () => {
  const previous={request:globalThis.requestAnimationFrame,cancel:globalThis.cancelAnimationFrame};
  const frames=new Map();let serial=0;
  globalThis.requestAnimationFrame=callback=>{frames.set(++serial,callback);return serial;};
  globalThis.cancelAnimationFrame=id=>frames.delete(id);
  const next=()=>{const [id,callback]=frames.entries().next().value;frames.delete(id);callback();};
  const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {queue:{onSubmittedWorkDone:()=>promise},resolve,reject};};
  try {
    const gpu=deferred(),abort=new AbortController();let presented=false;
    const wait=afterPresented(gpu.queue,abort.signal).then(()=>{presented=true;});
    assert.equal(frames.size,0,'Browser frames cannot outrun GPU compilation');
    gpu.resolve();await Promise.resolve();assert.equal(frames.size,1);
    next();await Promise.resolve();assert.equal(presented,false);
    next();await wait;assert.equal(presented,true);assert.equal(frames.size,0);

    for(const cancelAt of ['gpu','first-frame','second-frame']) {
      const pending=deferred(),controller=new AbortController(),reason=new Error(cancelAt);
      const aborted=assert.rejects(afterPresented(pending.queue,controller.signal),error=>error===reason);
      if(cancelAt!=='gpu'){pending.resolve();await Promise.resolve();if(cancelAt==='second-frame')next();}
      controller.abort(reason);await aborted;pending.resolve();await Promise.resolve();
      assert.equal(frames.size,0,'Cancellation left a scheduled frame at '+cancelAt);
    }
    const failed=deferred(),reason=new Error('Device lost');
    const rejected=assert.rejects(afterPresented(failed.queue,new AbortController().signal),error=>error===reason);
    failed.reject(reason);await rejected;assert.equal(frames.size,0);
    const already=new AbortController();already.abort(reason);
    await assert.rejects(afterPresented({onSubmittedWorkDone:()=>assert.fail('Aborted startup touched GPU')},already.signal),error=>error===reason);
  } finally {
    if(previous.request)globalThis.requestAnimationFrame=previous.request;else delete globalThis.requestAnimationFrame;
    if(previous.cancel)globalThis.cancelAnimationFrame=previous.cancel;else delete globalThis.cancelAnimationFrame;
  }
});
