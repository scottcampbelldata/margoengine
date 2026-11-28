import {elevation,smooth,terrainBounds} from './field.js';

const bronze=[.58,.37,.21],glass=[.075,.415,.40],black=[.105,.142,.133],clay=[.265,.223,.165];
const dark=[.036,.065,.055],light=[.71,.79,.61];
const lerp=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const normalize=([x,y,z])=>{const d=Math.hypot(x,y,z);return [x/d,y/d,z/d];};
const bands=52;

export function geometry(mode,frequency,amount){
  const vertices=[];
  const vertex=(p,n,c,u=0,v=0,type=0)=>[...p,...n,...c,u,v,type];
  const triangle=(a,b,c)=>vertices.push(...a,...b,...c);
  const quad=(a,b,c,d)=>{triangle(a,b,c);triangle(a,c,d);};

  function box(x,y,z,dx,dy,dz,color){
    const positions=[
      [x-dx,y-dy,z-dz],[x+dx,y-dy,z-dz],[x+dx,y+dy,z-dz],[x-dx,y+dy,z-dz],
      [x-dx,y-dy,z+dz],[x+dx,y-dy,z+dz],[x+dx,y+dy,z+dz],[x-dx,y+dy,z+dz],
    ];
    const faces=[[4,5,6,7,0,0,1],[1,0,3,2,0,0,-1],[0,4,7,3,-1,0,0],[5,1,2,6,1,0,0],[7,6,2,3,0,1,0],[0,1,5,4,0,-1,0]];
    for(const [a,b,c,d,nx,ny,nz] of faces){
      const corner=i=>vertex(positions[i],[nx,ny,nz],color);
      quad(corner(a),corner(b),corner(c),corner(d));
    }
  }
  function frame(levels){
    const outlines=levels.map(([x,y,z,radius,color])=>{
      const ring=[];
      for(let quarter=0;quarter<4;quarter++)for(let j=0;j<=8;j++){
        const angle=(quarter+j/8)*Math.PI/2;
        const nx=Math.cos(angle),nz=Math.sin(angle);
        const px=Math.sign(Math.cos((quarter+.5)*Math.PI/2))*(x-radius)+nx*radius;
        const pz=Math.sign(Math.sin((quarter+.5)*Math.PI/2))*(z-radius)+nz*radius;
        ring.push({p:[px,y,pz],n:[nx,nz],c:color});
      }
      return ring;
    });
    for(let l=0;l<outlines.length-1;l++){
      const lower=outlines[l],upper=outlines[l+1];
      const tilt=normalize([levels[l+1][1]-levels[l][1],levels[l][0]-levels[l+1][0],0]);
      const packed=point=>vertex(point.p,[point.n[0]*tilt[0],tilt[1],point.n[1]*tilt[0]],point.c);
      for(let i=0;i<lower.length;i++){
        const j=(i+1)%lower.length;
        quad(packed(lower[i]),packed(lower[j]),packed(upper[j]),packed(upper[i]));
      }
    }
    const upper=outlines.at(-1),center=vertex([0,levels.at(-1)[1],0],[0,1,0],levels.at(-1)[4]);
    const cap=p=>vertex(p.p,[0,1,0],p.c);
    for(let i=0;i<upper.length;i++)triangle(center,cap(upper[i]),cap(upper[(i+1)%upper.length]));
  }

  frame([[1.76,-.405,1.20,.135,black],[1.84,-.348,1.26,.172,bronze],[1.82,-.32,1.24,.17,bronze],
    [1.77,-.30,1.19,.135,black],[1.755,-.076,1.158,.13,black],[1.72,-.045,1.135,.12,bronze],
    [1.72,-.027,1.131,.118,bronze],[1.69,-.007,1.105,.112,clay]]);
  box(0,-.166,1.194,.54,.065,.013,bronze);
  box(0,-.163,1.211,.518,.048,.004,dark);
  for(let i=0;i<25;i++){
    const major=i%4===0;
    box((i-12)*.039,-.163-(major?0:.011),1.217,.0023,major?.029:.018,.002,lerp(bronze,light,major?.70:.28));
  }
  for(const x of [-1.465,1.465]){
    box(x,-.17,1.187,.115,.041,.015,black);
    box(x,-.17,1.205,.044,.017,.008,mode==='terrain'?glass:bronze);
  }
  for(const x of [-1.55,1.55])for(const z of [-.895,.895])box(x,-.435,z,.125,.048,.102,dark);

  let range=0,triangles=0;
  if(mode==='terrain'){
    const [extentX,extentZ]=terrainBounds;
    const width=bands+1;
    const samples=Array.from({length:width*width},(_,i)=>{
      const u=((i%width)/bands)*2-1,v=(Math.floor(i/width)/bands)*2-1;
      const h=elevation(u,v,frequency,amount);
      range=Math.max(range,h);
      const d=.002;
      const dx=(elevation(u+d,v,frequency,amount)-elevation(u-d,v,frequency,amount))/(2*d*extentX);
      const dz=(elevation(u,v+d,frequency,amount)-elevation(u,v-d,frequency,amount))/(2*d*extentZ);
      const water=lerp([.077,.296,.273],[.145,.59,.476],smooth(1.13,.16,Math.hypot(u*.87,v*.87)));
      const shore=lerp([.81,.64,.38],[.54,.47,.30],smooth(.018,.107,h));
      const stone=lerp([.52,.37,.23],[.90,.82,.57],smooth(.15,.64,h));
      const land=lerp(shore,stone,smooth(.070,.19,h));
      const color=lerp(water,land,smooth(.008,.045,h));
      return vertex([u*extentX,.034+h,v*extentZ],normalize([-dx,1,-dz]),color,u,h,1);
    });
    for(let z=0;z<bands;z++)for(let x=0;x<bands;x++){
      const a=z*width+x,b=a+width;
      quad(samples[a],samples[b],samples[b+1],samples[a+1]);
      triangles+=2;
    }
    for(const [x,z,dx,dz] of [[0,-1.035,1.60,.014],[0,1.035,1.60,.014],[-1.596,0,.014,1.02],[1.596,0,.014,1.02]])box(x,.020,z,dx,.017,dz,bronze);
  }else if(mode==='cloud'){
    box(0,.021,0,1.35,.021,1.031,dark);
    for(const x of [-1.29,1.29])for(const z of [-.99,.99]){
      box(x,.092,z,.038,.046,.04,bronze);
      box(x,.174,z,.013,.047,.012,bronze);
    }
    for(let i=-8;i<=8;i++){
      box(i*.141,.044,1.019,.0025,.002,.009,i%4===0?light:bronze);
    }
  }else{
    box(0,.065,0,1.56,.075,.97,bronze);
    const xy=[[-1.51,-.92],[1.51,-.92],[1.51,.92],[-1.51,.92]];
    const face=xy.map(([x,z],i)=>vertex([x,.142,z],[0,1,0],light,i===0||i===3?0:1,i<2?0:1,2));
    quad(...face);
    for(const x of [-1.542,1.542])for(const z of [-.95,.95])box(x,.143,z,.029,.010,.024,light);
  }
  return {data:new Float32Array(vertices),range,triangles};
}
