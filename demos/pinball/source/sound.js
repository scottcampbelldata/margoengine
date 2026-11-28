import {AudioListener,AudioVoicePool} from '@margoengine/audio';

export function pinballSound(engine,context){
  const listener=AudioListener.attach(engine,{context,volume:.27,autoResume:false});
  const rate=context.sampleRate;
  function voice(frequency,decay,sweep){
    const seconds=.27;
    const buffer=context.createBuffer(1,Math.floor(seconds*rate),rate);
    const samples=buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++){
      const t=i/rate,phase=Math.PI*2*(frequency*t+sweep*t*t);
      const tone=.67*Math.sin(phase)+.23*Math.sin(phase*2.018)+.06*Math.sin(phase*3.917);
      samples[i]=tone*Math.min(1,t/.004)*Math.exp(-decay*t);
    }
    return new AudioVoicePool(listener,buffer,{voices:4,refDistance:.65,maxDistance:6,rolloffFactor:.7});
  }
  const synth={
    bumper:voice(610,21,280),flipper:voice(210,48,-108),launch:voice(315,24,645),
    drain:voice(195,20,-95),kickback:voice(410,29,155)
  };
  function play(kind,slot){
    const pool=synth[kind];
    if(pool)pool.play([slot===1?-.17:.13,.069,.08],{volume:kind==='bumper'?.9:.61,playbackRate:1+slot*.118});
  }
  return {play,dispose(){
    for(const pool of Object.values(synth))pool.dispose();
    listener.dispose();
  }};
}
