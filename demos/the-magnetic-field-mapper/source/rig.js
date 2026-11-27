import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { measure, sensorY, sphereRadius, sphereY } from './model.js';

const Y = [0,1,0], Z = [0,0,1];

function arrow(direction) {
  const points = [[0,-.0023],[direction*.0118,0],[0,.0023]];
  if (direction < 0) points.reverse();
  const positions = [], normals = [], indices = [];
  function face(coords,normal) {
    const first=positions.length/3;
    for(const coord of coords) {
      positions.push(...coord);
      normals.push(...normal);
    }
    indices.push(first,first+1,first+2);
    if(coords.length===4) indices.push(first,first+2,first+3);
  }
  const low = -.00065, hi = .00065;
  face([...points].reverse().map(([x,z])=>[x,hi,z]),[0,1,0]);
  face(points.map(([x,z])=>[x,low,z]),[0,-1,0]);
  for(let i=0;i<3;i++){
    const [x,z]=points[i], [a,b]=points[(i+1)%3];
    const dx=a-x,dz=b-z,span=Math.hypot(dx,dz);
    face([[x,low,z],[x,hi,z],[a,hi,b],[a,low,b]],[dz/span,0,-dx/span]);
  }
  return new Geometry(positions,normals,indices);
}

function halfSphere(top) {
  const profile=[];
  for(let i=0;i<=28;i++){
    const angle=(top?i:i-28)*Math.PI/56;
    profile.push([Math.cos(angle)*sphereRadius, Math.sin(angle)*sphereRadius]);
  }
  return latheGeometry(profile,64);
}

export function buildBoard(engine, shadows) {
  const coat=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const room=coat('#526c66',.86), foot=coat('#353c36',.75), green=coat('#365950',.42);
  const plate=coat('#526e63',.66), brass=coat('#cbb084',.34,1), bronze=coat('#9b724a',.40,1);
  const alloy=coat('#afbbb3',.29,1), polished=coat('#c5c2ae',.25,1);
  const ceramic=coat('#e5d8b3',.62), mint=coat('#cbdfc5',.45);
  const red=coat('#b84c42',.37), blue=coat('#4c7986',.41);
  const centering=coat('#45665e',.55);
  function node(name,position,parent=null){
    const mesh=engine.createMesh(parent).setPosition(position);
    mesh.name=name;
    return mesh;
  }
  function part(name,source,finish,position,parent=null,cast=true,dynamic=!!parent){
    const mesh=node(name,position,parent).setGeometry('uvs' in source?toGeometry(source):source).setMaterial(finish);
    if(cast) shadows.add(mesh,{static:!dynamic});
    return mesh;
  }
  const block=(name,size,r,finish,position,parent=null,casts=true)=>
    part(name,roundedBoxGeometry(...size,2,r),finish,position,parent,casts);
  const pin=(name,r,h,finish,position,parent=null,sides=24,casts=true)=>
    part(name,cylinderGeometry(r,r,h,sides),finish,position,parent,casts);

  part('Studio sweep',box(30,.06,30),room,[0,-.047,0],null,false);
  block('Ebonized lower frame',[.558,.026,.383],.010,foot,[0,0,0]);
  block('Enamel instrument case',[.546,.023,.372],.010,green,[0,.014,0]);
  block('Inset needle bed',[.485,.013,.308],.006,plate,[0,.029,.012]);
  for(const x of [-.245,.245]){
    for(const z of [-.158,.158]){
      const screw=pin('Milled case screw',.005,.003,alloy,[x,.028,z],null,12);
      screw.setQuaternion(axisAngleToQuaternion(Y,z<0?.31:-.54));
    }
  }
  block('Bridge rail',[.437,.011,.014],.0032,bronze,[0,.111,-.139]);
  block('Rail contact face',[.436,.0018,.009],.00075,polished,[0,.117,-.139]);
  for(const x of [-.207,.207]){
    block('Rail foot casting',[.029,.096,.036],.006,green,[x,.070,-.137]);
    block('Rail mounting shoulder',[.034,.010,.041],.0025,alloy,[x,.112,-.138]);
    for(const z of [-.151,-.124]) pin('Shoulder fastener',.0030,.0041,brass,[x,.119,z],null,6);
  }
  const magnetHalves=[toGeometry(halfSphere(true)),toGeometry(halfSphere(false))];
  function carrier(name,x,initialDirection) {
    const root=node(name,[x,0,0]);
    block('Rail slide',[.033,.021,.030],.0030,bronze,[0,.109,-.139],root);
    pin('Brass vernier lock',.0068,.009,brass,[0,.124,-.140],root,16);
    block('Enamel arm',[.015,.014,.125],.0031,green,[0,.108,-.071],root);
    pin('Pivot suspension pin',.0041,.012,polished,[0,.104,0],root);
    const sphere=node('Magnetic axis',[0,sphereY,0],root);
    part('North hemisphere',magnetHalves[0],red,[0,0,0],sphere);
    part('South hemisphere',magnetHalves[1],blue,[0,0,0],sphere);
    sphere.setQuaternion(axisAngleToQuaternion(Z,-initialDirection*Math.PI/2));
    return {root,sphere};
  }
  const left=carrier('Left magnet carrier',-.085,1);
  const right=carrier('Right magnet carrier',.085,1);
  const trim=toGeometry(latheGeometry([[.0099,.038],[.0129,.038],[.014,.040],[.014,.047],[.0133,.0495],
    [.0101,.0495],[.0098,.047],[.0099,.038]],24));
  const insert=toGeometry(cylinderGeometry(.0108,.0108,.0025,24));
  const head=toGeometry(cylinderGeometry(.0020,.0020,.0025,14));
  const needles=[arrow(1),arrow(-1)];
  const compasses=[];
  for(let row=-3;row<=3;row++){
    for(let col=-5;col<=5;col++){
      const x=col*.039,z=row*.039;
      const center=col===0&&row===0;
      part('Knurled compass bezel',trim,center?alloy:bronze,[x,0,z],null,false);
      part('Ivory compass face',insert,center?mint:ceramic,[x,.0465,z],null,false);
      const gimbal=node('Compass needle pivot',[x,sensorY,z]);
      const tip=part('Compass north needle',needles[0],red,[0,0,0],gimbal,false);
      const heel=part('Compass south needle',needles[1],blue,[0,0,0],gimbal,false);
      part('Compass axle cap',head,center?centering:brass,[0,.0012,0],gimbal,false);
      compasses.push({ gimbal, tip, heel, x, z, balanced: false });
    }
  }
  return {
    pose(separation,orientation) {
      left.root.setPosition([-separation/2,0,0]);
      right.root.setPosition([separation/2,0,0]);
      right.sphere.setQuaternion(axisAngleToQuaternion(Z,-orientation*Math.PI/2));
      for(const compass of compasses) {
        const { gimbal, tip, heel, x, z } = compass;
        const field=measure(x,z,separation,orientation);
        const compassScale=Math.min(1,field.horizontal/.000020);
        const pointerScale=[compassScale*.82+.18,1,compassScale*.77+.23];
        gimbal.setQuaternion(axisAngleToQuaternion(Y,field.bearing));
        tip.setScale(pointerScale);
        heel.setScale(pointerScale);
        const balanced = compassScale === 0;
        if (balanced !== compass.balanced) {
          tip.setMaterial(balanced ? centering : red);
          heel.setMaterial(balanced ? centering : blue);
          compass.balanced = balanced;
        }
      }
      return measure(0,0,separation,orientation);
    },
  };
}


