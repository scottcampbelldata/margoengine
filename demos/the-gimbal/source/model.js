import { Material, createMesh } from '@margoengine/materials';
import {
  applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries,
  sphereGeometry, torusGeometry,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { mountAxis } from './mechanism.js';

const height=.353;
const vertical=[0,1,0], axial=[0,0,1], crosswise=[1,0,0];
const point=(direction,distance)=>direction.map((v)=>v*distance);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>point(v,1/Math.hypot(...v));
const offset=(a,b)=>a.map((v,i)=>v+b[i]);
const radial=(r,t,z)=>[r*Math.cos(t),r*Math.sin(t),z];
const midpoint=(a,b)=>a.map((v,i)=>(v+b[i])*.5);

const finishes={
  studio:{color:[.074,.107,.124],roughness:.95,metalness:0},
  rubber:{color:[.031,.043,.050],roughness:.88,metalness:.04},
  base:{color:[.092,.157,.197],roughness:.45,metalness:.27},
  carrier:{color:[.125,.175,.201],roughness:.42,metalness:.41},
  blue:{color:[.063,.29,.462],roughness:.33,metalness:.30},
  bronze:{color:[.65,.38,.156],roughness:.33,metalness:.50},
  mass:{color:[.46,.237,.093],roughness:.36,metalness:.43},
  steel:{color:[.49,.54,.54],roughness:.33,metalness:.52},
  enamel:{color:[.75,.80,.74],roughness:.6,metalness:.06},
  black:{color:[.057,.075,.079],roughness:.58,metalness:.15},
  warm:{color:[1,.57,.119],shading:'basic'},
  cool:{color:[.18,.77,1],shading:'basic'},
};

function place(geometry,position,axis=vertical) {
  const seed=Math.abs(axis[2])>.85?crosswise:axial;
  const right=unit(cross(axis,seed));
  const front=cross(right,axis);
  return applyMatrix4(geometry,[...right,0,...axis,0,...front,0,...position,1]);
}

function hoop(inner,outer,depth,bevel,z=0,segments=80) {
  const a=-depth*.5,b=depth*.5;
  return place(latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],
    [outer-bevel,b],[inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],segments),[0,0,z],axial);
}

function rail(from,to,width,depth,bevel) {
  const delta=from.map((v,i)=>to[i]-v);
  return place(roundedBoxGeometry(width,Math.hypot(...delta),depth,1,bevel),midpoint(from,to),unit(delta));
}

const glyph={
  G:['01111','11000','10000','10111','10001','11001','01111'],
  Y:['10001','10001','01010','00100','00100','00100','00100'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  O:['01110','11011','10001','10001','10001','11011','01110'],
  '/':['00001','00001','00010','00100','01000','10000','10000'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
};

export function prepareGimbal() {
  const sets=new Map();
  function add(owner,finish,geometry) {
    const key=owner+'/'+finish;
    if(!sets.has(key)) sets.set(key,[]);
    sets.get(key).push(geometry);
  }

  function slab(owner,finish,position,dimensions,bevel,axis=vertical) {
    add(owner,finish,place(roundedBoxGeometry(...dimensions,2,bevel),position,axis));
  }

  function barrel(owner,finish,position,axis,radius,depth,segments=24,back=radius) {
    add(owner,finish,place(cylinderGeometry(radius,back,depth,segments),position,axis));
  }

  function screw(owner,position,axis,radius) {
    barrel(owner,'black',position,axis,radius*1.24,radius*.25,16);
    const head=offset(position,point(axis,radius*.19));
    barrel(owner,'steel',head,axis,radius,radius*.33,12,radius*1.02);
    const slot=offset(head,point(axis,radius*.18));
    slab(owner,'black',slot,[radius*1.33,radius*.06,radius*.25],radius*.026,axis);
  }

  function beam(owner,finish,from,to,radius,segments=12) {
    const delta=to.map((v,i)=>v-from[i]);
    barrel(owner,finish,midpoint(from,to),unit(delta),radius,Math.hypot(...delta),segments);
  }

  // Shadow deck, layered plinth, felt isolation feet and milled nomenclature plate.
  slab('world','studio',[0,-.081,0],[110,.032,110],.006);
  slab('world','rubber',[0,-.049,.009],[.746,.036,.552],.015);
  slab('world','steel',[0,-.032,.009],[.788,.019,.597],.008);
  slab('world','base',[0,-.002,.009],[.807,.055,.607],.020);
  slab('world','carrier',[0,.028,.009],[.755,.018,.553],.008);
  for(const x of [-.337,.337]) for(const z of [-.224,.244]) {
    barrel('world','rubber',[x,-.057,z],vertical,.031,.021,24,.035);
    screw('world',[x,.040,z],vertical,.0095);
  }
  slab('world','black',[0,-.001,.314],[.173,.023,.007],.003);
  for(const x of [-.075,.075]) screw('world',[x,-.001,.320],axial,.004);
  const inscription='GYRO/01';
  const pitch=.00208;
  for(let char=0;char<inscription.length;char++) {
    glyph[inscription[char]].forEach((row,y)=>{
      [...row].forEach((cell,x)=>{
        if(cell==='1') slab('world','enamel',[(char*6+x-20)*pitch,(3-y)*pitch-.001,.3186],[.00175,.00175,.0008],.0002);
      });
    });
  }

  // The two fixed pedestal bearings share the physical mount axis.
  for(const sign of [-1,1]) {
    const away=point(mountAxis,sign);
    const bearing=offset([0,height,0],point(away,.306));
    const base=[bearing[0]+sign*.082,.044,bearing[2]-sign*.049];
    const shoulder=offset(bearing,point(away,.009));
    slab('world','black',[base[0],.044,base[2]],[.102,.015,.100],.006);
    for(const x of [-.035,.035]) for(const z of [-.034,.034])
      screw('world',[base[0]+x,.054,base[2]+z],vertical,.0065);
    add('world','base',rail([base[0],.055,base[2]],shoulder,.055,.042,.008));
    const lower=[base[0]-sign*.026,.061,base[2]+sign*.028];
    add('world','carrier',rail(lower,offset(shoulder,[0,-.034,0]),.022,.023,.003));
    add('world','steel',rail(offset(lower,[0,.002,.013]),offset(shoulder,[0,-.039,.013]),.005,.005,.001));
    barrel('world','carrier',bearing,away,.031,.059);
    barrel('world','steel',offset(bearing,point(away,.030)),away,.027,.011);
    barrel('world','black',offset(bearing,point(away,.036)),away,.017,.008);
    screw('world',offset(bearing,point(away,.044)),away,.010);
    barrel('mount','steel',point(away,.276),away,.020,.086);
    const joint=point(away,.259);
    barrel('mount','carrier',joint,away,.026,.038,20);
    const projected=point([away[0],away[1],0],.269/Math.hypot(away[0],away[1]));
    const rim=[projected[0],projected[1],Math.sign(away[2])*.009];
    add('mount','carrier',rail(joint,rim,.038,.028,.004));
    const seam=point(unit(cross(away,axial)),.017);
    add('mount','steel',rail(offset(joint,seam),offset(rim,seam),.0037,.0042,.00085));
  }

  add('mount','carrier',hoop(.244,.281,.040,.006));
  add('mount','steel',hoop(.271,.276,.003,.001,.018));
  add('mount','black',hoop(.248,.252,.004,.001,.020));
  for(let i=0;i<64;i++) {
    const angle=i*Math.PI/32;
    const major=i%8===0;
    add('mount',major?'enamel':'steel',rail(radial(major?.256:.262,angle,.0205),radial(.268,angle,.0205),major?.0026:.0014,.0010,.00030));
  }

  add('yaw','bronze',hoop(.209,.233,.033,.005,0,72));
  add('yaw','mass',hoop(.227,.234,.009,.002,0,72));
  add('yaw','steel',hoop(.228,.231,.0025,.0008,.0136,72));
  add('pitch','blue',hoop(.169,.195,.031,.0045,0,72));
  add('pitch','steel',hoop(.172,.174,.0026,.0007,.0134,72));
  add('pitch','carrier',hoop(.189,.194,.006,.002,-.013,72));

  for(const sign of [-1,1]) {
    const outer=point(vertical,sign);
    const inner=point(crosswise,sign);
    barrel('mount','black',point(outer,.245),outer,.023,.016);
    barrel('mount','steel',point(outer,.231),outer,.017,.017);
    barrel('yaw','bronze',point(outer,.224),outer,.024,.026);
    screw('mount',point(outer,.282),outer,.014);
    barrel('yaw','black',point(inner,.209),inner,.021,.018);
    barrel('yaw','steel',point(inner,.204),inner,.016,.021);
    barrel('pitch','blue',point(inner,.184),inner,.021,.035);
    screw('yaw',point(inner,.233),inner,.011);
  }

  for(let i=0;i<12;i++) {
    const t=(i+.5)*Math.PI/6;
    screw('yaw',radial(.220,t,.0155),axial,.0039);
    screw('pitch',radial(.183,t,.0145),axial,.00345);
  }

  // A rear spider ties the shaft bearings to the inner gimbal.
  for(let i=0;i<3;i++) {
    const t=i*Math.PI*2/3+Math.PI/6;
    add('pitch','carrier',rail(radial(.036,t,-.055),radial(.18,t,-.024),.021,.017,.003));
    add('pitch','steel',rail(radial(.125,t,-.040),radial(.178,t,-.019),.005,.006,.0018));
    barrel('pitch','black',radial(.175,t,-.025),axial,.012,.019,18);
  }
  barrel('pitch','carrier',[0,0,-.055],axial,.041,.042,40);
  barrel('pitch','steel',[0,0,-.072],axial,.030,.014,36);
  barrel('pitch','black',[0,0,-.032],axial,.029,.012,36);

  // A thick flywheel rim carries the mass. Six webs tie it to the keyed hub.
  add('rotor','mass',hoop(.103,.145,.045,.006,0,80));
  add('rotor','bronze',hoop(.108,.141,.005,.002,.0208,80));
  add('rotor','steel',hoop(.138,.144,.0035,.001,-.0180,80));
  add('rotor','black',hoop(.103,.107,.003,.0009,.022,80));
  add('rotor','mass',hoop(.128,.132,.0016,.00045,.0234,80));
  for(let i=0;i<6;i++) {
    const t=i*Math.PI/3;
    add('rotor','steel',rail(radial(.022,t,0),radial(.109,t+.19,0),.020,.017,.005));
    add('rotor','black',rail(radial(.044,t+.055,.009),radial(.091,t+.150,.009),.004,.002,.0008));
    screw('rotor',radial(.122,t+.18,.024),axial,.005);
  }
  for(let i=0;i<48;i++) {
    const t=i*Math.PI/24;
    const radius=i%8===0?.138:.135;
    add('rotor',i%8===0?'enamel':'mass',rail(radial(.133,t,.0236),radial(radius,t,.024),.0016,.0010,.00025));
  }
  barrel('rotor','steel',[0,0,-.005],axial,.033,.034,36);
  barrel('rotor','black',[0,0,.017],axial,.029,.014,32);
  barrel('rotor','bronze',[0,0,.023],axial,.023,.014,32);
  barrel('rotor','steel',[0,0,-.009],axial,.013,.100,28);
  screw('rotor',[0,0,.043],axial,.0105);

  const focusZ=.396;
  for(let i=0;i<9;i++) {
    const start=.059+i*.036;
    beam('movingGuide','warm',[0,0,start],[0,0,start+.023],.0033);
  }
  add('movingGuide','warm',place(sphereGeometry(.006,16,10),[0,0,focusZ]));
  add('fixedGuide','cool',applyMatrix4(torusGeometry(.041,.0027,7,44),[1,0,0,0,0,1,0,0,0,0,1,0,0,height,focusZ,1]));
  for(let i=0;i<4;i++) {
    const t=i*Math.PI/2;
    const shift=[0,height,0];
    beam('fixedGuide','cool',offset(radial(.039,t,focusZ),shift),offset(radial(.056,t,focusZ),shift),.0021,8);
  }

  const parts=Array.from(sets,([key,geometry])=>({
    owner:key.split('/')[0],finish:key.split('/')[1],
    geometry:geometry.length===1?geometry[0]:mergeGeometries(geometry),
  }));

  return (engine,shadows)=>{
    const world=engine.createMesh();
    const mount=engine.createMesh().setPosition([0,height,0]).setParent(world);
    const yaw=engine.createMesh().setParent(mount);
    const pitch=engine.createMesh().setParent(yaw);
    const rotor=engine.createMesh().setParent(pitch);
    const groups={world,mount,yaw,pitch,rotor,movingGuide:pitch,fixedGuide:world};
    const materials=new Map();
    const guides=[];
    for(const {owner,finish,geometry} of parts) {
      if(!materials.has(finish)) materials.set(finish,new Material(finishes[finish]));
      const part=createMesh(engine,geometry,materials.get(finish));
      part.root.name=owner+' '+finish;
      part.root.setParent(groups[owner]);
      if(owner.endsWith('Guide')) guides.push(part.root);
      else shadows.add(part,{static:owner==='world',castShadow:finish!=='studio'});
    }
    return {
      pose({mount:quaternion,outer,inner}) {
        mount.setQuaternion(quaternion);
        yaw.setRotation([0,outer,0]);
        pitch.setRotation([inner,0,0]);
      },
      spin(radians) { rotor.setRotation([0,0,radians]); },
      showGuides(value) { guides.forEach((mesh)=>{ mesh.visible=value; }); },
    };
  };
}
