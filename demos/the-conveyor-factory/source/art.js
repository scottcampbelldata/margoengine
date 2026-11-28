import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {lanes,belt,bin,objectsForLane} from './layout.js';

const finishes={
  ground:['#40505a',.87,.01], plinth:['#182b34',.63,.21], edge:['#97a0a0',.44,.57],
  frame:['#273b44',.54,.43], truss:['#637276',.55,.51], panel:['#48555a',.49,.35],
  tread:['#1c2d39',.91,.04], rib:['#62767b',.74,.17], lip:['#85958d',.48,.41],
  chute:['#4c616c',.42,.58], rail:['#929997',.34,.65], guide:['#dfaa48',.44,.43],
  dark:['#192b32',.61,.23], teal:['#439889',.56,.4], ochre:['#cb8743',.55,.39], coral:['#b65e53',.55,.4],
  pale:['#d7dbca',.55,.11], card:['#bf8754',.84,.01], paper:['#eac28b',.80,.01],
  chestnut:['#9e6546',.82,.01], label:['#e3d5ad',.88,.0], tape:['#8d592f',.74,.03]
};
const badges=['teal','ochre','coral'];
const half=x=>x*.5;
const usableBelt=belt.end-belt.start;
const ribCount=27,ribStep=usableBelt/ribCount;
const cartonKinds=['card','paper','chestnut'];
function rounded(dim,radius){
  const {positions,normals,indices}=roundedBoxGeometry(...dim,1,radius);
  return new Geometry(positions,normals,indices);
}
export function createAisle(engine){
  const mesh=box(1,1,1),packMesh=rounded([1,1,1],.076);
  const materials=Object.fromEntries(Object.entries(finishes).map(([name,[color,roughness,metalness]])=>
    [name,new PbrMaterial({color,roughness,metalness,doubleSided:false})]));
  function part(name,p,size,roll=0,parent=null,geometry=mesh){
    const object=engine.createMesh(parent).setGeometry(geometry).setMaterial(materials[name]).setPosition(p).setScale(size);
    if(roll)object.rotation.z=roll;
    return object;
  }
  function fixture(name,p,size,radius,roll=0,parent=null){
    return part(name,p,[1,1,1],roll,parent,rounded(size,radius));
  }
  part('ground',[0,-.12,0],[100,.23,100]);
  fixture('plinth',[.08,.032,0],[6.75,.082,3.44],.030);
  fixture('edge',[.08,.075,0],[6.57,.035,3.32],.012);
  fixture('frame',[.03,.104,0],[6.38,.04,3.13],.013);
  for(const sign of [-1,1]){
    part('dark',[.02,.126,sign*1.536],[6.12,.009,.022]);
    for(let i=0;i<28;i++){
      part(i%3===0?'guide':'truss',[-2.96+i*.218,.129,sign*1.51],[.125,.010,.043],0);
    }
  }
  function truss(x,z){
    fixture('panel',[x,.167,z],[.42,.083,.45],.018);
    fixture('frame',[x,.83,z],[.18,1.38,.24],.027);
    fixture('truss',[x,.82,z+.136],[.095,1.28,.053],.013);
    fixture('edge',[x,1.456,z],[.37,.12,.36],.018);
  }
  for(const z of [lanes[0]-.28,lanes[2]+.28])for(const x of [-2.21,-.62,1.04])truss(x,z);
  for(const x of [-2.25,-.61,1.04]){
    part('truss',[x,.58,0],[.105,.113,2.38]);
    part('frame',[x,1.42,0],[.105,.119,2.43]);
  }
  for(const sign of [-1,1])for(const x of [-1.44,.20]){
    const width=1.52,height=.66;
    part('truss',[x,.70,sign*1.10],[Math.hypot(width,height),.047,.068],Math.atan2(height,width));
  }
  const slats=[];
  lanes.forEach((z,index)=>{
    const color=badges[index];
    for(const item of objectsForLane(z)){
      const {kind,p,s,roll=0}=item;
      const material={belt:'tread',chute:'chute',rail:'rail',floor:'panel',front:color,side:color}[kind];
      fixture(material,p,s,Math.min(.023,...s.map(value=>value*.22)),roll);
      if(kind==='rail'){
        const [x,y,z]=p;
        fixture('lip',[x,y+s[1]*.45,z],[s[0]*.992,.027,s[2]+.014],.011,roll);
      }
      if(kind==='front'){
        fixture('plinth',[p[0]+.042,p[1]+.05,p[2]],[.024,.173,.372],.010);
        for(let i=0;i<=index;i++)part('pale',[p[0]+.059,p[1]+.055,p[2]+(i-index/2)*.088],[.012,.068,.034]);
      }
    }
    const sensorX=bin.center+.02;
    for(const zside of [-1,1]){
      fixture('guide',[sensorX,.64,z+zside*.294],[.07,.04,.07],.010);
      part('dark',[sensorX,.60,z+zside*.294],[.049,.055,.049]);
    }
    for(let i=0;i<ribCount;i++){
      slats.push({z,i,part:part('rib',[belt.start+(i+.5)*ribStep,belt.top+.005,z],[.018,.013,belt.width-.052])});
    }
    for(const x of [belt.start+.135,belt.end-.125]){
      fixture(color,[x,1.42,z],[.225,.18,.76],.035);
      for(const sign of [-1,1])fixture('edge',[x,1.42,z+sign*.39],[.135,.135,.071],.027);
    }
    fixture('panel',[belt.start+.03,2.06,z],[.22,.13,.67],.022);
    for(const sign of [-1,1])fixture('frame',[belt.start+.03,1.83,z+sign*.313],[.115,.39,.078],.016);
    fixture(color,[belt.start+.010,2.135,z],[.16,.027,.36],.012);
  });
  const drawn=new Map();
  function carton(entity){
    const root=engine.createMesh();
    const [w,h,d]=entity.size;
    part(cartonKinds[entity.variant%3],[0,0,0],[w,h,d],0,root,packMesh);
    part('tape',[0,half(h)+.001,0],[w*.96,.004,d*.23],0,root);
    part('label',[w*.174,half(h)+.004,d*.223],[w*.27,.003,d*.32],0,root);
    part(badges[entity.lane],[w*.174,half(h)+.007,d*.253],[w*.20,.002,d*.07],0,root);
    return root;
  }
  function sync(entities,phase){
    for(const entity of entities){
      let shape=drawn.get(entity);
      if(!shape){shape=carton(entity);drawn.set(entity,shape);}
      shape.setPosition(entity.body.position).setQuaternion(entity.body.rotation);
    }
    for(const rib of slats){
      const offset=((rib.i+.5)*ribStep+phase)%usableBelt;
      rib.part.position.x=belt.start+offset;
    }
  }
  function reset(){
    for(const root of drawn.values())root.dispose();
    drawn.clear();
  }
  return {sync,reset};
}
