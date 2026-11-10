/** @internal Audio-thread modulation, fractional delay, filtering and sample/bit reduction, written from DSP descriptions. */
export const fxProcessor = `class FXProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [['rate',1,0,20],['depth',.5,0,1],['mix',.5,0,1],['time',.02,0,.1],['feedback',0,-.95,.95],
      ['frequency',400,10,96000],['octaves',3,0,8],['q',1,.1,40],['bits',4,1,24],['reduction',1,1,128]]
      .map(([name,defaultValue,minValue,maxValue])=>({name,defaultValue,minValue,maxValue,automationRate:'a-rate'}));
  }
  constructor(options) {
    super(); const o=this.o=options.processorOptions;
    this.phase=o.phase/360; this.at=0; this.active=true;
    this.ring=Array.from({length:o.channels},()=>new Float64Array(Math.ceil(sampleRate*.21)+4));
    this.filters=Array.from({length:o.channels},()=>Array.from({length:o.stages},()=>new Float64Array(4)));
    this.held=new Float64Array(o.channels); this.hold=0;
    this.port.onmessage=()=>{this.active=false;};
  }
  process(inputs,outputs,params) {
    if(!this.active)return false;
    const input=inputs[0], out=outputs[0], o=this.o;
    const get=(name,i)=>{const p=params[name];return p.length===1?p[0]:p[i];};
    const wave=p=>{
      p=((p%1)+1)%1;
      if(o.waveform==='triangle')return 1-4*Math.abs(p-.5);
      if(o.waveform==='square')return p<.5?1:-1;
      if(o.waveform==='sawtooth')return 2*p-1;
      return Math.sin(2*Math.PI*p);
    };
    for(let i=0;i<out[0].length;i++){
      const mix=get('mix',i),depth=get('depth',i),time=get('time',i),feedback=get('feedback',i);
      const capture=this.hold<=0;
      if(capture)this.hold=Math.max(1,Math.round(get('reduction',i)));
      for(let c=0;c<out.length;c++){
        const x=input[c]?.[i]??0, lfo=wave(this.phase+(c%2)*o.spread/360);
        let y=x;
        if(o.type==='chorus'||o.type==='flanger'||o.type==='vibrato'){
          const ring=this.ring[c], delay=Math.max(1,time*sampleRate*(1+depth*lfo));
          let pos=(this.at-delay+ring.length)%ring.length;
          const a=Math.floor(pos),f=pos-a;
          y=ring[a]*(1-f)+ring[(a+1)%ring.length]*f;
          ring[this.at]=x+feedback*y;
        }else if(o.type==='tremolo')y=x*(1-depth*.5+depth*.5*lfo);
        else if(o.type==='auto-pan'){
          const pan=depth*lfo, l=input[0]?.[i]??0,r=input[1]?.[i]??l;
          const angle=(pan<=0?pan+1:pan)*Math.PI/2;
          y=c===0?(pan<=0?l+r*Math.cos(angle):l*Math.cos(angle)):(pan<=0?r*Math.sin(angle):r+l*Math.sin(angle));
        }else if(o.type==='bitcrusher'){
          if(capture){const step=2**(1-Math.round(get('bits',i)));this.held[c]=Math.round(x/step)*step;}
          y=this.held[c];
        }else{
          const f=Math.min(sampleRate*.45,get('frequency',i)*2**(get('octaves',i)*depth*(lfo+1)*.5));
          const w=2*Math.PI*f/sampleRate, cs=Math.cos(w),sn=Math.sin(w),alpha=sn/(2*get('q',i)),a0=1+alpha;
          let b0,b1,b2,a1=-2*cs/a0,a2=(1-alpha)/a0;
          if(o.type==='phaser'){b0=(1-alpha)/a0;b1=a1;b2=1;}
          else {b0=(1-cs)/(2*a0);b1=2*b0;b2=b0;}
          for(let k=0;k<(o.type==='phaser'?o.stages:1);k++){
            const s=this.filters[c][k];
            const v=b0*y+b1*s[0]+b2*s[1]-a1*s[2]-a2*s[3];
            s[1]=s[0];s[0]=y;s[3]=s[2];s[2]=v;y=v;
          }
        }
        out[c][i]=mix===0?x:mix===1?y:(1-mix)*x+mix*y;
      }
      this.hold--;this.at=(this.at+1)%this.ring[0].length;
      this.phase=(this.phase+get('rate',i)/sampleRate)%1;
    }
    return true;
  }
}
registerProcessor('margo-fx-v1',FXProcessor);`;
