import exhibit from './exhibit.json';

const textureWidth=336,textureHeight=208;
const clamp=(x,min=0,max=1)=>Math.max(min,Math.min(max,x));
const blend=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const ridge=(x,width)=>Math.exp(-((x/width)**2));
const contour=(pitch,size)=>ridge(pitch-Math.round(pitch),size);
const cold=[56,108,105],green=[77,123,113],amber=[174,136,83],enamel=[103,134,119];

export function buildRelief(){
  const width=textureWidth,height=textureHeight,count=width*height;
  const data=new Uint8Array(count*4),normal=new Uint8Array(count*4),rowDepth=new Float32Array(count);
  for(let row=0;row<height;row++)for(let col=0;col<width;col++){
    const u=(col+.5)/width,v=(row+.5)/height,x=2*u-1,y=1-2*v;
    // A current runs around a terraced headland beneath a punched sun disk.
    const r=Math.hypot((x+.185+.073*Math.sin(y*4.3))/.74,(y-.132-.078*Math.sin(x*3.7))/.68)
      +.013*Math.sin(x*13+y*6)+.018*Math.sin(y*10-x*6);
    const headland=(1-smooth(.79,1.24,r))*smooth(-.73,-.40,y);
    const peninsula=.014*ridge(r-.18,.43);
    const terraces=.017*contour(r*10.55+.19*Math.sin(r*11),.137)*headland;
    const bays=y+.132*Math.sin(x*3.3+.46)+.048*Math.sin(x*8.9-.59)+.077*x;
    const surf=.0133*contour(8.5*bays+.29*Math.sin(x*4+y*3.2),.165)*(1-.93*headland);
    const tidal=.012*ridge(bays+.32,.23);
    const wash=.00055*Math.sin(x*35+1.07*Math.sin(y*14))*Math.sin(y*42+x*11);
    const mask=smooth(.99,.91,Math.abs(x))*smooth(.998,.91,Math.abs(y));
    const sx=(x-.583)*1.40,sy=y-.518;
    const radius=Math.hypot(sx,sy),solar=smooth(.181,.161,radius);
    const rings=ridge(radius-.224,.010)+ridge(radius-.255,.008);
    const radiant=smooth(.201,.183,radius)*smooth(.072,.117,radius)*(.5+.5*Math.cos(Math.atan2(sy,sx)*32))**4;
    const pixel=row*width+col;
    rowDepth[pixel]=(peninsula+terraces+surf+tidal+wash)*mask*(1-.92*smooth(.270,.184,radius))
      +.023*solar+.008*rings+.0048*radiant;
    const glaze=.53*headland+.14*smooth(-.80,.90,y)+.04*Math.sin(3.1*x+1.2*y);
    const rim=smooth(.992,.997,Math.max(Math.abs(x),Math.abs(y)));
    const tint=clamp(.77*solar+.24*rings);
    const colourVariation=.8*Math.sin(u*11+1.2*Math.sin(v*17));
    for(let rgb=0;rgb<3;rgb++){
      const base=blend(blend(cold[rgb],green[rgb],glaze),enamel[rgb],rim);
      data[pixel*4+rgb]=Math.round(blend(base,amber[rgb],tint)+colourVariation);
    }
    data[pixel*4+3]=255;
  }
  const sx=width/exhibit.width,sy=height/exhibit.height;
  for(let y=0;y<height;y++){
    const v0=Math.max(0,y-1),v1=Math.min(height-1,y+1);
    for(let x=0;x<width;x++){
      const u0=Math.max(0,x-1),u1=Math.min(width-1,x+1),i=(y*width+x)*4;
      const nx=-(rowDepth[y*width+u1]-rowDepth[y*width+u0])*sx/(u1-u0);
      const ny=-(rowDepth[v1*width+x]-rowDepth[v0*width+x])*sy/(v1-v0);
      const inverse=127.5/Math.sqrt(1+nx*nx+ny*ny);
      normal[i]=Math.round(127.5+nx*inverse);
      normal[i+1]=Math.round(127.5+ny*inverse);
      normal[i+2]=Math.round(127.5+inverse);
      normal[i+3]=255;
    }
  }
  return [{width,height,data},{width,height,data:normal}];
}
