import {AudioListener,PositionalAudio} from '@margoengine/audio';
import {AudioDoppler} from '@margoengine/audio/doppler';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
/** Actual AudioContext state changes and nodes, with deterministic 60 Hz render and quantized audio clocks. */
export async function measureLiveDoppler(){
 const context=new AudioContext(),listener=new AudioListener({context,smoothing:0,autoResume:false});
 const descriptor=Object.getOwnPropertyDescriptor(performance,'now');
 let frameTime=0,audioTime=0;
 Object.defineProperty(performance,'now',{configurable:true,value:()=>frameTime*1000});
 Object.defineProperty(context,'currentTime',{configurable:true,get:()=>audioTime});
 try{
  await context.resume();await context.suspend();
  const sound=new PositionalAudio(listener,{rolloffFactor:0,loop:true});
  sound.setBuffer(context.createBuffer(1,48000,48000)).setPosition(20,0,0).play();
  const control=new AudioDoppler(sound);listener.update();
  frameTime=5;sound.setPosition(19.9,0,0);listener.update();
  assert(context.currentTime===0,'The suspended audio clock stays frozen while the render clock advances');
  await context.resume();frameTime=5.01;audioTime=.010667;listener.update();
  assert(control.ratio===1,'First live sample after unlock stays neutral');
  const ratios=[],expected=343/(343+20);
  for(let k=1;k<=120;k++){
   frameTime=5.01+k/60;audioTime=Math.floor((.010667+k/60)/.010667)*.010667;
   sound.setPosition(19.9+20*k/60,0,0);listener.update();ratios.push(control.ratio);
  }
  const maxRatioError=Math.max(...ratios.map(value=>Math.abs(value-expected)));
  assert(maxRatioError<1e-12,`Quantized live clock warble ${maxRatioError}`);
  await context.suspend();sound.setPosition(60,0,0);await context.resume();
  frameTime+=.01;audioTime+=.010667;listener.update();
  assert(control.ratio===1,'Small moves across state changes without rendered frames reset history');
  return {context:'AudioContext',renderHz:60,audioClockStepSeconds:.010667,samples:ratios.length,maxRatioError,resumeRatio:control.ratio,
   scope:'Real live nodes/state changes; controlled frame/audio clocks. No device PCM or listening measurement.'};
 }finally{
  listener.dispose();await context.close();
  if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;
 }
}
