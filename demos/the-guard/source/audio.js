export function chimePlayer(){
  let audio;
  function ring(station,strength){
    try{
      audio??=new AudioContext();
      if(audio.state==='suspended')void audio.resume().catch(()=>{});
      const t=audio.currentTime;
      for(const [multiple,amp,length] of [[1,.067,.99],[2.317,.035,.41],[3.91,.024,.24],[5.27,.013,.13]]){
        const oscillator=audio.createOscillator(),envelope=audio.createGain();
        oscillator.frequency.value=station.tone*multiple;
        envelope.gain.setValueAtTime(.0001,t);
        envelope.gain.exponentialRampToValueAtTime(Math.max(.0002,amp*strength),t+.006);
        envelope.gain.exponentialRampToValueAtTime(.0001,t+length);
        oscillator.connect(envelope);envelope.connect(audio.destination);
        oscillator.start(t);oscillator.stop(t+length+.02);
      }
    }catch{ /* A browser that declines audio can still render and simulate the chime. */ }
  }
  return {ring,dispose(){if(audio&&audio.state!=='closed')void audio.close();}};
}
