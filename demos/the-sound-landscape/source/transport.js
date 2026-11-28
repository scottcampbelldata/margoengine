
import {Audio,AudioListener,AudioAnalyser} from '@margoengine/audio';

export function openTransport(plot,canvas,bank,opening,signal,fail){
  const play=document.querySelector('#play'), slide=document.querySelector('#time'), mode=document.querySelector('#view');
  const elapsed=document.querySelector('#elapsed'), peak=document.querySelector('#peak'), description=document.querySelector('#clip-details');
  const settings=[...document.querySelectorAll('[data-clip]')], audioNote=document.querySelector('#audio-note');
  const {duration,nx,sampleRate,tracks}=bank;
  const cache=new Map([['bells',opening]]);
  const decoded=new Map();
  let track='bells', data=opening, overhead=false, playing=false, starting=false, position=0, frame=0, applied=false;
  let listener, voice, analyser, waveform, queued=false;

  function positionAt(seconds){
    position=Math.max(0,Math.min(duration,seconds));
    slide.value=String(position);
    elapsed.value=position.toFixed(2);
    const bin=Math.max(0,Math.min(nx-1,Math.round(position/duration*(nx-1))));
    const hz=Math.round(data.peaks[bin]);
    peak.value=hz?hz.toLocaleString('en-US')+' Hz':'—';
    canvas.dataset.time=position.toFixed(3);
    canvas.dataset.peak=String(hz);
    plot.move(position);
  }
  function state(){
    play.textContent=playing?'Pause sound':'Play sound';
    canvas.dataset.playing=String(playing);
    canvas.dataset.track=track;
    canvas.dataset.view=overhead?'overhead':'relief';
  }
  function changeSource(){
    let sound=decoded.get(track);
    if(!sound){
      sound=listener.context.createBuffer(1,data.samples.length,sampleRate);
      sound.copyToChannel(data.samples,0);
      decoded.set(track,sound);
    }
    voice.setBuffer(sound);
  }
  function pause(){
    cancelAnimationFrame(frame);
    if(playing)voice.pause();
    playing=false;
    state();
  }
  function measure(){
    if(applied||queued)return;
    const bins=analyser.getFloatWaveformData(waveform);
    const rms=Math.sqrt(bins.reduce((sum,value)=>sum+value*value,0)/bins.length);
    if(position<=.04||rms<.0015)return;
    queued=true;
    canvas.dataset.audioRms=rms.toFixed(6);
    requestAnimationFrame(()=>{
      queued=false;
      if(signal.aborted||applied||!playing)return;
      applied=true;
      performance.mark('landscape-play-applied');
    });
  }
  function tick(){
    if(!playing||signal.aborted)return;
    positionAt(voice.currentTime);
    measure();
    frame=requestAnimationFrame(tick);
  }

  play.addEventListener('click',async()=>{
    if(starting)return;
    if(playing){pause();return;}
    starting=true;
    audioNote.hidden=true;
    try{
      if(!listener){
        listener=new AudioListener({autoResume:false,volume:.78});
        voice=new Audio(listener,{volume:.72,onEnded:()=>{pause();positionAt(duration);}});
        analyser=new AudioAnalyser(voice,{fftSize:2048,smoothingTimeConstant:0});
        waveform=new Float32Array(analyser.analyser.fftSize);
        changeSource();
      }
      await listener.resume();
      if(signal.aborted)return;
      if(position>=duration)positionAt(0);
      voice.seek(position).play();
      playing=true;
      state();
      tick();
    }catch(reason){
      audioNote.textContent='Sound playback is unavailable. You can still explore the landscape with the position control.';
      audioNote.hidden=false;
      console.warn(reason);
    }finally{starting=false;}
  },{signal});

  slide.addEventListener('input',()=>{
    const next=Number(slide.value);
    if(voice)voice.seek(next);
    positionAt(next);
  },{signal});
  for(const button of settings)button.addEventListener('click',()=>{
    const selected=button.dataset.clip;
    if(selected===track)return;
    try{
      pause();
      if(!cache.has(selected))cache.set(selected,bank.makeLandscape(selected,signal));
      track=selected;
      data=cache.get(track);
      description.textContent=tracks[track].description;
      for(const candidate of settings)candidate.setAttribute('aria-pressed',String(candidate===button));
      if(voice)changeSource();
      plot.update(data);
      positionAt(0);
      state();
    }catch(reason){fail(reason);}
  },{signal});
  mode.addEventListener('click',()=>{
    overhead=!overhead;
    plot.setView(overhead);
    mode.ariaPressed=String(overhead);
    mode.textContent=overhead?'Relief view':'Overhead view';
    state();
  },{signal});
  signal.addEventListener('abort',()=>{
    cancelAnimationFrame(frame);
    analyser?.dispose();
    voice?.dispose();
    listener?.dispose();
  },{once:true});

  positionAt(0);
  state();
}
