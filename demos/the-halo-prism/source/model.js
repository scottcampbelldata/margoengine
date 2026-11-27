import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, icosahedronGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { geometryData, toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { minAt, prismHeight, prismRadius, rad, tracePrism } from './optics.js';
import { installLight } from './light.js';

export const prismCenter=[-.322,.331,.002];
export const skyCenter=[.334,.354,-.048];
const tilt=axisAngleToQuaternion([1,0,0],-.165);
const facing=axisAngleToQuaternion([1,0,0],Math.PI/2);
const yaw=(a)=>axisAngleToQuaternion([0,1,0],a);
const sourceRange=.198;

function turnedRing(inner,outer,depth,bevel,sides=80){
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}
function surface(tris){
  const vertices=[],normals=[],uv=[],indices=[];
  for(const [a,b,c] of tris){
    const [x,y,z]=b.map((p,i)=>p-a[i]),[v,w,u]=c.map((p,i)=>p-a[i]);
    const norm=[y*u-z*w,z*v-x*u,x*w-y*v];
    const mag=Math.hypot(...norm);
    const n=norm.map((p)=>p/mag);
    for(const p of [a,b,c]){
      indices.push(vertices.length/3);
      vertices.push(...p);
      normals.push(...n);
      uv.push(0,0);
    }
  }
  return geometryData(vertices,normals,uv,indices);
}
function mountain(width,height,lean,phase){
  const sides=13;
  const layers=[
    Array.from({length:sides},(_,i)=>{
      const az=i*2*Math.PI/sides+phase;
      const skirt=.94+.17*Math.sin(i*2.56+phase);
      return [width*Math.cos(az)*skirt,-.15,width*Math.sin(az)*skirt*.60];
    }),
    Array.from({length:sides},(_,i)=>{
      const az=i*2*Math.PI/sides+phase;
      const line=.51+.19*Math.sin(i*2.32+phase);
      return [width*Math.cos(az)*line+lean*.5,height*(.43+.20*Math.sin(i*2.48)),width*Math.sin(az)*line*.60];
    }),
    Array.from({length:sides},(_,i)=>{
      const az=i*2*Math.PI/sides+phase;
      const line=.20+.053*Math.cos(i*2.37);
      return [width*Math.cos(az)*line+lean*.79,height*(.72+.18*Math.cos(i*2.29+phase)),width*Math.sin(az)*line*.57];
    }),
  ];
  const rock=[],snow=[],tip=[lean,height,width*.030];
  for(let i=0;i<sides;i++){
    const j=(i+1)%sides;
    rock.push([layers[0][i],layers[1][i],layers[0][j]],[layers[0][j],layers[1][i],layers[1][j]]);
    const middle=i%4===0?rock:snow;
    middle.push([layers[1][i],layers[2][i],layers[1][j]],[layers[1][j],layers[2][i],layers[2][j]]);
    snow.push([layers[2][i],tip,layers[2][j]]);
  }
  return [surface(rock),surface(snow)];
}

export function createObservatory(engine,shadows){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const ground=finish('#8eabbe',.88);
  const backRock=finish('#9bb1c5',.85);
  const backSnow=finish('#d0dce6',.87);
  const frontRock=finish('#849db2',.79);
  const frontSnow=finish('#d3e1e8',.83);
  const snow=finish('#d8e3e9',.86);
  const rock=finish('#748b99',.78);
  const base=finish('#394550',.50);
  const blue=finish('#556f89',.46);
  const panel=finish('#798da4',.45);
  const navy=finish('#374f66',.47);
  const seal=finish('#354353',.65);
  const chromed=finish('#c4c9cc',.29,.71);
  const bronze=finish('#ac7d63',.35,.72);
  const brass=finish('#d3ac84',.34,.54);
  const cold=finish('#adc5d3',.43);
  const ink=finish('#d9d1c3',.52);
  const cache=new WeakMap();
  const light=installLight(engine);
  const fixed={cast:true};
  let meshes=0,seed=32740;
  function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  function mount(data,material,at,{parent,rotation,cast}={}){
    if(!cache.has(data))cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const block=(w,h,d,r)=>roundedBoxGeometry(w,h,d,3,r);
  const box=(dims,r,mat,at,options)=>mount(block(...dims,r),mat,at,options);
  const disc=(r,d,mat,at,options)=>mount(cylinderGeometry(r,r,d,52,1),mat,at,options);
  const ring=(r0,r1,d,b,mat,at,options)=>mount(turnedRing(r0,r1,d,b),mat,at,options);

  box([68,.07,68],.017,ground,[0,-.173,0]);
  // Two offset ridgelines let the close landscape fall away behind the instrument.
  const peaks=[
    [-4.95,-4.15,1.49,1.55,-.38,.17],[-2.73,-4.25,1.86,2.13,.29,.28],
    [-.19,-4.25,1.71,1.79,-.33,.07],[2.12,-4.33,1.63,2.18,.26,.44],[4.33,-4.10,1.81,1.85,.47,.18],
    [-3.42,-2.62,1.38,1.19,.18,.47],[-1.48,-2.61,1.22,1.05,-.27,.21],
    [.102,-2.89,1.26,1.23,-.13,.16],[2.27,-2.74,1.55,1.38,.31,.02],[4.20,-2.71,1.42,1.52,-.18,.27],
  ];
  peaks.forEach(([x,z,w,h,lean,phase],i)=>{
    const [r,s]=mountain(w,h*(i<5?.39:.46),lean,phase);
    mount(r,i<5?backRock:frontRock,[x,-.104,z]);
    mount(s,i<5?backSnow:frontSnow,[x,-.104,z]);
  });

  const foundation=latheGeometry([[0,-.080],[.62,-.080],[.665,-.046],[.665,-.022],[.637,.006],[0,.006]],
    11,Math.PI/18);
  mount(foundation,rock,[0,0,0],fixed).setScale([1.40,1,1.05]);
  box([1.611,.046,.858],.022,snow,[0,.003,-.009],fixed);
  box([1.508,.060,.748],.024,base,[0,.038,.006],fixed);
  box([1.482,.014,.718],.005,bronze,[0,.071,.006]);
  box([1.452,.020,.696],.008,panel,[0,.084,.006],fixed);
  const fragment=icosahedronGeometry(1,0,false);
  for(let i=0;i<12;i++){
    const a=i*Math.PI/6;
    mount(fragment,i%4===0?rock:snow,[.821*Math.sin(a),.010,.474*Math.cos(a)],{rotation:yaw(rand()*Math.PI)})
      .setScale([.021+rand()*.057,.014+rand()*.031,.041+rand()*.052]);
  }

  const [px,py,pz]=prismCenter;
  box([.409,.025,.378],.011,navy,[px,.102,pz+.022],fixed);
  disc(.170,.041,base,[px,.126,pz],fixed);
  ring(.110,.161,.011,.0027,chromed,[px,.150,pz]);
  disc(.112,.027,blue,[px,.160,pz],fixed);
  disc(.108,.014,bronze,[px,.180,pz]);
  const cradle=latheGeometry([
    [.126,-.011],[.148,-.011],[.153,-.004],[.153,.012],[.148,.018],[.127,.018],[.126,.011],[.126,-.011],
  ],72,Math.PI/12,Math.PI*1.62);
  mount(cradle,bronze,[px,py-prismHeight/2-.007,pz]);
  const shard=engine.createMesh().setPosition(prismCenter);
  light.prism(shard);

  // Graduated arc carries the current source visually as incidence changes.
  const fixedEntry=tracePrism(minAt()).entry;
  const pivot=[px+fixedEntry[0],.098,pz+fixedEntry[1]];
  const track=latheGeometry([
    [.247,-.016],[.309,-.016],[.314,-.009],[.314,.004],[.305,.013],
    [.250,.013],[.246,.008],[.247,-.016],
  ],76,164*rad,52*rad);
  mount(track,navy,pivot,fixed);
  const tick=block(.003,.0019,.020,.0006);
  for(let j=0;j<13;j++){
    const a=(166+j*4)*rad;
    mount(tick,j%3===0?ink:bronze,[pivot[0]+.301*Math.sin(a),.112,pivot[2]+.301*Math.cos(a)],{rotation:yaw(a)});
  }
  const carriage=engine.createMesh();
  const at={parent:carriage};
  box([.122,.024,.101],.010,navy,[0,.122,0],at);
  box([.062,.128,.064],.016,blue,[0,.190,0],at);
  disc(.049,.170,base,[0,.256,0],{parent:carriage,rotation:facing});
  for(let i=0;i<5;i++)ring(.048,.054,.007,.002,bronze,[0,.256,-.043+i*.017],{parent:carriage,rotation:facing});
  ring(.018,.050,.025,.003,chromed,[0,.256,.076],{parent:carriage,rotation:facing});
  const lamp=engine.createMesh(carriage).setPosition([0,.256,.091]);
  light.plate(lamp,.020,4);

  // Calibrated circular sky viewer on a sloped, ribbed aluminum pedestal.
  const screen=engine.createMesh().setPosition(skyCenter).setQuaternion(tilt);
  const front={parent:screen};
  const [sx,sy,sz]=skyCenter;
  box([.406,.040,.296],.017,navy,[sx,.116,sz+.023],fixed);
  box([.163,.201,.124],.024,blue,[sx,.225,sz-.052],fixed);
  box([.283,.057,.117],.015,base,[sx,.195,sz-.045],fixed);
  const caseDisk=disc(.248,.078,navy,[0,0,-.068],{parent:screen,rotation:facing});
  shadows.add(caseDisk,{static:true});
  ring(.211,.247,.038,.006,chromed,[0,0,-.022],{parent:screen,rotation:facing});
  ring(.203,.224,.013,.0033,bronze,[0,0,.002],{parent:screen,rotation:facing});
  disc(.204,.016,seal,[0,0,-.003],{parent:screen,rotation:facing});
  const face=engine.createMesh(screen).setPosition([0,0,.008]);
  light.plate(face,.2025,3);
  const screw=cylinderGeometry(.0066,.0066,.006,20,1);
  for(let i=0;i<8;i++){
    const a=(i+.5)*Math.PI/4;
    mount(screw,brass,[.232*Math.cos(a),.232*Math.sin(a),-.001],{parent:screen,rotation:facing});
  }
  box([.092,.014,.018],.004,blue,[0,-.247,-.012],front);
  box([.037,.004,.002],.001,ink,[0,-.244,-.002],front);
  box([.148,.006,.058],.003,seal,[.035,.098,.232]);
  box([.102,.0018,.004],.0007,brass,[.027,.103,.239]);
  box([.071,.0017,.002],.0006,ink,[.039,.102,.222]);

  const beams=Array.from({length:5},(_,i)=>{
    const part=engine.createMesh();
    light.beam(part,i<3?0:1);
    return part;
  });
  function beam(anchor,from,to,width){
    const dx=to[0]-from[0],dz=to[2]-from[2];
    anchor.setPosition(from).setQuaternion(yaw(Math.atan2(dx,dz))).setScale([width,width,Math.hypot(dx,dz)]);
  }
  return {
    meshes:meshes+8,
    ready:light.ready,
    dispose:light.dispose,
    update(ray){
      const world=([x,z])=>[px+x,.256,pz+z];
      const add=(point,dir,t)=>point.map((part,i)=>part+t*dir[i]);
      const entry=world(ray.entry),exit=world(ray.exit);
      const start=world(add(ray.entry,ray.inDir,-sourceRange));
      const startAngle=Math.atan2(ray.inDir[0],ray.inDir[1]);
      carriage.setPosition([start[0]-ray.inDir[0]*.091,0,start[2]-ray.inDir[1]*.091]).setQuaternion(yaw(startAngle));
      beam(beams[0],start,entry,.011);
      beam(beams[1],entry,exit,.012);
      beam(beams[2],exit,world(add(ray.exit,ray.outDir,.305)),.011);
      beam(beams[3],entry,world(add(ray.entry,[Math.cos(Math.PI/6),Math.sin(Math.PI/6)],-.092)),.005);
      beam(beams[4],exit,world(add(ray.exit,[0,1],.094)),.005);
      light.update(ray.deviation);
    },
  };
}
