import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {pinTimeline,scrollSnapPoint} from '../dist/scroll-pin.js';
const fixture=()=>{
  const dom=new JSDOM('<main><div id="pin" style="color: red"></div><p>after</p></main>',{pretendToBeVisual:true});
  const view=dom.window,pin=view.document.querySelector('#pin');
  let y=0,now=0,id=0;
  const frames=new Map(),samples=[];
  Object.defineProperty(view,'scrollY',{get:()=>y});
  Object.defineProperty(view.performance,'now',{value:()=>now});
  view.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};
  view.cancelAnimationFrame=key=>frames.delete(key);
  view.scrollTo=({top})=>{y=top;view.dispatchEvent(new view.Event('scroll'));};
  pin.getBoundingClientRect=()=>({top:100-y,width:400,height:200,left:0,right:400,bottom:300-y});
  const timeline={duration:2,labelTimes:new Map([['start',0],['middle',1],['end',2]]),pause(){this.paused=true;},seek(time){samples.push(time);}};
  const tick=ms=>{now+=ms;const work=[...frames.values()];frames.clear();for(const fn of work)fn(now);};
  return {view,pin,timeline,tick,samples,frames,close:()=>dom.window.close()};
};

test('snap stops select nearest and directional labels without mutating the list',()=>{
  const stops=[1,0.5,0];
  assert.equal(scrollSnapPoint(0.4,stops),0.5);
  assert.equal(scrollSnapPoint(0.4,stops,-1),0);
  assert.equal(scrollSnapPoint(0.6,stops,1),1);
  assert.deepEqual(stops,[1,0.5,0]);
  assert.throws(()=>scrollSnapPoint(0.5,[]),RangeError);
  assert.throws(()=>scrollSnapPoint(0.5,[NaN]),RangeError);
});

test('pin range follows both directions, reserves spacing and restores exact DOM/styles',()=>{
  const f=fixture(),parent=f.pin.parentNode,next=f.pin.nextSibling,style=f.pin.getAttribute('style');
  const link=pinTimeline(f.timeline,{pin:f.pin,distance:1000});
  assert.equal(f.timeline.paused,true);
  assert.equal(f.pin.parentNode.style.height,'1200px');
  f.view.scrollTo({top:600});
  assert.equal(link.progress,0.5);
  assert.equal(f.pin.style.top,'500px');
  f.view.scrollTo({top:100});
  assert.equal(link.progress,0);
  f.view.scrollTo({top:1400});
  assert.equal(f.pin.style.top,'1000px');
  link.dispose();link.dispose();
  assert.equal(f.pin.parentNode,parent);
  assert.equal(f.pin.nextSibling,next);
  assert.equal(f.pin.getAttribute('style'),style);
  assert.equal(f.frames.size,0);
  const count=f.samples.length;
  f.view.scrollTo({top:0});
  assert.equal(f.samples.length,count);
  f.close();
});

test('idle label snap animates the actual scroll, and user input interrupts it',()=>{
  const f=fixture();
  const link=pinTimeline(f.timeline,{pin:f.pin,distance:1000,snap:'labels',snapDelay:0.1,snapDuration:0.2});
  f.view.scrollTo({top:530});
  f.tick(50);
  assert.equal(link.progress,0.43);
  f.tick(50);
  assert.equal(link.snapping,true);
  f.tick(100);
  assert.ok(link.progress>0.43 && link.progress<0.5);
  f.view.dispatchEvent(new f.view.Event('wheel'));
  const held=f.view.scrollY;
  f.tick(200);
  assert.equal(link.snapping,false);
  assert.equal(f.view.scrollY,held);
  f.view.scrollTo({top:530});f.tick(100);f.tick(200);
  assert.equal(f.view.scrollY,600);
  assert.equal(link.progress,0.5);
  link.dispose();f.close();
});

test('directional labels, interval and custom stops use normalized timeline progress',()=>{
  for(const snap of ['labelsDirectional',0.25,()=>0.75]) {
    const f=fixture(),link=pinTimeline(f.timeline,{pin:f.pin,distance:1000,snap,snapDelay:0,snapDuration:0});
    f.view.scrollTo({top:720});f.tick(1);
    assert.equal(link.progress,snap==='labelsDirectional'?1:snap===0.25?0.5:0.75);
    link.dispose();f.close();
  }
});

test('aborted attachment and invalid options leave DOM and timeline unchanged',()=>{
  const f=fixture(),parent=f.pin.parentNode,controller=new AbortController();controller.abort();
  const link=pinTimeline(f.timeline,{pin:f.pin,distance:1000,signal:controller.signal});
  assert.equal(f.pin.parentNode,parent);assert.equal(f.samples.length,0);assert.equal(f.timeline.paused,undefined);
  link.dispose();
  for(const options of [{distance:0},{snap:[]},{snap:0},{snap:'bad'},{scrub:-1}]) assert.throws(()=>pinTimeline(f.timeline,{pin:f.pin,...options}));
  assert.equal(f.pin.parentNode,parent);assert.equal(f.samples.length,0);
  f.close();
});

test('abort during idle removes all owned work; a tiny interval does not allocate reciprocal stops',()=>{
  const f=fixture(),controller=new AbortController();
  const link=pinTimeline(f.timeline,{pin:f.pin,distance:1000,snap:1e-15,signal:controller.signal});
  f.view.scrollTo({top:532});controller.abort();f.tick(1000);
  assert.equal(f.frames.size,0);assert.equal(link.snapping,false);
  assert.equal(f.pin.parentNode.tagName,'MAIN');
  f.close();
});
