import voiceURL from './keeper.ogg?url';
import {total} from './cut.js';

export function prepareSounds(signal){
  const Context=window.AudioContext??window.webkitAudioContext;
  if(!Context)throw new Error('This browser has no audio decoder.');
  const context=new Context({sampleRate:48000});
  signal.addEventListener('abort',()=>{void context.close();},{once:true});
  const inventory={};
  const ready=(async()=>{
    const response=await fetch(voiceURL,{signal});
    if(!response.ok)throw new Error('The keeper’s dialogue could not load.');
    const speech=await context.decodeAudioData(await response.arrayBuffer());
    const length=Math.ceil(total*context.sampleRate);
    const surf=context.createBuffer(1,length,context.sampleRate);
    const wave=surf.getChannelData(0);
    let rng=477381,moving=0;
    for(let at=0;at<wave.length;at++){
      rng=(Math.imul(rng,1664525)+1013904223)>>>0;
      const noise=rng/4294967296*2-1;
      moving=.988*moving+.012*noise;
      const t=at/context.sampleRate;
      const roll=.28+.31*(.5+.5*Math.sin(t*1.418-.7))**3;
      wave[at]=(moving*.78+.033*noise)*roll+.013*Math.sin(t*152)*(.53+.38*Math.sin(t*2.5));
    }
    Object.assign(inventory,{keeper:speech,surf});
  })();
  const live=[];
  function stop(){
    for(const source of live.splice(0)){
      source.stop();
      source.disconnect();
    }
  }
  const unlock=()=>context.state==='running'?Promise.resolve():context.resume();
  function play(doc,start){
    stop();
    const now=context.currentTime+.027;
    for(const track of doc.tracks){
      if(track.type!=='audio'||track.muted)continue;
      for(const clip of track.clips){
        if(start>=clip.start+clip.duration)continue;
        const source=context.createBufferSource();
        source.buffer=inventory[clip.sound];
        const gain=context.createGain();
        const when=now+Math.max(0,clip.start-start);
        const offset=Math.max(0,start-clip.start);
        const duration=Math.min(source.buffer.duration-offset,clip.duration-offset);
        if(duration<=0)continue;
        const head=clip.fadeIn??0,tail=clip.fadeOut??0;
        const volume=clip.volume??1;
        const last=when+duration;
        gain.gain.setValueAtTime(head&&offset<head?volume*offset/head:volume,when);
        if(head>offset&&head-offset<duration)gain.gain.linearRampToValueAtTime(volume,when+head-offset);
        if(tail&&tail<duration){
          gain.gain.setValueAtTime(volume,last-tail);
          gain.gain.linearRampToValueAtTime(0,last);
        }
        source.connect(gain).connect(context.destination);
        live.push(source);
        source.start(when,offset,duration);
      }
    }
  }
  return {inventory,stop,play,unlock,ready};
}
