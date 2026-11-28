import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { displayedOrders,radians,rulerLimit,spectralColor } from './optics.js';
import { attachMarks } from './marks.js';

const zCenter = .017;
const beamHeight = .232;
const radius = .57;
const origin = [0,beamHeight,zCenter];
const vertical = axisAngleToQuaternion([1,0,0],Math.PI/2);
const yaw = (angle) => axisAngleToQuaternion([0,1,0],angle);

function arc(inside, outside, low, high, bevel) {
  return latheGeometry([
    [inside+bevel,low],[outside-bevel,low],[outside,low+bevel],[outside,high-bevel],
    [outside-bevel,high],[inside+bevel,high],[inside,high-bevel],[inside,low+bevel],[inside+bevel,low],
  ],120,Math.PI-rulerLimit,2*rulerLimit);
}

function annulus(inside,outside,depth) {
  const b = .0017;
  const half = depth/2;
  return latheGeometry([
    [inside+b,-half],[outside-b,-half],[outside,-half+b],[outside,half-b],[outside-b,half],
    [inside+b,half],[inside,half-b],[inside,-half+b],[inside+b,-half],
  ],64);
}

const numeral = ['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
const strokes = {
  a:[0,.006,true], b:[.0043,.003,false], c:[.0043,-.003,false], d:[0,-.006,true],
  e:[-.0043,-.003,false], f:[-.0043,.003,false], g:[0,0,true],
};

export function createRuler(engine,shadows) {
  const finish = (color,roughness,metalness=0) => new PbrMaterial({color,roughness,metalness});
  const background = finish('#626276',.88);
  const graphite = finish('#363238',.52);
  const plum = finish('#603d47',.42);
  const leather = finish('#463848',.67);
  const receptor = finish('#303238',.77);
  const bronze = finish('#be9067',.33,1);
  const steel = finish('#b7c4c6',.31,1);
  const oxide = finish('#845849',.41);
  const ivory = finish('#d8d1b8',.65);
  const smoked = finish('#414857',.39);
  const beamColor = finish([.13,.87,.40],.58);
  const geometry = new WeakMap();
  let count = 0;
  function mount(data,material,at,{parent,rotation,cast}={}) {
    if(!geometry.has(data))geometry.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(geometry.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    count++;
    return mesh;
  }
  const block = (w,h,d,b) => roundedBoxGeometry(w,h,d,3,b);
  const box = (dims,b,material,at,options) => mount(block(...dims,b),material,at,options);
  const disc = (r,d,material,at,options) => mount(cylinderGeometry(r,r,d,52,1),material,at,options);
  const fixed = {cast:true};
  const curve = (inner,outer,low,high,b,material,cast) =>
    mount(arc(inner,outer,low,high,b),material,[0,0,zCenter],{cast});
  const polar = (r,angle,y) => [r*Math.sin(angle),y,zCenter-r*Math.cos(angle)];

  box([56,.12,56],.023,background,[0,-.116,0]);
  box([1.35,.066,1.16],.031,graphite,[0,-.003,-.062],fixed);
  box([1.312,.008,1.127],.0038,steel,[0,.029,-.062]);
  box([1.29,.019,1.104],.0088,plum,[0,.039,-.062]);
  for(const x of [-.522,.522])for(const z of [-.526,.391])disc(.046,.035,graphite,[x,-.036,z],fixed);

  // A heavy curved receiver keeps every marker at the same distance from the grating.
  curve(radius-.018,radius+.049,.049,.122,.010,graphite,true);
  curve(radius+.002,radius+.036,.118,.322,.008,leather,true);
  curve(radius,radius+.018,.146,.309,.005,receptor);
  curve(radius-.010,radius+.042,.311,.336,.008,bronze,true);
  curve(radius-.007,radius+.027,.130,.154,.005,steel);
  for(const angle of [-rulerLimit,rulerLimit]){
    box([.026,.225,.060],.010,plum,polar(radius+.009,angle,.225),{rotation:yaw(-angle),cast:true});
    box([.010,.183,.040],.004,bronze,polar(radius-.003,angle,.230),{rotation:yaw(-angle)});
  }
  const long=block(.0019,.019,.0023,.0006);
  const short=block(.0013,.010,.0017,.0005);
  for(let step=-70;step<=70;step+=5){
    const major = step%15===0;
    const angle = step*radians;
    mount(major?long:short,major?ivory:oxide,polar(radius-.002,angle,major?.292:.296),{rotation:yaw(-angle)});
  }
  const dash = block(.0083,.0018,.0014,.0005);
  const upright = block(.0018,.0070,.0014,.00045);
  for(let degree=-60;degree<=60;degree+=15){
    const angle = degree*radians;
    const sign = engine.createMesh().setPosition(polar(radius-.003,angle,.269)).setQuaternion(yaw(-angle));
    const number=String(Math.abs(degree));
    for(const [i,digit] of Array.from(number).entries()){
      const center=(i-(number.length-1)/2)*.0155;
      for(const key of numeral[Number(digit)]){
        const [x,y,horizontal]=strokes[key];
        mount(horizontal?dash:upright,ivory,[center+1.20*x,1.20*y,0],{parent:sign});
      }
    }
  }

  // Dovetail bench and precisely centered single-wavelength source.
  for(const x of [-.050,.050]){
    box([.022,.016,.508],.006,graphite,[x,.055,.242],fixed);
    box([.009,.006,.488],.0028,steel,[x,.064,.242]);
  }
  for(const z of [.187,.405]){
    box([.150,.038,.062],.011,leather,[0,.082,z],fixed);
    box([.082,.119,.048],.015,plum,[0,.140,z],fixed);
  }
  disc(.074,.126,graphite,[0,beamHeight,.378],{rotation:vertical,cast:true});
  mount(annulus(.044,.065,.010),bronze,[0,beamHeight,.442],{rotation:vertical});
  disc(.038,.006,leather,[0,beamHeight,.448],{rotation:vertical});
  for(let i=0;i<7;i++)mount(annulus(.068,.080,.0058),plum,[0,beamHeight,.331+.014*i],{rotation:vertical});
  mount(annulus(.020,.070,.021),bronze,[0,beamHeight,.312],{rotation:vertical,cast:true});
  mount(annulus(.006,.030,.0057),steel,[0,beamHeight,.298],{rotation:vertical});
  disc(.007,.004,beamColor,[0,beamHeight,.297],{rotation:vertical});

  const frame=engine.createMesh().setPosition(origin);
  box([.160,.025,.088],.008,graphite,[0,.079,zCenter],fixed);
  box([.063,.088,.041],.011,plum,[0,.128,zCenter],fixed);
  for(const x of [-.066,.066])box([.018,.146,.017],.005,bronze,[x,0,0],{parent:frame});
  for(const y of [-.067,.067])box([.140,.018,.019],.006,bronze,[0,y,0],{parent:frame});
  box([.097,.100,.006],.0027,smoked,[0,0,.007],{parent:frame});
  const ruling=block(.0012,.087,.0015,.00035);
  for(let i=-7;i<=7;i++)if(i!==0)mount(ruling,ivory,[i*.0054,0,.011],{parent:frame});
  box([.033,.009,.026],.0037,oxide,[0,.083,0],{parent:frame});
  const cartridge=engine.createMesh(frame).setPosition([0,.078,.017]);
  box([.013,.018,.005],.0018,ivory,[0,0,0],{parent:cartridge});

  // Grip wheel, recessed plate and attachment fasteners.
  box([.181,.007,.091],.003,graphite,[.356,.053,.326]);
  box([.110,.0018,.0026],.0006,ivory,[.337,.057,.348]);
  box([.070,.0014,.0018],.0005,steel,[.319,.058,.334]);
  const wheel=engine.createMesh().setPosition([.414,.079,.308]);
  disc(.040,.021,bronze,[0,0,0],{parent:wheel});
  disc(.028,.005,leather,[0,.012,0],{parent:wheel});
  box([.0035,.002,.022],.00065,ivory,[0,.016,.016],{parent:wheel});
  const bolt=cylinderGeometry(.007,.007,.004,18,1);
  const slot=block(.009,.0011,.0018,.0004);
  for(const x of [-.532,.532])for(const z of [-.397,.370]){
    mount(bolt,bronze,[x,.054,z]);mount(slot,graphite,[x,.0565,z],{rotation:yaw(x*3+z)});
  }

  const rayShape=cylinderGeometry(.0029,.0029,1,12,1);
  const beamMaterial = beamColor;
  const sourceBeam=mount(rayShape,beamMaterial,origin);
  const rayMeshes=Array.from({length:11},()=>mount(rayShape,beamMaterial,origin));
  const anchors=Array.from({length:11},()=>engine.createMesh());
  const lights=attachMarks(engine,anchors);
  function aim(mesh,from,to){
    const offset=to.map((value,i)=>value-from[i]);
    const length=Math.hypot(...offset);
    mesh.setPosition(from.map((value,i)=>(value+to[i])/2)).setQuaternion(axisAngleToQuaternion(
      [offset[2]/length,0,-offset[0]/length],Math.PI/2)).setScale([1,length,1]);
  }
  aim(sourceBeam,[0,beamHeight,.296],origin);
  return{
    meshes:count+anchors.length,
    ready:lights.ready,
    update(wavelength,density){
      const spectral=spectralColor(wavelength);
      beamMaterial.set({color:spectral.map((value)=>.12+.76*value)});
      lights.update(spectral.map((value)=>.09+.80*value));
      wheel.setQuaternion(yaw((wavelength-420)*.022));
      cartridge.setPosition([(density===450?-.035:density===650?0:.035),.078,.017]);
      const orders=displayedOrders(wavelength,density);
      for(let i=0;i<rayMeshes.length;i++){
        const active=orders[i];
        rayMeshes[i].visible=lights.marks[i].visible=!!active;
        if(!active)continue;
        const theta=active.angle;
        const landing=polar(radius-.0018,theta,beamHeight);
        aim(rayMeshes[i],origin,landing);
        anchors[i].setPosition(polar(radius-.004,theta,beamHeight)).setQuaternion(yaw(-theta));
      }
    },
  };
}
