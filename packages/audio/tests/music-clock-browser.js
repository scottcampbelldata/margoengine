import {AudioListener} from '@margoengine/audio';
import {AudioMusic} from '@margoengine/audio/music';
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
/** Test fractional loop endpoints by measuring every repeated marker, including the last loop. */
export async function measureLoopGrid(){
 const reports=[];
 for(const [sampleRate,seconds]of [[8000,3600],[44100,300],[48000,300]]){
  const context=new OfflineAudioContext(1,sampleRate*seconds,sampleRate);
  const listener=new AudioListener({context,smoothing:0,autoResume:false});
  const bpm=130,period=4*60/bpm,frames=period*sampleRate;
  assert(!Number.isInteger(frames),'Fractional loop length is required');
  const buffer=context.createBuffer(1,Math.ceil(frames),sampleRate);
  buffer.getChannelData(0).fill(.25,0,32);
  const music=new AudioMusic(listener,{marker:buffer},{on:{marker:0}},{bpm,loopBeats:4,leadTime:0,fade:0});
  music.start('on',0);
  const transition=music.transition('on',{quantize:'beat',after:seconds-1});
  assert(transition===(Math.ceil((seconds-1)/(60/bpm))*(60/bpm)),'The grid stays on the authored tempo');
  const pcm=await context.startRendering(),data=pcm.getChannelData(0);
  let maxPhaseErrorFrames=0,loops=0,lastPhaseErrorFrames=0;
  for(let k=1;k*frames+35<data.length;k++){
   const ideal=k*frames,centre=Math.floor(ideal);let crossing=null;
   // Loop interpolation can spread the discontinuity across one sample interval.
   for(let i=centre-2;i<=centre+2;i++)if(data[i]<.125&&data[i+1]>=.125){
    crossing=i+(.125-data[i])/(data[i+1]-data[i]);break;
   }
   assert(crossing!==null,`${sampleRate}: loop ${k} marker drifted off the grid`);
   lastPhaseErrorFrames=crossing-ideal;
   maxPhaseErrorFrames=Math.max(maxPhaseErrorFrames,Math.abs(lastPhaseErrorFrames));loops++;
   assert(data[centre+4]>.24&&data[centre-3]<.01,'Expected marker at each loop boundary');
  }
  assert(maxPhaseErrorFrames<=1.5,`${sampleRate}: accumulated loop phase error ${maxPhaseErrorFrames}`);
  reports.push({sampleRate,seconds,bpm,framesPerLoop:frames,loops,maxPhaseErrorFrames,lastPhaseErrorFrames,transition});
  music.dispose();listener.dispose();
 }
 return reports;
}
