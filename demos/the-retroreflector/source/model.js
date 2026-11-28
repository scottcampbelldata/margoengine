import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, icosahedronGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { addScaled, aperture, directionToWorld, entry, mirrorCenter, pointToWorld, rise, subtract, unit } from './optics.js';
import { installLight } from './light.js';

const axial=axisAngleToQuaternion([1,0,0],Math.PI/2);
const yaw=(r)=>axisAngleToQuaternion([0,1,0],r);
const fixedBeacons=[[-.844,.326,-.533],[.888,.477,-.557]];

function ringShape(inner,outer,width,bevel,sides=80){
  const t=width/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

// Rotate a stock cylinder from +Y or a light guide from +Z.
function pointY(vector){
  const angle=Math.acos(Math.max(-1,Math.min(1,vector[1])));
  const run=Math.hypot(vector[0],vector[2]);
  return run>1e-10?axisAngleToQuaternion([vector[2]/run,0,-vector[0]/run],angle)
    :axisAngleToQuaternion([1,0,0],angle);
}
function pointZ(vector){
  const angle=Math.acos(Math.max(-1,Math.min(1,vector[2])));
  const run=Math.hypot(vector[0],vector[1]);
  return run>1e-10?axisAngleToQuaternion([-vector[1]/run,vector[0]/run,0],angle)
    :axisAngleToQuaternion([1,0,0],angle);
}

export function createRoad(engine,shadows,lights){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const tabletop=finish('#333e4b',.90);
  const base=finish('#313946',.64);
  const asphalt=finish('#37404b',.35);
  const puddle=finish('#363f49',.23);
  const grit=finish('#4c5053',.76);
  const shoulder=finish('#4d5350',.75);
  const concrete=finish('#7c8180',.65);
  const charcoal=finish('#343d46',.63);
  const navy=finish('#405667',.43);
  const aluminum=finish('#a3b6b7',.34,.72);
  const slate=finish('#5d7880',.40);
  const gold=finish('#b9965e',.30,.56);
  const amber=finish('#bf7845',.47);
  const orange=finish('#bd6340',.58);
  const marks=finish('#dbd6b5',.64);
  const clay=finish('#755d49',.78);
  const moss=finish('#475955',.80);
  const pine=finish('#3c524c',.73);
  const cache=new WeakMap();
  const light=installLight(engine);
  const fixed={cast:true};
  let meshes=0,seed=11583;
  function random(){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  }
  function mount(data,material,at,{parent,rotation,cast}={}){
    if(!cache.has(data))cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const block=(w,y,z,r)=>roundedBoxGeometry(w,y,z,3,r);
  const box=(dims,r,mat,at,options)=>mount(block(...dims,r),mat,at,options);
  const disc=(r,d,mat,at,options)=>mount(cylinderGeometry(r,r,d,48,1),mat,at,options);
  const ring=(r0,r1,d,b,mat,at,options)=>mount(ringShape(r0,r1,d,b),mat,at,options);
  function rod(radius,material,from,to,options){
    const d=subtract(to,from);
    return disc(radius,1,material,addScaled(from,d,.5),{...options,rotation:pointY(unit(d))})
      .setScale([1,Math.hypot(...d),1]);
  }

  // A wet survey pullout with lane markings, curb, gravel shoulder and a crash rail.
  box([42,.09,42],.02,tabletop,[0,-.185,0]);
  box([2.27,.150,1.622],.062,base,[0,-.068,-.120],fixed);
  box([2.215,.035,1.561],.015,grit,[0,.002,-.117],fixed);
  box([2.196,.037,1.003],.014,asphalt,[0,.022,.143],fixed);
  box([2.183,.070,.486],.020,shoulder,[0,.033,-.604],fixed);
  box([2.176,.061,.114],.011,concrete,[0,.067,-.407]);
  const curbLine=block(.0036,.064,.116,.001);
  for(let i=0;i<12;i++)mount(curbLine,charcoal,[-1.00+i*.179,.067,-.405]);
  for(const z of [-.288,.563])box([2.143,.003,.020],.001,marks,[0,.043,z]);
  const dash=block(.187,.003,.019,.001);
  for(let i=-3;i<=3;i++)mount(dash,marks,[i*.319,.043,.143]);
  const flake=icosahedronGeometry(1,0,false);
  for(let i=0;i<44;i++){
    const x=(random()-.5)*2.09,z=-.452-random()*.397;
    const size=.012+random()*.036;
    mount(flake,[grit,clay,moss][i%3],[x,.070,z],{rotation:yaw(random()*Math.PI)})
      .setScale([size*(.7+random()),size*.41,size]);
  }
  const rain=latheGeometry([[0,0],[.95,0],[1,.001],[0,.001]],18);
  for(let i=0;i<10;i++){
    const r=.023+random()*.074;
    mount(rain,puddle,[(random()-.5)*1.79,.0414,.49-random()*.69],{rotation:yaw((random()-.5)*.67)})
      .setScale([r*(1+random()*.82),1,r*(.37+random()*.29)]);
  }
  // A low crash barrier follows the shoulder, interrupted at the equipment bay.
  for(const x of [-.899,-.676,.66,.899]){
    box([.031,.183,.035],.007,slate,[x,.151,-.811],fixed);
    box([.054,.012,.069],.004,navy,[x,.078,-.809]);
  }
  for(const x of [-.787,.782]){
    box([.422,.047,.041],.008,slate,[x,.215,-.790],fixed);
    box([.408,.009,.049],.004,aluminum,[x,.231,-.788]);
  }
  for(const x of [-.977,-.724,.754,.964]){
    box([.011,.020,.006],.002,amber,[x,.225,-.764]);
  }
  const reed=cylinderGeometry(.005,0,.13,8,1);
  for(const x of [-.949,-.671,.685,.976]){
    for(let i=0;i<6;i++){
      const z=-.741+random()*.045;
      mount(reed,pine,[x+random()*.072,.111,z],{rotation:axisAngleToQuaternion([0,0,1],(random()-.5)*.58)})
        .setScale([1,.62+random()*.74,1]);
    }
  }

  // Roadside post, directed red-amber markers, and the open front-surface survey cube.
  const [cx,cy,cz]=mirrorCenter;
  box([.192,.032,.192],.011,concrete,[cx,.100,cz-.049],fixed);
  box([.105,.019,.103],.006,navy,[cx,.119,cz-.061]);
  box([.055,.381,.057],.014,slate,[cx,.310,cz-.069],fixed);
  box([.038,.143,.013],.004,marks,[cx,.284,cz-.038]);
  box([.038,.052,.014],.004,orange,[cx,.302,cz-.036]);
  box([.127,.066,.110],.013,navy,[cx,cy-.119,cz-.045],fixed);
  ring(.124,.146,.121,.004,navy,[cx,cy,cz-.066],{rotation:axial,cast:true});
  ring(.126,.145,.030,.005,aluminum,[cx,cy,cz+.004],{rotation:axial,cast:true});
  ring(.118,.132,.019,.004,amber,[cx,cy,cz+.017],{rotation:axial});
  disc(.123,.013,charcoal,[cx,cy,cz-.092],{rotation:axial});
  const edges=Array.from({length:3},(_,i)=>[0,0,0].map((_,j)=>i===j?aperture:0));
  const corners=edges.map(pointToWorld);
  const vertex=pointToWorld([0,0,0]);
  const mirror=engine.createMesh();
  for(let face=0;face<3;face++){
    const ids=[(face+1)%3,(face+2)%3];
    const normal=directionToWorld([0,0,0].map((_,i)=>i===face?1:0));
    light.mirror(mirror,[vertex,...ids.map((i)=>corners[i])],normal,face);
    rod(.0034,aluminum,corners[ids[0]],corners[ids[1]]);
    rod(.0021,slate,vertex,corners[face]);
    const point=corners[face];
    disc(.0089,.007,face===0?amber:face===1?slate:aluminum,[point[0],point[1],point[2]+.004],{rotation:axial});
  }

  // Work lamps and cones on the dark shoulder.
  const lightHeads=[];
  for(const [i,position] of fixedBeacons.entries()){
    const [x,y,z]=position;
    box([.086,.018,.084],.008,navy,[x,.090,z],fixed);
    rod(.015,navy,[x,.097,z],[x,y-.014,z],fixed);
    box([.098,.030,.083],.009,navy,[x,y-.004,z],fixed);
    const anchor=engine.createMesh().setPosition([x,y-.016,z+.021])
      .setQuaternion(axisAngleToQuaternion([1,0,0],.81));
    light.plate(anchor,.037,i===0?0:2);
    lightHeads.push({position:[x,y-.014,z+.023],direction:i===0?[.31,-.62,.65]:[-.48,-.62,.61],
      innerAngle:.33,outerAngle:.99,range:1.9,color:i===0?[1,.51,.21]:[.51,.73,1],intensity:i===0?1.40:1.89});
  }
  const coneBase=block(.095,.014,.089,.008);
  for(const [x,z] of [[-.834,-.235],[.609,-.240],[.801,-.174]]){
    mount(coneBase,charcoal,[x,.049,z],fixed);
    mount(cylinderGeometry(.017,.035,.110,28,1),orange,[x,.110,z],fixed);
    mount(cylinderGeometry(.023,.026,.019,28,1),marks,[x,.111,z]);
  }

  // Survey lamp and its receiving plane share the same translating instrument head.
  const tripod=engine.createMesh();
  const surveyHead=engine.createMesh();
  const received=engine.createMesh();
  const feetY=.051-pointToWorld(entry)[1]-rise;
  for(let i=0;i<3;i++){
    const a=i*(Math.PI*2/3)+.29;
    const tip=[.166*Math.sin(a),feetY,.166*Math.cos(a)];
    const root=[tip[0]*.29,-.126,tip[2]*.29];
    const knee=addScaled(root,subtract(tip,root),.66);
    rod(.015,gold,root,knee,{parent:tripod});
    rod(.0088,aluminum,knee,tip,{parent:tripod});
    box([.050,.022,.047],.007,charcoal,tip,{parent:tripod});
    box([.029,.062,.036],.007,navy,knee,{parent:tripod,rotation:yaw(a)});
  }
  disc(.055,.051,navy,[0,-.104,0],{parent:tripod});
  disc(.044,.022,gold,[0,-.077,0],{parent:tripod});
  box([.298,.239,.058],.015,navy,[0,0,-.029],{parent:surveyHead});
  box([.268,.197,.015],.010,slate,[0,0,-.058],{parent:surveyHead});
  box([.173,.103,.012],.005,charcoal,[0,.026,-.067],{parent:surveyHead});
  box([.150,.077,.005],.003,navy,[0,.026,-.073],{parent:surveyHead});
  const status=engine.createMesh(surveyHead).setPosition([.053,-.057,-.069]);
  light.plate(status,.008,1);
  const rearFin=block(.017,.025,.004,.001);
  for(let i=0;i<4;i++)mount(rearFin,gold,[-.091+i*.021,-.060,-.069],{parent:surveyHead});
  box([.265,.208,.014],.009,aluminum,[0,0,-.005],{parent:surveyHead});
  box([.250,.191,.010],.007,slate,[0,0,.001],{parent:surveyHead});
  for(const x of [-.117,.117])for(const y of [-.086,.086])
    disc(.0058,.003,gold,[x,y,.007],{parent:surveyHead,rotation:axial});
  ring(.011,.022,.011,.002,gold,[0,0,.006],{parent:surveyHead,rotation:axial});
  const lampHead=engine.createMesh(surveyHead).setPosition([0,0,.015]);
  light.plate(lampHead,.014,0);
  light.plate(received,.017,2);

  const beamParts=Array.from({length:6},(_,i)=>{
    const anchor=engine.createMesh();
    light.beam(anchor,i===0?0:i===5?2:1);
    return anchor;
  });
  const bounceDots=Array.from({length:3},(_,i)=>{
    const anchor=engine.createMesh();
    light.plate(anchor,.0125,3+i);
    return anchor;
  });
  function beam(anchor,from,to,w){
    const d=subtract(to,from);
    anchor.setPosition(from).setQuaternion(pointZ(unit(d))).setScale([w,w,Math.hypot(...d)]);
  }

  return {
    meshes:meshes+16,
    ready:light.ready,
    update(angle,result,detail){
      const source=result.lamp;
      const apertureIn=pointToWorld(entry);
      const apertureOut=pointToWorld(result.exit);
      const inbound=directionToWorld(result.incoming);
      const aim=pointZ(inbound);
      tripod.setPosition(source).setQuaternion(yaw(-angle*Math.PI/180));
      surveyHead.setPosition(addScaled(source,inbound,-.015)).setQuaternion(aim);
      received.setPosition(addScaled(result.receiver,inbound,.0014)).setQuaternion(aim);
      const nearLight=detail?addScaled(apertureIn,inbound,-.115):source;
      const nearReceiver=detail?addScaled(apertureOut,result.outgoing,.115):result.receiver;
      const optical=[nearLight,apertureIn,...result.hits.map((hit)=>pointToWorld(hit.position)),apertureOut,nearReceiver];
      for(let i=0;i<beamParts.length;i++){
        beam(beamParts[i],optical[i],optical[i+1],detail?(i===0||i===5?.0058:.0052):.0097);
      }
      for(const hit of result.hits){
        const front=addScaled(pointToWorld(hit.position),[0,0,1],.0006);
        bounceDots[hit.axis].setPosition(front);
      }
      lights.setLights([
        ...lightHeads,
        {position:addScaled(source,inbound,.035),direction:[inbound[0],inbound[1]-.32,inbound[2]],
          innerAngle:.38,outerAngle:1.01,range:2.20,color:[1,.73,.41],intensity:2.7},
      ]);
    },
  };
}
