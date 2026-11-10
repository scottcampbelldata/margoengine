import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, createExpander, expanderCurve, createMultibandCompressor, createBusDynamics } from '@margoengine/mixer/dynamics';
import { Mixer, biquadCoefficients, biquadProcess, compressorCurve } from '@margoengine/mixer';
import { processorHarness, processAudio } from './processor-harness.js';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} vs ${b}`);
test('gate uses linked detection, exact hysteresis/hold and gain time constants across render quanta',async t=>{
  const h=processorHarness(t);
  const x=new Float32Array(1024).fill(.01);x.fill(.2,10,20);x.fill(.08,20,30);
  using a=await createGate(h.context,{threshold:-20,hysteresis:6,hold:3/48000,attack:0,release:0});
  const out=processAudio(h.worklets[0].processor,[x,x.map(v=>v*.5)],7);
  for(let i=0;i<x.length;i++){
    assert.equal(out[0][i],i>=10&&i<33?x[i]:0);
    assert.equal(out[1][i],out[0][i]*.5);
  }
  using b=await createGate(h.context,{threshold:-20,hysteresis:6,hold:3/48000,attack:0,release:0});
  assert.deepEqual(processAudio(h.worklets[1].processor,[x,x.map(v=>v*.5)],128),out);
  using smooth=await createGate(h.context,{threshold:-20,attack:.01,hold:0});
  const steady=new Float32Array(512).fill(.2);
  const y=processAudio(h.worklets.at(-1).processor,[steady,steady])[0];
  for(const i of [0,1,100,479])near(y[i],steady[i]*(1-Math.exp(-(i+1)/480)));
});

test('expander exact hard/soft knees, range and makeup agree with closed-form levels',async t=>{
  const h=processorHarness(t);
  for(const knee of [0,6,30])for(const db of [-100,-60,-43,-40,-37,-20]){
    using a=await createExpander(h.context,{threshold:-40,knee,ratio:3,range:30,attack:0,release:0,makeup:2});
    const x=new Float32Array(128).fill(10**(db/20)),actualDb=20*Math.log10(x[0]),d=actualDb+40;
    const reduction=d < -knee/2?2*d:knee>0&&d<knee/2?-((d-knee/2)**2)/knee:0;
    const expected=actualDb+Math.max(-30,reduction)+2;
    near(expanderCurve(actualDb,{threshold:-40,knee,ratio:3,range:30,makeup:2}),expected,1e-10);
    const out=processAudio(h.worklets.at(-1).processor,[x,x.map(v=>-v*.5)]);
    near(out[0][64],10**(expected/20));assert.equal(out[1][64],-out[0][64]*.5);
  }
  assert.equal(expanderCurve(-Infinity,{ratio:1}),-Infinity);
  assert.throws(()=>expanderCurve(NaN));
});

function split(pcm,rate=48000){
  const pair=(x,type,hz)=>{const c=biquadCoefficients(type,rate,hz,-3.010299956639812);return biquadProcess(c,biquadProcess(c,x));};
  const lo=pair(pcm,'lowpass',250),hi=pair(pcm,'highpass',250);
  const ll=pair(lo,'lowpass',2500),lh=pair(lo,'highpass',2500);
  return [ll.map((v,i)=>v+lh[i]),pair(hi,'lowpass',2500),pair(hi,'highpass',2500)];
}

test('multiband LR4 phase compensation sums flat and per-band curves match an independent filter-bank calculation',async t=>{
  const h=processorHarness(t),pcm=Float32Array.from({length:16384},(_,i)=>i===0?.5:0);
  const bands=split(pcm),reference=bands[0].map((v,i)=>v+bands[1][i]+bands[2][i]);
  using unity=await createMultibandCompressor(h.context,{low:{ratio:1},mid:{ratio:1},high:{ratio:1}});
  const out=processAudio(h.worklets.at(-1).processor,[pcm,pcm],17)[0];
  out.forEach((v,i)=>near(v,reference[i]));
  for(const hz of [20,100,250,1000,2500,5000,15000]){
    let re=0,im=0;out.forEach((v,i)=>{re+=v*Math.cos(2*Math.PI*hz*i/48000);im-=v*Math.sin(2*Math.PI*hz*i/48000);});
    near(Math.hypot(re,im),.5,1e-6);
  }
  const input=Float32Array.from({length:4096},(_,i)=>.3*Math.sin(i*.023)+.2*Math.sin(i*.71));
  const filtered=split(input),settings=[{threshold:-30,knee:6,ratio:2},{threshold:-20,knee:0,ratio:4},{threshold:-25,knee:10,ratio:8}];
  using comp=await createMultibandCompressor(h.context,Object.fromEntries(['low','mid','high'].map((key,i)=>[key,{...settings[i],attack:0,release:0}])));
  const compressed=processAudio(h.worklets.at(-1).processor,[input,input.map(v=>-v*.5)])[0];
  for(let i=0;i<input.length;i++){
    let expected=0;for(let b=0;b<3;b++){const x=filtered[b][i],db=20*Math.log10(Math.abs(x));expected+=x===0?0:x*10**((compressorCurve(db,settings[b])-db)/20);}
    near(compressed[i],expected,3e-7);
  }
});

test('dynamics validates before graph edits, aborts and disposes with its bus',async t=>{
  const h=processorHarness(t);
  for(const options of [{crossovers:[300,200]},{crossovers:[0,2000]},{low:{ratio:0}},{channels:1.5}])await assert.rejects(createMultibandCompressor(h.context,options));
  await assert.rejects(createGate(h.context,{floor:Infinity}));
  using m=new Mixer(h.context);using stage=await createBusDynamics(m.master,{type:'expander'});
  m.dispose();assert.equal(h.worklets.at(-1).processor.active,false);assert.equal(stage.latencyFrames,0);
  const controller=new AbortController();controller.abort();await assert.rejects(createExpander(h.context,{signal:controller.signal}),{name:'AbortError'});
});
