import {Geometry,PbrMaterial} from '@margoengine/core';

const pi=Math.PI;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const noise=(x,z)=>Math.sin(x*.017+z*.009)*Math.cos(z*.013-x*.007);
const ridge=(x,z,rx,rz,a,b)=>Math.max(0,1-Math.hypot((x-rx)/a,(z-rz)/b));

export function coastHeight(x,z){
  const promontory=Math.max(
    ridge(x,z,-415,-721,239,210),
    ridge(x,z,-556,-814,300,178)*.96,
    ridge(x,z,-256,-751,79,98)*.73,
    ridge(x,z,375,-476,167,181)*.58,
    ridge(x,z,490,-644,198,166)*.71,
    ridge(x,z,-206,-148,173,126)*.40,
    ridge(x,z,158,-291,59,39)*.15,
    ridge(x,z,-145,-596,30,55)*.17
  );
  const strata=Math.sin((z+x*.13)*.21)*2.3+noise(x,z)*11+Math.sin(x*.085-z*.038)*2.6;
  const chips=.52*Math.sin(x*.77+z*.26)+.35*Math.cos(z*.73-x*.53);
  const layers=strata+chips;
  return -5.2+Math.pow(promontory,.53)*(84+layers)+Math.max(0,promontory-.17)*layers;
}

function surfaceHeight(x,z){
  return .69*Math.sin(x*.045-z*.17)+.47*Math.cos(x*.08+z*.094)+.29*Math.sin(x*.182-z*.229);
}

const rock=['#343845','#39414e','#414954','#504f57','#5e5660','#303847'];
const water=['#172431','#1d2e3c','#223341','#203447','#2d4052','#354657'];
const whitecap=['#3e5262','#556675','#667b89'];

const normal=(a,b,c)=>{
  const u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const len=Math.hypot(...n)||1;
  return n.map(t=>t/len);
};

function batch(){
  const groups=new Map();
  return {
    tri(a,b,c,color,roughness=.78,normals){
      const key=color+'/'+roughness;
      if(!groups.has(key))groups.set(key,{color,roughness,positions:[],normals:[],indices:[]});
      const g=groups.get(key),i=g.positions.length/3,n=normals??normal(a,b,c);
      g.positions.push(...a,...b,...c);
      if(normals?.length===9)g.normals.push(...normals);
      else g.normals.push(...n,...n,...n);
      g.indices.push(i,i+1,i+2);
    },
    quad(a,b,c,d,color,roughness){
      this.tri(a,b,c,color,roughness);
      this.tri(a,c,d,color,roughness);
    },
    finish(){
      return Array.from(groups.values(),g=>({
        geometry:new Geometry(g.positions,g.normals,g.indices),
        material:new PbrMaterial({color:g.color,roughness:g.roughness,doubleSided:false}),
      }));
    },
  };
}

function buildTerrain(geo){
  const s=6,wide=236,deep=186;
  const values=Array.from({length:deep+1},(_,j)=>Array.from({length:wide+1},(_,i)=>{
    const x=(i-117)*s+Math.sin(i*14.78+j*71.11)*2.08,z=85-j*s+Math.cos(i*51.12+j*9.31)*2.1;
    return [x,coastHeight(x,z),z];
  }));
  for(let j=0;j<deep;j++)for(let i=0;i<wide;i++){
    const a=values[j][i],b=values[j][i+1],c=values[j+1][i+1],d=values[j+1][i];
    if(Math.max(a[1],b[1],c[1],d[1])<-1.55)continue;
    const v=noise(a[0],a[2])*.65+Math.sin(a[2]*.26+a[0]*.039)*.3+Math.cos(a[0]*.19)*.18;
    const idx=clamp(Math.floor(2.5+2.5*v),0,5);
    geo.tri(a,b,c,rock[(j+i)%19===0?5:idx]);
    geo.tri(a,c,d,rock[(j+3*i)%27===0?5:idx]);
  }
}

function surf(geo){
  const rows=135,columns=52;
  const point=(i,j)=>{
    const z=172-j*13.4-j*j*.069;
    const x=(i-columns/2)*Math.max(5,(172-z)*.034);
    return [x,surfaceHeight(x,z),z];
  };
  for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const p=point(i,j),q=point(i+1,j),r=point(i+1,j+1),s=point(i,j+1);
    const hue=clamp(Math.floor(2.5+(p[1]+q[1]+r[1]+s[1])*.48+Math.cos(j*.33+i*.43)),0,4);
    const waveNormal=p=>[-.041*Math.cos(p[0]*.045-p[2]*.17),1,.15*Math.cos(p[0]*.045-p[2]*.17)];
    const n=[waveNormal(p),waveNormal(q),waveNormal(r),waveNormal(s)];
    geo.tri(p,q,r,water[hue],.52,n.slice(0,3).flat());
    geo.tri(p,r,s,water[hue],.52,[n[0],n[2],n[3]].flat());
  }
  geo.quad([-15000,-2.4,170],[15000,-2.4,170],[15000,-2.4,-19000],[-15000,-2.4,-19000],water[0],.60);
  for(let j=0;j<154;j++){
    let x=Math.sin(j*81.114)*720,z=-136-Math.abs(Math.cos(j*39.325))*900;
    const edge=coastHeight(x,z);
    if(edge>6||edge<-4.3)continue;
    const length=2.2+Math.abs(Math.sin(j*53.17))*17.6;
    const width=.27+Math.abs(Math.cos(j*31.35))*.9;
    const foam=(x,z)=>[x,surfaceHeight(x,z)+.1,z];
    for(let k=0;k<3;k++){
      const x1=x+(k-1)*length*.4,z1=z+k*2.3;
      geo.quad(foam(x1-length*.5,z1-width),foam(x1+length*.3,z1-width*.6),foam(x1+length*.55,z1-width*2.1),foam(x1-length*.22,z1-width*2.3),whitecap[(j+k)%3],.81);
    }
  }
}

function rectangular(geo,x,y,z,w,h,d,color,roughness){
  const a=[x-w/2,y,z+d/2],b=[x+w/2,y,z+d/2],c=[x+w/2,y,z-d/2],e=[x-w/2,y,z-d/2];
  const top=p=>[p[0],p[1]+h,p[2]];
  geo.quad(a,b,top(b),top(a),color,roughness);
  geo.quad(b,c,top(c),top(b),color,roughness);
  geo.quad(c,e,top(e),top(c),color,roughness);
  geo.quad(e,a,top(a),top(e),color,roughness);
  geo.quad(top(a),top(b),top(c),top(e),color,roughness);
}

function round(geo,x,z,levels,colors,n=12){
  const pos=(i,j)=>[x+Math.cos(i*2*pi/n)*levels[j][1],levels[j][0],z+Math.sin(i*2*pi/n)*levels[j][1]];
  for(let ring=0;ring<levels.length-1;ring++)for(let i=0;i<n;i++)
    geo.quad(pos(i,ring),pos(i,ring+1),pos(i+1,ring+1),pos(i+1,ring),colors[ring],.57);
}

function station(geo){
  const x=-239,z=-758,y=coastHeight(x,z)-1;
  const foundation='#66616b',plaster='#91868e',trim='#242932',roof='#444151',amber='#ffbb68';
  round(geo,x,z,[[y-4,13.7],[y+2,13.4],[y+4,10.7],[y+27,8.4],[y+29,9.1],[y+31,11.9],[y+32,11.9]], [foundation,foundation,plaster,plaster,trim,trim]);
  round(geo,x,z,[[y+32,7.35],[y+39,7.35],[y+40.8,8.55],[y+44,5.1],[y+47.5,.36]],[amber,trim,roof,roof]);
  round(geo,x,z,[[y+31.8,11.5],[y+32.2,11.5]],[trim]);
  for(let i=0;i<12;i++){
    const theta=i*2*pi/12,point=(r,h)=>[x+Math.cos(theta)*r,y+h,z+Math.sin(theta)*r];
    const fr=point(7.57,32),rail=point(11.19,32),a=point(11.4,34.6);
    rectangular(geo,fr[0],fr[1],fr[2],.60,7.3,.60,trim,.62);
    rectangular(geo,rail[0],rail[1],rail[2],.32,3.1,.32,trim,.70);
    const b=[x+Math.cos(theta+pi/6)*11.4,a[1],z+Math.sin(theta+pi/6)*11.4];
    geo.quad(a,b,[b[0],b[1]+.32,b[2]],[a[0],a[1]+.32,a[2]],trim,.65);
  }
  for(let j=0;j<3;j++){
    const ye=y+7+j*6.6;
    rectangular(geo,x-1.3,ye,z+(j?9.3:10.1),1.6,3,.4,trim,.56);
    rectangular(geo,x-1.3,ye+.48,z+(j?9.56:10.4),.87,2,.23,'#9b7762',.54);
  }
  const houseX=-288,houseZ=-770,houseY=coastHeight(houseX,houseZ)-3;
  rectangular(geo,houseX,houseY,houseZ,30,12,16,plaster,.82);
  const p=[houseX-16,houseY+12,houseZ+9],q=[houseX+16,p[1],p[2]];
  const r=[q[0],p[1]+6.3,houseZ],s=[p[0],r[1],r[2]],u=[p[0],p[1],houseZ-9],v=[q[0],p[1],houseZ-9];
  geo.quad(p,q,r,s,roof,.7);
  geo.quad(s,r,v,u,roof,.7);
  geo.tri(p,s,u,plaster);
  geo.tri(q,v,r,plaster);
  rectangular(geo,houseX+9,houseY+13,houseZ-3,2.6,7.1,2.6,foundation,.8);
  for(const dx of [-9,0,9]){
    rectangular(geo,houseX+dx,houseY+3.5,houseZ+8.18,3.5,4.6,.3,trim,.74);
    rectangular(geo,houseX+dx,houseY+4,houseZ+8.39,2.55,3.4,.3,'#cf915b',.60);
  }
}

export function prepareReflection(eye,point){
  const marks=batch();
  const steps=72;
  for(let i=1;i<steps;i++){
    const t=i/(steps-1),z=point[2]+(eye[2]-point[2])*t*.84;
    const x=point[0]+(eye[0]-point[0])*t*.84+Math.sin(i*75.31)*(5+25*t);
    if(coastHeight(x,z)>-.2||Math.sin(i*19.61)<-.62)continue;
    const length=(2+14*t)*(.24+Math.abs(Math.cos(i*43.21)));
    const depth=1.7+5.1*t;
    const face=(x,z)=>[x,surfaceHeight(x,z)+.16,z];
    const a=face(x-length,z), b=face(x+length,z-1.3);
    const c=face(x+length*.47,z-depth), d=face(x-length*.62,z-depth*.86);
    marks.quad(a,b,c,d,i%5===1?'#9eadc9':'#586b8e',.70);
  }
  return marks.finish();
}

export function prepareHeadland(){
  const geo=batch();
  buildTerrain(geo);
  surf(geo);
  station(geo);
  return geo.finish();
}
