import {
  boxGeometry, cylinderGeometry, sphereGeometry, torusGeometry,
  CatmullRomCurve3, tubeGeometry, mergeGeometries, applyMatrix4,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, createInstancedMesh, Material } from '@margoengine/materials';
import { blade, louvers, stampedRibs } from './coil-geometry.js';

const PI = Math.PI, TAU = PI * 2;
const row = (x,y,z,sx=1,sy=1,sz=1) => [sx,0,0,0,0,sy,0,0,0,0,sz,0,x,y,z,1];
const offset = (geometry,x,y,z) => applyMatrix4(geometry,row(x,y,z));
const clamp = (number, a, b) => Math.min(b, Math.max(a, number));

export function cutaway(engine, shadows, env) {
  const exploded = [], flows = [], fans = [], glows = [];
  const material = {
    silver: new Material({color:'#b7c5c7',roughness:.37,metalness:.74}),
    machined: new Material({color:'#879797',roughness:.42,metalness:.8}),
    painted: new Material({color:'#d3dbd7',roughness:.36,metalness:.29,clearcoat:.3}),
    black: new Material({color:'#222c32',roughness:.48,metalness:.28}),
    fan: new Material({color:'#435963',roughness:.41,metalness:.20,clearcoat:.16}),
    outdoorShell: new Material({color:'#45616c',roughness:.31,metalness:.32,clearcoat:.38}),
    indoorShell: new Material({color:'#9fa79a',roughness:.36,metalness:.42,clearcoat:.32}),
    outdoorFin: new Material({color:'#597c86',roughness:.50,metalness:.67,doubleSided:true}),
    indoorFin: new Material({color:'#899c9b',roughness:.48,metalness:.71,doubleSided:true}),
    stage: new Material({color:'#20343f',roughness:.79}),
    copper: new Material({color:[.91,.418,.188],roughness:.235,metalness:.94}),
    bronze: new Material({color:[.73,.47,.20],roughness:.325,metalness:.79}),
    gasket: new Material({color:'#172024',roughness:.84}),
  };
  const hot = new Material({color:'#df774e',emissive:[1,.22,.044],emissiveIntensity:2.1,roughness:.43});
  const cold = new Material({color:'#5599b4',emissive:[.04,.62,1],emissiveIntensity:1.85,roughness:.43});

  const stamp = (geometry, mat, name, xyz=[0,0,0], parent=null, dynamic=false) => {
    const mesh=createMesh(engine,geometry,mat);
    mesh.root.name=name;
    mesh.root.setPosition(xyz);
    if(parent) mesh.root.setParent(parent);
    env.add(mesh);
    shadows.add(mesh,{static:!parent && !dynamic});
    return mesh;
  };
  const group = (name, movement) => {
    const node=engine.createMesh();
    node.name=name;
    if(movement) exploded.push({node,offset:movement});
    return node;
  };
  const box = (w,h,d,mat,name,p,parent) => stamp(boxGeometry(w,h,d),mat,name,p,parent);
  const rounded = (w,h,d,r,mat,name,p,parent) => stamp(roundedBoxGeometry(w,h,d,3,r),mat,name,p,parent);
  const collar = (diameter,length,mat,name,p,parent) => {
    const mesh=stamp(cylinderGeometry(diameter,diameter,length,18,1),mat,name,p,parent);
    return mesh.root.setRotation([PI/2,0,0]);
  };
  const copperPipe=(points,name,parent,groupOffset,kind,radius=.027)=>{
    const curve=new CatmullRomCurve3(points,false,'centripetal');
    curve.arcLengthDivisions=points.length>24?280:110;
    const length=curve.getLength();
    stamp(tubeGeometry(curve,clamp(Math.ceil(length*26),22,340),radius,8),material.copper,name,[0,0,0],parent);
    const count=clamp(Math.round(length*6),4,46);
    const sample=curve.getSpacedPoints(clamp(Math.ceil(length*116),100,920));
    flows.push({sample,length,count,groupOffset,kind,radius});
    return curve;
  };
  rounded(5.12,.15,1.58,.07,material.black,'Anodized aluminum tray',[0,-.09,.1]);
  rounded(5.03,.075,1.50,.034,material.machined,'Brushed edge',[0,-.177,.1]);
  rounded(4.94,.085,1.42,.040,material.black,'Underside channel',[0,-.25,.1]);
  stamp(boxGeometry(600,.15,600),material.stage,'Studio surface',[0,-.425,0]);
  for (const x of [-2.12,-.95,.95,2.12]) for(const z of [-.51,.72]) {
    stamp(cylinderGeometry(.061,.071,.085,18,1),material.gasket,'Rubber mounting foot',[x,-.322,z]);
    stamp(cylinderGeometry(.036,.036,.019,6,1),material.silver,'Hex mounting bolt',[x,.006,z]);
  }
  const centerX=1.47;
  const brackets=mergeGeometries([-1,1].flatMap(side=>[
    offset(boxGeometry(1.53,.06,.86),side*centerX,.085,-.004),
    offset(boxGeometry(1.53,.045,.85),side*centerX,1.49,-.005),
    offset(boxGeometry(.045,1.42,.85),side*(centerX+.755),.788,-.005),
  ]));
  stamp(brackets,material.painted,'Folded exchanger housings');
  const gas = (side) => [side*.80,1.37,.41];
  const liquid = (side) => [side*.80,.236,.41];
  for(const side of [-1,1]){
    const cx=side*centerX;
    const movement=[side*.25, .23,-.11];
    const bank=group((side===-1?'Outdoor':'Indoor')+' exchanger cartridge', movement);
    const coilFront=.225;
    const shell = side<0 ? material.outdoorShell : material.indoorShell;
    const fin = side<0 ? material.outdoorFin : material.indoorFin;
    stamp(louvers(cx,coilFront,1.30,.234,1.185,83),fin,'Corrugated louvered aluminum plate fins',[0,0,0],bank);
    stamp(stampedRibs(cx,coilFront+.008,.247,1.31,55),fin,'Staggered forward fin edges',[0,0,0],bank);
    const contactFrames=mergeGeometries([
      offset(roundedBoxGeometry(1.35,.053,.42,2,.018),cx,.225,-.012),
      offset(roundedBoxGeometry(1.35,.050,.42,2,.018),cx,1.417,-.012),
      offset(roundedBoxGeometry(.056,1.24,.44,2,.017),cx+side*.673,.827,-.012),
    ]);
    stamp(contactFrames,material.machined,'Rolled cartridge frame',[0,0,0],bank);
    const edgeX=cx+side*.689, headerX=cx-side*.659;
    const sides=mergeGeometries([
      offset(roundedBoxGeometry(.035,1.15,.30,2,.010),headerX,.804,.016),
      offset(roundedBoxGeometry(.032,1.15,.33,2,.010),edgeX,.804,.005),
    ]);
    stamp(sides,material.silver,'Pierced header plates',[0,0,0],bank);
    for(const x of [headerX,edgeX]){
      for(let i=0;i<10;i++){
        const y=1.36-i*.124;
        const nipple=stamp(cylinderGeometry(.028,.031,.031,10,1),material.bronze,'Brazed tube collar',[x,y,.059],bank);
        nipple.root.setRotation([0,0,PI/2]);
      }
    }

    const tubing=group('Copper serpentine',[side*.13,.087,.55]);
    const points=[gas(side)];
    const inside=cx-side*.70, outside=cx+side*.70;
    points.push([inside-side*.047,1.385,.259]);
    for(let i=0;i<10;i++){
      const y=1.36-i*.124, forward=i%2===0;
      const a=forward?inside:outside,b=forward?outside:inside;
      points.push([a,y,.055],[b,y,.055]);
      if(i!==9){
        points.push([b+side*(forward?.059:-.056),y-.061,.055]);
      }
    }
    points.push([inside-side*.047,.247,.259],liquid(side));
    copperPipe(points,side<0?'Outdoor ten-pass copper circuit':'Indoor ten-pass copper circuit',tubing,
      [side*.13,.087,.55],side<0?'leftCoil':'rightCoil',.0135);

    const coverMovement=[side*.49, .59,-.16];
    const cover=group(side<0?'Outdoor folded service hood':'Indoor drain inspection cover',coverMovement);
    rounded(1.57,.108,.91,.047,shell,'Powder-coated service hood',[cx,1.57,-.036],cover);
    rounded(1.51,.036,.87,.016,material.gasket,'Compressed panel gasket',[cx,1.501,-.036],cover);
    box(1.51,.031,.033,material.silver,'Exposed rolled aluminium lip',[cx,1.523,.427],cover);
    const slotRow=mergeGeometries(Array.from({length:11},(_,i)=>
      offset(roundedBoxGeometry(.056,.010,.287,2,.004),cx-.62+i*.124,1.628,-.102)));
    stamp(slotRow,material.gasket,'Pressed ventilation louvers',[0,0,0],cover);
    for(const x of [cx-.60,cx+.60]) for(const z of [.295,-.34])
      stamp(cylinderGeometry(.021,.023,.008,14,1),material.silver,'Recessed captive screw',[x,1.628,z],cover);
    const casework=mergeGeometries([
      offset(roundedBoxGeometry(.093,1.29,.071,2,.026),cx+side*.733,.819,.428),
      offset(roundedBoxGeometry(1.53,.083,.073,2,.023),cx,.165,.423),
      offset(roundedBoxGeometry(1.52,.077,.070,2,.021),cx,1.466,.423),
    ]);
    stamp(casework,shell,'Folded cabinet lip');
    if(side<0){
      const fanMount=group('Axial fan assembly',[-.58,.16,1.10]);
      const fanCenter=[cx-.075,.837,.438];
      stamp(torusGeometry(.515,.047,12,55),material.black,'Glass-filled fan shroud',fanCenter,fanMount);
      for(const radius of [.414,.483,.548]){
        stamp(torusGeometry(radius,.0065,7,56),material.silver,'Welded fan guard ring',
          [fanCenter[0],fanCenter[1],fanCenter[2]+.082],fanMount);
      }
      for(const angle of [0,PI/2,PI/4,-PI/4]){
        stamp(boxGeometry(.012,1.086,.012),material.black,'Fan guard support',
          [fanCenter[0],fanCenter[1],fanCenter[2]+.076],fanMount).root.setRotation([0,0,angle]);
      }
      const hub=group('Axial fan rotor');
      hub.setPosition(fanCenter).setParent(fanMount);
      collar(.123,.121,material.black,'Fan motor hub',[0,0,-.005],hub);
      collar(.063,.028,material.machined,'Machined shaft cap',[0,0,.07],hub);
      const sweptBlade=blade();
      for(let i=0;i<5;i++){
        const part=stamp(sweptBlade,material.fan,'Molded airfoil fan blade',[0,0,0],hub);
        part.root.setRotation([0,0,TAU*i/5]);
      }
      fans.push(hub);
    }else{
      const drain=group('Condensate tray',[.32,.08,.89]);
      rounded(1.49,.10,.55,.041,material.black,'Molded condensate trough',[cx,.10,.291],drain);
      rounded(1.37,.019,.475,.008,material.machined,'Sump mesh insert',[cx,.15,.276],drain);
      const condensate=stamp(cylinderGeometry(.034,.041,.124,14,1),material.gasket,'Barbed condensate outlet',
        [cx+.709,.11,.38],drain);
      condensate.root.setRotation([0,0,PI/2]);
    }
    const lamp=box(.112,.012,.018,new Material({
      color:'#344953',emissive:side<0?[.04,.62,1]:[1,.22,.044],emissiveIntensity:1.4,
    }),'Cycle indication',[cx+.44,1.456,.465]);
    glows.push(lamp);
  }

  const body=[0,.398,.49];
  collar(.227,.07,material.black,'Motor housing front',body);
  stamp(cylinderGeometry(.221,.221,.60,36,1),material.black,'Hermetic compressor cylinder',[0,.353,.472]);
  stamp(sphereGeometry(1,28,14),material.black,'Dished compressor lid',[0,.656,.472]).root.setScale([.221,.119,.221]);
  stamp(sphereGeometry(1,28,14),material.black,'Dished compressor base',[0,.072,.472]).root.setScale([.221,.069,.221]);
  for(const y of [.116,.136,.155,.174]) stamp(torusGeometry(.22,.008,7,32),material.machined,'Compressor cooling band',[0,y,.472])
    .root.setRotation([PI/2,0,0]);
  for(const x of [-.188,.188]) {
    box(.19,.07,.33,material.machined,'Compressor saddle',[x,.064,.467]);
    stamp(cylinderGeometry(.038,.038,.022,6,1),material.silver,'Saddle bolt',[x*1.23,.106,.615]);
  }
  box(.136,.068,.014,material.machined,'Compressor identification plate',[0,.409,.708]);
  const valveY=1.095;
  const valve=stamp(cylinderGeometry(.067,.067,.548,24,1),material.bronze,'Four-way reversing valve',[0,valveY,.558]);
  valve.root.setRotation([0,0,PI/2]);
  for(const x of [-.274,-.229,.23,.274]) collar(.077,.036,material.silver,'Valve union',[x,valveY,.556]).setRotation([0,0,PI/2]);
  box(.13,.095,.06,material.black,'Valve solenoid',[.219,1.162,.566]);
  const blank=[0,0,0];
  copperPipe([[.056,.73,.487],[.055,.862,.515],[.0,.943,.557],[-.006,1.066,.558]],'Compressor discharge',null,blank,'discharge');
  copperPipe([[.007,1.068,.562],[.152,.987,.566],[.20,.799,.51],[.17,.632,.566]],'Compressor return',null,blank,'return');
  for(const side of [-1,1]){
    copperPipe([[side*.18,1.109,.559],[side*.296,1.16,.543],[side*.41,1.30,.409],
      [side*.61,1.39,.408],gas(side)],'Coil gas line',null,blank,side<0?'leftGas':'rightGas');
    copperPipe([liquid(side),[side*.574,.225,.425],[side*.404,.188,.57],[side*.32,.176,.727],
      [side*.191,.176,.746],[side*.044,.176,.746]],'Expansion device line',null,blank,side<0?'leftLiquid':'rightLiquid',.020);
    for(const [x,y,z] of [gas(side),liquid(side)]) collar(.036,.037,material.bronze,'Flared refrigerant union',[x,y,z])
      .setRotation([0,0,PI/2]);
  }
  const expansion=stamp(cylinderGeometry(.052,.052,.13,12,1),material.bronze,'Bi-flow expansion device',[0,.176,.746]);
  expansion.root.setRotation([0,0,PI/2]);
  collar(.045,.050,material.silver,'Expansion actuator',[0,.209,.762]);
  const capacity=flows.reduce((count,flow)=>count+flow.count,0);
  const glowGeometry=sphereGeometry(1,8,5);
  const high=createInstancedMesh(engine,glowGeometry,hot,capacity);
  const low=createInstancedMesh(engine,glowGeometry,cold,capacity);
  const highRows=new Float32Array(capacity*16), lowRows=new Float32Array(capacity*16);
  const hide=row(0,-10,0,.001,.001,.001);
  const term={
    discharge:[1,1],return:[1,0],leftGas:[-1,0],rightGas:[1,1],
    leftCoil:[-1,0],rightCoil:[1,1],leftLiquid:[-1,0],rightLiquid:[1,1],
  };
  function flow(time,amount,heating,tracing){
    let at=0;
    for(const path of flows){
      const {sample,length,count,groupOffset,kind,radius}=path, last=sample.length-1;
      let [direction,pressure]=term[kind];
      if(!heating && kind!=='discharge' && kind!=='return'){ direction=-direction; pressure=1-pressure; }
      const show=pressure?highRows:lowRows, hideRows=pressure?lowRows:highRows;
      for(let i=0;i<count;i++){
        const t=(i/count+time*.84/length*direction+10000)%1*last;
        const current=sample[Math.floor(t)], next=sample[Math.min(last,Math.ceil(t))], w=t%1;
        const xyz=current.map((value,j)=>value+(next[j]-value)*w+groupOffset[j]*amount);
        const r=radius*(i%3===0?1.29:1.13);
        const coil=kind.endsWith('Coil');
        const lift=tracing&&coil?.22*(1-amount):0;
        show.set(tracing || !coil ? row(xyz[0],xyz[1],xyz[2]+lift,r,r,r) : hide,at*16);
        hideRows.set(hide,at*16);
        at++;
      }
    }
    high.instances.setMatrices(0,highRows);
    low.instances.setMatrices(0,lowRows);
  }
  function changeMode(heating){
    glows[0].material.emissive=heating?[.04,.62,1]:[1,.22,.044];
    glows[1].material.emissive=heating?[1,.22,.044]:[.04,.62,1];
  }
  return { exploded, flow, fans, changeMode };
}



