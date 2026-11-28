import {PbrMaterial,box} from '@margoengine/core';
import {toGeometry} from '@margoengine/geometry';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {cylinderGeometry} from '@margoengine/geometry/primitives';
import {divider,laneGap,openingPose,sampleLimit,testBlock} from './experiment.js';

const material=(color,roughness=.58,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const M={
  ground:material('#26323a',.82),shadow:material('#18222c',.82),lower:material('#2c3e47',.55,.16),
  anodised:material('#627780',.36,.31),panel:material('#39525b',.69),laneA:material('#664c31',.54),
  laneB:material('#335c66',.58),engraving:material('#75868b'),amber:material('#eb9b52',.34,.17),
  ice:material('#87e5db',.32,.13),ivory:material('#e8e1ca',.42),silver:material('#b0b4aa',.35,.44),
  charcoal:material('#2b363b',.67),brass:material('#bd9868',.30,.45),tungsten:material('#8b8369',.35,.40),
};
const block=box();
const dowel=toGeometry(cylinderGeometry(.5,.5,1,20,1));
const tray=toGeometry(roundedBoxGeometry(7.42,.256,3.54,3,.107));
const rim=toGeometry(roundedBoxGeometry(7.34,.096,3.46,3,.043));
const basePort=toGeometry(roundedBoxGeometry(7.09,.032,3.19,3,.014));
const ceramic=box(...testBlock.map(x=>x*2));
const flag=box(divider[0]*2,divider[1]*2,divider[2]*2);

// Every part goes to the bench, which casts its shadow from the sun.
export function buildStation(engine,add){
  const put=(shape,finish,at,scale=[1,1,1],parent)=>{
    const part=engine.createMesh(parent).setGeometry(shape).setMaterial(finish).setPosition(at).setScale(scale);
    add(part);
    return part;
  };
  const bar=(finish,at,scale,parent)=>put(block,finish,at,scale,parent);
  const rod=(finish,at,scale,parent)=>put(dowel,finish,at,scale,parent);

  bar(M.ground,[0,-.493,0],[140,.12,140]);
  for(const x of [-2.86,2.86])for(const z of [-1.28,1.28]){
    put(rim,M.shadow,[x,-.386,z],[.101,1,.153]);
    rod(M.tungsten,[x,-.323,z],[.154,.132,.154]);
  }
  put(tray,M.lower,[0,-.184,0]);
  put(rim,M.anodised,[0,-.056,0]);
  put(basePort,M.panel,[0,.002,0]);
  bar(M.shadow,[0,-.093,1.766],[2.66,.074,.018]);
  for(let i=0;i<31;i++){
    const x=(i-15)*.077;
    bar(i%5===0?M.ivory:M.tungsten,[x,-.093,1.779],[.008,i%5===0?.042:.024,.013]);
  }
  for(const x of [-3.38,3.38])for(const z of [-1.48,1.48]){
    rod(M.silver,[x,.029,z],[.082,.031,.082]);
    bar(M.charcoal,[x,.046,z],[.057,.004,.009]).setRotation([0,.32+x*.13,0]);
  }
  for(const x of [-3.45,3.45])for(let r=0;r<4;r++){
    bar(r%2===0?M.anodised:M.brass,[x,.021, -.138+r*.085],[.112,.011,.020]);
  }

  const lanes=[];
  for(const sign of [-1,1]){
    const lane=sign*laneGap;
    const tint=sign>0?M.ice:M.amber;
    bar(sign>0?M.laneB:M.laneA,[-.08,.022,lane],[6.71,.023,1.46]);
    for(const z of [lane-.697,lane+.697]){
      bar(M.anodised,[0,.039,z],[6.89,.022,.031]);
      for(let i=0;i<17;i++)bar(i%4===0?M.ivory:M.engraving,[(i-8)*.393,.051,z+Math.sign(lane-z)*.016],[.011,.006,.052]);
    }
    bar(M.charcoal,[-3.28,.041,lane],[.50,.012,1.20]);
    for(let k=0;k<6;k++)bar(tint,[-3.18-k*.056,.054,lane-.49],[.015,.007,.151]);
    for(const x of [-.160,.16]){
      bar(M.anodised,[x,.048,lane],[.018,.010,1.15]);
    }
    put(flag,M.ivory,[0,.44,lane]);
    for(const side of [-1,1]){
      const z=lane+side*.558;
      bar(M.charcoal,[0,.075,z],[.214,.085,.169]);
      bar(M.silver,[0,.454,z],[.080,.899,.058]);
      bar(M.brass,[0,.425,z+side*.035],[.038,.744,.022]);
      rod(tint,[0,.905,z],[.066,.077,.067]);
    }
    bar(M.silver,[0,.914,lane],[.078,.040,1.11]);
    bar(M.brass,[0,.939,lane],[.051,.009,.99]);
    const body=put(ceramic,tint,[0,0,0]);
    rod(M.ivory,[0,testBlock[1]+.0025,0],[.082,.006,.082],body);
    bar(M.charcoal,[0,testBlock[1]+.006,0],[.054,.005,.009],body);
    const dots=Array.from({length:sampleLimit},()=>rod(tint,[0,.059,lane],[.065,.017,.065]));
    const segments=Array.from({length:sampleLimit},()=>bar(tint,[0,.049,lane],[.12,.006,.013]));
    const step=rod(M.ivory,[0,.060,lane],[.102,.017,.102]);
    lanes.push({lane,body,dots,segments,step});
  }

  function pose(lane,samples,index){
    const sample=samples[index];
    const [x,y,z]=sample.position;
    lane.body.setPosition([x,y,z+lane.lane]).setQuaternion(sample.rotation);
    lane.step.setPosition([x,.059,z+lane.lane]);
    for(let i=0;i<sampleLimit;i++){
      const seen=i<index;
      const dot=lane.dots[i],line=lane.segments[i];
      dot.visible=seen;
      line.visible=seen;
      if(!seen)continue;
      const [sx,,sz]=samples[i].position,[ax,,az]=samples[i+1].position;
      const dx=ax-sx,dz=az-sz;
      dot.setPosition([sx,.052,sz+lane.lane]);
      line.setPosition([(ax+sx)/2,.052,(az+sz)/2+lane.lane]);
      line.setRotation([0,-Math.atan2(dz,dx),0]);
      line.setScale([Math.max(.009,Math.hypot(dx,dz)),.009,.017]);
    }
  }
  function set(data,index){
    pose(lanes[0],data.discrete,index);
    pose(lanes[1],data.continuous,index);
  }
  const initial=[openingPose()];
  set({discrete:initial,continuous:initial},0);
  return {set};
}
