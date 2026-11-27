import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { radians, reflectionDirection } from './optics.js';
import { installLight } from './light.js';

const height=.234;
const zCenter=.036;
const pivot=[0,height,zCenter];
const detectorRange=.419;
const axial=axisAngleToQuaternion([1,0,0],Math.PI/2);
const yaw=(theta)=>axisAngleToQuaternion([0,1,0],theta);

function ringShape(inner,outer,depth,bevel,sides=80){
  const t=depth/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

export function createSplitter(engine,shadows){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const table=finish('#667883',.88);
  const outer=finish('#353c48',.48);
  const marine=finish('#2d5a67',.41);
  const glazed=finish('#476a76',.31);
  const polished=finish('#b9c6c9',.24,1);
  const gray=finish('#32383c',.50);
  const rubber=finish('#394147',.76);
  const mark=finish('#ddd4bd',.56);
  const bronze=finish('#c19562',.35,1);
  const titanium=finish('#95a5b3',.39,1);
  const rust=finish('#985b40',.39);
  const detector=finish('#3d4e58',.72);
  const cached=new WeakMap();
  let meshes=0;
  const glass=installLight(engine);
  function mount(data,material,at,{parent,rotation,cast}={}){
    if(!cached.has(data))cached.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cached.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const block=(w,h,d,b)=>roundedBoxGeometry(w,h,d,3,b);
  const box=(dims,b,material,where,options)=>mount(block(...dims,b),material,where,options);
  const disc=(r,d,material,where,options)=>mount(cylinderGeometry(r,r,d,48,1),material,where,options);
  const ring=(r0,r1,d,b,material,where,options)=>mount(ringShape(r0,r1,d,b),material,where,options);
  const fixed={cast:true};

  box([60,.12,60],.018,table,[0,-.116,0]);
  const shell=latheGeometry([[0,-.034],[.555,-.034],[.608,-.024],[.626,-.007],[.626,.028],[.605,.046],[0,.046]],8,Math.PI/8);
  mount(shell,outer,[0,0,0],fixed).setScale([1,1,1.05]);
  const lip=latheGeometry([[0,.044],[.599,.044],[.611,.054],[.588,.061],[0,.061]],8,Math.PI/8);
  mount(lip,polished,[0,0,0]).setScale([1,1,1.05]);
  const deck=latheGeometry([[0,.058],[.580,.058],[.593,.066],[.581,.073],[0,.073]],8,Math.PI/8);
  mount(deck,marine,[0,0,0]).setScale([1,1,1.05]);
  for(const x of [-.374,.374])for(const z of [-.365,.365])disc(.039,.033,rubber,[x,-.043,z],fixed);

  // A curved metal track supports the reflected receiver as the plate turns.
  const track=latheGeometry([
    [.377,.069],[.462,.069],[.470,.078],[.470,.090],[.461,.096],[.386,.096],[.377,.087],[.377,.069],
  ],100,37*radians,96*radians);
  mount(track,gray,[0,0,zCenter],fixed);
  const guide=latheGeometry([
    [.411,.091],[.431,.091],[.436,.096],[.432,.104],[.411,.104],[.407,.099],[.411,.091],
  ],100,37*radians,96*radians);
  mount(guide,bronze,[0,0,zCenter]);
  const tick=block(.0024,.0016,.014,.0005);
  for(let degrees=40;degrees<=130;degrees+=5){
    const angle=degrees*radians;
    mount(tick,degrees%10===0?mark:titanium,[.452*Math.sin(angle),.097,zCenter+.452*Math.cos(angle)],
      {rotation:yaw(angle)});
  }

  // Center turret and glass lips. The clear aperture is an independent translucent Margo surface.
  box([.242,.012,.223],.006,outer,[0,.079,zCenter],fixed);
  disc(.103,.019,glazed,[0,.094,zCenter],fixed);
  ring(.075,.107,.008,.002,bronze,[0,.107,zCenter]);
  const turntable=engine.createMesh().setPosition([0,0,zCenter]);
  const pointer=block(.013,.004,.046,.0012);
  mount(pointer,mark,[0,.112,.080],{parent:turntable});
  box([.082,.025,.045],.007,gray,[0,.120,0],{parent:turntable});
  const frame=engine.createMesh(turntable).setPosition([0,height,0]);
  for(const x of [-.088,.088]){
    box([.022,.199,.023],.006,polished,[x,0,0],{parent:frame});
    box([.006,.176,.018],.0023,glazed,[x+.004,0,.006],{parent:frame});
  }
  for(const y of [-.088,.088]){
    box([.185,.023,.020],.006,titanium,[0,y,0],{parent:frame});
    box([.168,.006,.016],.002,bronze,[0,y+.006,.008],{parent:frame});
  }
  box([.063,.030,.047],.009,marine,[0,-.108,0],{parent:frame});
  box([.032,.009,.009],.003,rust,[0,.100,.004],{parent:frame});
  const coating=engine.createMesh(frame).setPosition([0,0,.002]);
  glass.panel(coating,.079,.080,3);

  // White collimator at the front of the optical axis.
  box([.207,.024,.231],.009,gray,[0,.084,.373],fixed);
  for(const x of [-.062,.062])box([.019,.010,.222],.003,titanium,[x,.098,.373]);
  for(const z of [.295,.437]){
    box([.103,.104,.055],.012,glazed,[0,.154,z],fixed);
    disc(.044,.015,bronze,[0,.104,z]);
  }
  disc(.074,.166,outer,[0,height,.367],{rotation:axial,cast:true});
  for(let i=0;i<7;i++) ring(.070,.079,.007,.0019,glazed,[0,height,.312+.015*i],{rotation:axial});
  ring(.024,.074,.023,.004,polished,[0,height,.284],{rotation:axial,cast:true});
  ring(.012,.036,.007,.0016,bronze,[0,height,.269],{rotation:axial});
  disc(.015,.003,mark,[0,height,.263],{rotation:axial});
  ring(.036,.067,.010,.002,bronze,[0,height,.453],{rotation:axial});
  disc(.033,.007,rubber,[0,height,.461],{rotation:axial});

  function receiver(kind,moving,z){
    const support=engine.createMesh().setPosition([0,0,z]);
    const cast=(mesh)=>{if(moving)shadows.add(mesh);else shadows.add(mesh,{static:true});};
    cast(box([.125,.027,.101],.008,outer,[0,.113,0],{parent:support}));
    cast(box([.065,.132,.072],.018,glazed,[0,.167,-.025],{parent:support}));
    cast(box([.148,.141,.039],.016,outer,[0,height,-.022],{parent:support}));
    box([.131,.124,.008],.005,polished,[0,height,-.001],{parent:support});
    box([.115,.103,.008],.004,detector,[0,height,.004],{parent:support});
    const screen=engine.createMesh(support).setPosition([0,height,.009]);
    glass.panel(screen,.055,.049,kind);
    box([.071,.008,.010],.0025,bronze,[0,height-.057,.008],{parent:support});
    return support;
  }
  receiver(4,false,zCenter-.394);
  const reflected=receiver(5,true,zCenter);
  // Indicators engraved beside the track, with restrained brushed-metal secondary surfaces.
  box([.151,.007,.063],.003,gray,[-.284,.077,.260]);
  box([.105,.0017,.0024],.0006,mark,[-.291,.081,.269]);
  box([.068,.0013,.0018],.0005,polished,[-.306,.081,.253]);
  const key=disc(.034,.021,bronze,[-.300,.090,.119],fixed);
  disc(.025,.005,rust,[-.300,.103,.119]);
  const screw=cylinderGeometry(.007,.007,.004,16,1);
  for(const x of [-.422,.421])for(const z of [-.266,.300])
    mount(screw,bronze,[x,.073,z]);

  const beams=Array.from({length:3},()=>engine.createMesh());
  beams.forEach((anchor,index)=>glass.beam(anchor,index));
  function beam(anchor,from,to,width){
    const x=to[0]-from[0],z=to[2]-from[2];
    anchor.setPosition(from).setQuaternion(yaw(Math.atan2(x,z))).setScale([width,width,Math.hypot(x,z)]);
  }
  beam(beams[0],[0,height,.264],pivot,.017);
  beam(beams[1],pivot,[0,height,zCenter-.385],.017);
  return {
    meshes:meshes+6,
    ready:glass.ready,
    update(degrees,spectrum){
      turntable.setQuaternion(yaw(degrees*radians));
      key.setQuaternion(yaw(degrees*radians*3));
      const [x,,z]=reflectionDirection(degrees);
      reflected.setPosition([x*detectorRange,0,zCenter+z*detectorRange]).setQuaternion(yaw(2*degrees*radians+Math.PI));
      beam(beams[2],pivot,[x*(detectorRange-.011),height,zCenter+z*(detectorRange-.011)],.017);
      glass.update(spectrum);
    },
  };
}
