import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { sourceHeight, lowerOffset } from './photometry.js';

const material=(color,roughness=.6,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const m={
  stone:material('#b7ab96',.92), return:material('#4b665d',.72), green:material('#46655d',.77),
  foot:material('#58645b',.67), grout:material('#343c33',.91), joint:material('#776353',.84),
  bronze:material('#be8e62',.37,.31), bright:material('#e2aa6b',.45,.25), dark:material('#383b34',.56),
  housing:material('#53655f',.45,.29), highlight:material('#98a095',.35,.32), glass:material('#98a795',.19,.18),
  paint:material('#d2c8a1',.8), black:material('#222821',.66), powder:material('#69776c',.61),
};
const cube=box(1,1,1);

function radial(rings,sides=32) {
  const positions=[],normals=[],indices=[];
  for(let j=0;j<rings.length;j++){
    const [y,r]=rings[j];
    const [lo,hi]=[rings[Math.max(0,j-1)],rings[Math.min(rings.length-1,j+1)]];
    const ny=lo[1]-hi[1], nr=hi[0]-lo[0], length=Math.hypot(nr,ny);
    for(let i=0;i<=sides;i++){
      const t=i*2*Math.PI/sides, x=Math.cos(t),z=Math.sin(t);
      positions.push(r*x,y,r*z);
      normals.push(x*nr/length,ny/length,z*nr/length);
      if(j&&i){
        const a=j*(sides+1)+i, b=a-sides-1;
        indices.push(a,a-1,b-1,a,b-1,b);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}

function ringShape(size) {
  const positions=[],normals=[],indices=[];
  const N=48;
  for(let i=0;i<=N;i++){
    const t=i*2*Math.PI/N;
    for(const r of [size-.0036,size]){
      positions.push(r*Math.cos(t),r*Math.sin(t),0);
      normals.push(0,0,1);
    }
    if(i)indices.push(i*2-2,i*2-1,i*2+1,i*2-2,i*2+1,i*2);
  }
  return new Geometry(positions,normals,indices);
}

function chamfered() {
  const ring=[[-.46,-.50],[.46,-.50],[.50,-.46],[.50,.46],[.46,.50],[-.46,.50],[-.50,.46],[-.50,-.46]];
  const pts=[], normal=[], ix=[];
  const poly=(face,n)=>{
    const start=pts.length/3;
    for(const v of face){pts.push(...v);normal.push(...n);}
    for(let i=1;i+1<face.length;i++)ix.push(start,start+i,start+i+1);
  };
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length], dx=b[0]-a[0],dz=b[1]-a[1];
    const len=Math.hypot(dx,dz);
    poly([[b[0],-.5,b[1]],[a[0],-.5,a[1]],[a[0],.5,a[1]],[b[0],.5,b[1]]],[dz/len,0,-dx/len]);
  }
  poly(ring.map(([x,z])=>[x,-.5,z]),[0,-1,0]);
  poly([...ring].reverse().map(([x,z])=>[x,.5,z]),[0,1,0]);
  return new Geometry(pts,normal,ix);
}
const bevel=chamfered();
const post=radial([[0,.047],[.025,.06],[.08,.05],[1.322,.05],[1.36,.046]],32);
const collar=radial([[-.045,.094],[-.032,.108],[.032,.108],[.046,.094]]);
const pan=radial([[0,.13],[.012,.156],[.032,.161],[.057,.148],[.064,.12]],40);
const probe=ringShape(.047);

export function buildBay(scene) {
  const mesh=(name,geo,mat,position,scale,parent=null)=>{
    const object=scene.createMesh(parent);
    object.name=name;
    return object.setGeometry(geo).setMaterial(mat).setPosition(position).setScale(scale);
  };
  const block=(name,mat,x,y,z,w,h,d,parent)=>mesh(name,cube,mat,[x,y,z],[w,h,d],parent);
  const shaped=(name,mat,x,y,z,w,h,d,parent)=>mesh(name,bevel,mat,[x,y,z],[w,h,d],parent);
  block('Matte mineral test wall',m.stone,0,1.58,-.09,3.20,3.16,.18);
  block('Left jamb',m.return,-1.65,1.59,.40,.12,3.18,.94);
  block('Right jamb',m.return,1.65,1.59,.40,.12,3.18,.94);
  block('Valance',m.green,0,3.18,.39,3.42,.115,.94);
  shaped('Ashlar heel',m.joint,0,.105,.026,3.19,.17,.052);
  shaped('Threshold bronze inlay',m.bronze,0,.044,.795,3.40,.027,.028);
  block('Concrete bay plinth',m.foot,0,-.068,1.95,3.48,.136,4.13);
  block('Front fascia',m.dark,0,-.114,4.08,3.54,.228,.18);
  shaped('Cove line',m.bronze,0,3.107,.485,3.42,.027,.02);

  for(const side of [-1,1]){
    shaped('Corner glazing bead',m.bronze,side*1.595,1.60,.036,.028,3.04,.06);
    shaped('Outer chamfered jamb',m.dark,side*1.742,1.58,.45,.105,3.2,.95);
    for(let y=.27;y<=3.02;y+=.28) {
      block('Recessed jamb joint',m.grout,side*1.582,y,.45,.012,.013,.86);
    }
    for(let i=0;i<8;i++){
      const z=1.40+i*.33;
      block('Floor casting seam',m.grout,side*1.18,.003,z,.15,.005,.010);
    }
  }

  for(let tick=0;tick<=10;tick++){
    const z=1.60+tick*.20;
    const length=tick%5===0?.16:.072;
    block('Distance scale left',m.paint,-.21,.018,z,length,.006,.021);
    block('Distance scale right',m.paint,.21,.018,z,length,.006,.021);
  }
  for(const y of [sourceHeight,sourceHeight-lowerOffset]){
    mesh('Wall reading ring',probe,m.bright,[0,y,.006],[1,1,1]);
  }
  for(let y=.36;y<2.92;y+=.20){
    for(const side of [-1,1]) block('Wall ruler tick',m.joint,side*1.48,y,.004,.032,.004,.008);
  }

  const carriage=scene.createMesh();
  carriage.name='Movable photometry jig';
  shaped('Carriage base',m.dark,0,.076,.12,.62,.153,.52,carriage);
  shaped('Carriage steel cap',m.highlight,0,.157,.12,.56,.036,.46,carriage);
  for(const x of [-.217,.217]){
    for(const z of [-.032,.27]){
      mesh('Socket cap fastener',pan,m.bronze,[x,.177,z],[.14,.26,.14],carriage);
    }
  }
  mesh('Telescoping test post',post,m.housing,[0,.176,.168],[1,1,1],carriage);
  mesh('Lower post ferrule',collar,m.highlight,[0,.259,.168],[1.06,.72,1.06],carriage);
  mesh('Height lock collar',collar,m.bronze,[0,1.12,.168],[.78,.78,.78],carriage);
  shaped('Tilt yoke base',m.highlight,0,sourceHeight-.213,.16,.48,.054,.15,carriage);
  for(const side of [-1,1]){
    shaped('Tilt yoke arm',m.highlight,side*.255,sourceHeight-.092,.158,.064,.266,.095,carriage);
    mesh('Tilt pivot hardware',pan,m.bronze,[side*.285,sourceHeight+.008,.158],[.47,.79,.47],carriage)
      .setRotation([0,0,side*Math.PI/2]);
  }
  shaped('Finned floodlight housing',m.housing,0,sourceHeight,.153,.480,.285,.263,carriage);
  shaped('Floodlight front rim',m.highlight,0,sourceHeight,.026,.494,.285,.045,carriage);
  shaped('Optic inset bezel',m.black,0,sourceHeight,.003,.431,.235,.018,carriage);
  shaped('Test optic',m.glass,0,sourceHeight,-.008,.392,.202,.010,carriage);
  shaped('Light visor upper',m.dark,0,sourceHeight+.153,-.049,.51,.035,.190,carriage).setRotation([-.16,0,0]);
  for(let i=0;i<8;i++){
    shaped('Heat sink fin',m.powder,(i-3.5)*.052,sourceHeight,.305,.023,.235,.081,carriage);
  }
  shaped('Identification plate',m.highlight,.027,sourceHeight-.041,.350,.158,.037,.010,carriage);
  for(let row=0;row<3;row++)block('Enamel grade line',m.dark,.020,sourceHeight-.049+row*.008,.356,.10-row*.013,.0025,.0016,carriage);
  return carriage;
}
