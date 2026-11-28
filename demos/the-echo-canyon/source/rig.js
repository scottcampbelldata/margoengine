import { PbrMaterial } from '@margoengine/core';
import { cylinderGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { pointAlong, source } from './model.js';
import { makeCanyon } from './terrain.js';

export function makeSurvey(engine) {
  const floorHeight=makeCanyon(engine);
  const coat=(color,roughness=.68,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const guide=[coat('#fff2cc',.58),coat('#f4a577',.58),coat('#a6e1fa',.58)];
  const bead=[coat('#fff3d9',.37),coat('#ffb684',.42),coat('#b5eeff',.41)];
  const metal=coat('#898a80',.40,1), night=coat('#394750',.70), gold=coat('#d5a174',.39,1);
  function node(name,at,parent=null){
    const x=engine.createMesh(parent).setPosition(at);
    x.name=name;
    return x;
  }
  function mesh(name,m,paint,at,parent=null){
    return node(name,at,parent).setGeometry('uvs' in m?toGeometry(m):m).setMaterial(paint);
  }

  const cylinder=(r,h,sides=24)=>toGeometry(cylinderGeometry(r,r,h,sides));
  const pathRod=cylinder(.31,1,10), tripodLeg=cylinder(.20,1,10);
  const dot=toGeometry(sphereGeometry(1.03,16,12));
  const endpoint=toGeometry(sphereGeometry(.52,14,10));
  const collar=toGeometry(roundedBoxGeometry(1.4,.94,1.08,2,.16));

  function orient(mesh,a,b) {
    const delta=b.map((x,i)=>x-a[i]),length=Math.hypot(...delta),projected=Math.hypot(delta[0],delta[2]);
    mesh.setPosition(a.map((x,i)=>(x+b[i])*.5)).setScale([1,length,1]);
    if(projected>1e-7) {
      const axis=[delta[2]/projected,0,-delta[0]/projected];
      mesh.setQuaternion(axisAngleToQuaternion(axis,Math.acos(delta[1]/length)));
    }
  }

  function tripod(name,at,accent){
    const [x,y,z]=at,ground=floorHeight(x,z);
    const root=node(name,at);
    const colors=[accent,metal,metal];
    for(let j=0;j<3;j++){
      const angle=Math.PI*2*j/3;
      const foot=[x+1.56*Math.cos(angle),ground+.07,z+1.56*Math.sin(angle)];
      const cap=mesh('Survey tripod foot',cylinder(.29,.13,8),night,foot);
      cap.receiveShadow=false;
      orient(mesh('Adjustable tripod leg',tripodLeg,colors[j],[0,0,0]),[x,y-.43,z],foot);
    }
    mesh('Field receiver housing',collar,night,[0,0,0],root);
    mesh('Instrument shoulder',cylinder(.64,.28,14),accent,[0,.46,0],root);
    return root;
  }

  tripod('Pulse source',source,gold);
  mesh('Source location',endpoint,guide[0],source);
  const receiver=node('Receiving station',[0,0,0]);
  const mast=mesh('Receiver antenna',cylinder(.25,3.0),metal,[0,-1.54,0],receiver);
  mast.receiveShadow=false;
  mesh('Receiver shell',collar,night,[0,.01,0],receiver);
  mesh('Warm receiver marker',endpoint,gold,[0,.65,0],receiver);
  mesh('Receiver footing',cylinder(.90,.21,12),night,[0,-3.12,0],receiver);

  const paths=Array.from({length:3},(_,i)=>({
    guides:Array.from({length:i?2:1},()=>mesh('Travel-path guide',pathRod,guide[i],[0,0,0])),
    marker:i?mesh('Specular bounce marker',endpoint,guide[i],[0,0,0]):null,
    pulse:mesh('Travelling acoustic pulse',dot,bead[i],[0,0,0]),
  }));
  let current;
  return {
    configure(measurement) {
      current=[measurement.direct,...measurement.reflected];
      receiver.setPosition(measurement.receiver);
      for(const [i,path] of current.entries()){
        const r=paths[i];
        r.guides.forEach((item,j)=>orient(item,path.points[j],path.points[j+1]));
        r.marker?.setPosition(path.points[1]);
      }
    },
    pose(distance) {
      for(const [i,r] of paths.entries()){
        const path=current[i];
        r.pulse.visible=distance>=0&&distance<=path.length;
        if(r.pulse.visible)r.pulse.setPosition(pointAlong(path.points,distance));
      }
    },
  };
}


