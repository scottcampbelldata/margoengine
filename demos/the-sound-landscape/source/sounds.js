
import {stft} from '@margoengine/audio/spectrogram';

export const sampleRate=16000;
export const duration=6.24;
export const nx=121, ny=70;
export const frequencyLow=125, frequencyHigh=5200;
export const bandSpan=Math.log2(frequencyHigh/frequencyLow);
export const floorDb=-62, ceilingDb=-11;
export const tracks={
  bells:{name:'Bell cascade',description:'Overlapping tones leave narrow ridges as each bell rings out.'},
  sweep:{name:'Frequency sweep',description:'A rising tone and its harmonics travel diagonally across the surface.'},
  pulses:{name:'Pulse train',description:'Brief attacks raise many frequencies together, then decay.'},
};
const tau=2*Math.PI;

function bellCascade(out){
  const score=[
    [.055,261.626,.31],[.71,329.628,.28],[1.26,391.995,.30],[1.84,493.883,.28],
    [2.62,349.228,.31],[3.18,440,.28],[3.76,523.251,.29],[4.33,659.255,.31],
    [5.04,391.995,.25],[5.37,587.330,.25],
  ];
  const modes=[
    [1,.83,1.02],[2,.42,.75],[2.76,.24,.41],[3.98,.18,.34],[5.41,.13,.23],[7.14,.080,.13],
  ];
  for(const [at,pitch,amplitude] of score){
    const first=Math.round(at*sampleRate);
    const limit=Math.min(out.length,first+Math.round(2.6*sampleRate));
    for(const [ratio,gain,decay] of modes){
      const frequency=ratio*pitch;
      if(frequency>=sampleRate*.47)continue;
      const rotation=tau*frequency/sampleRate, loss=Math.exp(-1/(sampleRate*decay));
      const c=loss*Math.cos(rotation), s=loss*Math.sin(rotation);
      let cosine=amplitude*gain, sine=0;
      for(let j=first;j<limit;j++){
        const onset=Math.min(1,(j-first)*170/sampleRate);
        out[j]+=onset*sine;
        const next=c*cosine-s*sine;
        sine=s*cosine+c*sine;
        cosine=next;
      }
    }
  }
}
function frequencySweep(out){
  const start=157, end=1510, exponent=Math.log(end/start)/duration;
  for(let i=0;i<out.length;i++){
    const time=i/sampleRate;
    const phase=tau*start*Math.expm1(exponent*time)/exponent;
    const envelope=.62+.38*Math.sin(Math.PI*time/duration)**2;
    out[i]=envelope*(.33*Math.sin(phase)+.108*Math.sin(2*phase)+.056*Math.sin(3*phase));
  }
}
function pulseTrain(out){
  let seed=18273;
  let bed=0;
  for(const [at,gain] of [[.25,.41],[1.14,.5],[1.91,.43],[2.65,.54],[3.81,.49],[4.49,.52],[5.29,.51]]){
    const first=Math.floor(at*sampleRate), end=Math.min(out.length,first+Math.round(.65*sampleRate));
    for(let i=first;i<end;i++){
      const time=(i-first)/sampleRate;
      seed^=seed<<13;
      seed^=seed>>>17;
      seed^=seed<<5;
      const white=2*(seed>>>0)/4294967296-1;
      bed+=.38*(white-bed);
      const struck=Math.min(1,time*330)*Math.exp(-time*20);
      const body=Math.min(1,time*240)*Math.exp(-time*11);
      const pitch=158*time+33*(1-Math.exp(-time*25))/25;
      out[i]+=gain*(.55*struck*bed+.84*body*Math.sin(tau*pitch));
    }
  }
}

function generate(track){
  const out=new Float32Array(Math.round(duration*sampleRate));
  ({bells:bellCascade,sweep:frequencySweep,pulses:pulseTrain})[track](out);
  for(let i=0;i<out.length;i++){
    const time=i/sampleRate;
    const edge=Math.max(0,Math.min(1,time/.045,(duration-time)/.24));
    out[i]*=edge*edge*(3-2*edge);
  }
  return out;
}

export function makeLandscape(track,signal){
  const samples=generate(track);
  const size=1024, hop=416;
  const {real,imag,bins,window}=stft(samples,{sampleRate,size,hop,pad:'zero',signal});
  const compensation=2/window.reduce((sum,value)=>sum+value,0);
  const values=new Float32Array(nx*ny), peaks=new Float32Array(nx);
  const lowBin=Math.ceil(frequencyLow*size/sampleRate), highBin=Math.floor(frequencyHigh*size/sampleRate);
  const stepped=Array.from({length:ny},(_,index)=>{
    const ratio=bandSpan/(ny-1);
    const left=frequencyLow*2**(Math.max(0,index-.5)*ratio)*size/sampleRate;
    const right=frequencyLow*2**(Math.min(ny-1,index+.5)*ratio)*size/sampleRate;
    const middle=frequencyLow*2**(index*ratio)*size/sampleRate;
    return [Math.ceil(left),Math.floor(right),middle];
  });
  for(let col=0;col<nx;col++){
    const base=col*2*bins;
    const magnitudes=Float32Array.from({length:highBin+2},(_,i)=>Math.hypot(real[base+i],imag[base+i]));
    let peak=lowBin;
    for(let j=lowBin+1;j<=highBin;j++){
      if(magnitudes[j]>magnitudes[peak])peak=j;
    }
    if(magnitudes[peak]*compensation>.0008){
      const [l,m,r]=[magnitudes[peak-1],magnitudes[peak],magnitudes[peak+1]].map(x=>Math.log(Math.max(1e-9,x)));
      const width=l-2*m+r;
      const offset=width===0?0:Math.max(-.5,Math.min(.5,.5*(l-r)/width));
      peaks[col]=(peak+offset)*sampleRate/size;
    }
    for(let row=0;row<ny;row++){
      const [low,high,middle]=stepped[row], first=Math.floor(middle);
      const blend=middle-first;
      let amplitude=(1-blend)*magnitudes[first]+blend*magnitudes[first+1];
      for(let j=low;j<=high;j++)amplitude=Math.max(amplitude,magnitudes[j]);
      values[row*nx+col]=Math.min(ceilingDb,Math.max(floorDb,20*Math.log10(Math.max(1e-9,amplitude*compensation))));
    }
  }
  // Let the cabinet show through below the displayed noise floor. One sample
  // of the floor borders each raised region to make its drop to the base clear.
  const visible=values.map((value,index)=>{
    if(value>floorDb)return value;
    const col=index%nx;
    for(const adjacent of [col>0?index-1:-1,col<nx-1?index+1:-1,index-nx,index+nx]){
      if(values[adjacent]>floorDb)return value;
    }
    return NaN;
  });
  return {samples,values,visible,peaks};
}
