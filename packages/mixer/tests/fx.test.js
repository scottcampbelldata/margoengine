import test from 'node:test';
import assert from 'node:assert/strict';
import { createFX, createFXChain, createBusFX } from '@margoengine/mixer/fx';
import { Mixer, biquadCoefficients, biquadProcess } from '@margoengine/mixer';
import { processorHarness, processAudio } from './processor-harness.js';

const near = (a, b, e = 1e-7) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
test('tremolo is exact audio-rate modulation with independent stereo spread and quantum-independent phase', async t => {
  const h = processorHarness(t);
  const pcm = [new Float32Array(48000).fill(0.2), new Float32Array(48000).fill(0.2)];
  using a = await createFX(h.context, { type: 'tremolo', rate: 2, depth: 0.8 });
  const out = processAudio(h.worklets[0].processor, pcm, 37);
  for (let i = 0; i < pcm[0].length; i++) {
    near(out[0][i], 0.2 * (0.6 + 0.4*Math.sin(4*Math.PI*i/48000)));
    near(out[1][i], 0.2 * (0.6 - 0.4*Math.sin(4*Math.PI*i/48000)));
  }
  using b = await createFX(h.context, { type: 'tremolo', rate: 2, depth: 0.8 });
  assert.deepEqual(processAudio(h.worklets[1].processor, pcm, 128), out);
});

test('chorus/flanger/vibrato fractional delays interpolate and feedback recurs below a render quantum', async t => {
  const h = processorHarness(t);
  const input = new Float32Array(512); input[0] = 1;
  for (const type of ['chorus','flanger','vibrato']) {
    using stage = await createFX(h.context, { type, time: 1.5/48000, depth: 0, mix: 1 });
    const data = processAudio(h.worklets.at(-1).processor, [input,input], 7)[0];
    near(data[0],0); near(data[1],.5); near(data[2],.5);
    assert.ok(data.slice(3).every(v=>v===0));
  }
  using stage = await createFX(h.context, { type: 'flanger', time: 2/48000, depth: 0, mix: 1, feedback: .5 });
  const data = processAudio(h.worklets.at(-1).processor, [input,input])[0];
  for (let i=0;i<16;i++) near(data[2+2*i],.5**i);
});

test('static phaser and auto-filter match independent RBJ filter convolution, and auto-pan follows stereo law', async t => {
  const h = processorHarness(t);
  const input = Float32Array.from({length:2048},(_,i)=>.2*Math.sin(i*.71));
  for (const type of ['phaser','auto-filter']) {
    using s = await createFX(h.context,{type,frequency:700,depth:0,q:2,stages:3,mix:1});
    const coefficients = biquadCoefficients(type==='phaser'?'allpass':'lowpass',48000,700,type==='phaser'?2:20*Math.log10(2));
    let reference = input;
    for(let k=0;k<(type==='phaser'?3:1);k++) reference=biquadProcess(coefficients,reference);
    const out = processAudio(h.worklets.at(-1).processor,[input,input])[0];
    out.forEach((v,i)=>near(v,reference[i],2e-7));
  }
  using s = await createFX(h.context,{type:'auto-pan',rate:0,phase:90,depth:1,mix:1});
  const out = processAudio(h.worklets.at(-1).processor,[new Float32Array(128).fill(.2),new Float32Array(128).fill(-.1)]);
  near(out[0][100],0);near(out[1][100],.1);
});

test('bitcrusher quantisation and sample/hold persist across quanta; zero wet is bit-identical for every processor', async t => {
  const h = processorHarness(t);
  const input = Float32Array.from({length:1024},(_,i)=>Math.sin(i*.343)*.7);
  using s = await createFX(h.context,{type:'bitcrusher',bits:4,reduction:3});
  const out = processAudio(h.worklets.at(-1).processor,[input,input],17)[0];
  out.forEach((v,i)=>assert.equal(v,Math.round(input[i-i%3]/.125)*.125));
  for(const type of ['chorus','flanger','vibrato','phaser','auto-filter','tremolo','auto-pan','bitcrusher']) {
    using a=await createFX(h.context,{type,mix:0});
    assert.deepEqual(processAudio(h.worklets.at(-1).processor,[input,input]),[input,input]);
  }
});

test('JSON chains own worklets/native nodes; validation and abort roll back without changing bus routing', async t => {
  const h=processorHarness(t);
  using mixer=new Mixer(h.context);
  const specs=JSON.parse(JSON.stringify([{type:'distortion',amount:.3,oversample:'4x'},{type:'chorus',depth:.2},{type:'bitcrusher',bits:8}]));
  const chain=await createBusFX(mixer.master,specs);
  assert.ok(chain.params['0.mix']); assert.ok(chain.params['1.rate']);
  mixer.dispose();assert.equal(h.worklets[0].processor.active,false);chain.dispose();
  for(const spec of [{type:'wat'},{type:'phaser',stages:1.5},{type:'bitcrusher',bits:0},{type:'chorus',time:Infinity},
    {type:'waveshaper',curve:[0,NaN]},{type:'distortion',oversample:'8x'}])await assert.rejects(createFX(h.context,spec));
  const controller=new AbortController();
  const pending=createFXChain(h.context,[{type:'distortion'}],{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(createFXChain(h.context,[],{signal:controller.signal}),{name:'AbortError'});
  assert.ok(h.context.nodes.filter(n=>n.kind==='constant').every(n=>n.stopped));
});
