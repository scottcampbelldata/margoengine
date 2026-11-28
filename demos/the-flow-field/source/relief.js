import {Geometry,PbrMaterial} from '@margoengine/core';
import {WALL} from '@margoengine/behavior/flowfield';
import {center,cell,columnCount,rowCount,minX,minZ,maxX,maxZ,floorY} from './flow-data.js';

const tau=2*Math.PI;
const sum=(a,b)=>a.map((v,i)=>v+b[i]);
const dif=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(v,n)=>v.map(i=>i*n);
const lerp=(a,b,t)=>a+(b-a)*t;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>scale(a,1/(Math.hypot(...a)||1));
const ease=v=>v*v*(3-2*v);
function generator(n){return ()=>{n=Math.imul(n,1664525)+1013904223|0;return (n>>>0)/4294967296;};}
const material={
  frame0:['#293742',.84],frame1:['#394a57',.74],frame2:['#53616a',.64],
  recess:['#333a40',.94],floor0:['#384a5a',.83],floor1:['#3b4d5d',.86],floor2:['#3e5664',.81],
  slow0:['#506275',.81],slow1:['#526777',.79],hairline:['#5c7783',.85],
  facet0:['#384955',.94],facet1:['#495c68',.90],facet2:['#566e7a',.89],facet3:['#6a8590',.87],facet4:['#7c999e',.88],
  shadow0:['#2f3c4b',.95],shadow1:['#364552',.95],sideline0:['#303b48',.91],sideline1:['#3d4c57',.91],
  sideline2:['#4d6269',.87],sideline3:['#596e74',.85],sideline4:['#697875',.81],
  line0:['#7b999e',.71],line1:['#b69b73',.70],line2:['#8eacaa',.75],
  steel:['#5d7683',.55],steelDark:['#435962',.61],blue:['#699ba7',.54],
  brass:['#a78759',.49],bronze:['#8e714b',.60],amber:['#e2b477',.41],chalk:['#c9d7c9',.62],
  target:['#f1ce85',.41],signal:['#7fbac9',.48],arrow:['#81a0a8',.7],
};
function sourceMesh(){
  const bins=new Map();
  function triangle(id,a,b,c,fixed){
    let n=norm(cross(dif(b,a),dif(c,a)));
    if(fixed&&n.reduce((dot,v,k)=>dot+v*fixed[k],0)<0){[b,c]=[c,b];n=scale(n,-1);}
    if(Math.hypot(...n)<.5)return;
    if(!bins.has(id))bins.set(id,{points:[],normals:[],indices:[]});
    const g=bins.get(id),i=g.points.length/3;
    g.points.push(...a,...b,...c);g.normals.push(...(fixed??n),...(fixed??n),...(fixed??n));g.indices.push(i,i+1,i+2);
  }
  return {
    triangle,
    quad(id,a,b,c,d,n){triangle(id,a,b,c,n);triangle(id,a,c,d,n);},
    meshes(engine,parent=null){
      return [...bins].map(([id,g])=>{
        const [color,roughness]=material[id];
        return engine.createMesh(parent).setGeometry(new Geometry(g.points,g.normals,g.indices))
          .setMaterial(new PbrMaterial({color,roughness,metalness:0,doubleSided:true}));
      });
    },
  };
}
function box(m,id,c,[w,h,d],bevel=.027){
  const [x,y,z]=c,a=w/2,b=h/2,k=d/2,t=Math.max(.0007,Math.min(bevel,a*.35,b*.64,k*.35));
  const ring=(dy,u,v)=>[[u-t,v],[-u+t,v],[-u,v-t],[-u,-v+t],[-u+t,-v],[u-t,-v],[u,-v+t],[u,v-t]]
    .map(([p,q])=>[x+p,y+dy,z+q]);
  const rows=[ring(-b,a-t,k-t),ring(-b+t,a,k),ring(b-t,a,k),ring(b,a-t,k-t)];
  for(let l=0;l<3;l++)for(let i=0;i<8;i++){
    const j=(i+1)%8;m.quad(id,rows[l][j],rows[l][i],rows[l+1][i],rows[l+1][j]);
  }
  for(let i=1;i<=6;i++){
    m.triangle(id,rows[3][0],rows[3][i],rows[3][i+1],[0,1,0]);
    m.triangle(id,rows[0][0],rows[0][i],rows[0][i+1],[0,-1,0]);
  }
}
function rod(m,id,a,b,r0,r1=r0,n=12){
  const axis=norm(dif(b,a)),u=norm(cross(axis,Math.abs(axis[1])>.8?[1,0,0]:[0,1,0])),v=cross(axis,u);
  const radial=i=>sum(scale(u,Math.cos(i*tau/n)),scale(v,Math.sin(i*tau/n)));
  for(let i=0;i<n;i++){
    const x=radial(i),y=radial(i+1),p=sum(a,scale(x,r0)),q=sum(a,scale(y,r0)),s=sum(b,scale(y,r1)),t=sum(b,scale(x,r1));
    m.quad(id,p,q,s,t,norm(sum(x,y)));m.triangle(id,a,p,q,scale(axis,-1));m.triangle(id,b,s,t,axis);
  }
}
function floor(m,id,x,z,w,d,y=floorY){
  m.quad(id,[x,y,z],[x,y,z+d],[x+w,y,z+d],[x+w,y,z],[0,1,0]);
}
function line(m,id,a,b,width,raise=.004){
  if(Math.hypot(a[0]-b[0],a[2]-b[2])<1e-8)return;
  const [u,,v]=scale(norm([b[2]-a[2],0,a[0]-b[0]]),width/2);
  const P=(v0,s)=>[v0[0]+u*s,v0[1]+raise,v0[2]+v*s];
  m.quad(id,P(a,-1),P(a,1),P(b,1),P(b,-1),[0,1,0]);
}
function ring(m,id,[x,y,z],r,width,start=0,end=tau,steps=60){
  const p=(a,d)=>[x+Math.cos(a)*d,y,z+Math.sin(a)*d];
  for(let i=0;i<steps;i++){
    const a=lerp(start,end,i/steps),b=lerp(start,end,(i+1)/steps);
    m.quad(id,p(a,r-width),p(a,r),p(b,r),p(b,r-width),[0,1,0]);
  }
}
function frame(m){
  const w=maxX-minX,d=maxZ-minZ;
  box(m,'frame0',[0,-.386,0],[w+1.58,.53,d+1.55],.133);
  box(m,'frame1',[0,-.158,0],[w+1.48,.21,d+1.44],.079);
  box(m,'frame2',[0,-.069,0],[w+1.28,.10,d+1.23],.043);
  box(m,'recess',[0,-.026,0],[w+1.12,.072,d+1.06],.016);
  for(const z of [minZ-.337,maxZ+.337]){
    box(m,'steelDark',[0,.062,z],[w+1.05,.081,.58],.040);
    box(m,'frame2',[0,.090,z],[w+.91,.041,.40],.018);
    box(m,'bronze',[0,.111,z+(z>0?.237:-.237)],[w+.81,.016,.021],.006);
    for(let i=0;i<92;i++){
      const x=(i-45.5)*.124;
      floor(m,i%8===0?'chalk':'hairline',x,z-.092,i%8===0?.017:.011,i%8===0?.168:.086,.113);
    }
  }
  for(const x of [minX-.354,maxX+.354]){
    box(m,'steelDark',[x,.066,0],[.58,.089,d+.34],.030);
    box(m,'frame1',[x,.115,0],[.241,.035,d+.29],.011);
    for(let i=0;i<66;i++){
      const z=(i-32.5)*.124;
      floor(m,i%8===0?'chalk':'hairline',x-.078,z,i%8===0?.128:.07,.010,.135);
    }
  }
  for(const x of [minX-.43,maxX+.43])for(const z of [minZ-.37,maxZ+.37]){
    rod(m,'steel',[x,.118,z],[x,.164,z],.080,.078,14);
    rod(m,'brass',[x,.163,z],[x,.176,z],.054,.050,12);
    line(m,'recess',[x-.026,.178,z-.015],[x+.027,.178,z+.016],.015,.0001);
  }
  for(const x of [-3.93,3.93]){
    box(m,'steelDark',[x,-.286,maxZ+.799],[1.04,.185,.046],.012);
    for(let i=0;i<8;i++)box(m,'recess',[x+(i-3.5)*.101,-.289,maxZ+.821],[.056,.114,.027],.008);
  }
  for(const t of [-1,1]){
    box(m,'frame1',[t*3.69,-.672,2.53],[3.07,.10,2.42],.054);
    box(m,'frame0',[t*3.69,-.696,2.53],[3.0,.08,2.33],.045);
  }
}
function platform(m,shapes){
  const random=generator(34727),w=maxX-minX,d=maxZ-minZ;
  for(let i=0;i<9;i++)for(let j=0;j<7;j++){
    const x=minX+i*w/9,z=minZ+j*d/7,k=Math.floor(random()*3);
    floor(m,'floor'+k,x+.002,z+.002,w/9-.005,d/7-.005);
  }
  for(let z=0;z<rowCount;z++){
    let x=0;
    while(x<columnCount){
      if(shapes[z*columnCount+x].cost!==4){x++;continue;}
      const lo=x;
      while(x<columnCount&&shapes[z*columnCount+x].cost===4)x++;
      floor(m,z%4===0?'slow0':'slow1',minX+lo*cell,minZ+z*cell,cell*(x-lo),cell,floorY+.003);
    }
  }
  for(let i=0;i<1350;i++){
    const x=lerp(minX+.03,maxX-.03,random()),z=lerp(minZ+.03,maxZ-.03,random());
    const length=.005+random()*.016;
    if(random()<.8)m.triangle(i%9===0?'hairline':'floor2',[x-length,.022,z],[x,.022,z+length*.6],[x+length,.022,z-length],[0,1,0]);
  }
  for(let i=0;i<=columnCount;i+=8){
    const x=minX+cell*i;
    for(let j=0;j<rowCount;j+=8){
      const z=minZ+j*cell;
      floor(m,'hairline',x-.031,z-.004,.062,.008,.023);
      floor(m,'hairline',x-.004,z-.031,.008,.062,.0237);
    }
  }
}
function terrain(m,shapes){
  const rock=(x,z)=>x>=0&&x<columnCount&&z>=0&&z<rowCount&&shapes[z*columnCount+x].cost===WALL;
  const vertex=(x,z)=>{
    const support=[[x-1,z-1],[x-1,z],[x,z-1],[x,z]].filter(([i,j])=>rock(i,j));
    const sampled=support.reduce((s,[i,j])=>s+shapes[j*columnCount+i].height,0)/Math.max(1,support.length);
    return [minX+x*cell,sampled,minZ+z*cell];
  };
  const lineAt=(tri,level)=>{
    const found=[];
    for(let i=0;i<3;i++){
      const a=tri[i],b=tri[(i+1)%3];
      if((a[1]<level)===(b[1]<level))continue;
      const t=(level-a[1])/(b[1]-a[1]);found.push([lerp(a[0],b[0],t),level,lerp(a[2],b[2],t)]);
    }
    return found;
  };
  const tiers=[.018,.104,.214,.371,.521];
  for(let z=0;z<rowCount;z++)for(let x=0;x<columnCount;x++){
    if(!rock(x,z))continue;
    const sample=shapes[z*columnCount+x];
    const a=vertex(x,z),b=vertex(x,z+1),c=vertex(x+1,z+1),d=vertex(x+1,z);
    const level=Math.min(4,Math.max(0,Math.floor((sample.height-.42)*2.55+.38*Math.sin(x*.56+z*.19))));
    m.quad('facet'+level,a,b,c,d);
    for(const tri of [[a,b,c],[a,c,d]])for(let tier=0;tier<9;tier++){
      const y=.44+tier*.184;
      const [p,q]=lineAt(tri,y);
      if(q)line(m,sample.part===1||sample.part===3?'line1':'line0',p,q,tier%3===0?.012:.007,.006);
    }
    const edges=[[x-1,z,a,b], [x,z+1,b,c], [x+1,z,c,d], [x,z-1,d,a]];
    for(const [i,j,p,q] of edges){
      if(rock(i,j))continue;
      const outward=norm([i-x,0,j-z]),visibleTier=Math.min(4,Math.max(1,Math.floor(sample.height*.95)));
      const point=(v,height,f)=>[v[0]+outward[0]*f,height,v[2]+outward[2]*f];
      const heights=tiers.filter(t=>t<Math.min(p[1],q[1])-.014);
      for(let l=0;l<heights.length;l++){
        const y=heights[l],next=heights[l+1];
        const w=.047*(1-l/Math.max(1,heights.length)),v=.047*(1-(l+1)/Math.max(1,heights.length));
        m.quad('sideline'+Math.min(visibleTier+l,4),point(p,y,w),point(q,y,w),point(q,next??q[1],v),point(p,next??p[1],v));
        if(l>0)line(m,l%3===1?'line1':'line0',point(p,y,w),point(q,y,w),.011,.004);
      }
      floor(m,'shadow1',Math.min(p[0],q[0])+Math.min(0,outward[0]*.079),
        Math.min(p[2],q[2])+Math.min(0,outward[2]*.079),Math.abs(p[0]-q[0])||.080,Math.abs(p[2]-q[2])||.080,.025);
    }
  }
}
function inlet(m,x,z,polarity){
  const k=polarity<0?'amber':'signal',sign=-polarity;
  box(m,'recess',[x,.188,z],[.46,.31,.83],.043);
  box(m,'steel',[x,.380,z],[.477,.09,.83],.037);
  box(m,'steelDark',[x-sign*.17,.299,z],[.193,.27,.72],.023);
  for(let i=0;i<6;i++){
    const dz=(i-2.5)*.099;
    rod(m,'bronze',[x+sign*.094,.122,z+dz],[x+sign*.29,.110,z+dz],.031,.033);
    rod(m,k,[x+sign*.273,.111,z+dz],[x+sign*.306,.108,z+dz],.024,.023);
  }
  for(const o of [-.28,.28])rod(m,'brass',[x,.425,z+o],[x,.456,z+o],.049,.042,12);
  box(m,'chalk',[x,.429,z-.062],[.087,.012,.120],.006);
}
function locator(engine){
  const root=engine.createMesh(),fixed=sourceMesh(),spinning=engine.createMesh(root),d=sourceMesh();
  ring(fixed,'bronze',[0,.027,0],.344,.027);
  ring(fixed,'target',[0,.031,0],.274,.020);
  for(let i=0;i<4;i++){
    const a=tau*i/4,x=Math.cos(a),z=Math.sin(a);
    line(fixed,'target',[x*.355,.033,z*.355],[x*.461,.033,z*.461],.026);
  }
  rod(fixed,'steelDark',[0,.020,0],[0,.220,0],.037,.025,12);
  rod(fixed,'target',[0,.215,0],[0,.275,0],.026,.015,10);
  for(let i=0;i<3;i++)ring(d,i===0?'target':'brass',[0,.269,0],.149-i*.026,.014,i*tau/3,i*tau/3+.94,21);
  fixed.meshes(engine,root);d.meshes(engine,spinning);
  return {root,spinning};
}
const arrowSize=.153;
export function buildRelief(engine,flow){
  engine.scene.background='#222d39';
  engine.lighting.direction.set([-.60,.84,.42,2.95]);
  engine.lighting.radiance.set([1,.89,.72,.49]);
  engine.lighting.ambient.set([.62,.81,1]);
  const art=sourceMesh();frame(art);platform(art,flow.shapes);terrain(art,flow.shapes);
  inlet(art,minX-.33,-2.46,-1);inlet(art,minX-.33,1.47,-1);inlet(art,maxX+.31,-2.11,1);
  art.meshes(engine);
  const destination=locator(engine),vectors=engine.createMesh().setMaterial(new PbrMaterial({color:material.arrow[0],roughness:.73}));
  const out=[0,0,0];
  function updateField(){
    const p=[],n=[],idx=[];
    for(let z=2;z<rowCount;z+=4)for(let x=2;x<columnCount;x+=4){
      const i=z*columnCount+x;
      if(flow.field.cost[i]===WALL||!Number.isFinite(flow.field.integration[i]))continue;
      const point=center(i),[u,,v]=flow.field.direction(point,out);
      if(!u&&!v)continue;
      const y=floorY+.011,h=arrowSize,pointAt=(f,k)=>[point[0]+u*f+v*k,y,point[2]+v*f-u*k];
      const base=p.length/3;
      p.push(...pointAt(-h,-.008),...pointAt(-h,.008),...pointAt(h*.28,.008),...pointAt(h*.28,-.008),
        ...pointAt(h*.16,-.045),...pointAt(h,.000),...pointAt(h*.16,.045));
      for(let j=0;j<7;j++)n.push(0,1,0);
      idx.push(base,base+1,base+2,base,base+2,base+3,base+4,base+5,base+6);
    }
    vectors.setGeometry(new Geometry(p,n,idx));
    destination.root.setPosition([flow.stats().goal.point[0],0,flow.stats().goal.point[2]]);
  }
  updateField();vectors.visible=false;
  return {updateField,showField(value){vectors.visible=value;},animate(t){
    destination.spinning.setRotation([0,t*1.15,0]);
    destination.spinning.setPosition([0,.047+.025*Math.sin(t*3.5),0]);
  }};
}
