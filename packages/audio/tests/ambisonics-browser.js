import {Engine} from '@margoengine/core';
import {AudioListener} from '@margoengine/audio';
import {AmbisonicAudio} from '@margoengine/audio/ambisonics';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const root3=Math.sqrt(3)/4;
const matrices=[
 [[.5,.25,0,root3],[.5,-.25,0,root3]],
 [[.5,root3,0,-.25],[.5,root3,0,.25]],
 [[.5,.25,0,root3],[.5,-.25,0,root3]],
];
async function render(buffer,backend,engine,generated){
 const context=new OfflineAudioContext(2,28800,48000);
 const listener=AudioListener.attach(engine,{context,name:generated?'ambi-tones':'ambi-file',autoResume:false,smoothing:0});
 listener.follow(null).setPose([0,0,0],[0,0,-1]);
 const bed=new AmbisonicAudio(listener,buffer,{volume:.5,smoothing:0});bed.play();
 const pause1=context.suspend(.128),pause2=context.suspend(.256),rendered=context.startRendering();
 await pause1;listener.setPose([100,20,30],[-1,0,0]);engine.render();await context.resume();
 await pause2;bed.setRotation([0,Math.SQRT1_2,0,Math.SQRT1_2]);engine.render();await context.resume();
 const pcm=await rendered;let maxError=0,sum=0;
 for(let i=0;i<pcm.length;i++){
  const segment=i<6144?0:i<12288?1:2;
  for(let ear=0;ear<2;ear++){
   let expected=0;
   for(let channel=0;channel<4;channel++)expected+=matrices[segment][ear][channel]*buffer.getChannelData(channel)[i%buffer.length]*.5;
   const value=pcm.getChannelData(ear)[i];assert(Number.isFinite(value),'Finite decoded PCM');
   maxError=Math.max(maxError,Math.abs(value-expected));sum+=value*value;
  }
 }
 // Source, gain and addition use float32; the reference uses float64 on the same decoded samples.
 assert(maxError<1e-6,`${backend} ${generated?'generated':'file'} rotation PCM ${maxError}`);
 assert(sum>0,'Non-silent decoded bed');bed.dispose();listener.dispose();
 return {maxError,rms:Math.sqrt(sum/(pcm.length*2)),channels:buffer.numberOfChannels,sourceFrames:buffer.length,sourceRate:buffer.sampleRate};
}
export async function runAmbisonicTests(){
 const decode=new OfflineAudioContext(2,48000,48000);
 const file=await decode.decodeAudioData(await (await fetch('./fixtures/rain-foa.wav')).arrayBuffer());
 assert(file.numberOfChannels===4 && file.sampleRate===48000,'Decoded four discrete AmbiX channels at render rate');
 const generated=decode.createBuffer(4,24000,48000);
 [600,900,1200,1500].forEach((hz,c)=>generated.getChannelData(c).forEach((_,i,a)=>{a[i]=.05*Math.sin(2*Math.PI*hz*i/48000);}));
 const reports=[];
 for(const backend of ['webgpu','webgl2','webgl2-compat']){
  const compat=backend==='webgl2-compat'?await import('@margoengine/webgl2-compat'):null;
  if(compat)await compat.install({force:true});
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);let engine;
  try{
   const fallback=backend==='webgl2'?(await import('@margoengine/webgl')).webglRenderer:undefined;
   engine=await Engine.create(canvas,{backend:backend==='webgl2'?'webgl2':'webgpu',fallback});
   if(compat){const {isCompatDevice}=await import('@margoengine/webgl2-compat/device');assert(isCompatDevice(engine.gpu),'Compatibility device');}
   else assert(engine.backend===backend,'Native backend');
   const gpuErrors=[];engine.gpu?.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
   const tones=await render(generated,backend,engine,true),recording=await render(file,backend,engine,false);
   assert(gpuErrors.length===0,'No GPU errors');reports.push({backend,tones,recording,gpuErrors});
  }finally{engine?.dispose();canvas.remove();compat?.uninstall();}
 }
 return {fixture:'Generated independent-channel tones (stand-in) and first-order prefix excerpt of Stefan Riedel RainSceneO7.wav (CC BY 4.0)',reports};
}
