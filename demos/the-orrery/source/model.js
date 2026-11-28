import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material } from '@margoengine/materials';
import { orbitTrack, planets, position } from './orbits.js';
import { paintedGlobe } from './globes.js';

export const metersPerAU=.27;
const tau=2*Math.PI;
const orbitalHeight=.205;
const shelf=.067;
const hues=[[.43,.47,.49],[.70,.53,.253],[.20,.50,.64],[.58,.265,.16]];
const finish={
  floor:{color:[.101,.072,.084],roughness:.92,metalness:0},
  foot:{color:[.055,.027,.025],roughness:.75,metalness:0},
  case:{color:[.15,.065,.043],roughness:.44,metalness:0},
  grain:{color:[.193,.087,.054],roughness:.53,metalness:0},
  brass:{color:[.76,.474,.225],roughness:.32,metalness:.62},
  bronze:{color:[.46,.245,.121],roughness:.44,metalness:.48},
  enamel:{color:[.073,.089,.116],roughness:.46,metalness:.04},
  ink:{color:[.55,.39,.253],roughness:.62,metalness:.10},
  dial:{color:[.092,.120,.164],roughness:.55,metalness:0},
  steel:{color:[.46,.49,.522],roughness:.33,metalness:.59},
  sun:{color:[1,.90,.67],roughness:.39,metalness:0,emissive:[.27,.088,.014]},
  globe:{color:[1,1,1],roughness:.61,metalness:0},
};

function stamp(geometry,x,y,z) {
  return applyMatrix4(geometry,[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);
}

function circle(radius,angle) { return [radius*Math.cos(angle),radius*Math.sin(angle)]; }

function cylinderRing(radius,thickness,y) {
  return applyMatrix4(torusGeometry(radius,thickness,8,116),[1,0,0,0,0,0,-1,0,0,1,0,0,0,y,0,1]);
}

function link(from,to,y,width,depth) {
  const [ax,az]=from,[bx,bz]=to;
  const length=Math.hypot(bx-ax,bz-az);
  const c=(bx-ax)/length,s=(bz-az)/length;
  return applyMatrix4(roundedBoxGeometry(length+width*.24,depth,width,1,Math.min(width,depth)*.38),
    [c,0,-s,0,0,1,0,0,s,0,c,0,(ax+bx)*.5,y,-(az+bz)*.5,1]);
}

function inlay(points,halfWidth) {
  const positions=[],normals=[],uvs=[],indices=[];
  for(let i=0;i<points.length;i++) {
    const [x,z]=points[i];
    const [ax,az]=points[(i+points.length-1)%points.length];
    const [bx,bz]=points[(i+1)%points.length];
    const length=Math.hypot(bx-ax,bz-az);
    const offsetX=(bz-az)*halfWidth/length,offsetZ=(ax-bx)*halfWidth/length;
    positions.push(x-offsetX,.070,-z+offsetZ,x+offsetX,.070,-z-offsetZ);
    normals.push(0,1,0,0,1,0);
    uvs.push(i/points.length,0,i/points.length,1);
    const a=i*2,next=(i+1)%points.length*2;
    indices.push(a,a+1,next+1,a,next+1,next);
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}
function toothedProfile(radius,count,y,height) {
  const points=[];
  for(let i=0;i<count;i++) {
    const middle=i*tau/count;
    for(const [slot,ratio] of [[-.50,.87],[-.28,.87],[-.20,1],[.20,1],[.28,.87]]) {
      const [x,z]=circle(radius*ratio,middle+tau/count*slot);
      points.push([x,z]);
    }
  }
  const pos=[], normals=[], uv=[], indices=[];
  // The gear face and teeth share one clean outline. The shaft collar hides the center fan.
  for(const sign of [-1,1]) {
    const start=pos.length/3;
    const layer=y+height*.5*sign;
    pos.push(0,layer,0); normals.push(0,sign,0); uv.push(.5,.5);
    points.forEach(([x,z])=>{pos.push(x,layer,-z); normals.push(0,sign,0); uv.push(x/radius*.5+.5,z/radius*.5+.5);});
    points.forEach((_,i)=>{
      const a=start+i+1,b=start+(i+1)%points.length+1;
      indices.push(start,sign===1?a:b,sign===1?b:a);
    });
  }
  points.forEach(([x,z],i)=>{
    const [nx,nz]=points[(i+1)%points.length];
    const h=Math.hypot(nz-z,x-nx);
    const normal=[(nz-z)/h,0,(nx-x)/h];
    const start=pos.length/3;
    pos.push(x,y-height*.5,-z,nx,y-height*.5,-nz,nx,y+height*.5,-nz,x,y+height*.5,-z);
    normals.push(...normal,...normal,...normal,...normal);
    uv.push(0,0,1,0,1,1,0,1);
    indices.push(start,start+1,start+2,start,start+2,start+3);
  });
  return {positions:Float32Array.from(pos),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uv),indices:Uint32Array.from(indices)};
}

const numbers={
  '7':[[.10,1,.93,1],[.93,1,.30,0]],
  '8':[[.25,0,.75,0],[.75,0,.93,.23],[.93,.23,.74,.47],[.74,.47,.26,.55],[.26,.55,.08,.79],[.08,.79,.28,1],[.28,1,.72,1],[.72,1,.92,.79],[.92,.79,.72,.55],[.72,.55,.28,.47],[.28,.47,.08,.23],[.08,.23,.25,0]],
  '1':[[.5,0,.5,1],[0,.72,.5,1],[.15,0,.85,0]],
  '2':[[.10,.85,.38,1],[.38,1,.9,.88],[.9,.88,.9,.67],[.9,.67,.13,.13],[.13,.13,.13,0],[.13,0,.96,0]],
  '3':[[.13,1,.90,1],[.90,1,.57,.55],[.57,.55,.91,.41],[.91,.41,.98,.15],[.98,.15,.70,0],[.70,0,.13,.14]],
  '0':[[.25,0,.75,0],[.75,0,.92,.25],[.92,.25,.92,.75],[.92,.75,.75,1],[.75,1,.25,1],[.25,1,.08,.75],[.08,.75,.08,.25],[.08,.25,.25,0]],
  '9':[[.12,0,.53,0],[.53,0,.86,.34],[.86,.34,.86,.84],[.86,.84,.64,1],[.64,1,.25,1],[.25,1,.08,.78],[.08,.78,.25,.54],[.25,.54,.86,.54]],
};

export function prepareOrrery() {
  const batches=new Map();
  const add=(material,geometry)=>{
    if(!batches.has(material)) batches.set(material,[]);
    batches.get(material).push(geometry);
  };
  const disk=(material,radius,y,h,segments=100)=>add(material,stamp(cylinderGeometry(radius,radius,h,segments),0,y,0));
  const trim=(material,profile)=>add(material,latheGeometry(profile,132));
  const ring=(material,r,y,t)=>add(material,cylinderRing(r,t,y));
  const box=(material,position,dimensions,bevel)=>add(material,stamp(roundedBoxGeometry(...dimensions,2,bevel),...position));

  box('floor',[0,-.053,0],[42,.025,42],.004);
  for(let i=0;i<4;i++) {
    const [x,z]=circle(.349,tau*i/4+.26);
    add('foot',stamp(cylinderGeometry(.054,.060,.032,44),x,-.025,-z));
    add('bronze',stamp(cylinderGeometry(.052,.053,.009,44),x,-.014,-z));
  }
  trim('case',[[.002,-.019],[.447,-.019],[.475,-.013],[.485,-.003],[.486,.038],[.482,.051],[.472,.060],[.002,.060]]);
  trim('grain',[[.474,-.009],[.490,-.009],[.496,-.003],[.495,.004],[.485,.011],[.478,.011]]);
  trim('grain',[[.478,.029],[.489,.029],[.495,.034],[.495,.040],[.489,.045],[.480,.045]]);
  ring('bronze',.480,.017,.0035);
  ring('brass',.488,.046,.0033);
  trim('enamel',[[.003,.050],[.471,.050],[.480,.058],[.471,.065],[.466,.067],[.003,.067]]);
  disk('dial',.462,.0655,.004);
  ring('brass',.466,.069,.0027);
  ring('bronze',.452,.069,.0013);
  for(let i=0;i<120;i++) {
    const a=i*tau/120;
    const length=i%10===0?.011:i%5===0?.007:.0035;
    add(i%10===0?'brass':'ink',link(circle(.462-length,a),circle(.462,a),.069,i%5===0?.00145:.00080,.001));
  }
  for(const [angle,label] of [[0,'0'],[Math.PI/2,'90'],[Math.PI,'180'],[Math.PI*1.5,'270']]) {
    const [cx,cz]=circle(.439,angle);
    [...label].forEach((d,i)=>{
      const x=cx+(i-(label.length-1)*.5)*.0085;
      for(const [x1,z1,x2,z2] of numbers[d]) {
        add('brass',link([x+x1*.006-.003,cz+z1*.009-.0045],[x+x2*.006-.003,cz+z2*.009-.0045],.070,.0011,.001));
      }
    });
  }

  planets.forEach((planet,i)=>{
    const points=orbitTrack(planet).map(([x,y])=>[x*metersPerAU,y*metersPerAU]);
    add('orbit'+i,inlay(points,i===0?.00105:.00125));
  });

  disk('enamel',.068,.078,.020,60);
  ring('brass',.064,.089,.0016);
  add('bronze',toothedProfile(.068,30,.092,.009));
  disk('bronze',.053,.101,.010,54);
  ring('steel',.049,.108,.00165);
  add('brass',toothedProfile(.047,24,.113,.008));
  disk('enamel',.037,.119,.010,48);
  ring('bronze',.036,.125,.0016);
  add('brass',toothedProfile(.035,22,.132,.008));
  disk('bronze',.027,.143,.016,42);
  disk('brass',.019,.155,.020,38);
  ring('steel',.017,.164,.0017);
  disk('brass',.011,.173,.024,32);
  for(let i=0;i<6;i++) {
    const [x,z]=circle(.050,i*tau/6);
    add('steel',stamp(cylinderGeometry(.0039,.0042,.003,16),x,.109,-z));
  }
  const fixed=Array.from(batches,([material,parts])=>({material,data:parts.length===1?parts[0]:mergeGeometries(parts)}));
  const bodyGeometry=planets.map((planet)=>paintedGlobe(planet.id,planet.radius));
  const sunGeometry=paintedGlobe('sun',.0455);

  return (engine,shadows)=>{
    const world=engine.createMesh();
    const materials=new Map(Object.entries(finish).map(([name,value])=>[name,new Material(value)]));
    hues.forEach((color,i)=>materials.set('orbit'+i,new Material({color,roughness:.58,metalness:.11})));
    function model(name,data,material,parent,stationary=false,castShadow=true) {
      const mesh=createMesh(engine,data,materials.get(material));
      mesh.root.name=name;
      mesh.root.setParent(parent);
      shadows.add(mesh,{static:stationary,castShadow});
      return mesh.root;
    }
    for(const {material,data} of fixed) {
      model('Orrery '+material,data,material,world,true,material!=='floor'&&!material.startsWith('orbit'));
    }
    model('Sun globe',{...sunGeometry,...stamp(sunGeometry,0,orbitalHeight,0)},'sun',world,true);
    const driven=planets.map((planet,i)=>{
      const armHeight=.102+i*.0155;
      const pivot=engine.createMesh().setParent(world);
      const reach=.039+i*.004;
      const arm=stamp(roundedBoxGeometry(reach,.0056,.015,2,.0024),.028+reach*.5,armHeight,0);
      model(planet.name+' outer sleeve',arm,'bronze',pivot);
      const slider=model(planet.name+' brass slide',roundedBoxGeometry(1,.0039,.009,2,.00165),'brass',pivot);
      const hinge=model(planet.name+' shaft carriage',cylinderGeometry(.0084,.010,.0067,24),'brass',pivot);
      const pedestal=model(planet.name+' vertical pin',cylinderGeometry(.0037,.004,1,24),'steel',pivot);
      const body=model(planet.name+' painted globe',bodyGeometry[i],'globe',pivot);
      return (day)=>{
        const [x,y,z]=position(planet,day);
        const longitude=Math.atan2(y,x),radius=Math.hypot(x,y)*metersPerAU;
        const center=orbitalHeight+z*metersPerAU;
        pivot.setRotation([0,longitude,0]);
        const from=.035+reach*.28;
        slider.setScale([radius-from,1,1]).setPosition([(radius+from)*.5,armHeight,0]);
        hinge.setPosition([radius,armHeight-.001,0]);
        const underGlobe=center-planet.radius+.004;
        pedestal.setScale([1,underGlobe-armHeight,1]).setPosition([radius,(underGlobe+armHeight)*.5,0]);
        body.setPosition([radius,center,0]).setRotation([0,-longitude,0]);
      };
    });
    return (day)=>driven.forEach((move)=>move(day));
  };
}
