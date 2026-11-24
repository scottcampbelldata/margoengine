import { Engine } from '@margoengine/core';
import { AudioListener } from '@margoengine/audio';
import { AudioReverbZones } from '@margoengine/audio/zones';
import { roomImpulseResponse } from '@margoengine/mixer/reflections';
const assert = (ok,message) => { if (!ok) throw new Error(message); };

export async function runZoneTests() {
  const reports=[];
  for (const backend of ['webgpu','webgl2','webgl2-compat']) {
    const compat=backend==='webgl2-compat' ? await import('@margoengine/webgl2-compat') : null;
    if(compat)await compat.install({force:true});
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
    let engine;
    try {
      const fallback=backend==='webgl2' ? (await import('@margoengine/webgl2-compat/preview')).webglRenderer : undefined;
      engine=await Engine.create(canvas,{backend:backend==='webgl2'?'webgl2':'webgpu',fallback});
      if(compat){ const {isCompatDevice}=await import('@margoengine/webgl2-compat/device');assert(isCompatDevice(engine.gpu),'Compatibility device'); }
      else assert(engine.backend===backend,'Native backend');
      const gpuErrors=[];engine.gpu?.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
      const context=new OfflineAudioContext(2,28800,48000);
      const listener=AudioListener.attach(engine,{context,autoResume:false,smoothing:0});
      listener.follow(null).setPose([-1,0,0],[0,0,-1]);
      const a={room:[4,4,4],source:[2,2,2],listener:[2,2,2],channels:1,seconds:0.2,seed:7};
      const b={...a,room:[8,4,4],source:[4,2,2],listener:[4,2,2],seed:8};
      const zones=new AudioReverbZones(listener,[
        {name:'small',min:[-2,-2,-2],max:[0,2,2],gain:0.25,reverb:a},
        {name:'large',min:[0,-2,-2],max:[2,2,2],gain:0.5,reverb:b},
      ],{fade:0});
      assert(zones.active==='small','Initial zone');
      const buffer=context.createBuffer(1,28800,48000);
      for(const frame of [0,6144,12288])buffer.getChannelData(0)[frame]=0.25;
      const source=context.createBufferSource();source.buffer=buffer;
      source.connect(listener.input);source.connect(zones.input);source.start();
      const pause1=context.suspend(0.128),pause2=context.suspend(0.256),rendered=context.startRendering();
      await pause1;listener.setPose([1,0,0],[0,0,-1]);engine.render();assert(zones.active==='large','Entered second zone');await context.resume();
      await pause2;listener.setPose([3,0,0],[0,0,-1]);engine.render();assert(zones.active===null,'Outside zones');await context.resume();
      const pcm=await rendered, expected=new Float32Array(28800);
      for(const frame of [0,6144,12288])expected[frame]=0.25;
      for(const [options,offset,gain] of [[a,0,0.25],[b,6144,0.5]]) {
        const ir=roomImpulseResponse(48000,options)[0];
        for(let i=0;i<ir.length && i+offset<expected.length;i++)expected[i+offset]+=ir[i]*gain*0.25;
      }
      let maxError=0;
      for(let c=0;c<2;c++)for(let i=0;i<expected.length;i++) {
        const value=pcm.getChannelData(c)[i];assert(Number.isFinite(value),'Finite PCM');
        maxError=Math.max(maxError,Math.abs(value-expected[i]));
      }
      // FFT convolution and float32 summation roundoff; no perceptual tolerance.
      assert(maxError<1e-6,`Zone wet routing, dry path and preserved tails ${maxError}`);
      assert(pcm.getChannelData(0).slice(23040).every(v=>Math.abs(v)<1e-7),'Outside wet send is silent after old tails');
      source.disconnect();zones.dispose();assert(gpuErrors.length===0,'No GPU validation errors');
      reports.push({backend,maxError,selection:['small','large',null],tails:'preserved',gpuErrors});
    } finally {engine?.dispose();canvas.remove();compat?.uninstall();}
  }
  return {fixture:'Generated impulses, room responses and listener motion, stand-ins',reports};
}
