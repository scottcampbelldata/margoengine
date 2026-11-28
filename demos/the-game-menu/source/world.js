import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, latheGeometry, sphereGeometry, torusGeometry } from '@margoengine/geometry';
import { zones } from './language.js';

const swatch=(color,roughness=.56,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const basalt=swatch('#203b43',.91),bed=swatch('#1c3941',.96),seam=swatch('#4c7170',.83);
const sediment=swatch('#284b50',.95),farRidge=swatch('#18353e',.94),shadowStone=swatch('#172d34',.95);
const rockLayers=['#263f45','#2d5356','#3a5f60','#2a464c'].map(color=>swatch(color,.92));
const pearl=swatch('#c9e7cf',.58),oxide=swatch('#95665c',.79),sand=swatch('#527c7b',.91);
const orange=swatch('#bc703b',.39,.16),amber=swatch('#a5714c',.37,.64),cream=swatch('#ded3ad',.44,.06);
const steel=swatch('#5f727c',.33,.62),enamel=swatch('#376279',.41,.46),silver=swatch('#b9c9cc',.35,.7);
const carbon=swatch('#2e3e47',.66),port=swatch('#237482',.15,.38),glass=swatch('#72adb0',.21,.19);
const white=swatch('#cadecf',.33),stripe=swatch('#b14f3c',.58),gasket=swatch('#33454e',.74);
const lensDetail=swatch('#283f43',.5,.41),yellowSeal=swatch('#e5b568',.31,.27);
const convert=g=>new Geometry(g.positions,g.normals,g.indices);
const cylinder=(r,h,segments=32)=>convert(cylinderGeometry(r,r,h,segments));
const torus=(r,w,radial=10,segments=44)=>convert(torusGeometry(r,w,radial,segments));
const disk=(r,h)=>cylinder(r,h);
const unit=box(1,1,1),bead=convert(sphereGeometry(.5,8,6));
const face=[Math.PI/2,0,0];
const pi2=2*Math.PI;

export function makeWorld(engine){
  engine.lighting.direction.set([-.47,.79,.56,3.55]);
  engine.lighting.radiance.set([.88,1,1.15,.7]);
  engine.lighting.ambient.set([.54,.78,.89]);
  const origin=engine.createMesh();
  const rig=engine.createMesh(origin);
  function part(parent,model,material,x,y,z,sx=1,sy=1,sz=1){
    return engine.createMesh(parent).setGeometry(model).setMaterial(material).setPosition([x,y,z]).setScale([sx,sy,sz]);
  }
  const build=(g,m,x,y,z,sx,sy,sz)=>part(rig,g,m,x,y,z,sx,sy,sz);
  const block=(m,x,y,z,w,h,d)=>build(unit,m,x,y,z,w,h,d);
  const ring=(m,x,y,z,r,t)=>build(torus(r,t),m,x,y,z);
  const cap=(m,x,y,z,r,h)=>build(disk(r,h),m,x,y,z).setRotation(face);

  // The titanium pressure can lies inside a removable ribbed instrument cage.
  const vessel=convert(latheGeometry([[0,-.93],[.37,-.93],[.52,-.83],[.60,-.59],[.60,.48],[.57,.62],
    [.49,.74],[.45,.77],[0,.77]],48));
  build(vessel,orange,0,0,0).setRotation(face);
  for(const z of [-.76,-.43,.34,.64]){
    ring(z===.64?amber:steel,0,0,z,.583,.027);
    ring(gasket,0,0,z-.045,.58,.009);
  }
  // Acrylic port sits recessed inside the bolted flange, under a small anti-glare hood.
  cap(carbon,0,0,.774,.464,.07);
  ring(cream,0,0,.821,.386,.034);
  ring(silver,0,0,.844,.305,.022);
  cap(steel,0,0,.833,.287,.015);
  cap(port,0,0,.845,.267,.012);
  build(bead,glass,0,0,.852,.49,.49,.09);
  build(bead,white,-.109,.079,.888,.105,.030,.006).setRotation([0,0,-.29]);
  const bolt=disk(.021,.022);
  for(let i=0;i<14;i++){
    const q=i*pi2/14;
    build(bolt,carbon,.388*Math.cos(q),.388*Math.sin(q),.852).setRotation(face);
  }
  for(const side of [-1,1]){
    const skid=block(steel,side*.60,-.665,-.08,.13,.095,2.24);
    skid.name='Survey cradle runner';
    block(cream,side*.60,-.613,-.09,.082,.034,2.24);
    for(const z of [-.77,.64]){
      block(steel,0,-.555,z,1.40,.092,.14);
      block(steel,side*.53,-.407,z,.09,.312,.11).setRotation([0,0,side*.26]);
    }
    block(enamel,side*.54,-.39,-.18,.21,.174,.89);
    const lampX=side*.57;
    cap(carbon,lampX,.19,.50,.114,.29);
    cap(steel,lampX,.19,.661,.108,.055);
    cap(cream,lampX,.19,.700,.085,.014);
    cap(white,lampX,.19,.715,.072,.012);
    for(const z of [-.66,.55])block(stripe,side*.601,-.598,z,.086,.015,.12);
  }
  for(let i=0;i<6;i++){
    const z=-.60+i*.15;
    block(cream,0,.586,z,.164,.064,.099);
    block(amber,0,.624,z,.125,.015,.061);
  }
  block(enamel,0,.665,-.24,.245,.15,.265);
  cap(carbon,0,-.016,-.936,.31,.079);
  ring(silver,0,-.016,-.972,.285,.016);
  const screws=disk(.014,.020);
  for(const side of [-1,1]){
    const panelX=side*.589;
    block(carbon,panelX,.04,-.04,.048,.236,.52);
    block(silver,panelX+side*.026,.067,-.04,.011,.166,.45);
    block(enamel,panelX+side*.034,.067,-.04,.011,.134,.411);
    for(let z=0;z<6;z++){
      const vent=-.229+z*.073;
      block(carbon,panelX+side*.042,.078,vent,.007,.077,.041);
      block(steel,panelX+side*.048,.11,vent,.009,.008,.040);
    }
    for(const y of [-.045,.135]){
      for(const z of [-.259,.179])
        build(screws,amber,panelX+side*.034,y,z).setRotation([0,0,Math.PI/2]);
    }
    block(lensDetail,side*.16,-.343,.792,.225,.091,.069);
    block(yellowSeal,side*.16,-.340,.831,.102,.048,.01);
    for(const z of [.12,.24,.36])block(carbon,side*.601,-.595,z,.084,.015,.022);
  }
  const cable=cylinder(.024,1,12),collar=cylinder(.067,.076);
  build(collar,steel,0,.784,-.235);
  build(collar,amber,0,.838,-.235);
  function segment(parent,material,from,to,geometry){
    const [dx,dy,dz]=to.map((value,i)=>value-from[i]),dist=Math.hypot(dx,dy,dz);
    return part(parent,geometry,material,...from.map((value,i)=>(value+to[i])*.5),1,dist,1)
      .setRotation([Math.atan2(dz,dy),0,-Math.asin(dx/dist)]);
  }
  const tether=[[0,.864,-.235],[.035,1.07,-.24],[.16,1.28,-.24],[.34,1.49,-.25],[.55,1.66,-.28],[.78,1.80,-.33],[1.045,1.91,-.38],[1.43,2.03,-.43],[3.55,2.58,-.66]];
  for(let i=1;i<tether.length;i++)segment(rig,i<3?amber:steel,tether[i-1],tether[i],cable);

  // Seabed and distant basalt contours use the same 3D camera as the vehicle.
  const floor=engine.createMesh().setGeometry(box(113,.06,113)).setMaterial(bed).setPosition([0,-1.72,0]);
  floor.name='Seabed';
  let seed=5079;
  function random(){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  }
  // Build stratified, fractured basalt with a different height profile per shelf.
  const rock=convert(latheGeometry([[0,-.43],[.86,-.437],[1,-.18],[.86,.27],[.54,.67],[.39,.745],[0,.77]],8));
  const shard=convert(latheGeometry([[0,-.02],[.85,0],[.77,.29],[.51,.55],[.39,.86],[.22,.96],[0,.98]],7));
  const terrain=engine.createMesh();
  const ridge=engine.createMesh();
  for(let n=0;n<22;n++){
    const x=-25+n*2.5,z=-13-random()*6.6,r=1.3+random()*2.6;
    part(ridge,rock,farRidge,x,-2.3,z,r*1.7,1.6+random()*2,r);
    part(ridge,rock,shadowStone,x+.6,-2.2,z+1.4,r,1.1+random()*1.6,r);
  }
  for(let n=0;n<25;n++){
    const x=(random()-.5)*24,y=-1.84,z=-random()*11+1.1,r=.18+random()*.88;
    const turn=random()*pi2,dy=r*.20;
    part(terrain,rock,shadowStone,x,y-.02,z,r*1.19,r*.29,r*1.14).setRotation([0,turn,0]);
    part(terrain,rock,rockLayers[n%rockLayers.length],x,y+dy,z,r,r*.44,r*.84)
      .setRotation([.18,turn,-.11]);
    if(n%4===0)part(terrain,rock,basalt,x+r*.3,y+.45*r,z-r*.2,r*.49,r*.55,r*.55)
      .setRotation([.14,turn+.27,.23]);
  }
  for(let n=0;n<49;n++){
    const x=(random()-.5)*17,y=-1.676,z=(random()-.75)*12;
    const r=.035+random()*.20;
    part(terrain,bead,n%7?sediment:seam,x,y,z,r,.019,r*.31).setRotation([0,random()*pi2,0]);
  }
  const vents=engine.createMesh(terrain).setPosition([2.25,-1.74,-2.7]);
  for(let n=0;n<13;n++){
    const x=(random()-.5)*3.3,z=(random()-.5)*1.75,r=.18+random()*.43,h=.45+random()*1.95;
    part(vents,shard,n%3?basalt:oxide,x,0,z,r,h,r*.82).setRotation([.12*(random()-.5),random()*pi2,.41*(random()-.5)]);
    if(n%3===0)part(vents,bead,pearl,x,h*.89,z,r*.49,.13,r*.55);
  }
  for(let n=0;n<56;n++){
    const x=(random()-.5)*14,y=(random()-.53)*6,z=-3.3+random()*5,r=.007+random()*.021;
    part(terrain,bead,n%3?sand:pearl,x,y,z,r,r,r);
  }

  function setScene(screen,index,narrow,rtl){
    const title=screen==='title'||screen==='settings'||screen==='paused';
    const localeSide=rtl?-1:1;
    const offset=narrow?(title?.04:0):(title?-.92:-.52)*localeSide;
    const height=narrow?(title?.22:-.46):(title?.14:-.04);
    engine.camera.position=[offset+2.55*localeSide,1.33,5.0];
    engine.camera.target=[offset,height+(narrow&&title?.18:0),0];
    engine.camera.fov=narrow?47:36;
    engine.scene.background=zones[index].sky;
    ridge.setPosition([index*.6,0,-index*.55]);
    rig.setPosition([0,narrow&&!title?.32:0,0]);
    rig.setRotation([title?.04:0,index*.19*localeSide,index===1?-.08:.025]);
    terrain.setPosition([index===0?0:index===1?-1.28:-1.8,0,index===0?0:index===1?.4:1.16]);
    vents.setScale(index===0?[.5,.5,.5]:index===1?[1,.84,1]:[1.25,1.24,1.12]);

  }
  return {setScene};
}
