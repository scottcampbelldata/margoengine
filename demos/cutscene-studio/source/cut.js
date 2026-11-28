import {Cutscene} from '@margoengine/cutscene';
import {lipSyncTrack} from '@margoengine/cutscene/lipsync';
import {PhysicalLens} from '@margoengine/cinematic/physical-lens';
import {toVtt,parseVtt,cueText} from '@margoengine/text/captions';

export const title='Bring the Light Around', total=11.8, endTitle=10.0;
export const tracks=[lipSyncTrack()];
export const names=['The lens','The keeper','The channel'];
const dialogueStart=2.58;
const fov=focalLength=>new PhysicalLens({focalLength,filmGauge:36}).fov(16/9);

export function film(cuts,voice,subtitles=true){
  const [first,second]=cuts;
  const cameras=[
    {time:0,position:[1.24,1.45,1.93],target:[-.22,.95,-.51],fov:fov(34)},
    {time:first-.001,position:[.74,1.41,1.88],target:[-.28,.98,-.53],fov:fov(36),ease:'smoothstep'},
    {time:first,position:[1.71,1.63,1.94],target:[.98,1.540,-.28],fov:fov(64),cut:true},
    {time:second-.001,position:[1.64,1.615,1.85],target:[.99,1.546,-.28],fov:fov(67),ease:'smoothstep'},
    {time:second,position:[16.0,-1.6,32.6],target:[0,-4.7,0],fov:fov(31),cut:true},
    {time:total,position:[11.8,-.8,27.0],target:[0,-5.0,.90],fov:fov(32),ease:'smoothstep'},
  ];
  const timed=voice.cues.map(({start,end,text})=>{
    const t=dialogueStart+start;
    return {start:t,end:dialogueStart+end,lines:[text]};
  });
  const captions=toVtt(timed);
  const cues=parseVtt(captions).cues.map(cue=>({start:cue.start,duration:cue.end-cue.start,text:cue.lines.map(cueText).join(' ')}));
  const doc={
    format:'margo-cutscene',version:1,duration:total,
    markers:[{time:0,name:names[0]},{time:first,name:names[1]},{time:second,name:names[2]}],
    tracks:[
      {type:'camera',id:'picture',path:'linear',keys:cameras},
      {type:'property',id:'beacon-direction',target:'beacon',property:'heading',keys:[
        {time:0,value:.94},{time:2.05,value:.40,ease:'smoothstep'},{time:5.35,value:.30},{time:6.7,value:.09},
        {time:8.87,value:.72,ease:'easeInOutCubic'},{time:total,value:1.40},
      ]},
      {type:'property',id:'beacon-power',target:'beacon',property:'power',keys:[
        {time:0,value:.38},{time:1.74,value:.57},{time:5.38,value:.57},{time:6.54,value:1,ease:'smoothstep'},
      ]},
      {type:'audio',id:'sound',clips:[
        {start:0,duration:total,sound:'surf',volume:.29,fadeIn:.28,fadeOut:.64},
        {start:dialogueStart,duration:voice.duration,sound:'keeper',volume:.89},
      ]},
      {type:'subtitle',id:'captions',muted:!subtitles,clips:cues},
      {type:'lipsync',id:'lip-sync',target:'keeper',blend:.055,clips:[
        {start:dialogueStart,duration:voice.duration,phonemes:voice.phonemes},
      ]},
    ],
  };
  return {doc,cut:new Cutscene(doc,{tracks}),captions};
}
