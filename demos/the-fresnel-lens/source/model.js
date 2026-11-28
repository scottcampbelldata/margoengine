import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { baseDepth, focalDistance, targetPlane, targetRadius, traceFacet } from './optics.js';
import { installLight } from './light.js';

const h=.393;
const axial=axisAngleToQuaternion([0,0,1],Math.PI/2);
const yaw=(a)=>axisAngleToQuaternion([0,1,0],a);

function ringShape(inner,outer,width,bevel,sides=96){
  const t=width/2;
  return latheGeometry([
    [inner+bevel,-t],[outer-bevel,-t],[outer,-t+bevel],[outer,t-bevel],[outer-bevel,t],
    [inner+bevel,t],[inner,t-bevel],[inner,-t+bevel],[inner+bevel,-t],
  ],sides);
}

export function createLantern(engine,shadows){
  const finish=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const floor=finish('#655f66',.86);
  const timber=finish('#4e3a39',.58);
  const deck=finish('#6d5144',.49);
  const navy=finish('#35414c',.53);
  const bronze=finish('#a8804e',.40,.73);
  const brass=finish('#c4a067',.29,.79);
  const polished=finish('#dfc88f',.24,.54);
  const verdigris=finish('#466f63',.56);
  const blue=finish('#49636b',.37);
  const porcelain=finish('#d0bb96',.57);
  const dark=finish('#3a3a41',.66);
  const marks=finish('#dec8a8',.55);
  const cache=new WeakMap();
  const light=installLight(engine);
  const fixed={cast:true};
  let meshes=0;
  function mount(data,material,at,{parent,rotation,cast}={}){
    if(!cache.has(data))cache.set(data,toGeometry(data));
    const mesh=engine.createMesh(parent).setGeometry(cache.get(data)).setMaterial(material).setPosition(at);
    if(rotation)mesh.setQuaternion(rotation);
    if(cast)shadows.add(mesh,{static:true});
    meshes++;
    return mesh;
  }
  const shape=(w,y,z,r)=>roundedBoxGeometry(w,y,z,3,r);
  const box=(dims,r,mat,at,options)=>mount(shape(...dims,r),mat,at,options);
  const disc=(r,d,mat,at,options)=>mount(cylinderGeometry(r,r,d,56,1),mat,at,options);
  const ring=(r0,r1,d,b,mat,at,options)=>mount(ringShape(r0,r1,d,b),mat,at,options);

  box([44,.10,44],.02,floor,[0,-.133,0]);
  box([1.658,.071,.861],.036,navy,[-.058,-.016,0],fixed);
  box([1.644,.012,.842],.005,bronze,[-.058,.017,0]);
  box([1.619,.067,.821],.029,timber,[-.058,.044,0],fixed);
  box([1.585,.012,.789],.005,deck,[-.058,.077,0]);
  for(const x of [-.746,.625])for(const z of [-.308,.308]){
    disc(.047,.028,dark,[x,-.066,z],fixed);
    disc(.010,.004,bronze,[x,.085,z]);
  }
  // Long dovetail and calibrated brass rail support the moving burner.
  box([.706,.032,.212],.013,navy,[-.482,.095,0],fixed);
  box([.691,.009,.162],.004,bronze,[-.481,.115,0]);
  for(const z of [-.082,.082]){
    disc(.014,.686,polished,[-.483,.123,z],{rotation:axial});
    for(const sx of [-.806,-.172])box([.047,.032,.049],.008,navy,[sx,.130,z],fixed);
  }
  box([.430,.007,.068],.003,dark,[-.483,.087,.171]);
  const tick=shape(.0025,.0017,.020,.0006);
  for(let mm=290;mm<=660;mm+=10){
    const significant=mm%50===0;
    mount(tick,significant?marks:bronze,[-mm/1000,.092,significant?.174:.166])
      .setScale([significant?1.45:1,1,significant?1.3:.74]);
  }
  box([.007,.004,.039],.001,verdigris,[-focalDistance,.096,.172]);

  const carriage=engine.createMesh();
  const along={parent:carriage};
  const slide=box([.145,.025,.194],.010,navy,[-.032,.135,0],along);
  shadows.add(slide);
  for(const z of [-.075,.075])box([.122,.032,.039],.009,bronze,[-.035,.144,z],along);
  box([.007,.004,.060],.0015,polished,[0,.125,.137],along);
  box([.064,.038,.067],.012,verdigris,[-.018,.171,0],along);
  const burner=latheGeometry([
    [0,-.070],[.045,-.070],[.049,-.063],[.032,-.050],[.033,-.022],[.046,-.013],
    [.049,-.004],[.037,.008],[.033,.038],[.026,.045],[0,.048],
  ],60);
  const crown=mount(burner,bronze,[-.018,.274,0],along);
  shadows.add(crown);
  ring(.018,.039,.012,.003,polished,[-.018,.328,0],along);
  disc(.021,.034,porcelain,[-.013,.350,0],along);
  ring(.016,.024,.013,.002,brass,[-.011,.368,0],along);
  const filament=engine.createMesh(carriage).setPosition([0,h,0]);
  light.plate(filament,.023,5);
  for(const z of [-.031,.031]){
    box([.010,.088,.009],.003,bronze,[-.027,.383,z],along);
  }
  disc(.043,.010,brass,[-.023,.427,0],along);
  disc(.035,.010,dark,[-.023,.436,0],along);

  // Nautical lens cell with two outriggers and a sprung brass bezel.
  box([.205,.023,.326],.012,navy,[.014,.095,0],fixed);
  box([.158,.028,.285],.010,verdigris,[.022,.119,0],fixed);
  for(const z of [-.128,.128]){
    box([.059,.155,.065],.014,verdigris,[.022,.201,z],fixed);
    disc(.036,.024,bronze,[.027,.131,z]);
  }
  const cradleA=latheGeometry([
    [.210,-.034],[.230,-.034],[.238,-.022],[.238,.030],[.232,.037],[.210,.037],
    [.207,.027],[.207,-.026],[.210,-.034],
  ],72,Math.PI*.43,Math.PI*1.14);
  mount(cradleA,verdigris,[.011,h,0],{rotation:axial,cast:true});
  ring(.199,.218,.060,.006,bronze,[.009,h,0],{rotation:axial,cast:true});
  ring(.198,.214,.010,.0026,polished,[.042,h,0],{rotation:axial});
  ring(.200,.220,.010,.003,brass,[-.025,h,0],{rotation:axial});
  for(const side of [-1,1]){
    box([.058,.071,.057],.011,bronze,[.012,h,side*.225],fixed);
    disc(.022,.021,polished,[.012,h,side*.252],{rotation:axisAngleToQuaternion([1,0,0],Math.PI/2)});
  }
  const bolt=cylinderGeometry(.0068,.0068,.004,20,1);
  for(let i=0;i<12;i++){
    const angle=(i+.5)*Math.PI/6;
    mount(bolt,brass,[.048,h+.207*Math.cos(angle),.207*Math.sin(angle)],{rotation:axial});
  }
  const glass=engine.createMesh().setPosition([0,h,0]);
  light.lens(glass);

  // Ruled translucent receiver at the plane where the ray positions are compared.
  const frameX=targetPlane+.008;
  for(const z of [-.317,.317]){
    box([.104,.019,.081],.007,navy,[frameX,.093,z],fixed);
    box([.029,.622,.024],.006,blue,[frameX,.393,z],fixed);
    box([.006,.582,.011],.002,brass,[frameX+.016,.392,z]);
  }
  box([.027,.023,.652],.006,blue,[frameX,.705,0],fixed);
  box([.020,.005,.623],.002,brass,[frameX,.718,0]);
  box([.026,.018,.650],.006,navy,[frameX,.094,0],fixed);
  const receiver=engine.createMesh().setPosition([targetPlane+.001,h,0]);
  light.plate(receiver,.311,7);
  const ruler=shape(.0021,.0045,.013,.0007);
  for(let i=-6;i<=6;i++)mount(ruler,i%3===0?marks:bronze,[frameX-.012,.112,i*.047]);
  box([.129,.009,.064],.004,dark,[.399,.086,.268]);
  box([.101,.0016,.003],.0006,polished,[.396,.092,.282]);
  box([.067,.0016,.002],.0006,marks,[.415,.092,.268]);

  // Every visible segment uses the same planar entry and conical exit solved by optics.js.
  const rays=[];
  function ray(index,phi){
    const pieces=[engine.createMesh(),engine.createMesh(),engine.createMesh()];
    pieces.forEach((part,i)=>light.beam(part,i!==2));
    const hit=engine.createMesh();
    light.plate(hit,.012,6);
    rays.push({index,phi,pieces,hit});
  }
  ray(null,0);
  for(const index of [0,2,4,6,9]){
    ray(index,.98);
    ray(index,.98+Math.PI);
  }
  for(const index of [4,9]){
    ray(index,0);
    ray(index,Math.PI);
  }
  function segment(anchor,from,to,width){
    const [x,y,z]=to.map((value,i)=>value-from[i]);
    const distance=Math.hypot(x,y,z);
    const axis=Math.hypot(x,y);
    const q=axisAngleToQuaternion([-y/axis,x/axis,0],Math.acos(z/distance));
    anchor.setPosition(from).setQuaternion(q).setScale([width,width,distance]);
  }
  return {
    meshes:meshes+4*rays.length+3,
    ready:light.ready,
    update(distance){
      const source=[-distance,h,0];
      carriage.setPosition([-distance,0,0]);
      for(const {index,phi,pieces,hit} of rays){
        const ray=index===null?{entry:0,depth:baseDepth,exit:0,exterior:0}:traceFacet(distance,index);
        const u=Math.sin(phi),v=Math.cos(phi);
        const xyz=(x,r)=>[x,h+r*u,r*v];
        const start=xyz(0,ray.entry),exit=xyz(ray.depth,ray.exit);
        const landing=xyz(targetPlane,targetRadius(ray));
        segment(pieces[0],source,start,.0056);
        segment(pieces[1],start,exit,.0054);
        segment(pieces[2],exit,landing,.0066);
        hit.setPosition(landing);
      }
    },
  };
}
