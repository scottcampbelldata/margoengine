import {Noise,fbm} from '@margoengine/procedural/noise';

export const seed=413;
const noise=new Noise(seed);
const terrainNoise=fbm((x,z)=>noise.simplex2(x,z),{octaves:5,gain:.52});
const cloudNoise=fbm((x,y,z)=>noise.simplex(x,y,z),{octaves:4,gain:.53});
const zoom=(x,min,max)=>Math.min(max,Math.max(min,x));
export const smooth=(a,b,x)=>{
  const u=zoom((x-a)/(b-a),0,1);
  return u*u*(3-2*u);
};
export const terrainBounds=[1.58,1.03];
export const cloudSize=[48,30,40];

export function elevation(u,v,frequency,relief){
  const ring=Math.hypot(u*.94,v*.99);
  const basin=1-smooth(.30,.94,ring);
  const broad=.33+.65*terrainNoise(u*frequency*1.13+5.3,v*frequency*.81-3.35);
  const cascade=1-Math.abs(noise.simplex2(u*frequency*.68-9.2,v*frequency*.68+9.7));
  const height=(broad*1.29+.29*cascade*cascade)*basin-.117;
  return smooth(.001,.12,height)*height*(.42+relief*.99);
}
export function cloudAt(x,y,z,frequency){
  const stretch=frequency*1.10;
  const a=cloudNoise(x*stretch+.95,y*stretch*.77+5.1,z*stretch-7.02);
  const b=1-Math.abs(noise.simplex(x*stretch*.71-4.7,y*stretch*.62+1.97,z*stretch*.81+2.18));
  const crown=Math.exp(-3.3*((x+.32)**2+(y+.24)**2*1.21+z*z*.59));
  const bank=Math.exp(-3.5*((x-.38)**2+(y-.13)**2*.97+(z+.19)**2*.61));
  const shape=Math.max(crown,bank*.96);
  const attenuate=(1-smooth(.73,1,Math.abs(x)))*(1-smooth(.73,1,Math.abs(y)))*(1-smooth(.76,1,Math.abs(z)));
  return smooth(.18,.87,(.60*a+.48*b+shape*.94-.30))*attenuate;
}
export function makeVolume(frequency){
  const [width,height,depth]=cloudSize;
  const atlas=new Uint8Array(width*height*depth);
  let total=0;
  for(let z=0;z<depth;z++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const value=Math.round(255*cloudAt(x/(width-1)*2-1,y/(height-1)*2-1,z/(depth-1)*2-1,frequency));
    atlas[(z*height+y)*width+x]=value;
    total+=value;
  }
  return {atlas,total};
}
export function tileSample(u,v,frequency,phase){
  const tau=Math.PI*2,r=frequency*.192;
  const a=(u+phase)*tau,b=(v+phase*.33)*tau;
  const x=Math.cos(a)*r,y=Math.sin(a)*r,z=Math.cos(b)*r,w=Math.sin(b)*r;
  return noise.simplex4(x,y,z,w)*.67+noise.simplex4(2*x,2*y,2*z,2*w)*.24+
    noise.simplex4(4*x,4*y,4*z,4*w)*.09;
}
