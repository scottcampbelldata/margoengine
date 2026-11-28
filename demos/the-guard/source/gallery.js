import {Geometry,PbrMaterial} from '@margoengine/core';
import {patrol,stations} from './plan.js';

const tau=2*Math.PI;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/(Math.hypot(...a)||1));
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function random(n){return ()=>{n=Math.imul(n,1664525)+1013904223|0;return (n>>>0)/4294967296;};}
const tones={
  foundation:['#43464a',.84],edge:['#59615f',.65],recess:['#293638',.92],sand:['#b5a68c',.83],
  floor0:['#a8aa98',.74],floor1:['#acaf9b',.76],floor2:['#a6a894',.78],floor3:['#b2b39d',.80],
  seam:['#949684',.9],lite:['#bfc0a8',.72],sift:['#9b9d89',.84],
  stone:['#c0b59b',.83],stoneA:['#bbb296',.81],stoneB:['#c5b9a1',.85],ledger:['#d6c6a6',.67],
  shadow0:['#737870',.93],shadow1:['#868b7d',.88],shadow2:['#989985',.88],
  pale:['#dde1c8',.7],mist:['#a3bfc0',.52],bay:['#5a7780',.65],glass:['#829ea0',.42],
  timber:['#7b6a54',.64],woodEdge:['#9d896a',.62],woodDark:['#655849',.71],
  oxide:['#755b46',.61],bronze:['#9d754e',.47],brass:['#b28b59',.42],brushed:['#c4a576',.42],
  slate:['#426168',.80],petrol:['#314746',.75],paint:['#e1be86',.43],gold:['#dd9f62',.43],
  route:['#b3956d',.64],trail:['#b1a080',.70],beacon:['#edbf6b',.60],
};
function draft(){
  const bins=new Map();
  function tri(key,a,b,c,normals){
    const f=unit(cross(sub(b,a),sub(c,a)));
    const averaged=Array.isArray(normals?.[0])?normals[0]:normals;
    const flip=averaged&&f.reduce((v,x,i)=>v+x*averaged[i],0)<0;
    if(flip)[b,c]=[c,b];
    const n=Array.isArray(normals?.[0])?(flip?[normals[0],normals[2],normals[1]]:normals):[averaged??f,averaged??f,averaged??f];
    if(!bins.has(key))bins.set(key,{p:[],n:[],i:[]});
    const g=bins.get(key),i=g.p.length/3;
    g.p.push(...a,...b,...c);g.n.push(...n[0],...n[1],...n[2]);g.i.push(i,i+1,i+2);
  }
  return {
    tri,quad(key,a,b,c,d,n){
      const smooth=Array.isArray(n?.[0]);
      tri(key,a,b,c,smooth?n.slice(0,3):n);tri(key,a,c,d,smooth?[n[0],n[2],n[3]]:n);
    },
    meshes(engine,root=null){
      return [...bins].map(([key,{p,n,i}])=>{
        const [color,roughness]=tones[key];
        return engine.createMesh(root).setGeometry(new Geometry(p,n,i))
          .setMaterial(new PbrMaterial({color,roughness,metalness:0,doubleSided:true}));
      });
    },
  };
}
function plinth(m,key,c,[w,h,d],bevel=.034){
  const [x,y,z]=c,a=w/2,b=h/2,k=d/2,t=Math.max(.001,Math.min(bevel,a*.35,b*.60,k*.35));
  const outline=(X,Z)=>[[X-t,Z],[-X+t,Z],[-X,Z-t],[-X,-Z+t],[-X+t,-Z],[X-t,-Z],[X,-Z+t],[X,Z-t]];
  const levels=[
    [-b,a-t,k-t],[-b+t,a,k],[b-t,a,k],[b,a-t,k-t],
  ].map(([Y,X,Z])=>outline(X,Z).map(([u,v])=>[x+u,y+Y,z+v]));
  for(let l=0;l<levels.length-1;l++)for(let i=0;i<8;i++){
    const j=(i+1)%8;m.quad(key,levels[l][j],levels[l][i],levels[l+1][i],levels[l+1][j]);
  }
  for(let i=1;i<7;i++){
    m.tri(key,levels[3][0],levels[3][i],levels[3][i+1],[0,1,0]);
    m.tri(key,levels[0][0],levels[0][i],levels[0][i+1],[0,-1,0]);
  }
}
function tube(m,key,a,b,r0,r1=r0,steps=14){
  const tangent=unit(sub(b,a)),u=unit(cross(tangent,Math.abs(tangent[1])>.82?[1,0,0]:[0,1,0])),v=cross(tangent,u);
  const N=i=>add(mul(u,Math.cos(i*tau/steps)),mul(v,Math.sin(i*tau/steps)));
  for(let i=0;i<steps;i++){
    const n=N(i),o=N(i+1),x=add(a,mul(n,r0)),y=add(a,mul(o,r0)),z=add(b,mul(o,r1)),w=add(b,mul(n,r1));
    m.quad(key,x,y,z,w,[n,o,o,n]);m.tri(key,a,x,y,mul(tangent,-1));m.tri(key,b,z,w,tangent);
  }
}
function ring(m,key,x,y,z,r,width,begin=0,end=tau,count=50){
  for(let i=0;i<count;i++){
    const a=mix(begin,end,i/count),b=mix(begin,end,(i+1)/count);
    const P=(t,s)=>[x+s*Math.cos(t),y,z+s*Math.sin(t)];
    m.quad(key,P(a,r-width),P(a,r),P(b,r),P(b,r-width),[0,1,0]);
  }
}
function plane(m,key,x1,z1,x2,z2,y){
  m.quad(key,[x1,y,z1],[x1,y,z2],[x2,y,z2],[x2,y,z1],[0,1,0]);
}
function floor(m){
  plinth(m,'foundation',[0,-.29,-.07],[10.1,.58,8.97],.087);
  plinth(m,'edge',[0,-.11,-.07],[10.09,.098,8.97],.022);
  plinth(m,'stoneA',[0,-.04,-.07],[10,.082,8.87],.015);
  const next=random(71912);
  for(let i=0;i<10;i++)for(let j=0;j<9;j++){
    const x=(i-5),z=(j-4.5)*.98-.025;
    const key='floor'+Math.floor(next()*4);
    plane(m,key,x+.007,z+.006,x+.993,z+.972,.006);
  }
  // Sawn joints and quiet polished aggregate on the principal circulation route.
  for(let i=0;i<940;i++){
    const x=mix(-4.94,4.94,next()),z=mix(-4.38,4.33,next());
    const w=mix(.003,.018,next()),d=w*mix(.7,2.6,next());
    m.tri(i%3===0?'lite':i%7===0?'shadow2':'sift',[x-w,.007,z],[x+w*.22,.007,z+d],[x+w,.007,z-d],[0,1,0]);
  }
  for(const [i,x] of [-4.27,-3.16,-2.05,-.94].entries()){
    m.quad(i%2?'floor3':'lite',[x,.008,-3.48],[x+.58,.008,-3.48],[x+2.29,.008,2.65],[x+1.94,.008,2.65],[0,1,0]);
  }
  for(const x of [-4.81,4.81])plane(m,'shadow2',x-.052,-4.09,x+.052,4.26,.009);
  plane(m,'shadow2',-4.79,-4.14,4.79,-3.96,.008);
  for(const [,p] of patrol.entries()){
    ring(m,'trail',p[0],.014,p[2],.086,.016,0,tau,18);
    tube(m,'route',[p[0],.009,p[2]],[p[0],.018,p[2]],.028,.022,12);
  }
  for(let i=0;i<8;i++){
    plinth(m,'edge',[4.67-i*.33,-.30,4.37],[.18,.20,.033],.018);
  }
}
function panel(m,x,z,w=1.06,h=1.92){
  plinth(m,'recess',[x,h/2+.35,z],[w+.10,h+.14,.11],.018);
  plinth(m,'bay',[x,h/2+.35,z+.063],[w,h,.039],.011);
  const next=random(8149+Math.round(x*90));
  for(let row=0;row<9;row++){
    const y=.51+h*(row+.3)/9;
    const k=mix(.20,.46,next())*w;
    plinth(m,row===3?'brass':row%3===1?'mist':'slate',[x-.035*Math.sin(row),y,z+.087],[k*2,.018,.028],.006);
  }
  plinth(m,'ledger',[x+w*.37,.26,z+.14],[.21,.11,.039],.009);
}
function boundaries(m){
  plinth(m,'stone',[0,1.73,-4.25],[10,3.45,.26],.031);
  plinth(m,'edge',[0,.112,-4.075],[9.9,.22,.12],.018);
  plinth(m,'ledger',[0,3.53,-4.15],[10,.25,.66],.039);
  plinth(m,'woodDark',[0,3.40,-3.946],[9.79,.06,.11],.012);
  plinth(m,'stoneA',[-4.90,1.73,-1.81],[.24,3.46,4.89],.034);
  plinth(m,'edge',[-4.73,.12,-1.84],[.19,.23,4.73],.015);
  plinth(m,'glass',[-4.758,2.34,-.55],[.09,1.44,2.22],.014);
  for(let i=0;i<6;i++)plinth(m,i%2?'mist':'pale',[-4.692,2.34,-1.55+i*.40],[.021,1.24,.31],.004);
  for(const y of [1.62,3.077])plinth(m,'ledger',[-4.74,y,-.55],[.31,.12,2.38],.018);
  for(const z of [-1.67,-1.27,-.88,-.47,-.06,.34,.54])plinth(m,'timber',[-4.65,2.34,z],[.14,1.47,.055],.012);
  for(const x of [-4.81,-3.12,-1.50,1.26,3.16,4.45]){
    plinth(m,'stoneB',[x,1.74,-3.982],[.27,3.46,.23],.031);
    plinth(m,'ledger',[x,3.46,-3.94],[.43,.16,.37],.024);
    plinth(m,'stoneA',[x,.124,-3.94],[.41,.23,.37],.022);
  }
  for(let i=0;i<13;i++){
    const x=-4.31+i*.72,dy=i%4===0?.004:0;
    plinth(m,i%2?'timber':'woodEdge',[x,3.54+dy,-3.38],[.081,.26,1.31],.012);
    plinth(m,'woodDark',[x,3.667+dy,-3.02],[.113,.038,.51],.006);
  }
  panel(m,-3.89,-4.007,1.02,1.94);panel(m,3.83,-4.007,1.02,1.94);
  panel(m,-2.31,-4.005,1.01,1.75);panel(m,2.34,-4.005,1.08,1.75);
  // Milled acoustic backing in the central gallery alcove.
  plinth(m,'petrol',[-.07,1.79,-4.079],[2.38,2.49,.16],.044);
  for(let i=0;i<35;i++)plinth(m,i%3===0?'bay':'slate',[-1.19+i*.066,1.79,-3.976],[.021,2.37,.051],.006);
  for(const [i,y] of [1.04,1.71,2.49].entries()){
    const x=[.38,-.31,.18][i];
    tube(m,'oxide',[x,y,-3.951],[x,y,-3.913],.26+i*.130,.26+i*.130,36);
    tube(m,i%2?'brushed':'bronze',[x,y,-3.90],[x,y,-3.848],.243+i*.130,.248+i*.130,36);
    tube(m,'oxide',[x,y,-3.841],[x,y,-3.81],.035,.035,12);
  }
  for(const [x,z] of [[-3.98,-3.08],[4.11,-3.18],[4.17,1.17]]){
    plinth(m,'sand',[x,.218,z],[.37,.41,1.14],.048);
    for(let i=0;i<5;i++)plinth(m,i%2?'timber':'woodEdge',[x+(i-2)*.084,.462,z],[.074,.08,1.26],.013);
  }
}
function shadow(m,x,z,xScale,zScale){
  for(let i=0;i<3;i++){
    const key='shadow'+i;
    for(let j=0;j<40;j++){
      const a=j*tau/40,b=(j+1)*tau/40;
      const p=(t,s)=>[x+Math.cos(t)*s*xScale,.012+i*.0005,z+Math.sin(t)*s*zScale];
      m.quad(key,p(a,(i+.01)/3),p(a,(i+1)/3),p(b,(i+1)/3),p(b,(i+.01)/3),[0,1,0]);
    }
  }
}
function installation(m){
  shadow(m,0,.09,1.66,1.31);
  plinth(m,'shadow0',[0,.07,-.02],[2.81,.14,2.68],.081);
  plinth(m,'slate',[0,.21,-.02],[2.64,.30,2.44],.076);
  plinth(m,'bay',[0,.367,-.02],[2.63,.052,2.42],.032);
  plinth(m,'oxide',[0,.396,-.02],[2.49,.029,2.29],.014);
  for(const [r,w,key] of [[.97,.009,'brass'],[.83,.006,'brushed'],[.65,.008,'bronze']]){
    ring(m,key,0,.418,-.02,r,w,0,tau,64);
  }
  for(let i=0;i<18;i++){
    const t=i*tau/18,x=.93*Math.cos(t),z=-.02+.93*Math.sin(t);
    tube(m,i%3?'oxide':'brushed',[x,.413,z],[x,.422,z],.011,.011,7);
  }
  for(const x of [-1.23,1.23]){
    plinth(m,'recess',[x,1.47,-.73],[.093,2.91,.085],.012);
    plinth(m,'bronze',[x,1.47,-.67],[.038,2.85,.029],.009);
  }
  plinth(m,'recess',[0,2.912,-.73],[2.58,.108,.116],.016);
  plinth(m,'brushed',[0,2.987,-.72],[2.53,.029,.10],.009);
  for(let j=0;j<11;j++){
    const x=(j-5)*.207,base=.77+.061*j+.31*Math.sin(j*.389);
    tube(m,'oxide',[x,2.88,-.73],[x,base+1.15,-.25],.009,.008,6);
    const key=['brass','bronze','brushed','woodEdge'][j%4];
    const tip=(t,s)=>{
      const lean=Math.sin(Math.PI*t)*(j-5)*.014;
      const a=t*4.3+j*.194;
      const r=.183+.052*Math.sin(j*.87);
      return [x+lean+(s-.5)*(.067+(.02*Math.sin(t*4)))*Math.cos(a),
        base+t*(1.25+(j%3)*.07),-.15+Math.sin(a)*r+(s-.5)*.115*Math.sin(a)];
    };
    for(let i=0;i<30;i++){
      const a=i/30,b=(i+1)/30;
      m.quad(key,tip(a,0),tip(b,0),tip(b,1),tip(a,1));
      if(i%4===0)tube(m,key,tip(a,0),tip(b,0),.004,.004,4);
    }
    tube(m,'oxide',tip(.96,.5),[x,2.92,-.73],.008,.008,6);
  }
  // Recessed inlay with three bronze screws on the visitor's side of the mount.
  plinth(m,'ledger',[.60,.237,1.196],[.40,.14,.028],.009);
  for(let i=0;i<5;i++)plinth(m,i===0?'oxide':'sand',[.57,.268-i*.018,1.215],[.25-(i%2)*.032,.008,.008],.002);
  for(const x of [-.89,.88])ring(m,'brass',x,.407,.74,.102,.013,0,tau,25);
}
function pedestal(m,station){
  const [x,,z]=station.point;
  shadow(m,x,z,.40,.33);
  tube(m,'edge',[x,.015,z],[x,.121,z],.338,.270,24);
  tube(m,'slate',[x,.121,z],[x,.729,z],.235,.193,24);
  tube(m,'petrol',[x,.701,z],[x,.790,z],.231,.229,24);
  tube(m,'bronze',[x,.778,z],[x,.814,z],.206,.184,28);
  tube(m,'brushed',[x,.827,z],[x,.873,z],.099,.092,24);
  tube(m,'brass',[x,.865,z],[x,.938,z],.105,.052,24);
  tube(m,'oxide',[x,.933,z],[x,.961,z],.036,.031,16);
  for(const y of [.141,.174,.656,.691])tube(m,'woodEdge',[x,y,z],[x,y+.009,z],.233,.233,24);
  ring(m,'brass',x,.014,z,.383,.024,0,tau,32);
  for(let i=0;i<4;i++){
    const t=i*tau*.25,a=x+.409*Math.cos(t),b=z+.409*Math.sin(t);
    tube(m,'paint',[a,.013,b],[a,.016,b],.027,.027,8);
  }
}
function ringFactory(engine,key,r,width){
  const m=draft(),root=engine.createMesh();
  ring(m,key,0,0,0,r,width,0,tau,96);m.meshes(engine,root);
  root.visible=false;return root;
}
export function makeGallery(engine){
  engine.scene.background='#263438';
  engine.lighting.direction.set([-.63,.76,.47,2.72]);
  engine.lighting.radiance.set([1,.91,.746,.42]);
  engine.lighting.ambient.set([.72,.88,.97]);
  const staticArt=draft();
  floor(staticArt);boundaries(staticArt);installation(staticArt);
  for(const station of stations)pedestal(staticArt,station);
  staticArt.meshes(engine);
  const selection=ringFactory(engine,'beacon',.49,.031),pulse=[ringFactory(engine,'paint',1,.024),ringFactory(engine,'gold',1,.020)];
  const amber=ringFactory(engine,'gold',.34,.024);
  const marks=Array.from({length:16},()=>ringFactory(engine,'beacon',.043,.017));
  const shadowPad=draft(),guardShadow=engine.createMesh();
  shadow(shadowPad,0,0,.31,.22);shadowPad.meshes(engine,guardShadow);
  return {
    update(state,station){
      selection.visible=true;
      const [x,,z]=station.point;selection.setPosition([x,.023,z]);
      const loc=state.position;
      guardShadow.setPosition([loc[0]-.095,.008,loc[2]-.08]).setRotation([0,state.facing,0]);
      const memory=state.remembered;
      amber.visible=!!memory;
      if(memory)amber.setPosition([memory[0],.044,memory[2]]);
      for(const [i,ring] of pulse.entries()){
        const sound=state.lastSound,event=stations.find(item=>item.id===sound?.id);
        const age=sound?state.elapsed-sound.time-i*.15:3;
        const radius=event&&sound?Math.min(1.16,age*1.44):0;
        ring.visible=!!event&&age>=0&&age<.83;
        if(ring.visible){
          const s=Math.max(.032,radius);
          ring.setPosition([event.point[0],.035,event.point[2]]).setScale([s,1,s]);
        }
      }
      const path=[loc,...state.route];
      let segment=0,covered=0;
      for(const [i,marker] of marks.entries()){
        const at=(i+1)*.29;
        while(segment+1<path.length&&covered+Math.hypot(path[segment+1][0]-path[segment][0],path[segment+1][2]-path[segment][2])<at){
          covered+=Math.hypot(path[segment+1][0]-path[segment][0],path[segment+1][2]-path[segment][2]);segment++;
        }
        marker.visible=(state.state==='Investigating'||state.state==='Returning')&&segment+1<path.length;
        if(marker.visible){
          const a=path[segment],b=path[segment+1],t=clamp((at-covered)/Math.hypot(b[0]-a[0],b[2]-a[2]),0,1);
          marker.setPosition([mix(a[0],b[0],t),.031,mix(a[2],b[2],t)]);
        }
      }
    },
  };
}
