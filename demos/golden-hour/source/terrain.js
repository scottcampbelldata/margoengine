
import {Geometry} from '@margoengine/core';

const tau=2*Math.PI;
const shades={
  wash:['#b58d72','#ba9174','#bd9677','#c39c7e'],
  floor:['#9e6a50','#a16c50','#a67053','#a97254','#ae7759','#b48060'],
  cliffs:['#713d2d','#854837','#98563b','#b86a44','#cb794b','#bc7658','#d19a71','#934f3b','#ad6247'],
  stone:['#ae7962','#a67252','#8c5d4c','#bd8569'],
  foliage:['#525443','#69694e','#807457'],
};

function hash(x,y=0,seed=7){
  let n=Math.imul(x|0,374761393)+Math.imul(y|0,668265263)+Math.imul(seed,15485863)|0;
  n=Math.imul(n^(n>>>13),1274126177);
  return ((n^(n>>>16))>>>0)/4294967296;
}
function smooth(t){return t*t*(3-2*t);}
function clamp01(value){return Math.max(0,Math.min(1,value));}
function noise(x,z,seed=7){
  const i=Math.floor(x),j=Math.floor(z),a=smooth(x-i),b=smooth(z-j);
  const p=hash(i,j,seed)*(1-a)+hash(i+1,j,seed)*a;
  const q=hash(i,j+1,seed)*(1-a)+hash(i+1,j+1,seed)*a;
  return p+(q-p)*b;
}
function washCenter(z){return 104+132*Math.sin((z+220)/460)+59*Math.sin((z-240)/215)+z*.015;}
function channel(x,z){
  const width=32+12*noise(z/180,4,5)+.010*Math.max(0,-z);
  return Math.abs(x-washCenter(z)-10*noise(z/95,8,13))/width;
}
function terrainHeight(x,z){
  const main=17*noise(x/210,z/240,15)+12*noise(x/88,z/113,23)+4*noise(x/31,z/44,29);
  const basin=40*noise(x/1700,z/1300,9)+22*noise(x/800,z/1050,21);
  const bank=14*smooth(clamp01((channel(x,z)-.30)/1.85));
  const near=58*Math.exp(-((x+500)**2/220000+(z-920)**2/165000));
  return main+basin+bank+near;
}
function groundPoint(x,z){return [x,terrainHeight(x,z),z];}

function bucket(){return {points:[],normals:[],indices:[]};}
function direction(a,b,c){
  const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2];
  const u=c[0]-a[0],v=c[1]-a[1],w=c[2]-a[2];
  const n=[y*w-z*v,z*u-x*w,x*v-y*u];
  const l=Math.hypot(...n)||1;
  return n.map(v=>v/l);
}
function face(batch,verts,shading){
  const offset=batch.points.length/3,n=shading?null:direction(verts[0],verts[1],verts[2]);
  for(let i=0;i<verts.length;i++){
    batch.points.push(...verts[i]);
    batch.normals.push(...(shading?.[i]??n));
  }
  for(let i=1;i<verts.length-1;i++)batch.indices.push(offset,offset+i,offset+i+1);
}
function pointNormal(x,z,scale){
  return direction(groundPoint(x,z),groundPoint(x,z+scale),groundPoint(x+scale,z));
}

function ground(data){
  const side=120, length=144;
  const points=[], normals=[];
  for(let j=0;j<=length;j++){
    const z=1180-10000*(j/length)**2.24;
    for(let i=0;i<=side;i++){
      const s=2*i/side-1;
      const x=8600*Math.sign(s)*Math.abs(s)**2.0;
      points.push(groundPoint(x,z));
      normals.push(pointNormal(x,z,2.6));
    }
  }
  function draw(indices,i,j){
    const [x,,z]=points[indices[0]];
    const river=channel(x,z);
    const terra=noise(x/106,z/125,35)*.66+noise(x/28,z/41,3)*.27+hash(i,j,4)*.07;
    const beds=river<1.22&&terra*.28+.49<1.13-river*.45;
    const family=beds?'wash':'floor';
    let tone=Math.min(shades[family].length-1,Math.floor(terra*shades[family].length));
    if(!beds&&river<2.4&&terra>.35)tone=Math.max(1,tone);
    face(data[family][tone],indices.map(ix=>points[ix]),indices.map(ix=>normals[ix]));
  }
  for(let j=0;j<length;j++)for(let i=0;i<side;i++){
    const a=j*(side+1)+i,b=a+1,c=a+side+1,d=c+1;
    draw([a,b,c],i,j);
    draw([c,b,d],i,j);
  }
}

const footing=[
  [-.22,1.22,1],[-.015,1.22,1],[.06,1.105,2],[.11,.97,3],[.17,.835,2],
  [.226,.71,1],[.267,.66,2],[.287,.59,7],[.322,.604,5],[.342,.60,6],
  [.375,.59,4],[.50,.568,3],[.555,.573,2],[.586,.548,5],[.61,.577,6],
  [.628,.57,4],[.693,.553,3],[.76,.52,3],[.79,.51,7],[.823,.545,8],
  [.86,.513,4],[.91,.492,3],[.944,.472,5],[.958,.48,6],[.987,.447,4],
  [1.0,.414,3],[1.0,.315,4],[.993,.19,4],[.986,.092,3],
];
function tableProfile(variation){
  if(variation==='ridge')return footing.map(([h,r,c])=>[h,r*(h<.21?1:1+h*.20),c]);
  if(variation==='pinnacle')return footing.map(([h,r,c])=>[h,r*(h<.25?1:1-h*.38),c]);
  if(variation==='shoulder')return footing.map(([h,r,c])=>[h,r*(1+.12*Math.sin(4*h)),c]);
  return footing;
}
const buttes=[
  {x:-205,z:40,h:207,rx:245,rz:163,rot:-.14,seed:19},
  {x:-301,z:-43,h:169,rx:133,rz:165,rot:.11,seed:71,style:'shoulder'},
  {x:-141,z:20,h:316,rx:103,rz:102,rot:.21,seed:17,style:'pinnacle'},
  {x:-50,z:38,h:161,rx:92,rz:103,rot:.05,seed:22,style:'pinnacle'},
  {x:445,z:-679,h:260,rx:364,rz:183,rot:.44,seed:41,style:'ridge'},
  {x:535,z:-738,h:215,rx:304,rz:201,rot:.14,seed:9},
  {x:326,z:-638,h:173,rx:88,rz:113,rot:.16,seed:53,style:'pinnacle'},
  {x:-535,z:-440,h:131,rx:262,rz:158,rot:.53,seed:6,style:'ridge'},
  {x:-816,z:-1210,h:265,rx:536,rz:366,rot:.29,seed:33,style:'ridge'},
  {x:1012,z:-1400,h:328,rx:710,rz:465,rot:.12,seed:29,style:'ridge'},
  {x:5,z:-1570,h:206,rx:308,rz:221,rot:-.42,seed:5},
  {x:-217,z:-1834,h:223,rx:421,rz:353,rot:.38,seed:66,style:'ridge'},
  {x:494,z:-2200,h:183,rx:366,rz:289,rot:0,seed:82},
  {x:-1180,z:-2550,h:337,rx:920,rz:502,rot:.40,seed:48,style:'ridge'},
  {x:1011,z:-2770,h:423,rx:820,rz:665,rot:.13,seed:59,style:'ridge'},
  {x:-126,z:-3280,h:395,rx:1105,rz:489,rot:.32,seed:74,style:'ridge'},
  {x:2125,z:-3450,h:445,rx:1140,rz:590,rot:.48,seed:40,style:'ridge'},
  {x:-2320,z:-4140,h:238,rx:1150,rz:780,rot:0,seed:90,style:'ridge'},
  {x:1450,z:-5150,h:345,rx:2210,rz:840,rot:.23,seed:7,style:'ridge'},
];

function stripNormals(strip,reverse=false){
  const last=strip.length-1,length=strip[0].length;
  return strip.map((row,y)=>row.map((_,i)=>{
    const lower=strip[Math.max(0,y-1)][i],upper=strip[Math.min(last,y+1)][i];
    const left=row[(i+length-1)%length],right=row[(i+1)%length];
    const along=[upper[0]-lower[0],upper[1]-lower[1],upper[2]-lower[2]];
    const around=[right[0]-left[0],right[1]-left[1],right[2]-left[2]];
    return reverse?direction([0,0,0],around,along):direction([0,0,0],along,around);
  }));
}

function towers(data){
  for(const item of buttes){
    const {x,z,h,rx,rz,rot,seed,style}=item;
    const rows=tableProfile(style), divisions=h>254?72:64, base=terrainHeight(x,z)-16;
    const op=hash(seed,5)*tau,angleCos=Math.cos(rot),angleSin=Math.sin(rot);
    const yaw=Array.from({length:divisions},(_,i)=>{
      const phase=i/divisions*tau;
      return phase+(hash(i,12,seed)-.5)*.053;
    });
    const strip=rows.map(([level,radial],row)=>yaw.map((theta,index)=>{
      const c=Math.cos(theta),s=Math.sin(theta);
      const rock=.10*Math.sin(3*theta+op)+.076*Math.cos(5*theta+op)+.11*Math.sin(9*theta+op*.8);
      const fracture=.024*Math.cos(17*theta+op)+.026*(hash(index,21,seed)-.5)+.015*(hash(index,row,seed)-.5);
      const taper=radial*(1+rock+fracture);
      const shape=.83;
      const tx=Math.sign(c)*Math.abs(c)**shape*rx*taper;
      const tz=Math.sign(s)*Math.abs(s)**shape*rz*taper;
      const lean=.065*rx*Math.sin(op)*level**2;
      const crest=level>.80?Math.pow((level-.80)/.20,2):0;
      const ridge=(.020*Math.cos(2*theta+op)+.011*Math.sin(5*theta+op)+.029*crest*Math.cos(4*theta+op))*h;
      return [x+tx*angleCos-tz*angleSin+lean,base+h*level+ridge,z+tx*angleSin+tz*angleCos];
    }));
    const normals=z>-1900?stripNormals(strip):null;
    for(let j=0;j<strip.length-1;j++){
      for(let i=0;i<divisions;i++){
        const k=(i+1)%divisions;
        const a=strip[j][i],b=strip[j][k],c=strip[j+1][i],d=strip[j+1][k];
        const band=rows[j][2];
        const grain=hash(Math.floor(i*.41),Math.floor(j*.58),seed);
        const chosen=grain<.14?Math.max(0,band-1):grain>.86&&band===3?4:band;
        const verts=[a,c,d,b], first=direction(a,c,d);
        if(normals){
          const soft=j<7?.76:j>=strip.length-4?.55:.64;
          const smoothed=[normals[j][i],normals[j+1][i],normals[j+1][k],normals[j][k]].map(n=>{
            return n.map((value,axis)=>first[axis]*(1-soft)+value*soft);
          });
          face(data.cliffs[chosen],verts,smoothed);
        }else face(data.cliffs[chosen],verts);
      }
    }
    const cap=strip.at(-1), top=[x,base+h*.987,z];
    for(let i=0;i<divisions;i++)face(data.cliffs[4],[top,cap[(i+1)%divisions],cap[i]]);
  }
}

function arch(data){
  const x0=173,z0=-530,base=terrainHeight(x0,z0)-18,steps=54,sides=20;
  const rows=Array.from({length:steps+1},(_,row)=>{
    const angle=row/steps*Math.PI,s=Math.sin(angle),c=Math.cos(angle);
    return Array.from({length:sides},(_,index)=>{
      const ring=index/sides*tau;
      const variation=1+.17*Math.sin(angle*9+ring*2)+.12*Math.sin(19*angle+ring*3);
      const bank=15+20*Math.abs(c)**8+9*(1-s);
      const radius=bank*variation*Math.cos(ring);
      const x=c*(101+radius)+.08*122*s;
      const y=base+s*(113+radius)+3.7*Math.sin(7*angle+ring*2);
      const z=(22+5*Math.cos(19*angle))*Math.sin(ring)*variation;
      return [x0+x*.984-z*.18,y,z0+z*.984+x*.18];
    });
  });
  const normals=stripNormals(rows,true);
  for(let row=0;row<steps;row++)for(let i=0;i<sides;i++){
    const next=(i+1)%sides;
    const batch=[rows[row][i],rows[row][next],rows[row+1][next],rows[row+1][i]];
    const elevation=batch.reduce((sum,p)=>sum+p[1],0)/4;
    const stratum=Math.sin((elevation-base)*.17)+.19*Math.cos((elevation-base)*.35);
    const channel=stratum>.8?6:stratum>.12?4:stratum<-.8?7:3;
    face(data.cliffs[channel],batch,[normals[row][i],normals[row][next],normals[row+1][next],normals[row+1][i]]);
  }
}

function boulder(data,i,x,z,scale,seed){
  const y=terrainHeight(x,z), phase=hash(i,23,seed)*tau, height=scale*(.36+hash(i,11,seed)*.38);
  const ring=(h,r)=>Array.from({length:7},(_,j)=>{
    const a=j/7*tau+phase, bias=hash(j,i,seed);
    return [x+r*scale*(.67+bias*.34)*Math.cos(a),y+h*height+height*(bias-.42)*.42,z+r*scale*Math.sin(a)*(.71+bias*.32)];
  });
  const bottom=ring(-.31,.83),middle=ring(.2,1), top=ring(.85,.58);
  for(const [lo,hi] of [[bottom,middle],[middle,top]])for(let j=0;j<lo.length;j++){
    const next=(j+1)%lo.length, shade=Math.min(3,Math.floor(hash(j,i,seed)*4));
    face(data.stone[shade],[lo[j],hi[j],hi[next],lo[next]]);
  }
  face(data.stone[0],[...top].reverse());
}

function plants(data){
  for(let i=0;i<530;i++){
    const x=(hash(i,12,65)*2-1)*720,z=401+hash(i,44,26)*713;
    if(channel(x,z)<1.14||noise(x/114,z/78,29)<.24)continue;
    const y=terrainHeight(x,z)-.08,h=.75+hash(i,14,61)*1.28;
    const tone=hash(i,78,11)>.49?1:0;
    const leaves=9+Math.floor(hash(i,12,41)*8);
    for(let j=0;j<leaves;j++){
      const angle=12.08*hash(i,j)+j/leaves*tau,c=Math.cos(angle),s=Math.sin(angle);
      const crown=.25+hash(i,j,15)*.96, tilt=.64+hash(i,j,143)*1.26;
      const tip=[x+c*tilt*h,y+h*crown,z+s*tilt*h];
      const k=[x+c*.42*h,y+h*(.70+crown*.26),z+s*.42*h];
      const q=[-s*h*.09,0,c*h*.09], root=[x+c*.09,y,z+s*.09];
      const a=k.map((n,j)=>n+q[j]),b=k.map((n,j)=>n-q[j]);
      face(data.foliage[(j%5===0)?2:tone],[root,a,tip,b]);
    }
  }
  for(let i=0;i<350;i++){
    const scale=i<30?6+hash(i,19,10)*12:1+hash(i,19,10)*3.4;
    const z=510+hash(i,34,14)*630,x=(2*hash(i,6,81)-1)*730;
    if(channel(x,z)<.94&&i<80)continue;
    boulder(data,i,x,z,scale,64);
  }
  for(const [i,formation] of buttes.slice(0,9).entries()){
    for(let j=0;j<20;j++){
      const turn=j/20*tau, radius=1.04+.5*hash(j,i,72), size=3+hash(j,i,8)*12;
      boulder(data,j,formation.x+Math.cos(turn)*formation.rx*radius,formation.z+Math.sin(turn)*formation.rz*radius,size,i+6);
    }
  }
}

export function makeLandscape(){
  const data=Object.fromEntries(Object.entries(shades).map(([family,tones])=>[family,tones.map(bucket)]));
  ground(data);
  towers(data);
  arch(data);
  plants(data);
  return Object.entries(shades).flatMap(([family,tones])=>tones.flatMap((color,index)=>{
    const p=data[family][index];
    if(!p.indices.length)return [];
    return [{family,color,geometry:new Geometry(p.points,p.normals,p.indices)}];
  }));
}
