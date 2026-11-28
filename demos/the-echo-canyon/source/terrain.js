import { Geometry, PbrMaterial } from '@margoengine/core';
import { cylinderGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';

const reach=184;
const strata=[-2,1.6,5.0,7.8,10.5,13.8,16.3,20.2,23.0,26.4,28.0,31.0,34.5,37.2,41.0,45.4,49.0];
const hues=['#835645','#936150','#a26a54','#a0694e','#ab6d52','#9d5e47','#b27357','#a66850',
  '#c18460','#ac7157','#c48765','#b87b60','#bd8065','#cb9374','#d09b7b','#c08c71'];
const fract=x=>x-Math.floor(x);
const hash=(seed)=>fract(Math.sin(seed*12.9898+73.123)*43758.5453123);

function valleyShift(z) {
  const bend=Math.min(1,Math.max(0,(-z-61)/99));
  return -49*bend*bend*(3-2*bend);
}

export function wash(z) {
  return valleyShift(z)+6.6*Math.sin(z*.042)+2.4*Math.sin(z*.099+1.3)+1.8;
}
function floorHeight(x,z) {
  const channel=Math.exp(-(((x-wash(z))/5.0)**2));
  const layers=.34*Math.sin(x*.164+z*.121)+.21*Math.cos(x*.22-z*.183);
  return -.48+layers*(1-channel*.85)-1.07*channel;
}

function indexedGrid(columns,rows,sample,flip=false) {
  const positions=[],normals=[],indices=[];
  for(let j=0;j<=rows;j++){
    const v=j/rows;
    for(let i=0;i<=columns;i++){
      const u=i/columns;
      const p=sample(u,v);
      const left=sample(Math.max(0,u-.001),v),right=sample(Math.min(1,u+.001),v);
      const before=sample(u,Math.max(0,v-.001)),after=sample(u,Math.min(1,v+.001));
      const a=right.map((x,k)=>x-left[k]),b=after.map((x,k)=>x-before[k]);
      const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      const length=Math.hypot(...n)*(flip?-1:1);
      positions.push(...p);
      normals.push(...n.map(x=>x/length));
      if(i>0&&j>0){
        const q=j*(columns+1)+i,k=q-columns-2;
        if(flip)indices.push(k,k+columns+1,k+1,k+1,k+columns+1,q);
        else indices.push(k,k+1,k+columns+1,k+1,q,k+columns+1);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}

function cliffPoint(side,z,h) {
  const rough=Math.min(1,Math.max(0,(h-5)/16));
  const regional=2.7*Math.sin(z*.103+side)+1.65*Math.sin(z*.214+.4)+.70*Math.cos(z*.492);
  const cracks=.51*Math.sin(z*.73+h*.23)+.32*Math.sin(z*1.01-h*.61);
  const band=1.07*Math.sin(h*.52+.18*Math.sin(z*.2));
  const height=h+rough*(.72*Math.sin(z*.142+side*.7)+.33*Math.cos(z*.31+h*.21));
  const shelf=Math.max(0,h-30)*.40+Math.max(0,h-44)*1.1;
  return [valleyShift(z)+side*(46+shelf+rough*(4.1+regional+cracks+band)),height,z];
}

function valleyFloor() {
  return indexedGrid(96,156,(u,v)=>{
    const z=reach*(2*v-1);
    const x=valleyShift(z)+104*u-52;
    return [x,floorHeight(x,z),z];
  },true);
}

export function makeCanyon(engine) {
  const coat=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  function place(name,geometry,material,at=[0,0,0]){
    const mesh=engine.createMesh().setPosition(at).setGeometry(geometry).setMaterial(material);
    mesh.name=name;
    return mesh;
  }
  for(const side of [-1,1]){
    for(let i=0;i<strata.length-1;i++){
      const low=strata[i],high=strata[i+1];
      const geo=indexedGrid(155,3,(u,v)=>cliffPoint(side,reach*(2*u-1),low+v*(high-low)),side<0);
      place('Sandstone bed '+(i+1),geo,coat(hues[i],.84));
    }
    const mesa=indexedGrid(151,8,(u,v)=>{
      const z=reach*(2*u-1);
      const [x,y]=cliffPoint(side,z,49);
      return [x+side*v*68,y-v*(3+1.2*Math.sin(z*.016)),z];
    },side<0);
    place('Upper mesa',mesa,coat('#bd886c',.83));
  }
  place('Canyon floor',valleyFloor(),coat('#a88160',.90));
  const river=indexedGrid(16,156,(u,v)=>{
    const z=reach*(2*v-1);
    return [wash(z)+(u-.5)*(4.8+1.35*Math.sin(z*.108+1.2)),-1.21+.009*Math.sin(z*.35+u*5),z];
  },true);
  place('Still river',river,coat('#597d76',.33));
  for(const side of [-1,1]){
    const bank=indexedGrid(8,152,(u,v)=>{
      const z=reach*(2*v-1);
      const inner=2.16+.58*Math.sin(z*.108+1.2);
      const outer=inner+1.60+.49*Math.sin(z*.18+side)+.40*Math.cos(z*.57);
      const x=wash(z)+side*(inner+(outer-inner)*u);
      return [x,floorHeight(x,z)+.026,z];
    },side>0);
    place('Rippled sandbank',bank,coat(side<0?'#ac8c6e':'#a4876c',.92));
  }

  const oneRock=toGeometry(cylinderGeometry(1.0,.78,.70,7));
  const stone=[coat('#8d614c',.95),coat('#b78663',.87),coat('#a37357',.87)];
  for(let i=0;i<91;i++){
    const z=-95+190*hash(i+17);
    const x=(i%2===0?1:-1)*(28+16*hash(i+879));
    const size=.38+1.4*hash(i+191);
    place('Talus fragment',oneRock,stone[i%stone.length],[x,floorHeight(x,z)+size*.23,z])
      .setScale([size,size*.82,size*(.53+.59*hash(i-99))]);
  }
  for(const [band,material] of [coat('#8b895e',.86),coat('#8b9a6b',.88),coat('#606e57',.94)].entries()){
    const positions=[],normals=[],indices=[];
    for(let i=0;i<101;i++){
      const z=-92+184*hash(i+255+band*148);
      const x=wash(z)+(i%2?1:-1)*(2.8+8.7*hash(i+80+245*band));
      const height=.33+.75*hash(i+473);
      const ground=floorHeight(x,z);
      for(let sprig=0;sprig<5;sprig++){
        const angle=6.283*hash(i+sprig*211+band*321);
        const w=.10+.08*hash(i+sprig*119);
        const base=positions.length/3;
        const branch=.21+.62*hash(i+sprig*19);
        positions.push(x-w,ground,z,x+w,ground,z,
          x+Math.cos(angle)*branch,ground+height*(.7+.3*hash(i+sprig*87)),z+Math.sin(angle)*branch);
        normals.push(0,.6,1,0,.6,1,0,.6,1);
        indices.push(base,base+1,base+2);
      }
    }
    place('Waterside shrubs',new Geometry(positions,normals,indices),material);
  }
  return floorHeight;
}



