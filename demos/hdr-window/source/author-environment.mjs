import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the verified Margo Engine checkout.');
const {encodeEXR} = await import(pathToFileURL(resolve(checkout,'packages/environment/dist/exr-write.js')));
const width=288,height=144;
const data=new Float32Array(width*height*4);
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const add=(c,other,gain)=>c.map((v,p)=>v+other[p]*gain);
const angles=(i,j)=>[(i+.5-width/2)*2*Math.PI/width,(.5-(j+.5)/height)*Math.PI];

function skyline(az,phase){
  return .046+(.033+.013*Math.sin(az*2+phase))*(.47+.34*Math.sin(az*8.1+phase)+.19*Math.sin(az*16.7+.7*phase)+.11*Math.sin(az*31.5+phase))+
    .014*Math.cos(az*4.7-phase)**4;
}

for(let j=0;j<height;j++)for(let i=0;i<width;i++){
  const [az,el]=angles(i,j),t=smooth(-.02,.86,el);
  const distance=Math.acos(clamp(Math.sin(el)*Math.sin(.158)+Math.cos(el)*Math.cos(.158)*Math.cos(az+.134),-1,1));
  let c=[mix(.91,.124,t),mix(.51,.223,t),mix(.34,.448,t)];
  const horizon=Math.exp(-((el/.123)**2)/2);
  c=add(c,[.52,.244,.096],horizon*(.35+.52*Math.exp(-distance*2)));
  const halo=1.65*Math.exp(-distance*distance/.021)+.49*Math.exp(-distance*distance/.19);
  c=add(c,[1.0,.68,.35],halo);
  const sun=smooth(.074,.021,distance)*8.2;
  c=add(c,[1,.82,.63],sun);
  const flow=el+.015*Math.sin(az*11)+.012*Math.sin(az*23-1.1);
  const strata=Math.max(0,Math.sin(flow*51+Math.sin(az*6.2)*1.5))**4;
  const strands=smooth(.063,.096,flow)*smooth(.39,.235,flow)*strata;
  c=add(c,[1.1,.50,.25],strands*(.32+.78*Math.exp(-distance*distance/.13)));
  const cloudNeedles=Math.max(0,Math.sin((el+.009*Math.sin(az*37)+.016*Math.cos(az*17))*134))**7;
  c=add(c,[.96,.50,.34],cloudNeedles*smooth(.081,.132,el)*smooth(.34,.18,el)*.40);

  const ridge0=skyline(az-.35,3.2)*.86-.006;
  const ridge1=skyline(az+.217,13)*.67-.023;
  const ridge2=skyline(az+.44,22.4)*.51-.054;
  const hill=(ridge,color)=>{c=c.map((v,k)=>mix(v,color[k],smooth(ridge+.004,ridge-.004,el)));};
  hill(ridge0,[.203,.139,.194]);
  hill(ridge1,[.116,.109,.150]);
  hill(ridge2,[.073,.071,.104]);
  const earth=smooth(-.09,-.43,el);
  c=c.map((v,k)=>mix(v,[.028,.039,.045][k],earth*.70));

  // Broad studio-side skylight and pale terrazzo bounce, out of the direct view.
  const ring=(angle,center)=>Math.atan2(Math.sin(angle-center),Math.cos(angle-center));
  const room = Math.exp(-((ring(az,1.48)/.26)**4))*Math.exp(-(((el-.41)/.64)**4));
  const returnLight=Math.exp(-((ring(az,-1.79)/.42)**4))*Math.exp(-(((el-.17)/.61)**4));
  c=add(c,[.72,1.04,1.54],room*1.95);
  c=add(c,[1.35,.83,.52],returnLight*.81);
  const n=(j*width+i)*4;
  data.set([...c,1],n);
}
const target=new URL('.',import.meta.url);
const channels='RGB'.split('').map((name,offset)=>({name,type:'HALF',data,offset,stride:4}));
await writeFile(new URL('atrium.exr',target),await encodeEXR({width,height,channels}));
if(process.argv[2])await writeFile(process.argv[2],Buffer.from(data.buffer));
