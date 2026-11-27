import { Material } from '@margoengine/materials';
import { bed, inlet, outlet, jumpToe, upstreamDepth, width } from './hydraulics.js';
import { rgb } from './scenery.js';

const tau=2*Math.PI;
const streams=10;
const sideRows=5;
const zones=[23,46,25];
const span=zones.reduce((sum,n)=>sum+n,0)+1;
const half=width/2;
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
function smooth(a,b,value){
  const t=clamp((value-a)/(b-a));
  return t*t*(3-2*t);
}
function envelope(r){
  return smooth(-.045,.075,r)*(1-smooth(.58,1.03,r));
}
function meanDepth(model,r){
  return upstreamDepth+model.depthRise*smooth(-.016,.67,r);
}

function shape(model,x,z,t){
  const r=(x-jumpToe)/model.roller;
  const zeta=z/half;
  const wobble=.033*Math.sin(4.4*zeta+9.1*t)+.014*Math.sin(11.2*zeta-12.4*t);
  const ev=envelope(r);
  const dirty=r+wobble*ev;
  const surge=model.depthRise*ev*(.048*Math.sin(55*r+7.6*t+4.6*zeta)+.031*Math.sin(91*r-11.4*t-7.1*zeta)
    +.036*Math.sin(18.5*r+13.1*t+11*zeta)*Math.cos(8.2*zeta+4.7*t));
  const upstream=(1-smooth(-.22,-.01,r))*.0029*Math.sin(55*x-32*model.speed*t+5.1*zeta);
  const tail=smooth(.68,1.2,r)*.004*Math.sin(39*x-38*model.downstreamSpeed*t+3*zeta);
  return bed+meanDepth(model,dirty)+surge+upstream+tail;
}

const base=rgb('#2d7473'),shore=rgb('#459083'),light=rgb('#a4e3d5'),cream=rgb('#e5efe1');
const depthDark=rgb('#114c4b'),depthTop=rgb('#55a797');
function setColor(colors,i,a,b,m){
  for(let c=0;c<3;c++)colors[3*i+c]=a[c]+(b[c]-a[c])*m;
}
function freshMesh(columns,rows,front){
  const count=columns*rows;
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),colors=new Float32Array(count*3);
  const indices=new Uint16Array((columns-1)*(rows-1)*6);
  let at=0;
  for(let j=0;j<rows-1;j++)for(let i=0;i<columns-1;i++){
    const a=i+j*columns,b=a+1,c=a+columns,d=c+1;
    indices.set(front?[a,b,c,b,d,c]:[a,c,b,b,c,d],at);at+=6;
  }
  return {positions,normals,colors,indices};
}

function station(model,i){
  const [first,middle,last]=zones;
  if(i<=first)return inlet+(jumpToe-inlet)*i/first;
  if(i<=first+middle)return jumpToe+model.roller*(i-first)/middle;
  return model.end+(outlet-model.end)*(i-first-middle)/last;
}
function setTop(mesh,model,t){
  const {positions:p,normals:n,colors:c}=mesh;
  for(let j=0;j<streams;j++){
    const z=half*(2*j/(streams-1)-1);
    for(let i=0;i<span;i++){
      const v=i+j*span,x=station(model,i),r=(x-jumpToe)/model.roller;
      p.set([x,shape(model,x,z,t),z],3*v);
      const fizz=envelope(r)*smooth(-.02,.10,r);
      const a=.5+.5*Math.sin(67*r+9.8*t+45*z+1.1*Math.sin(29*z-12.3*t));
      const b=.5+.5*Math.sin(136*r-11.3*t-71*z+.9*Math.sin(29*r));
      const thread=Math.max(a,.76*b)*(.55+.45*Math.sin(11*r-3.1*t+31*z)**2);
      const glass=.28+.25*Math.sin(38*x-23*t+45*z)**2;
      const foam=clamp(fizz*(.42+.76*smooth(.35,.98,thread)));
      setColor(c,v,base,r<0?shore:light,glass);
      for(let k=0;k<3;k++)c[3*v+k]+=(cream[k]-c[3*v+k])*foam;
    }
  }
  for(let j=0;j<streams;j++)for(let i=0;i<span;i++){
    const v=i+j*span,prev=j*span+Math.max(0,i-1),next=j*span+Math.min(span-1,i+1);
    const x=(p[3*next+1]-p[3*prev+1])/(p[3*next]-p[3*prev]);
    const a=i+Math.max(0,j-1)*span,b=i+Math.min(streams-1,j+1)*span;
    const z=(p[3*b+1]-p[3*a+1])/(p[3*b+2]-p[3*a+2]);
    const normal=1/Math.hypot(x,1,z);
    n.set([-x*normal,normal,-z*normal],3*v);
  }
}
function setFace(mesh,model,t){
  const {positions:p,normals:n,colors:c}=mesh;
  for(let i=0;i<span;i++){
    const x=station(model,i),r=(x-jumpToe)/model.roller;
    const depth=shape(model,x,half,t)-bed;
    for(let j=0;j<sideRows;j++){
      const v=i+j*span,h=j/(sideRows-1),y=bed+depth*h;
      const ribbons=.5+.5*Math.sin(32*x-21*t+47*y+2*Math.sin(58*y+11*x));
      const ar=envelope(r)*h*h*(.43+.51*ribbons);
      p.set([x,y,half],3*v);n[3*v+2]=1;
      setColor(c,v,depthDark,depthTop,h*.70+.11*ribbons);
      for(let k=0;k<3;k++)c[3*v+k]+=(cream[k]-c[3*v+k])*ar;
    }
  }
}

function seed(i,j){
  const n=Math.sin(i*17.177+j*38.39)*43758.5453;
  return n-Math.floor(n);
}
function glints(){
  const n=174;
  const positions=new Float32Array(n*12),normals=new Float32Array(n*12),colors=new Float32Array(n*16);
  const indices=new Uint16Array(n*6);
  for(let i=0;i<n;i++){
    const v=4*i;
    indices.set([v,v+1,v+2,v+2,v+1,v+3],6*i);
    for(let j=0;j<4;j++)normals[3*(v+j)+2]=1;
  }
  const dots=Array.from({length:n},(_,i)=>Array.from({length:5},(_,j)=>seed(i+1,j+1)));
  return {geometry:{positions,normals,colors,indices},dots};
}
function setGlints({geometry:{positions:p,colors:c},dots},model,t){
  for(const [i,[a,b,d,e,f]] of dots.entries()){
    const cycle=(a+t*(.23+.52*b))%1,theta=tau*cycle;
    let x,y,z,alpha;
    const radius=.0018+.0080*d*d;
    if(i<92){
      const h=.56+.32*Math.sin(theta);
      x=jumpToe+model.roller*(.405+.34*Math.cos(theta)+.18*(d-.5));
      z=half+.0009;
      const depth=shape(model,x,half,t)-bed;
      y=bed+Math.max(.005,depth*h);
      alpha=(.43+.55*((1+b)*h)**2/4)*(.64+.35*Math.sin(theta));
    }else if(i<132){
      const r=.02+.76*(1-cycle)*(.57+.43*b);
      x=jumpToe+model.roller*r;
      z=half*1.88*(e-.5);
      y=shape(model,x,z,t)+.003;
      alpha=.66*Math.sin(Math.PI*cycle)**2;
    }else if(i<144){
      x=jumpToe+model.roller*(.155+.28*cycle+.095*b);
      z=half*1.78*(e-.5);
      y=shape(model,x,z,t)+.14*f*cycle*(1-cycle)*4;
      alpha=.54*Math.sin(Math.PI*cycle);
    }else{
      const left=i<166,a1=left?inlet+.06:model.end+.025,a2=left?jumpToe-.025:outlet-.04;
      const u=left?model.speed:model.downstreamSpeed;
      const k=(a+u*t/(a2-a1)*.72)%1;
      x=a1+(a2-a1)*k;
      z=half*1.87*(e-.5);
      y=shape(model,x,z,t)+.0016;
      alpha=(left?.57:.39)*Math.sin(Math.PI*k)**2;
    }
    const w=radius*(i>=144?3.7:i>=92?1.6:1.12),h=radius*(i>=144?.26:.78);
    const v=4*i;
    p.set([x-w,y-h,z,x+w,y-h,z,x-w,y+h,z,x+w,y+h,z],3*v);
    for(let j=0;j<4;j++)c.set([.50+b*.41,.80+b*.19,.70+b*.26,alpha],4*(v+j));
  }
}

export function buildWater(add,initial){
  const topSurface=freshMesh(span,streams,false);
  const section=freshMesh(span,sideRows,true);
  const bubbles=glints();
  const materials=[
    new Material({color:'#d4eee0',roughness:.26}),
    new Material({shading:'basic',color:'#c6ede4'}),
    new Material({shading:'basic',color:'#d5f7ec',transparent:true,opacity:.61,depthWrite:false}),
  ];
  function updateData(model,t){
    setTop(topSurface,model,t);setFace(section,model,t);setGlints(bubbles,model,t);
  }
  updateData(initial,0);
  const meshes=[
    add(topSurface,materials[0],'Sloped live water surface'),
    add(section,materials[1],'Water section and entrained air'),
    add(bubbles.geometry,materials[2],'Foam tracers and roller bubbles',undefined,5),
  ];
  const geometry=[topSurface,section,bubbles.geometry];
  let lastModel=initial,lastTime=0;
  return {
    update(model,t){
      if(model===lastModel&&t===lastTime)return;
      updateData(model,t);
      meshes.forEach((mesh,i)=>mesh.setGeometry(geometry[i],{start:0,count:geometry[i].positions.length/3}));
      lastModel=model;lastTime=t;
    },
    dispose(){for(const m of materials)m.dispose();},
  };
}
