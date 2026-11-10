/** @internal Exact linked-channel expansion/gating and phase-aligned LR4 three-band compression. */
export const dynamicsProcessor = `class ExtendedDynamics extends AudioWorkletProcessor {
  constructor(options){
    super();const o=this.o=options.processorOptions;this.active=true;this.open=false;this.remaining=0;
    this.gains=new Float64Array(3).fill(o.type==='gate'?10**(o.floor/20):1);
    this.filters=Array.from({length:o.channels},()=>Array.from({length:12},()=>new Float64Array(4)));
    this.values=Array.from({length:o.channels},()=>new Float64Array(3));
    this.peaks=new Float64Array(3);
    this.port.onmessage=()=>{this.active=false;};
  }
  filter(x,c,s){const y=c[0]*x+c[1]*s[0]+c[2]*s[1]-c[3]*s[2]-c[4]*s[3];s[1]=s[0];s[0]=x;s[3]=s[2];s[2]=y;return y;}
  pair(x,c,s,at){return this.filter(this.filter(x,c,s[at]),c,s[at+1]);}
  process(inputs,outputs){
    if(!this.active)return false;
    const input=inputs[0],out=outputs[0],o=this.o;
    for(let i=0;i<out[0].length;i++){
      const peaks=this.peaks;peaks.fill(0);
      for(let ch=0;ch<out.length;ch++){
        const x=input[ch]?.[i]??0,v=this.values[ch],s=this.filters[ch];
        if(o.type==='multiband'){
          const lo=this.pair(x,o.cross[0][0],s,0),hi=this.pair(x,o.cross[0][1],s,2);
          v[0]=this.pair(lo,o.cross[1][0],s,4)+this.pair(lo,o.cross[1][1],s,6);
          v[1]=this.pair(hi,o.cross[1][0],s,8);v[2]=this.pair(hi,o.cross[1][1],s,10);
        }else v[0]=x;
        for(let b=0;b<(o.type==='multiband'?3:1);b++)peaks[b]=Math.max(peaks[b],Math.abs(v[b]));
      }
      for(let b=0;b<(o.type==='multiband'?3:1);b++){
        const s=o.type==='multiband'?o.bands[b]:o,peak=peaks[b];let target=1;
        if(o.type==='gate'){
          if(peak>=10**(o.threshold/20)){this.open=true;this.remaining=o.holdFrames;}
          else if(this.open && peak>=10**((o.threshold-o.hysteresis)/20))this.remaining=o.holdFrames;
          else if(this.remaining>0)this.remaining--;else this.open=false;
          target=this.open?1:10**(o.floor/20);
        }else if(peak>0){
          const d=20*Math.log10(peak)-s.threshold;let reduction=0;
          if(o.type==='expander'){
            if(d < -s.knee/2)reduction=(s.ratio-1)*d;
            else if(s.knee>0 && d<s.knee/2)reduction=-(s.ratio-1)*(d-s.knee/2)**2/(2*s.knee);
            reduction=Math.max(-s.range,reduction);
          }else{
            if(d>s.knee/2)reduction=d*(1/s.ratio-1);
            else if(s.knee>0 && d>-s.knee/2)reduction=(1/s.ratio-1)*(d+s.knee/2)**2/(2*s.knee);
          }
          target=10**(reduction/20);
        }else if(o.type==='expander')target=10**(-s.range/20);
        const opening=o.type==='gate'||o.type==='expander';
        const seconds=(opening?target>this.gains[b]:target<this.gains[b])?s.attack:s.release;
        const a=seconds===0?0:Math.exp(-1/(sampleRate*seconds));
        this.gains[b]=target+a*(this.gains[b]-target);
      }
      for(let ch=0;ch<out.length;ch++){
        let sum=0;for(let b=0;b<(o.type==='multiband'?3:1);b++){
          const s=o.type==='multiband'?o.bands[b]:o;
          sum+=this.values[ch][b]*this.gains[b]*10**((s.makeup??0)/20);
        }out[ch][i]=sum;
      }
    }return true;
  }
}
registerProcessor('margo-extended-dynamics-v1',ExtendedDynamics);`;
