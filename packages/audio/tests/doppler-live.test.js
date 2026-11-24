import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioListener,PositionalAudio,AudioVoicePool} from '../dist/index.js';
import {AudioDoppler} from '../dist/doppler.js';
import {AudioEventContainer} from '../dist/events.js';
import {FakeAudioContext,FakeMediaElement} from './fake-web-audio.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} vs ${b}`);
function live(t,{state='running',speedOfSound=343}={}) {
 const context=new FakeAudioContext({state});let wall=0;
 t.mock.method(performance,'now',()=>wall*1000);
 const listener=new AudioListener({context,smoothing:0,autoResume:false});listener.follow(null);
 const sound=new PositionalAudio(listener,{playbackRate:1.5,detune:100});
 sound.setBuffer(context.createBuffer(1,480000,48000)).setPosition(20,0,0).play();
 const control=new AudioDoppler(sound,{speedOfSound});listener.update();
 return {context,listener,sound,control,frame(time,audio=time){wall=time;context.currentTime=audio;listener.update();}};
}
test('live Doppler resumes neutrally after autoplay suspension, explicit suspension and hidden state changes',async t=>{
 const s=live(t,{state:'suspended'});
 s.sound.setPosition(10,0,0);s.frame(5,0);
 await s.context.resume();s.frame(5.01,.01);near(s.control.ratio,1);
 s.sound.setPosition(9.8,0,0);s.frame(5.02,.02);assert.ok(s.control.ratio>1);
 await s.context.suspend();s.sound.setPosition(100,0,0);s.frame(6,.02);
 await s.context.resume();s.frame(6.01,.03);near(s.control.ratio,1);
 // No render sample during suspension: the statechange event must invalidate history too.
 await s.context.suspend();s.sound.setPosition(100.1,0,0);await s.context.resume();
 s.frame(6.02,.04);near(s.control.ratio,1);s.listener.dispose();
});
test('live Doppler uses frame time with a quantized device clock, including unchanged audio times',t=>{
 const s=live(t);const expected=343/(343+20),ratios=[];
 for(let k=1;k<=120;k++) {
  const time=k/60;s.sound.setPosition(20+20*time,0,0);
  s.frame(time,Math.floor(time/.010667)*.010667);ratios.push(s.control.ratio);
 }
 ratios.forEach(ratio=>near(ratio,expected));
 s.sound.setPosition(60.2,0,0);s.frame(2.01,s.context.currentTime);near(s.control.ratio,expected);
 s.listener.dispose();
});
test('live Doppler treats camera/source cuts and render gaps as discontinuities',t=>{
 const s=live(t);s.sound.setPosition(1000,0,0);s.frame(1/60);near(s.control.ratio,1);
 s.listener.setPose([1000,20,0],[0,0,-1]);s.frame(2/60);near(s.control.ratio,1);
 s.sound.setPosition(1001,0,0);s.frame(2);near(s.control.ratio,1);
 s.sound.setPosition(1001.1,0,0);s.frame(2.01);assert.notEqual(s.control.ratio,1);s.listener.dispose();
});
test('Doppler source kind switches detach locally, restore authored pitch and allow later sources to update',t=>{
 const s=live(t);let after=0,frame=0;s.listener.addSource({update(){after++;},dispose(){}});
 for(const kind of ['node','media','stream']) {
  if(kind!=='node'){s.sound.setBuffer(s.context.createBuffer(1,48000,48000));s.control=new AudioDoppler(s.sound);}
  s.sound.setPosition(20,0,0);s.frame(frame);s.sound.setPosition(19,0,0);frame+=.01;s.frame(frame);assert.ok(s.control.ratio>1);
  if(kind==='node')s.sound.setNodeSource(s.context.createGain());
  else if(kind==='media')s.sound.setMediaElementSource(new FakeMediaElement());
  else s.sound.setMediaStreamSource({});
  const before=after;assert.doesNotThrow(()=>s.listener.update());assert.equal(after,before+1);
  near(s.sound.playbackRate,1.5);assert.throws(()=>s.control.update(),e=>e.code==='disposed');
 }
 s.listener.dispose();
});
test('Doppler composes pool per-play rates even when an authored write equals the previous effective rate',t=>{
 const s=live(t,{speedOfSound:100});s.control.dispose();s.sound.dispose();
 const pool=new AudioVoicePool(s.listener,s.context.createBuffer(1,480000,48000),{voices:1,playbackRate:1.5});
 const voice=pool.play([10,0,0]),control=new AudioDoppler(voice,{speedOfSound:100});s.frame(0);
 voice.setPosition(9,0,0);s.frame(.1);near(control.ratio,100/90);
 const authored=voice.playbackRate;assert.equal(pool.play([9,0,0],{playbackRate:authored}),voice);
 near(control.playbackRate,authored);near(voice.playbackRate,authored*control.ratio);
 s.frame(.2);near(voice.playbackRate,authored);
 pool.play([9,0,0],{playbackRate:.75});s.frame(.3);near(control.playbackRate,.75);near(voice.playbackRate,.75);
 const before=voice.source;assert.throws(()=>pool.play([3,0,0],{playbackRate:-1}),RangeError);
 assert.equal(voice.source,before);assert.equal(before.stopped,null);
 control.dispose();near(voice.playbackRate,.75);pool.dispose();s.listener.dispose();
});
test('Doppler adopts event-container random pitch on each reused voice',t=>{
 const s=live(t);s.control.dispose();s.sound.dispose();let draw=0;
 const events=new AudioEventContainer(s.listener,[s.context.createBuffer(1,480000,48000)],
  {mode:'sequence',voices:1,pitch:[0,1200],random:()=>draw});
 const voice=events.play([10,0,0]),control=new AudioDoppler(voice);s.frame(0);
 draw=.5;assert.equal(events.play([10,0,0]),voice);s.frame(.1);
 near(control.playbackRate,Math.SQRT2);near(voice.playbackRate,Math.SQRT2);
 draw=.75;events.play([10,0,0]);s.frame(.2);near(voice.playbackRate,2**.75);
 assert.throws(()=>{voice.playbackRate=-1;},RangeError);near(control.playbackRate,2**.75);
 events.dispose();s.listener.update();assert.throws(()=>control.update(),e=>e.code==='disposed');s.listener.dispose();
});
