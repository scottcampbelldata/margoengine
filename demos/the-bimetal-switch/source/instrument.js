import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { CatmullRomCurve3 } from '@margoengine/geometry/shapes';
import { cylinderGeometry, latheGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { curve, gap, length, mechanism, thickness } from './model.js';

const Z = [0, 0, 1];
const X = [1, 0, 0];
const tipBase = [-.129, .121, .043];
const postCenter = [.016, tipBase[1] + gap + .0037, tipBase[2]];
const stripWidth = .024;

function ribbon(temperature, lower, upper) {
  const steps = 42, positions = [], normals = [], indices = [];
  function point(t, offset, z) {
    const p = curve(temperature, t * length);
    return [p.x - offset * Math.sin(p.angle), p.y + offset * Math.cos(p.angle), z];
  }
  function quad(a, b, c, d) {
    const u = b.map((value, i) => value - a[i]);
    const v = d.map((value, i) => value - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const size = Math.hypot(...n);
    const index = positions.length / 3;
    for (const corner of [a, b, c, d]) {
      positions.push(...corner);
      normals.push(...n.map((value) => value / size));
    }
    indices.push(index, index + 1, index + 2, index, index + 2, index + 3);
  }
  const z = stripWidth / 2;
  for (let k = 0; k < steps; k++) {
    const a = k / steps, b = (k + 1) / steps;
    quad(point(a,upper,-z),point(a,upper,z),point(b,upper,z),point(b,upper,-z));
    quad(point(a,lower,z),point(a,lower,-z),point(b,lower,-z),point(b,lower,z));
    quad(point(a,lower,z),point(b,lower,z),point(b,upper,z),point(a,upper,z));
    quad(point(b,lower,-z),point(a,lower,-z),point(a,upper,-z),point(b,upper,-z));
  }
  quad(point(0,lower,-z),point(0,lower,z),point(0,upper,z),point(0,upper,-z));
  quad(point(1,lower,z),point(1,lower,-z),point(1,upper,-z),point(1,upper,z));
  return new Geometry(positions,normals,indices);
}
export function makeSwitch(engine, shadows) {
  const paint = (color, roughness, metalness=0) => new PbrMaterial({color,roughness,metalness});
  const room = paint('#587168', .86);
  const walnut = paint('#634b3a', .55), walnutEdge=paint('#533d30',.59);
  const enamel = paint('#435c51',.63), dark = paint('#323e38',.64), slate=paint('#607469',.48);
  const steel = paint('#9eaca9',.33,1), chrome=paint('#bac9c8',.23,1), bronze=paint('#8d6b44',.46,1);
  const brass = paint('#c08d54',.32,1), copper=paint('#ae6e49',.42,1), light=paint('#c5c8b1',.62);
  const ceramic=paint('#c8b68e',.64), graphite=paint('#49504a',.67);
  const lampOn=paint('#a9d5a4',.39), lampOff=paint('#50675b',.56);
  const label=paint('#d9d0b7',.70);

  function node(name, at, parent=null) {
    const item=engine.createMesh(parent).setPosition(at);
    item.name=name;
    return item;
  }
  function add(name,data,finish,at,parent=null,casts=true,moving=!!parent){
    const item=node(name,at,parent).setGeometry('uvs' in data?toGeometry(data):data).setMaterial(finish);
    if(casts)shadows.add(item,{static:!moving});
    return item;
  }
  function block(name,dims,r,finish,at,parent=null,casts=true){
    return add(name,roundedBoxGeometry(...dims,2,r),finish,at,parent,casts);
  }
  function pin(name,r,h,finish,at,parent=null,sides=48,moving=!!parent){
    return add(name,cylinderGeometry(r,r,h,sides),finish,at,parent,true,moving);
  }
  function axial(...args) {
    return pin(...args).setQuaternion(axisAngleToQuaternion(X,Math.PI/2));
  }

  add('Studio sweep',box(32,.066,32),room,[0,-.053,0],null,false);
  block('Walnut support',[.416,.034,.264],.011,walnut,[0,-.002,0]);
  block('Lower walnut chamfer',[.395,.008,.244],.0036,walnutEdge,[0,-.015,0]);
  block('Bronze face reveal',[.393,.0035,.240],.00145,bronze,[0,.016,0]);
  block('Enamel instrument board',[.385,.013,.229],.006,enamel,[0,.023,0]);
  for(const x of [-.169,.169]){
    for(const z of [-.087,.087]){
      block('Isolation foot',[.045,.012,.036],.005,dark,[x,-.014,z]);
      pin('Board hex fastener',.0048,.0037,steel,[x,.031,z],null,6);
    }
  }

  const plinth = block('Split ceramic heater block',[.143,.021,.056],.006,ceramic,[-.068,.047,.045]);
  plinth.receiveShadow=true;
  block('Inset heater element',[.099,.006,.038],.0027,graphite,[-.067,.059,.045]);
  for(let i=0;i<16;i++) {
    block('Heater slot',[.00125,.0022,.033],.00042,copper,[-.111+i*.00565,.0624,.045],null,false);
  }
  for(const x of [-.119,-.012]){
    pin('Heater connection sleeve',.0039,.007,brass,[x,.059,.077],null,24);
    pin('Heater terminal screw',.0028,.0027,chrome,[x,.064,.077],null,6);
  }

  block('Steel clamp pedestal',[.039,.079,.055],.006,dark,[-.140,.070,.044]);
  block('Clamp bottom jaw',[.033,.011,.039],.003,bronze,[-.140,tipBase[1]-.006,.043]);
  block('Clamp top jaw',[.031,.009,.036],.0029,brass,[-.142,tipBase[1]+.0051,.043]);
  for(const z of [.031,.055]){
    pin('Clamp fixing',[.0049,.0052][Number(z>.04)],.008,steel,[-.143,.135,z],null,10);
  }

  const lower = add('Lower brass laminate',ribbon(24,-thickness*.5,0),brass,tipBase,null,true,true);
  const upper = add('Upper steel laminate',ribbon(24,0,thickness*.5),chrome,tipBase,null,true,true);

  block('Contact bracket support',[.023,.089,.042],.0043,slate,[.056,.073,.008]);
  block('Contact crossbar back plate',[.093,.035,.009],.004,dark,[.077,.108,-.016]);
  block('Pivot mounting bridge',[.043,.015,.042],.004,dark,[.033,.117,.006]);
  for(const x of [.046,.109]) axial('Bakelite terminal washer',.0073,.0095,graphite,[x,.109,-.009]);
  axial('Pivot shoulder pin',.0086,.028,bronze,[postCenter[0],postCenter[1],postCenter[2]-.009]);
  axial('Rear pivot pin head',.0064,.006,steel,[postCenter[0],postCenter[1],postCenter[2]-.024]);

  const lever = node('Contact and indicator lever',postCenter);
  block('Spring contact arm',[.087,.0054,.014],.0018,steel,[.0205,0,0],lever);
  const thumb = block('Ceramic strip follower',[.0060,.0063,.011],.0022,ceramic,[-.019,-.00014,0],lever);
  thumb.receiveShadow=true;
  pin('Moving silver contact',.0034,.0037,chrome,[.057,.0034,0],lever,48,true);
  axial('Pivot hub',.0068,.011,brass,[0,0,.0007],lever);
  block('Contact pointer support',[.007,.011,.010],.002,brass,[.025,.006,.001],lever);
  block('Copper viewing pointer',[.049,.0029,.003],.0009,copper,[.036,.012,.009],lever);
  pin('Stationary silver contact',.0040,.0046,chrome,[postCenter[0]+.057,postCenter[1]+.00756,postCenter[2]]);
  block('Insulated upper terminal',[.020,.014,.025],.0035,ceramic,
    [postCenter[0]+.057,postCenter[1]+.0167,postCenter[2]]);
  block('Ceramic terminal standoff',[.014,.012,.051],.0028,ceramic,[postCenter[0]+.057,postCenter[1]+.0167,.014]);
  pin('Upper terminal screw',.0040,.0042,steel,[postCenter[0]+.057,postCenter[1]+.0251,postCenter[2]],null,6);

  block('Arc indicator frame',[.096,.017,.007],.0030,bronze,[.063,.142,.023]);
  block('Parchment indicator scale',[.090,.0128,.0025],.0011,label,[.063,.142,.027]);
  for(let i=0;i<16;i++){
    const x=.023+i*.00525;
    block('Etched indication tick',[.0006,i%5===0?.0071:.0038,.00045],.00018,graphite,[x,.144,.0287],null,false);
  }

  block('Switch lamp chassis',[.045,.028,.044],.008,dark,[.139,.044,.059]);
  pin('Lamp brass bezel',.0155,.007,brass,[.139,.061,.059]);
  const bulb=add('Circuit indication dome',latheGeometry([
    [0,-.0005],[.0128,-.0005],[.0130,.0024],[.0120,.0061],[.0090,.0083],[.0050,.0092],[0,.00955],
  ],64),lampOn,[.139,.066,.059]);
  for(const [sign,color] of [[-1,dark],[1,slate]]){
    const wire=new CatmullRomCurve3([
      [.073,.151,.064],[.090,.143,.072],[.102,.086,.101],[.139+sign*.009,.045,.082],
    ]);
    add('Insulated lamp lead',tubeGeometry(wire,36,.00155,8),color,[0,0,0]);
  }
  for (const x of [-.152,-.132]) {
    pin('Supply socket',.0084,.012,graphite,[x,.037,-.057],null,42);
    pin('Supply brass collar',.0059,.0033,brass,[x,.045,-.057],null,38);
    const wire=new CatmullRomCurve3([[x,.045,-.055],[x+.012,.045,-.025],[x+.017,.034,.070],[x+.030,.060,.076]]);
    add('Metered heater lead',tubeGeometry(wire,42,.00145,8),x<-.143?dark:slate,[0,0,0]);
  }

  let last=24,open=false;
  return {
    pose(temperature) {
      const next=mechanism(temperature);
      if(temperature!==last){
        lower.setGeometry(ribbon(temperature,-thickness*.5,0));
        upper.setGeometry(ribbon(temperature,0,thickness*.5));
        last=temperature;
      }
      lever.setQuaternion(axisAngleToQuaternion(Z,-next.rotation));
      if(next.open!==open){
        bulb.setMaterial(next.open?lampOff:lampOn);
        open=next.open;
      }
      return next;
    },
  };
}
