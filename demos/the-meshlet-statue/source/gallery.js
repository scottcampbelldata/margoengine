import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {center,ribbons} from './form.js';

const surface=(color,roughness=.64,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const tau=Math.PI*2;
const cube=box();
const materials={
  floor:surface('#646866',.85),grout:surface('#4b525c'),wall:surface('#879294',.87),
  inset:surface('#56666d',.83),trim:surface('#343a45',.44,.20),metal:surface('#aa916b',.48,.36),
  slate:surface('#394550',.60,.12),panel:surface('#4e6070',.58,.16),plaque:surface('#bcad93',.45,.19),
  belt:surface('#242b36',.75),porcelain:surface('#e5c5a1',.38),
};

function put(engine,geometry,material,position,scale=[1,1,1],parent){
  return engine.createMesh(parent).setGeometry(geometry).setMaterial(material).setPosition(position).setScale(scale);
}
function round(n=80){
  const positions=[],normals=[],indices=[];
  for(let i=0;i<n;i++){
    const a=i*tau/n,x=Math.cos(a),z=Math.sin(a);
    positions.push(x,-.5,z,x,.5,z);normals.push(x,0,z,x,0,z);
  }
  for(let i=0;i<n;i++){
    const j=(i+1)%n,b=i*2,c=j*2;
    indices.push(b,b+1,c+1,b,c+1,c);
  }
  for(const top of [false,true]){
    const center=positions.length/3,y=top?.5:-.5,normal=top?1:-1;
    positions.push(0,y,0);normals.push(0,normal,0);
    for(let i=0;i<n;i++){
      const a=i*tau/n;
      positions.push(Math.cos(a),y,Math.sin(a));normals.push(0,normal,0);
    }
    for(let i=0;i<n;i++){
      const a=center+1+i,b=center+1+(i+1)%n;
      if(top)indices.push(center,b,a);
      else indices.push(center,a,b);
    }
  }
  return new Geometry(positions,normals,indices);
}
function pearl(steps=32,layers=22){
  const p=[0,.5,0],n=[0,1,0],ix=[];
  for(let j=1;j<layers;j++){
    const v=j*Math.PI/layers,y=Math.cos(v),r=Math.sin(v);
    for(let i=0;i<steps;i++){
      const t=i*tau/steps,x=r*Math.cos(t),z=r*Math.sin(t);
      p.push(x*.50,y*.50,z*.50);n.push(x,y,z);
    }
  }
  const end=p.length/3;
  p.push(0,-.5,0);n.push(0,-1,0);
  for(let i=0;i<steps;i++){
    const k=(i+1)%steps;
    ix.push(0,k+1,i+1,end,1+(layers-2)*steps+i,1+(layers-2)*steps+k);
    for(let j=0;j<layers-2;j++){
      const a=1+j*steps+i,b=1+j*steps+k;
      ix.push(a,b+steps,a+steps,a,b,b+steps);
    }
  }
  return new Geometry(p,n,ix);
}

export function buildGallery(engine){
  const shadows=[];
  const block=(material,position,scale,parent)=>put(engine,cube,material,position,scale,parent);
  const cylinder=round();
  const disk=(material,position,scale)=>put(engine,cylinder,material,position,scale);
  const floor=block(materials.floor,[0,-.125,-1.2],[24,.24,25]);
  for(let i=-4;i<=4;i++){
    block(materials.grout,[i*2.15,.001,-1.2],[.016,.006,25]);
  }
  for(let i=-5;i<=4;i++){
    block(materials.grout,[0,.002,i*2.15],[24,.006,.016]);
  }

  block(materials.wall,[0,3.48,-4.8],[18,7.02,.50]);
  block(materials.inset,[0,.38,-4.53],[18,.76,.08]);
  block(materials.trim,[0,.061,-4.47],[18,.115,.15]);
  for(const x of [-5.05,0,5.05]){
    block(materials.trim,[x,5.87,-4.48],[4.68,.055,.12]);
    block(materials.wall,[x,3.31,-4.51],[4.50,4.87,.16]);
  }
  for(const x of [-7.65,-3.92,3.92,7.65]){
    const pier=block(materials.inset,[x,3.34,-3.98],[.56,6.70,1.25]);
    shadows.push(pier);
    block(materials.wall,[x,3.35,-3.345],[.42,6.68,.025]);
    block(materials.trim,[x,.168,-3.513],[.68,.31,.43]);
  }
  block(materials.inset,[-9.2,3.46,-.12],[.32,7,10.82]);
  block(materials.inset,[9.2,3.46,-.12],[.32,7,10.82]);

  shadows.push(disk(materials.belt,[0,.068,0],[2.63,.136,1.64]));
  disk(materials.metal,[0,.153,0],[2.58,.032,1.60]);
  disk(materials.belt,[0,.194,0],[2.54,.050,1.57]);
  disk(materials.slate,[0,.235,0],[2.46,.036,1.50]);
  for(const rib of ribbons){
    const [x,y,z]=center(0,rib);
    const support=Math.max(.038,y+.24-.25);
    shadows.push(disk(materials.metal,[x,.25+support/2,z],[.081,support,.071]));
  }
  const goldenCore=put(engine,pearl(),materials.porcelain,[.43,2.32,-.38],[.66,.66,.66]);
  const holder=disk(materials.trim,[.43,1.146,-.38],[.036,1.78,.036]);
  shadows.push(goldenCore,holder);

  const railZ=2.15;
  block(materials.belt,[-1.61,.018,railZ],[7.13,.048,.65]);
  for(const z of [railZ-.255,railZ+.255])block(materials.metal,[-1.61,.048,z],[7.19,.018,.041]);
  for(let i=0;i<17;i++){
    const x=-5.05+i*.425;
    block(materials.metal,[x,.043,railZ+.34],[.018,.020,i%4===0?.097:.049]);
  }
  const wall=engine.createMesh();
  const moving=block(materials.slate,[0,2.31,0],[2.47,4.50,.33],wall);
  block(materials.trim,[0,.115,0],[2.56,.16,.57],wall);
  block(materials.panel,[0,2.35,.172],[2.32,4.31,.041],wall);
  for(const x of [-1.08,1.08]){
    block(materials.trim,[x,2.35,.201],[.045,4.05,.022],wall);
    block(materials.metal,[x*.89,2.33,.202],[.016,4.02,.015],wall);
  }
  for(let i=0;i<16;i++){
    const y=.435+i*.244;
    const width=i%5===0?.16:.084;
    block(materials.plaque,[.87-width/2,y,.208],[width,.014,.014],wall);
  }
  block(materials.trim,[-.74,.45,.218],[.41,.22,.032],wall);
  block(materials.metal,[-.74,.45,.237],[.319,.145,.009],wall);
  return {wall,moving,floor,shadows,railZ};
}
