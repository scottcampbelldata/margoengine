import {cutsceneFrames,mixCutsceneAudio} from '@margoengine/cutscene/render';
import {endTitle,title} from './cut.js';

export async function renderVideo(drawing,renderFrame,cut,sounds,{signal,report}){
  const width=960,height=540,fps=24;
  const compositor=document.createElement('canvas');
  compositor.width=width;compositor.height=height;
  const ctx=compositor.getContext('2d',{alpha:false,willReadFrequently:true});
  if(!ctx)throw new Error('The video compositor could not open.');
  const audio=sounds?mixCutsceneAudio(cut,sounds,{sampleRate:48000,channels:1}):undefined;
  if(audio&&audio.peak>1)throw new Error('The scene audio would clip.');
  const total=Math.ceil(cut.duration*fps);
  async function* frames(){
    let done=0;
    for(const {state} of cutsceneFrames(cut,{fps})){
      signal.throwIfAborted();
      await renderFrame(state);
      ctx.drawImage(drawing,0,0,width,height);
      paintOverlay(ctx,state,width,height);
      const {data}=ctx.getImageData(0,0,width,height);
      yield {width,height,data:new Uint8Array(data.buffer,data.byteOffset,data.byteLength)};
      if(++done%6===0||done===total)report(done,total);
    }
  }
  const {encodeVideo}=await import('@margoengine/headless/video');
  return encodeVideo(frames(),{
    format:'webm',fps,bitrate:2700000,signal,maxBytes:48*1024*1024,
    audio:audio?{channels:audio.channels,sampleRate:audio.sampleRate,bitrate:96000}:undefined,
    provenance:{title,source:'Margo Cutscene Studio',description:'Live edited camera, voice, and captions'},
  });
}
function paintOverlay(ctx,state,width,height){
  ctx.textAlign='center';ctx.textBaseline='middle';
  if(state.time>=endTitle){
    const y=height*.71;
    const shade=ctx.createLinearGradient(0,y,0,height);
    shade.addColorStop(0,'#19242c00');shade.addColorStop(.53,'#172129');shade.addColorStop(1,'#172129');
    ctx.fillStyle=shade;ctx.fillRect(0,y,width,height-y);
    ctx.fillStyle='#f1dcb5';ctx.font='45px Georgia';
    ctx.fillText(title,width/2,height*.83);
    ctx.fillStyle='#ddd7cd';ctx.font='17px system-ui';
    ctx.fillText('Made with Margo Engine',width/2,height*.90);
    ctx.fillText('Please subscribe',width/2,height*.95);
    return;
  }
  if(!state.subtitles.length)return;
  const text=state.subtitles.map(cue=>cue.text).join(' ');
  ctx.font='600 24px system-ui';
  const span=ctx.measureText(text).width+39,y=height*.88;
  ctx.fillStyle='#111723db';ctx.fillRect((width-span)/2,y-20,span,41);
  ctx.fillStyle='#fff2dd';ctx.fillText(text,width/2,y);
}
