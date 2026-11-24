import test from 'node:test';
import assert from 'node:assert/strict';
import { createPitchShift, createBusPitchShift } from '@margoengine/mixer/pitch';
import { Mixer, biquadCoefficients, biquadMagnitude } from '@margoengine/mixer';
import { processorHarness, processAudio } from './processor-harness.js';

const tone=(hz,n=96000)=>Float32Array.from({length:n},(_,i)=>.2*Math.sin(2*Math.PI*hz*i/48000));
function frequency(data,from=12000,to=data.length-1000){
  const crossings=[];for(let i=from+1;i<to;i++)if(data[i-1]<=0&&data[i]>0)crossings.push(i-1-data[i-1]/(data[i]-data[i-1]));
  return (crossings.length-1)*48000/(crossings.at(-1)-crossings[0]);
}
const rms=data=>Math.sqrt(data.reduce((sum,v)=>sum+v*v,0)/data.length);
test('transposition in both directions and fractional semitones preserves frame count and linked stereo',async t=>{
  const h=processorHarness(t),input=tone(400);
  for(const pitch of [-24,-12,-7,3.5,7,12,24,48]){
    using s=await createPitchShift(h.context,{pitch,windowSize:.1,antiAlias:false});
    const output=processAudio(h.worklets.at(-1).processor,[input,input.map(v=>-v*.5)],73);
    assert.equal(output[0].length,input.length);
    assert.ok(Math.abs(frequency(output[0])-400*2**(pitch/12))<.05,`pitch ${pitch}`);
    assert.ok(output[0].every((v,i)=>output[1][i]===-v*.5));
    assert.ok(output[0].every(Number.isFinite));
  }
});

test('unison and dry bypass are bit-identical, delay and feedback have exact frame boundaries, quantum size is irrelevant',async t=>{
  const h=processorHarness(t),input=tone(400,24000);
  for(const options of [{pitch:0},{pitch:7,mix:0}]){
    using a=await createPitchShift(h.context,options);
    assert.deepEqual(processAudio(h.worklets.at(-1).processor,[input,input]),[input,input]);
  }
  using a=await createPitchShift(h.context,{pitch:7});const first=processAudio(h.worklets.at(-1).processor,[input,input],17);
  using b=await createPitchShift(h.context,{pitch:7});assert.deepEqual(processAudio(h.worklets.at(-1).processor,[input,input],128),first);
  const impulse=new Float32Array(256);impulse[0]=1;
  using delay=await createPitchShift(h.context,{pitch:0,delayTime:2/48000,feedback:.5});
  const out=processAudio(h.worklets.at(-1).processor,[impulse,impulse])[0];
  for(let i=0;i<10;i++)assert.ok(Math.abs(out[2+2*i]-.5**i)<1e-6);
});

test('pitch shifting retains event times with only bounded wet delay, and complementary windows have unity DC gain',async t=>{
  const h=processorHarness(t),data=new Float32Array(96000);data.fill(.2,14400,28800);data.fill(.2,57600,72000);
  using s=await createPitchShift(h.context,{pitch:-12,antiAlias:false});
  const out=processAudio(h.worklets.at(-1).processor,[data,data])[0];
  assert.ok(out.slice(0,14400).every(v=>v===0));
  assert.ok(out.slice(33601,57600).every(v=>v===0),'silence between source events stays at source clock times');
  for(const [a,b]of [[19200,28800],[62400,72000]])assert.ok(out.slice(a,b).every(v=>Math.abs(v-.2)<1e-7));
  assert.ok(out.slice(76801).every(v=>v===0),'wet tail is bounded by one window');
});

test('upward anti-alias prefilter matches the fourth-order Butterworth magnitude',async t=>{
  const h=processorHarness(t),input=tone(18000,48000);
  const outputs=[];
  for(const antiAlias of [false,true]){
    using s=await createPitchShift(h.context,{pitch:12,antiAlias});
    outputs.push(processAudio(h.worklets.at(-1).processor,[input,input])[0].slice(12000));
  }
  const coefficients=biquadCoefficients('lowpass',48000,10800,-3.010299956639812);
  const expected=biquadMagnitude(coefficients,18000,48000)**2;
  assert.ok(Math.abs(rms(outputs[1])/rms(outputs[0])-expected)<1e-6);
});

test('pitch validates atomic scheduling, cancellation and bus-owned disposal',async t=>{
  const h=processorHarness(t);using m=new Mixer(h.context);
  using s=await createBusPitchShift(m.master);
  s.setPitch(7,{at:1,seconds:.2});assert.deepEqual(s.params.pitch.last(),{kind:'target',value:7,time:1,constant:.05});
  for(const [pitch,settings]of [[49,{}],[NaN,{}],[7,{at:-1}],[7,{seconds:Infinity}]]){
    const count=s.params.pitch.events.length;assert.throws(()=>s.setPitch(pitch,settings));assert.equal(s.params.pitch.events.length,count);
  }
  for(const options of [{windowSize:0},{feedback:1},{channels:1.5},{pitch:Infinity},{antiAlias:'yes'}])await assert.rejects(createPitchShift(h.context,options));
  m.dispose();s.dispose();assert.throws(()=>s.setPitch(0),{code:'disposed'});
  assert.equal(h.worklets[0].processor.active,false);
  const controller=new AbortController();controller.abort();await assert.rejects(createPitchShift(h.context,{signal:controller.signal}),{name:'AbortError'});
});
