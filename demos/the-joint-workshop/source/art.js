import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {gates,roof,linkLength} from './layout.js';

const swatches={
  enclosure:['#2e4149',.48,.38],panel:['#203039',.78,.07],satin:['#464c4e',.51,.46],
  bronze:['#a77c4c',.33,.74],inset:['#8d6542',.54,.28],brass:['#d3ab6e',.27,.77],
  lightBrass:['#eac591',.36,.68],iron:['#565d62',.52,.69],gearing:['#27353b',.5,.5],
  pale:['#d3d8d2',.33,.09],glass:['#53716b',.24,.36],dusk:['#15252a',.61,.18],
  seal:['#ca824a',.41,.24],mat:['#2b3439',.91,.02],plinth:['#57554f',.64,.01],floor:['#3e515b',.77,.01]
};
function surface(palette){
  const [color,roughness,metalness]=swatches[palette];
  return new PbrMaterial({color,roughness,metalness,doubleSided:false});
}

function bevelPanel(w,h,d,edge){
  const x=w*.5,y=h*.5;
  const outline=[[-x+edge,-y],[x-edge,-y],[x,-y+edge],[x,y-edge],
    [x-edge,y],[-x+edge,y],[-x,y-edge],[-x,-y+edge]];
  const border=outline.map(([x,y])=>[x-Math.sign(x)*edge*.65,y-Math.sign(y)*edge*.65]);
  const positions=[],normals=[],indices=[];
  function polygon(points){
    const [p,q,r]=points;
    const a=q.map((v,i)=>v-p[i]),b=r.map((v,i)=>v-p[i]);
    const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const normal=n.map(v=>v/Math.hypot(...n));
    const start=positions.length/3;
    for(const point of points){positions.push(...point);normals.push(...normal);}
    for(let i=1;i+1<points.length;i++)indices.push(start,start+i,start+i+1);
  }
  const outer=d*.5,shoulder=outer-edge*.52;
  polygon(border.map(p=>[...p,outer]));
  polygon(border.slice().reverse().map(p=>[...p,-outer]));
  for(let i=0;i<8;i++){
    const j=(i+1)%8,a=outline[i],b=outline[j],u=border[i],v=border[j];
    polygon([[...a,-shoulder],[...b,-shoulder],[...b,shoulder],[...a,shoulder]]);
    polygon([[...a,shoulder],[...b,shoulder],[...v,outer],[...u,outer]]);
    polygon([[...b,-shoulder],[...a,-shoulder],[...u,-outer],[...v,-outer]]);
  }
  return new Geometry(positions,normals,indices);
}

function lathe(profile,segments=24){
  const p=[],n=[],ix=[];
  for(let j=0;j+1<profile.length;j++){
    const [r0,y0]=profile[j],[r1,y1]=profile[j+1];
    const dr=r1-r0,dy=y1-y0,length=Math.hypot(dr,dy);
    if(!length)continue;
    for(let i=0;i<=segments;i++){
      const rad=i/segments*Math.PI*2,c=Math.cos(rad),s=Math.sin(rad),k=p.length/3;
      p.push(r0*c,y0,r0*s,r1*c,y1,r1*s);
      const normal=[dy/length*c,-dr/length,dy/length*s];
      n.push(...normal,...normal);
      if(i)ix.push(k-2,k-1,k,k,k-1,k+1);
    }
  }
  return new Geometry(p,n,ix);
}

export function makeBench(engine){
  const colors=Object.fromEntries(Object.keys(swatches).map(name=>[name,surface(name)]));
  const one=box(1,1,1);
  function shaped(geometry,material,position,parent=null){
    return engine.createMesh(parent).setGeometry(geometry).setMaterial(colors[material]).setPosition(position);
  }
  function rectangle(size,material,position,parent=null){
    return shaped(one,material,position,parent).setScale(size);
  }
  function beveled(size,edge,material,position,parent=null){
    return shaped(bevelPanel(...size,edge),material,position,parent);
  }
  const cabinet=engine.createMesh();
  rectangle([160,.2,120],'floor',[0,-.11,0],cabinet);
  beveled([4.89,.041,1.04],.018,'mat',[0,.017,.16],cabinet);
  beveled([4.65,.27,.87],.042,'plinth',[0,.165,.15],cabinet);
  beveled([4.46,.16,.79],.04,'enclosure',[0,.337,.16],cabinet);
  beveled([4.58,.15,.83],.042,'enclosure',[0,2.22,.15],cabinet);
  beveled([4.48,.055,.81],.018,'bronze',[0,2.30,.15],cabinet);
  for(const x of [-2.21,-.21,2.22]){
    beveled([.134,1.76,.67],.03,'enclosure',[x,1.27,.10],cabinet);
    rectangle([.036,1.68,.021],'bronze',[x,1.27,.447],cabinet);
  }
  beveled([1.84,1.69,.12],.025,'dusk',[-1.2,1.275,-.235],cabinet);
  beveled([2.29,1.69,.12],.025,'panel',[1.0,1.275,-.235],cabinet);
  beveled([1.48,.145,.34],.026,'satin',[-1.26,.511,.026],cabinet);
  beveled([1.47,.027,.40],.01,'bronze',[-1.26,.605,.026],cabinet);
  for(const gate of gates){
    const center=gate.pin-gate.sign*.21;
    beveled([.33,.39,.09],.032,'enclosure',[center,.885,-.095],cabinet);
    beveled([.24,.21,.057],.026,'brass',[center,.87,-.027],cabinet);
    beveled([.17,.14,.036],.018,'iron',[center,.87,.020],cabinet);
    beveled([.062,.043,.034],.008,'seal',[center,.87,.053],cabinet);
    beveled([.035,.30,.035],.008,'bronze',[center,.729,.072],cabinet);
    for(const dx of [-.10,.10])for(const dy of [-.105,.105]){
      beveled([.025,.025,.032],.005,'pale',[center+dx,.87+dy,.002],cabinet);
    }
  }
  for(const x of [.17,2.025]){
    beveled([.062,1.59,.018],.008,'iron',[x,1.28,-.141],cabinet);
    for(let i=0;i<14;i++){
      rectangle([i%4===0?.051:.030,.007,.012],'lightBrass',[x, .60+i*.092,-.124],cabinet);
    }
  }
  // Repeated slats catch highlights without hiding the chain's clear silhouette.
  for(let i=0;i<21;i++){
    const x=-.135+i*.108;
    rectangle([.007,1.47,.024],i%5===0?'satin':'gearing',[x,1.289,-.153],cabinet);
  }
  for(const x of [-1.93,-.32,.02,2.03]){
    beveled([.114,.124,.062],.013,'bronze',[x,.251,.626],cabinet);
    rectangle([.066,.025,.031],'gearing',[x,.251,.665],cabinet);
  }
  const hub=lathe([[0,-.085],[.065,-.085],[.08,-.063],[.08,.063],[.065,.085],[0,.085]]);
  const fastener=lathe([[0,-.015],[.026,-.015],[.032,-.009],[.032,.009],[.026,.015],[0,.015]],12);
  const spindle=lathe([[0,-.033],[.017,-.033],[.023,-.026],[.023,.026],[.017,.033],[0,.033]],16);
  const socket=lathe([[0,-.054],[.042,-.054],[.058,-.027],[.058,.027],[.042,.054],[0,.054]],20);
  beveled([.38,.10,.26],.024,'bronze',[roof[0],2.094,roof[2]],cabinet);
  shaped(hub,'brass',roof,cabinet);
  for(const x of [roof[0]-.134,roof[0]+.134])shaped(fastener,'iron',[x,2.04,roof[2]],cabinet);

  const doors=gates.map(({pin,sign,width,height,y,z})=>{
    const half=-sign*width/2;
    const leaf=engine.createMesh().setPosition([pin+half,y,z]);
    beveled([width,height,.084],.030,'inset',[0,0,0],leaf);
    beveled([width-.136,height-.16,.025],.013,'dusk',[0,0,.050],leaf);
    for(const px of [-width*.5+.044,width*.5-.044]){
      beveled([.063,height-.082,.033],.010,'bronze',[px,0,.062],leaf);
    }
    for(const py of [-height*.5+.043,height*.5-.043]){
      beveled([width-.075,.061,.033],.010,'bronze',[0,py,.062],leaf);
    }
    for(const py of [-.34,-.17,0,.17,.34]){
      beveled([width-.157,.055,.019],.007,'satin',[0,py,.068],leaf);
    }
    const margin=.21*half/(width/2);
    for(const py of [-.17,.16]){
      const post=shaped(fastener,'lightBrass',[margin,py,.104],leaf);
      post.rotation.x=Math.PI/2;
    }
    beveled([.056,.32,.048],.013,'brass',[margin,0,.111],leaf);
    for(const py of [-height*.5+.12,height*.5-.12]){
      shaped(hub,'iron',[pin,y+py,z],cabinet);
      shaped(socket,'bronze',[-half,py,0],leaf);
    }
    // The reverse is also finished, so the front lighting does not hide open-door detail.
    beveled([width-.095,height-.12,.019],.010,'glass',[0,0,-.046],leaf);
    rectangle([width-.127,.052,.023],'bronze',[0,-.43,-.059],leaf);
    return leaf;
  });
  const pendulum=lathe([[0,-.127],[.044,-.127],[.079,-.104],[.111,-.065],[.124,-.018],
    [.124,.025],[.101,.07],[.067,.098],[.033,.115],[0,.115]],38);
  const pendulumBand=lathe([[0,-.019],[.1246,-.019],[.127,-.010],[.127,.01],[.1246,.019],[0,.019]],38);
  const rods=Array.from({length:5},(_,index)=>{
    const joint=engine.createMesh();
    if(index===4){
      shaped(pendulum,'pale',[0,-.019,0],joint);
      shaped(pendulumBand,'brass',[0,-.019,0],joint);
      shaped(spindle,'iron',[0,linkLength*.42,0],joint);
      return joint;
    }
    const upper=linkLength*.5-.034;
    const lower=-upper;
    beveled([.062,upper*2,.059],.017,index%2?'enclosure':'bronze',[0,0,0],joint);
    for(const top of [upper,lower]){
      shaped(socket,'brass',[0,top,0],joint);
      const key=shaped(fastener,'satin',[0,top,.062],joint);
      key.rotation.x=Math.PI/2;
    }
    return joint;
  });
  function sync(rig){
    for(const [i,{door}] of rig.doors.entries()){
      doors[i].setPosition(door.position).setQuaternion(door.rotation);
    }
    for(const [i,{body}] of rig.links.entries()){
      rods[i].setPosition(body.position).setQuaternion(body.rotation);
    }
  }
  return {sync};
}
