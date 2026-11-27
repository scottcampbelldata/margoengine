import {Geometry,PbrMaterial} from '@margoengine/core';
import {bounds,clamp,groundY,mix,noise} from './meadow-data.js';

const TAU=Math.PI*2;
const rgb={
  soil0:['#565335',.96],soil1:['#57593b',.93],soil2:['#626144',.93],soil3:['#626843',.94],
  earth:['#776849',.94],dirt:['#605741',.97],
  ridge0:['#66756b',.92],ridge1:['#798c87',.92],ridge2:['#889b98',.93],
  granite0:['#77766d',.91],granite1:['#858578',.88],granite2:['#535951',.94],
  granite3:['#969487',.83],lichen:['#797958',.89],
  alpineStone:['#81918f',.93],alpineCold:['#74878b',.94],alpineSnow:['#c1c5bc',.91],distantSnow:['#a9baaf',.93],
  trunk:['#665942',.93],pine:['#3c5450',.88],pineLight:['#506157',.87],pineShadow:['#394d46',.91],
  stem:['#616f40',.88],leaf:['#637941',.89],leafLight:['#79874c',.87],
  petals:['#bfbfb2',.71],ivory:['#e0d6af',.70],flowerCenter:['#b29b61',.80],
  lupin0:['#635270',.76],lupin1:['#88728b',.75],lupin2:['#a891a4',.75],seed:['#9a8a59',.83],
};
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const scale=(a,k)=>a.map(x=>x*k);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>scale(a,1/(Math.hypot(...a)||1));
function batch(){
  const lists=new Map();
  const tri=(m,a,b,c,ns)=>{
    if(!lists.has(m))lists.set(m,[[],[],[]]);
    const [p,n,ind]=lists.get(m),start=p.length/3;
    p.push(...a,...b,...c);
    if(ns)n.push(...ns[0],...ns[1],...ns[2]);
    else{
      const N=unit(cross(sub(b,a),sub(c,a)));
      n.push(...N,...N,...N);
    }
    ind.push(start,start+1,start+2);
  };
  const quad=(m,a,b,c,d)=>{tri(m,a,b,c);tri(m,a,c,d);};
  return {tri,quad,finish(){
    return [...lists].map(([name,[p,n,i]])=>{
      const [color,roughness]=rgb[name];
      return {name,geometry:new Geometry(p,n,i),material:new PbrMaterial({color,roughness,doubleSided:true})};
    });
  }};
}
function tube(g,m,a,b,r,sides=5){
  const direction=unit(sub(b,a));
  const u=unit(cross(direction,Math.abs(direction[1])>.9?[1,0,0]:[0,1,0])),v=cross(direction,u);
  const p=(x,k)=>{
    const phi=k*TAU/sides;
    return add(x,add(scale(u,r*Math.cos(phi)),scale(v,r*Math.sin(phi))));
  };
  for(let k=0;k<sides;k++)g.quad(m,p(a,k),p(a,k+1),p(b,k+1),p(b,k));
}

function meadow(g){
  const nx=87,nz=90,x0=bounds[0]-7,z0=bounds[1]-8,dx=(bounds[2]+7-x0)/nx,dz=(bounds[3]-z0)/nz;
  const rows=Array.from({length:nz+1},(_,j)=>Array.from({length:nx+1},(_,i)=>{
    const x=x0+i*dx+(noise(i,j,1)-.5)*dx*.52,z=z0+j*dz+(noise(i,j,2)-.5)*dz*.53,d=.041;
    const n=unit([groundY(x-d,z)-groundY(x+d,z),2*d,groundY(x,z-d)-groundY(x,z+d)]);
    return [[x,groundY(x,z),z],n];
  }));
  function key(x,z){
    const f=.51+.19*Math.cos(.52*x+.14*z)*Math.cos(.86*z+.41)+.18*Math.sin(x*.15-z*.41)+.09*Math.sin(x*1.19+z*1.31);
    if(f<.28&&z<-6)return 'earth';
    return 'soil'+Math.round(clamp(f)*3);
  }
  for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){
    const [[a,na],[b,nb],[c,nc],[d,nd]]=[rows[j][i],rows[j+1][i],rows[j+1][i+1],rows[j][i+1]];
    g.tri(key((a[0]+b[0]+c[0])/3,(a[2]+b[2]+c[2])/3),a,b,c,[na,nb,nc]);
    g.tri(key((a[0]+c[0]+d[0])/3,(a[2]+c[2]+d[2])/3),a,c,d,[na,nc,nd]);
  }
}

function highCountry(g){
  const cols=101,rows=56;
  const anchors=[[-57,-119,30,52,67],[-31,-92,35,43,57],[-5,-113,47,41,63],
      [9,-99,37,39,55],[37,-128,53,54,62],[58,-93,27,69,52],[-62,-62,17,42,53],[54,-65,16,40,48]];
  function y(x,z){
    let peak=-3.85;
    for(const [ox,oz,h,rx,rz] of anchors){
      const d2=((x-ox)/rx)**2+((z-oz)/rz)**2;
      if(d2<1)peak=Math.max(peak,h*(1-Math.sqrt(d2))**1.08-4.0);
    }
    const conv=.50+.5*Math.sin(x*.21-z*.22);
    const gullies=Math.sin(x*.34+z*.13)*Math.sin(.105*z-.29*x)*2.41+Math.cos(x*.41+z*.12)*1.17;
    return peak+gullies*clamp((peak+2)/12)*(.72+.28*conv);
  }
  const rowsOf=Array.from({length:rows+1},(_,j)=>Array.from({length:cols+1},(_,i)=>{
    const z=-175+j*2.63+(noise(i,j,23)-.5)*1.25,x=-115+i*2.31+(noise(i,j,24)-.5)*1.89,d=.26;
    const n=unit([y(x-d,z)-y(x+d,z),2*d,y(x,z-d)-y(x,z+d)]);
    return [[x,y(x,z),z],n];
  }));
  function stone(a,n){
    const [x,h,z]=a;
    const snow=11.9+2.6*Math.sin(x*.32-z*.043)+3.1*Math.cos(x*.139+z*.24);
    if(h>snow&&n[1]>.36)return z<-116?'distantSnow':'alpineSnow';
    if(h>6.8)return n[1]>.58?'alpineStone':'alpineCold';
    return 'ridge'+(z<-111?2:n[1]>.64?1:0);
  }
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const [[a,na],[b,nb],[c,nc],[d,nd]]=[rowsOf[j][i],rowsOf[j+1][i],rowsOf[j+1][i+1],rowsOf[j][i+1]];
    g.tri(stone(b,nb),a,b,c,[na,nb,nc]);
    g.tri(stone(d,nd),a,c,d,[na,nc,nd]);
  }
}
function stone(g,x,z,R,H,seed){
  const Y=groundY(x,z)-H*.21,n=11;
  const rings=[[.83,.06],[1,.31],[.79,.76],[.44,.976]];
  const p=(level,j)=>{
    const [r,h]=rings[level],angle=(j/n+seed*.37)*TAU;
    const shape=(.86+.27*noise(j,seed,2))*r;
    return [x+Math.cos(angle)*R*shape+(h-.5)*R*.34,Y+H*(h+(noise(j,level,seed)-.5)*.21),
      z+Math.sin(angle)*R*shape*.73+.21*level*R/4];
  };
  for(let j=0;j<n;j++){
    const k=(j+1)%n;
    for(let r=0;r<3;r++){
      const value=noise(r,j,seed);
      const m=value>.85&&r===2?'lichen':'granite'+Math.floor(value*4);
      g.quad(m,p(r,j),p(r,k),p(r+1,k),p(r+1,j));
    }
    g.tri(j%4===0?'lichen':'granite3',p(3,k),p(3,j),[x+.20*R,Y+H*1.022,z+.15*R]);
  }
}
function stones(g){
  const authored=[[-1.51,4.6,.98,.66],[-2.51,4.31,.63,.40],[-2.81,4.62,.28,.17],
    [3.36,-3.4,1.24,.72],[3.98,-3.77,.67,.41],[4.31,-4.13,.51,.33],[-6.2,-5.3,1.13,.54],
    [-5.85,-5.1,.48,.37],[4.4,4.06,.46,.29],[-1.18,-8.1,.34,.26]];
  authored.forEach(([x,z,r,h],i)=>stone(g,x,z,r,h,i+1));
  for(let i=0;i<24;i++){
    const x=mix(-13,13,noise(i,0,6)),z=mix(-23,7,noise(i,1,6)),r=mix(.19,.55,noise(i,4,6));
    if(Math.abs(x)<1.25)continue;
    stone(g,x,z,r,r*mix(.34,.89,noise(i,6,12)),i+37);
  }
}
function fir(g,x,z,h,seed){
  const ground=groundY(x,z)-.15,stem=[x+.034*h,ground+h,z];
  tube(g,'trunk',[x,ground,z],stem,h*.028,6);
  for(let layer=0;layer<9;layer++){
    const u=layer/9,w=h*(.18-.142*u),y=ground+h*(.232+.079*layer),branches=layer>5?8:11;
    for(let t=0;t<branches;t++){
      const a=t*TAU/branches+layer*1.7+seed,s=Math.sin(a),c=Math.cos(a),d=w*(.68+noise(t,layer,seed)*.56);
      const color=noise(seed,t,layer)>.6?'pineLight':t%3===0?'pineShadow':'pine';
      const origin=[x+.032*h*u,y+.10*h,z],tip=[x+c*d,y-h*.039,z+s*d],mid=[x+c*d*.55,y+h*.026,z+s*d*.55];
      const sideX=-s*w*.29,sideZ=c*w*.29,xx=mix(origin[0],tip[0],.43),zz=mix(origin[2],tip[2],.43);
      const L=[xx+sideX,y-.04*h,zz+sideZ],R=[xx-sideX,y-.052*h,zz-sideZ];
      g.tri(color,origin,L,mid);g.tri(color,origin,mid,R);
      g.tri(color,L,tip,mid);g.tri(color,mid,tip,R);
    }
  }
}
function woodland(g){
  for(let i=0;i<61;i++){
    const x=mix(-19,18,noise(i,4,61)),z=mix(-31,-16,noise(i,5,61)),h=mix(.72,2.43,noise(i,7,61));
    if(Math.abs(x)<3.38&&z>-24)continue;
    fir(g,x,z,h,i+51);
  }
  for(const [i,[x,z,h]] of [[-10.2,-8.5,3.44],[-11.8,-10.4,2.41],
    [9.1,-8.62,2.52],[12,-12.40,3.37],[-13.7,-11.8,3.12],[11.2,-10.9,2.12]].entries())fir(g,x,z,h,i+875);
}

function flower(g,x,z,h,s,lupin){
  const pos=[x,groundY(x,z)-.023,z],drift=[h*.16*Math.cos(s),0,h*.19*Math.sin(s*.39)];
  const stem=u=>add(pos,[drift[0]*u*u,h*u,drift[2]*u*u]);
  const A=stem(0),B=stem(.46),C=stem(.89);
  tube(g,'stem',A,B,.00325,4);tube(g,'stem',B,C,.00271,4);
  for(let k=0;k<4;k++){
    const f=s+.98+k*2.412,c=Math.cos(f),d=Math.sin(f),u=.22+k*.124;
    const base=stem(u),w=h*(lupin?.19:.175),tip=add(base,[c*w,h*.077,d*w]);
    const M=add(base,[c*w*.51,h*.070,d*w*.51]);
    g.tri('leaf',base,add(M,[-d*w*.21,-.015,c*w*.21]),tip);
    g.tri('leafLight',base,tip,add(M,[d*w*.22,-.013,-c*w*.22]));
  }
  if(lupin){
    for(let k=0;k<7;k++){
      const u=.69+k*.043,r=h*(.047-.0048*k),center=stem(u);
      for(let j=0;j<4;j++){
        const a=s+k*2.394+j*TAU/4,c=Math.cos(a),d=Math.sin(a),v=h*.021;
        const side=[-d*r*.38,0,c*r*.38];
        const tip=add(center,[c*r,v,d*r]);
        g.tri('lupin'+((k+j)%3),add(center,side),add(center,scale(side,-1)),tip);
        g.tri(k%3===0?'lupin2':'lupin1',add(center,side),tip,add(center,[c*r*.52,v*1.82,d*r*.52]));
      }
    }
  }else{
    const center=stem(1),r=h*.074,n=8;
    tube(g,'flowerCenter',stem(.90),center,r*.33,6);
    for(let j=0;j<n;j++){
      const angle=s+j*TAU/n,c=Math.cos(angle),d=Math.sin(angle),d1=angle+.31,d2=angle-.31;
      g.quad(j%3===0?'ivory':'petals',add(center,[c*r*.27,.005,d*r*.27]),
        add(center,[Math.cos(d2)*r,.014,Math.sin(d2)*r]),
        add(center,[c*r*1.18,.010,d*r*1.18]),
        add(center,[Math.cos(d1)*r,.013,Math.sin(d1)*r]));
    }
  }
}
function blooms(g){
  const groups=[[-1.34,2.38,1.35,37,true],[2.58,3.06,1.19,38,false],[-3.64,-1.78,1.53,41,false],
    [4.22,-4.96,1.10,24,true],[.9,-7.15,1.4,25,false],[-2.20,5.74,.81,31,true],
    [4.78,5.17,1.15,47,false],[-4.79,3.02,.92,38,false],[6.85,-1.72,1.73,37,true],
    [-1.28,-10.42,1.67,27,true],[4.89,-13.26,1.48,36,false]];
  for(const [k,[X,Z,r,count,lupin]] of groups.entries())for(let i=0;i<count;i++){
    const az=noise(i,k,7)*TAU,rd=Math.sqrt(noise(i,k,17))*r;
    const x=X+Math.cos(az)*rd,z=Z+Math.sin(az)*rd*.82,h=mix(.24,.67,noise(i,k,4));
    flower(g,x,z,h,11.8*i+k,lupin);
  }
}

export function buildLandscape(){
  const builder=batch();
  highCountry(builder);meadow(builder);woodland(builder);stones(builder);blooms(builder);
  return builder.finish();
}

export function clump(){
  const p=[],n=[],indices=[];
  for(let blade=0;blade<6;blade++){
    const az=2.39996323*blade,c=Math.cos(az),s=Math.sin(az),o=blade===0?0:.088;
    const h=.48+noise(blade,0,86)*.37,bend=.092+.11*noise(blade,0,87),w=.014+.022*noise(blade,0,88);
    let previous=-1;
    for(let row=0;row<=4;row++){
      const t=row/4,width=w*(1-t)**.66,horizontal=o+bend*t*t;
      const here=p.length/3;
      p.push(c*horizontal-s*width,t*h,s*horizontal+c*width,c*horizontal+s*width,t*h,s*horizontal-c*width);
      const normal=unit([c,.32+.36*t,s]);
      n.push(...normal,...normal);
      if(row>0){
        if(row<4)indices.push(previous,previous+1,here,previous+1,here+1,here);
        else indices.push(previous,previous+1,here);
      }
      previous=here;
    }
  }
  return new Geometry(p,n,indices);
}
