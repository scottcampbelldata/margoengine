import { Geometry, PbrMaterial } from '@margoengine/core';
import { cylinderGeometry, latheGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { floorY, fountainPath, pitch, planeZ } from './path.js';

function studioSweep() {
  const profiles=[[10,-.05,0],[-1.85,-.05,0]];
  const radius=2.8;
  for(let i=1;i<=28;i++){
    const angle=Math.PI*i/56;
    profiles.push([-1.85-radius*Math.sin(angle),-.05+radius*(1-Math.cos(angle)),angle]);
  }
  profiles.push([-1.85-radius,10,Math.PI/2]);
  const positions=[],normals=[],indices=[];
  for(const [i,[z,y,theta]] of profiles.entries()){
    for(const x of [-12,12]){
      positions.push(x,y,z);
      normals.push(0,Math.cos(theta),Math.sin(theta));
    }
    if(i>0){
      const v=i*2;
      indices.push(v-2,v-1,v+1,v-2,v+1,v);
    }
  }
  return new Geometry(positions,normals,indices);
}

export function buildApparatus(engine,shadows) {
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const room=finish('#435863',.90), iron=finish('#364952',.56), dark=finish('#303741',.72);
  const enamel=finish('#344e65',.39), steel=finish('#a6b5b8',.31,1), chrome=finish('#c6d1ce',.25,1);
  const brass=finish('#c09765',.32,1), bronze=finish('#95734f',.42,1);
  const ceramic=finish('#ede0bf',.58), inset=finish('#4b5658',.70);
  const marker=finish('#d2a465',.47), riseMark=finish('#c68053',.42);
  const colorBead=finish('#efbb7d',.28,1);
  function node(name,position,parent=null) {
    const mesh=engine.createMesh(parent).setPosition(position);
    mesh.name=name;
    return mesh;
  }
  function mesh(name,geometry,coat,position,parent=null,cast=true) {
    const item=node(name,position,parent).setGeometry('uvs' in geometry?toGeometry(geometry):geometry).setMaterial(coat);
    if(cast)shadows.add(item,{static:!parent});
    return item;
  }
  const block=(name,dims,r,coat,position,parent=null,cast=true)=>
    mesh(name,roundedBoxGeometry(...dims,2,r),coat,position,parent,cast);
  const bolt=(name,r,h,coat,position,parent=null,sides=16,cast=true)=>
    mesh(name,cylinderGeometry(r,r,h,sides),coat,position,parent,cast);
  const profile=(name,points,coat,position,parent=null,phi=0,span=2*Math.PI)=>
    mesh(name,latheGeometry(points,72,phi,span),coat,position,parent);
  mesh('Laboratory floor',studioSweep(),room,[0,0,0],null,false);
  block('Cast floor pedestal',[1.16,.066,.72],.024,dark,[0,-.005,0]);
  block('Enamel deck',[1.10,.027,.66],.011,enamel,[0,.039,0]);
  for(const x of [-.468,.468])for(const z of [-.258,.258]){
    bolt('Floor deck countersunk washer',.022,.004,brass,[x,.055,z],null,24);
    bolt('Steel hex fastener',.014,.010,steel,[x,.06,z],null,6);
  }

  const supply=node('Adjustable chain supply',[-.300,1.75,planeZ]);
  block('Sleeve bearing for the feed tray',[.100,.124,.080],.012,enamel,[-.095,-.148,-.111],supply);
  block('Cantilever tray support',[.255,.047,.085],.019,enamel,[-.075,-.139,-.040],supply);
  profile('Cutaway porcelain hopper',[[0,-.137],[.075,-.139],[.123,-.118],[.155,-.075],[.162,-.035],
    [.161,-.014],[.149,-.011],[.141,-.025],[.137,-.063],[.112,-.098],[.071,-.113],[0,-.114]],ceramic,
    [0,0,0],supply,.70,Math.PI*2-1.40);
  profile('Hopper retaining band',[[.146,-.052],[.158,-.052],[.163,-.047],[.163,-.031],[.158,-.025],[.151,-.025]],
    bronze,[0,0,0],supply,.70,Math.PI*2-1.40);
  profile('Collector brass rim',[[.143,-.017],[.147,-.005],[.162,-.005],[.165,-.014],[.161,-.022]],
    brass,[0,0,0],supply,.70,Math.PI*2-1.40);
  block('Vernier head lock',[.055,.036,.070],.009,bronze,[-.157,-.135,-.107],supply);
  bolt('Lock cap',.025,.018,brass,[-.156,-.110,-.107],supply,26);
  const smallBall=toGeometry(sphereGeometry(.0090,12,8));
  for(let i=0;i<60;i++){
    const angle=i*2.39996;
    const r=.111*Math.sqrt((i+.5)/60);
    const y=-.093+(.022*(1-r/.111))+.004*Math.sin(i*2.3999);
    mesh('Packed bead chain',smallBall,i%8===0?brass:steel,[r*Math.cos(angle),y,r*Math.sin(angle)],supply,false);
  }
  const uprights=node('Feed tower',[0,0,0]);
  const tube=toGeometry(cylinderGeometry(.029,.029,1,48));
  const tower=mesh('Round steel feed tower',tube,steel,[-.394,1.23,-.097],uprights);
  tower.setScale([1,2.32,1]);
  bolt('Feed tower flanged foot',.075,.038,dark,[-.394,.073,-.097],null,48);
  const towerCap = bolt('Crowned tower end cap',.034,.033,brass,[-.394,2.38,-.097],uprights,42);

  block('Catch tray bowl outer',[.692,.047,.330],.039,enamel,[.074,.077,.031]);
  block('Catch tray basin',[.649,.013,.283],.005,inset,[.074,.091,.031]);
  for(const x of [-.265,.413])block('Basin turned side lip',[.027,.039,.313],.010,steel,[x,.113,.031]);
  for(const z of [-.119,.181])block('Basin rolled lip',[.681,.028,.026],.009,steel,[.073,.102,z]);
  for(let i=0;i<44;i++){
    const x=.075+(i%11-5)*.024+ .009*Math.sin(.707*i);
    const z=.058+(Math.floor(i/11)-1.5)*.021+.009*Math.cos(.991*i);
    mesh('Collected bead chain',smallBall,i%9===0?brass:chrome,[x,.106,z],null,false);
  }

  const scaleRoot=node('Fountain head measuring rail',[.360,.059,-.081]);
  const gauge=block('Engraved scale blade',[.067,1,.020],.007,ceramic,[0,.5,0],scaleRoot);
  gauge.setScale([1,3.25,1]);
  gauge.setPosition([0,1.625,0]);
  const ticks=[];
  for(let i=0;i<=33;i++){
    const major=i%5===0;
    const width=major?.043:.024;
    ticks.push(block('Scale graduations',[width,major?.0040:.0026,.0018],.00065,dark,[-.018+width/2,.100*i+.020,.011],scaleRoot,false));
  }
  bolt('Measurement rail base',.064,.027,bronze,[.360,.064,-.081],null,40);
  const fingers=[marker,riseMark].map((coat,i)=>{
    const group=node(i?'Fountain crest marker':'Feed level marker',[0,0,0],scaleRoot);
    block('Rail follower body',[.083,.031,.046],.008,coat,[0,0,0],group,false);
    block('Projected level finger',[.188,.010,.028],.0032,coat,[-.114,0,.026],group,false);
    return group;
  });

  const bead=toGeometry(sphereGeometry(.0104,14,10));
  const moving=Array.from({length:180},(_,i)=>mesh('Traveling chain bead',bead,
    i%11===0||i%17===0?colorBead:chrome,[0,0,0],null,false));
  const linkMesh=toGeometry(cylinderGeometry(.0024,.0024,.011,8));
  const links=moving.map(()=>mesh('Connector between chain beads',linkMesh,steel,[0,0,0],null,false));
  let path, previousDrop, previousRise;
  return {
    pose(drop,rise,travel) {
      if(drop!==previousDrop||rise!==previousRise){
        path=fountainPath(drop,rise);
        previousDrop=drop;
        previousRise=rise;
        supply.setPosition([-.3,floorY+drop,planeZ]);
        const feed=floorY+drop;
        const columnHeight=feed-.17;
        tower.setScale([1,columnHeight,1]);
        tower.setPosition([-.394,.065+columnHeight/2,-.097]);
        towerCap.setPosition([-.394,feed-.102,-.097]);
        const scaleTop=Math.ceil((path.crest+.12)/.1)*.1-.059;
        gauge.setScale([1,scaleTop,1]);
        gauge.setPosition([0,scaleTop/2,0]);
        for(const [i,tick] of ticks.entries())tick.visible=.100*i+.020<scaleTop;
        fingers[0].setPosition([0,floorY+drop-.059,0]);
        fingers[1].setPosition([0,path.crest-.059,0]);
      }
      const length=Math.ceil(path.length/pitch)*pitch;
      const count=Math.round(length/pitch);
      const start=travel%length;
      for(const [i,item] of moving.entries()){
        const distance=(i*pitch+start)%length;
        item.visible=i<count&&distance<path.length;
        if(item.visible)item.setPosition(path.sample(distance));
        const link=links[i];
        link.visible=item.visible&&distance+pitch<path.length;
        if(link.visible){
          const a=path.sample(distance),b=path.sample(distance+pitch);
          link.setPosition(path.sample(distance+pitch/2));
          link.setQuaternion(axisAngleToQuaternion([0,0,1],-Math.atan2(b[0]-a[0],b[1]-a[1])));
        }
      }
      return path.crest;
    },
  };
}



