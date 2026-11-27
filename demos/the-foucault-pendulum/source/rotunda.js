import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { amplitude, bobRadius, cableLength, pivotHeight } from './model.js';

const tau = Math.PI * 2;
const up = [0,1,0];
const point = (theta, radius, height) => [Math.sin(theta) * radius,height,-Math.cos(theta) * radius];

function stoneCourse(radius, height, start, end, thickness, roomFacing) {
  const positions = [], normals = [], indices = [];
  const segments = Math.ceil((end-start)*26);
  for (let i=0; i<=segments; i++) {
    const angle = start+(end-start)*i/segments;
    const [x,,z] = point(angle,radius,height);
    positions.push(x,height,z,x,height+thickness,z);
    const sign = roomFacing ? -1 : 1;
    normals.push(sign*x/radius,0,sign*z/radius,sign*x/radius,0,sign*z/radius);
    if (i>0) {
      const v=i*2;
      if (roomFacing) indices.push(v-2,v,v-1,v,v+1,v-1);
      else indices.push(v-2,v-1,v,v,v-1,v+1);
    }
  }
  return new Geometry(positions,normals,indices);
}

function archBand(radius, height, theta, interval, width) {
  const positions = [], normals = [], indices = [];
  const segments = 42, limit = interval/2;
  for (let i=0; i<=segments; i++) {
    const angle = Math.PI*i/segments;
    for (const edge of [0,width]) {
      const offset = Math.cos(angle)*(limit+edge/radius);
      positions.push(...point(theta+offset,radius,height+Math.sin(angle)*(limit*radius+edge)));
      normals.push(-Math.sin(theta+offset),0,Math.cos(theta+offset));
    }
    if (i>0) {
      const v=i*2;
      indices.push(v-2,v,v-1,v,v+1,v-1);
    }
  }
  return new Geometry(positions,normals,indices);
}

function topRing(inner, outer, y) {
  const positions = [], normals = [], indices = [];
  for (let i=0; i<=160; i++) {
    const theta=tau*i/160;
    positions.push(...point(theta,inner,y),...point(theta,outer,y));
    normals.push(0,1,0,0,1,0);
    if(i>0) {
      const v=i*2;
      indices.push(v-2,v-1,v,v,v-1,v+1);
    }
  }
  return new Geometry(positions,normals,indices);
}

export function makeRotunda(engine, shadows) {
  const finish = (color, roughness=.68, metalness=0) => new PbrMaterial({color,roughness,metalness});
  const plaster = ['#a99679','#b3a086','#a3927a','#ada18c','#b3a897'].map(color=>finish(color,.87));
  const cut = finish('#cfc0a3',.79);
  const stone = finish('#777568',.81);
  const platform = finish('#343c38',.59);
  const blue = finish('#46534b',.48);
  const green = finish('#addfc7',.50);
  const brass = finish('#e4b375',.35,.68);
  const bronze = finish('#73513c',.49,.63);
  const steel = finish('#a8afaa',.44,.55);
  const charcoal = finish('#39443d',.53);
  const inlay = finish('#bfaa84',.69);
  const mesh = (geometry, material, at=[0,0,0], parent=null) =>
    engine.createMesh(parent).setGeometry(geometry).setMaterial(material).setPosition(at);
  const cylinder = (radius,height,segments=128) => toGeometry(cylinderGeometry(radius,radius,height,segments));

  mesh(cylinder(12,.32),stone,[0,-.18,0]);
  mesh(cylinder(2.25,.20),charcoal,[0,-.142,0]);
  mesh(cylinder(2.16,.15),bronze,[0,-.099,0]);
  mesh(cylinder(2.12,.15),platform,[0,-.076,0]);
  mesh(topRing(1.977,2.086,.004),blue);
  for (const [r,w] of [[.33,.006],[.85,.006],[1.35,.008],[1.79,.012],[1.936,.012],[1.975,.005],[2.087,.014]]) {
    mesh(topRing(r,r+w,.006),inlay);
  }
  for (let i=0;i<72;i++) {
    const theta=tau*i/72, major=i%6===0;
    const tick=mesh(box(major?.027:.012,.007,major?.156:.101),major?brass:inlay,point(theta,1.919,.009));
    tick.setQuaternion(axisAngleToQuaternion(up,-theta));
  }
  const diamond = box(.105,.008,.105);
  for (let i=0;i<4;i++) {
    const theta=Math.PI*i/2;
    mesh(diamond,i===0?brass:inlay,point(theta,2.23,.012)).setQuaternion(axisAngleToQuaternion(up,Math.PI/4));
    mesh(box(.012,.008,2.92),inlay,point(theta,3.71,.009)).setQuaternion(axisAngleToQuaternion(up,-theta));
  }
  for (const r of [3.11,4.48,5.05,5.24,6.85]) mesh(topRing(r,r+.018,.003),inlay);

  const wallRadius=5.48, bays=10, interval=tau/bays;
  const spring=2.1, opening=.445;
  for (let bay=0;bay<bays;bay++) {
    const theta=interval*bay;
    const openStart=theta-opening/2, openEnd=theta+opening/2;
    const supports=[theta-interval/2,theta+interval/2];
    for(let row=0;row<12;row++) {
      const bottom=row*.42+.004, top=bottom+.408;
      const finish=plaster[(row*3+bay*7)%plaster.length];
      const gapTheta=row>=8?0:row>=5?opening*.5*Math.sqrt(Math.max(0,1-((bottom-spring)/1.23)**2)):opening/2;
      if(gapTheta>0) {
        mesh(stoneCourse(wallRadius,bottom,supports[0]+.0015,theta-gapTheta,top-bottom,true),finish);
        mesh(stoneCourse(wallRadius,bottom,theta+gapTheta,supports[1]-.0015,top-bottom,true),finish);
      } else {
        mesh(stoneCourse(wallRadius,bottom,supports[0]+.0015,supports[1]-.0015,top-bottom,true),finish);
      }
    }
    mesh(archBand(wallRadius-.053,spring,theta,opening,.178),cut);
    for(const angle of [openStart,openEnd]) {
      const jamb=mesh(box(.166,spring,.27),cut,point(angle,wallRadius-.020,spring/2));
      jamb.setQuaternion(axisAngleToQuaternion(up,-angle));
    }
    const angle=theta+interval/2;
    const footing=mesh(box(.47,.28,.52),cut,point(angle,wallRadius-.19,.14));
    footing.setQuaternion(axisAngleToQuaternion(up,-angle));
    const column=mesh(toGeometry(cylinderGeometry(.135,.187,3.97,24)),plaster[1],point(angle,wallRadius-.29,2.235));
    const collar=mesh(cylinder(.25,.14,28),cut,point(angle,wallRadius-.29,4.138));
    shadows.add(column,{static:true});
    shadows.add(collar,{static:true});
  }
  for(const [y,w,h] of [[.03,.24,.22],[3.66,.05,.042],[4.23,.12,.15],[4.39,.21,.12],[4.53,.11,.035]]) {
    mesh(stoneCourse(wallRadius-w,y,0,tau,h,true),cut);
  }
  for (const [radius, y, h] of [[6.6,-.02,.36],[7.1,-.02,.51],[7.6,-.02,.69]]) {
    mesh(stoneCourse(radius,y,0,tau,h,false),plaster[3]);
  }

  const pivot = [0,pivotHeight,0];
  const cable = mesh(cylinder(.0075,cableLength,12),steel);
  const bob = engine.createMesh();
  const silhouette = [[0,-1],[.08,-1],[.15,-.92],[.48,-.75],[.77,-.46],[.94,-.16],[1,.07],[.93,.40],[.69,.68],[.29,.85],[.15,.91],[.12,1.1],[0,1.1]];
  const shell = mesh(toGeometry(latheGeometry(silhouette.reverse().map(([r,y])=>[r*bobRadius,y*bobRadius]),64)),brass,[0,0,0],bob);
  const equator = mesh(cylinder(bobRadius*1.004,.013,64),bronze,[0,.014,0],bob);
  mesh(cylinder(.043,.064,32),steel,[0,.251,0],bob);
  mesh(cylinder(.009,.065,20),bronze,[0,-.243,0],bob);
  shadows.add(shell, {static:false});
  shadows.add(equator, {static:false});

  const initialAxis = mesh(box(.020,.008,amplitude*2+.22),brass,[0,.016,0]);
  const movingAxis = mesh(box(.029,.007,amplitude*2+.20),green,[0,.026,0]);
  const caps = [-1,1].map(sign=>mesh(box(sign>0?.145:.084,.007,.11),green,[0,.026,sign*amplitude]));
  initialAxis.receiveShadow=false;
  movingAxis.receiveShadow=false;
  caps.forEach(cap=>{cap.receiveShadow=false;});

  return ({position,azimuth},overhead)=>{
    bob.setPosition(position);
    const delta = pivot.map((value,axis)=>value-position[axis]);
    const horizontal = Math.hypot(delta[0],delta[2]);
    cable.visible=!overhead;
    cable.setPosition(position.map((value,axis)=>(value+pivot[axis])*.5));
    cable.setQuaternion(horizontal>1e-6
      ?axisAngleToQuaternion([delta[2]/horizontal,0,-delta[0]/horizontal],Math.atan2(horizontal,delta[1]))
      :[0,0,0,1]);
    movingAxis.setQuaternion(axisAngleToQuaternion(up,-azimuth));
    caps.forEach((cap,i)=>cap.setPosition(point(azimuth+(i===0?0:Math.PI),amplitude+.043,.024))
      .setQuaternion(axisAngleToQuaternion(up,-azimuth)));
  };
}
