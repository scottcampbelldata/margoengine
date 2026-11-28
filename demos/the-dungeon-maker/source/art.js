import {Geometry,box} from '@margoengine/core';
import {plot,cardinal,tile,width,depth,floorAt,roofAt,floorId,sanctuary} from './grid.js';

const stone=['#655d58','#6c6259','#74685d','#796d60','#584f4b','#81715f'].map(c=>({color:c,roughness:.88}));
const step=['#746d72','#655e66','#6b6269','#82756e','#645b61'].map(c=>({color:c,roughness:.86}));
const rim=({color:'#af967b',roughness:.73});
const bronze=({color:'#9b7450',metalness:.54,roughness:.35});
const dark=({color:'#342c34',roughness:.82});
const warm=({color:'#ffe2aa',roughness:.54});
const luminous=({color:'#8ee3d2',roughness:.37});
const greenMetal=({color:'#496e6a',metalness:.42,roughness:.39});
function random(a,b,c=0){
  let n=Math.imul(a+7601,18719)^Math.imul(b+833,1299827)^Math.imul(c+7,42877);
  n=Math.imul(n^(n>>>13),1274126177);
  return ((n^(n>>>16))>>>0)/4294967295;
}
function batches(){
  const layers=[new Map(),new Map()];
  function get(material,top){
    const map=layers[Number(top)];
    let g=map.get(material);
    if(!g){g={p:[],n:[],i:[]};map.set(material,g);}
    return g;
  }
  return {
    append(g,material,at=[0,0,0],yaw=0,top=false){
      const item=get(material,top),positions=g.vertices,start=item.p.length/3;
      const c=Math.cos(yaw),s=Math.sin(yaw);
      for(let i=0;i<positions.length;i+=6){
        const v=positions;
        item.p.push(c*v[i]+s*v[i+2]+at[0],v[i+1]+at[1],c*v[i+2]-s*v[i]+at[2]);
        item.n.push(c*v[i+3]+s*v[i+5],v[i+4],c*v[i+5]-s*v[i+3]);
      }
      for(const ix of g.indices)item.i.push(start+ix);
    },
    block(dimensions,material,at,yaw=0,top=false){this.append(box(...dimensions),material,at,yaw,top);},
    finish(){
      return layers.map(layer=>Array.from(layer,([material,b])=>({
        material,positions:new Float32Array(b.p),normals:new Float32Array(b.n),indices:new Uint32Array(b.i)
      })));
    }
  };
}
function cylinder(radius,height,facets=24){
  const pos=[],n=[],ix=[];
  for(let side=0;side<facets;side++){
    const w=Math.PI*2/facets,a=w*side,b=a+w;
    const c=Math.cos(a),s=Math.sin(a),d=Math.cos(b),t=Math.sin(b);
    const f=pos.length/3;
    pos.push(c*radius,-height/2,s*radius,c*radius,height/2,s*radius,d*radius,height/2,t*radius,d*radius,-height/2,t*radius);
    n.push(c,0,s,c,0,s,d,0,t,d,0,t);ix.push(f,f+1,f+2,f,f+2,f+3);
    const g=pos.length/3;
    pos.push(0,height/2,0,d*radius,height/2,t*radius,c*radius,height/2,s*radius);
    n.push(0,1,0,0,1,0,0,1,0);ix.push(g,g+1,g+2);
  }
  return new Geometry(pos,n,ix);
}
function facetedPrism(radius,height){
  const pos=[],n=[],ix=[];
  for(let i=0;i<8;i++){
    const u=Math.PI*.25*i,v=u+Math.PI*.25;
    for(const h of [-1,1]){
      const a=[Math.cos(u)*radius,0,Math.sin(u)*radius],b=[Math.cos(v)*radius,0,Math.sin(v)*radius],c=[0,h*height,0];
      const normal=[Math.cos((u+v)*.5)*.78,h*.48,Math.sin((u+v)*.5)*.78];
      const at=pos.length/3;
      pos.push(...a,...b,...c);n.push(...normal,...normal,...normal);ix.push(at,at+1,at+2);
    }
  }
  return new Geometry(pos,n,ix);
}
function wallBatch(b,gx,gz,yaw,height,door,intensity,seed){
  const c=Math.cos(yaw),s=Math.sin(yaw);
  const local=(x,y,z)=>[gx+c*x+s*z,y,gz+c*z-s*x];
  const block=(x,y,z,w,h,d,material)=>b.block([w,h,d],material,local(x,y,z),yaw);
  if(!door){
    block(0,height/2,0,tile+.055,height,.31,stone[4]);
    for(let row=0;row<6;row++){
      const y=.26+row*(height-.12)/6,bh=(height-.12)/6-.021;
      for(let col=0;col<5;col++){
        const edge=(row%2)*.40,w=tile/5;
        const low=col===0?-tile*.5:(col*w-tile*.5+edge)-.015;
        const high=col===4?tile*.5:((col+1)*w-tile*.5+edge)-.034;
        if(high>low)block((low+high)/2,y,.155,high-low,bh,.08,stone[Math.floor(random(seed,row,col)*stone.length)]);
      }
    }
    block(0,.127,.222,tile+.018,.225,.15,rim);
    block(0,height-.126,.218,tile+.031,.235,.17,rim);
    if(intensity){
      block(0,1.91,.247,.43,.60,.12,bronze);
      block(0,2.05,.392,.28,.39,.24,warm);
      block(0,2.29,.414,.43,.073,.31,bronze);
      block(0,1.79,.414,.43,.073,.31,bronze);
    }
    return;
  }
  const passage=1.23;
  const outer=(tile/2-passage)/2;
  for(const side of [-1,1]){
    block(side*(passage+outer),1.16,0,2*outer,2.32,.43,stone[4]);
    block(side*1.27,1.14,.13,.154,2.30,.32,rim);
    block(side*1.29,1.14,-.13,.154,2.30,.32,rim);
    block(side*1.28,.15,0,.25,.29,.65,bronze);
  }
  const pos=[],nor=[],ix=[];
  for(let k=0;k<16;k++){
    const a=Math.PI*k/16,d=Math.PI*(k+1)/16;
    const xa=Math.cos(a)*passage,xb=Math.cos(d)*passage;
    const ya=2.32+.48*Math.sin(a),yb=2.32+.48*Math.sin(d);
    const points=[[xa,ya,.22],[xb,yb,.22],[xb,height+.04,.22],[xa,height+.04,.22],
      [xa,ya,-.22],[xb,yb,-.22],[xb,height+.04,-.22],[xa,height+.04,-.22]];
    const f=pos.length/3,g=points.map(p=>local(...p));
    pos.push(...g.flat());
    for(let j=0;j<8;j++)nor.push(...(j<4?[s,0,c]:[-s,0,-c]));
    for(const j of [0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1])ix.push(f+j);
  }
  b.append(new Geometry(pos,nor,ix),stone[2]);
  const bandPos=[],bandNormal=[],bandIndex=[];
  function face(a,b,c,d,normal){
    const id=bandPos.length/3;
    for(const p of [a,b,c,d]){bandPos.push(...local(...p));bandNormal.push(...normal);}
    bandIndex.push(id,id+1,id+2,id,id+2,id+3);
  }
  for(let block=0;block<11;block++){
    const lo=Math.PI*(block+.055)/11,hi=Math.PI*(block+.945)/11;
    const p=(axis,thickness,z)=>[(passage+thickness)*Math.cos(axis),2.32+(.48+thickness)*Math.sin(axis),z];
    for(const side of [-1,1]){
      const z=side*.252;
      face(p(lo,.006,z),p(hi,.006,z),p(hi,.172,z),p(lo,.172,z),[s*side,0,c*side]);
    }
  }
  b.append(new Geometry(bandPos,bandNormal,bandIndex),rim);
}
export function prepareGallery(solved){
  const b=batches(),lamps=[];
  const add=(rgb,position,intensity,range)=>lamps.push({position,color:rgb,intensity,range});
  for(let z=0;z<depth;z++)for(let x=0;x<width;x++){
    const id=floorAt(solved,x,z);
    if(!floorId(id))continue;
    const [wx,wz]=plot(x,z),cap=roofAt(solved,x,z);
    const roof=3.56+(cap===6?-.32:cap===8?.47:0);
    b.block([tile+.015,.20,tile+.015],step[1],[wx,-.10,wz]);
    for(let row=0;row<4;row++)for(let col=0;col<4;col++){
      const variation=random(x,z,row*4+col),width=tile*.25;
      b.block([width-.028,.025+.012*variation,width-.029],step[Math.floor(variation*step.length)],
        [wx+width*(col-1.5),.014,wz+width*(row-1.5)]);
    }
    b.block([tile+.021,.18,tile+.021],stone[4],[wx,roof+.09,wz],0,true);
    for(const off of [-1.65,1.65]){
      b.block([.19,.158,tile+.03],stone[2],[wx+off,roof-.075,wz],0,true);
      if(cap===8)b.block([tile+.03,.16,.17],rim,[wx,roof-.073,wz+off],0,true);
    }
    const color=id===3?[.40,.86,.91]:id===5?[.48,1,.86]:[1,.69,.43];
    let bracket=0;
    for(const [i,[dx,dz]] of cardinal.entries()){
      const other=floorAt(solved,x+dx,z+dz),gx=wx+dx*tile*.5,gz=wz+dz*tile*.5;
      const yaw=Math.atan2(-dx,-dz);
      if(!floorId(other)){
        const lamp=bracket!==1&&((x+z)%2===0||id>1);
        wallBatch(b,gx,gz,yaw,roof,false,lamp,x*341+z*317+i*13);
      if(id===2&&((x+z)%3===1)&&!floorId(other)&&bracket===0){
        const loc=(u,y,v)=>[gx+Math.cos(yaw)*u+Math.sin(yaw)*v,y,gz+Math.cos(yaw)*v-Math.sin(yaw)*u];
        for(const side of [-1,1])b.block([.105,1.74,.52],bronze,loc(side*.76,.88,.41),yaw);
        for(let shelf=0;shelf<4;shelf++){
          const y=.24+shelf*.43;
          b.block([1.58,.063,.53],dark,loc(0,y,.41),yaw);
          for(let item=0;item<7;item++){
            const h=.17+.15*random(x+item,z,shelf);
            const color=[step[3],rim,greenMetal,stone[0]][(item+shelf+x)%4];
            b.block([.125,h,.276],color,loc(item*.182-.55,y+.03+h*.5,.45),yaw);
          }
        }
      }
        if(lamp){
          bracket++;
          add(color,[gx-dx*.58,2.1,gz-dz*.58],18.0,5.2);
        }
      }else if(i%2===0){
        const capNext=roofAt(solved,x+dx,z+dz);
        const otherHeight=3.56+(capNext===6?-.32:capNext===8?.47:0);
        if(other!==id&&(id>=4||other>=4||((x*11+z)%5===1))){
          wallBatch(b,gx,gz,yaw,Math.max(roof,otherHeight),true,false,0);
        }else if(Math.abs(roof-otherHeight)>.04){
          b.block([tile+.021,Math.abs(roof-otherHeight)+.035,.27],stone[4],[gx,(roof+otherHeight)*.5,gz],yaw,true);
        }
      }
    }
    if(id>=3||x%3===0&&z%3===0){
      b.block([.12,.27,.12],bronze,[wx,roof-.15,wz],0,true);
      b.block([.64,.087,.64],bronze,[wx,roof-.315,wz],.78,true);
      b.block([.41,.21,.41],id===3?luminous:warm,[wx,roof-.46,wz],.78,true);
      b.block([.54,.052,.54],bronze,[wx,roof-.582,wz],.78,true);
      add(color,[wx,roof-.73,wz],id===5?35:16,5.6);
    }
  }
  const [sx,sz]=plot(...sanctuary);
  b.append(cylinder(.93,.17),dark,[sx,.104,sz]);b.append(cylinder(.69,.16),rim,[sx,.263,sz]);
  b.append(cylinder(.48,.58),dark,[sx,.61,sz]);b.append(cylinder(.63,.13),bronze,[sx,.968,sz]);
  b.append(cylinder(.53,.08),greenMetal,[sx,1.07,sz]);
  b.append(facetedPrism(.56,.82),luminous,[sx,1.96,sz],.19);
  add([.28,.97,.76],[sx,1.62,sz],45,8);
  return {layers:b.finish(),lamps};
}
