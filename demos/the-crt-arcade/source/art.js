import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { cylinderGeometry,torusGeometry,sphereGeometry } from '@margoengine/geometry';
import { course,elevation,laneWidth } from './flight.js';

const coat=(color,roughness=.55,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const material={
  tile:coat('#34495a',.9),surface:coat('#3c5467',.76),cut:coat('#26384b',.83),shadow:coat('#253648',.85),
  structural:coat('#53778a',.64,.36),gunmetal:coat('#4b667b',.43,.43),edge:coat('#7b9eaa',.6,.25),
  rubber:coat('#272e43',.73),iron:coat('#536579',.32,.21),cyan:coat('#79dcce',.48),
  white:coat('#b7ccc4',.37,.14),ice:coat('#b2e6d5',.46),port:coat('#bb846b',.69),
  brass:coat('#deb78a',.54,.10),copper:coat('#c87f61',.52,.17),red:coat('#a65c68',.4),
  graphite:coat('#363548',.48,.17),glass:coat('#48768d',.18,.21),bright:coat('#9de2de',.27),
  shadowMark:coat('#314853',.92),
};
const shape=source=>new Geometry(source.positions,source.normals,source.indices);
const cylinder=(a,b,h,n=20)=>shape(cylinderGeometry(a,b,h,n,1));
function skin(rings){
  const positions=[],normals=[],indices=[];
  const vertices=rings.flat();
  const center=[0,1,2].map(i=>vertices.reduce((sum,p)=>sum+p[i],0)/vertices.length);
  function face(p){
    const u=p[1].map((value,i)=>value-p[0][i]),v=p[2].map((value,i)=>value-p[0][i]);
    let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,value,i)=>sum+value*(p[0][i]-center[i]),0)<0){
      p=p.slice().reverse();
      n=n.map(value=>-value);
    }
    const length=Math.hypot(...n),offset=positions.length/3;
    if(length<1e-8)return;
    for(const item of p){positions.push(...item);normals.push(...n.map(value=>value/length));}
    for(let i=1;i<p.length-1;i++)indices.push(offset,offset+i,offset+i+1);
  }
  for(let i=0;i<rings.length-1;i++)for(let j=0;j<rings[i].length;j++){
    const k=(j+1)%rings[i].length;
    face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]]);
  }
  face(rings[0].slice().reverse());
  face(rings.at(-1));
  return new Geometry(positions,normals,indices);
}

function chamfer(x,y,z,b){
  function at(h,shrink){
    const w=x/2-shrink,d=z/2-shrink,v=b*.65;
    return [[-w,-d+v],[-w+v,-d],[w-v,-d],[w,-d+v],[w,d-v],[w-v,d],[-w+v,d],[-w,d-v]]
      .map(([px,pz])=>[px,h,pz]);
  }
  return skin([at(-y/2,b),at(-y/2+b,0),at(y/2-b,0),at(y/2,b)]);
}

function cross(z,w,h,y){
  const cut=.28;
  return [[-w,-h+cut*h],[-w+cut*w,-h],[w-cut*w,-h],[w,-h+cut*h],
    [w,h-cut*h],[w-cut*w,h],[-w+cut*w,h],[-w,h-cut*h]].map(([x,d])=>[x,y+d,z]);
}
function profile(points,y,h){
  const rings=[y-h/2,y+h/2].map(level=>points.map(([x,z])=>[x,level,z]));
  return skin(rings);
}

function random(index){
  const a=Math.sin(index*78.248+11.16)*77372.392;
  return a-Math.floor(a);
}
function starfield(){
  const sets=[0,1,2].map(()=>({positions:[],normals:[],indices:[]}));
  for(let i=0;i<320;i++){
    const x=(random(i)-.5)*312,y=(random(i*7+34)-.24)*146;
    const z=-220-random(i*1.34+9)*38;
    const r=i%19===0?.32:i%7===0?.204:.115+.07*random(i*3);
    const mesh=sets[i%3],ix=mesh.positions.length/3;
    mesh.positions.push(x-r,y,z,x,y-r,z,x+r,y,z,x,y+r,z);
    mesh.normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
    mesh.indices.push(ix,ix+1,ix+2,ix,ix+2,ix+3);
  }
  return sets.map(({positions,normals,indices})=>new Geometry(positions,normals,indices));
}

function planetBand(radius,a,b){
  const points=[],normals=[],indices=[];
  const bands=Math.max(2,Math.ceil((b-a)*13)),count=60;
  for(let j=0;j<=bands;j++){
    const yaw=a+(b-a)*j/bands,vertical=Math.sin(yaw),base=Math.cos(yaw);
    for(let i=0;i<=count;i++){
      const theta=2*Math.PI*i/count;
      const n=[Math.cos(theta)*base,vertical,Math.sin(theta)*base];
      points.push(...n.map(x=>x*radius));normals.push(...n);
      const k=j*(count+1)+i;
      if(j<bands&&i<count)indices.push(k,k+count+1,k+1,k+1,k+count+1,k+count+2);
    }
  }
  return new Geometry(points,normals,indices);
}

function rings(radius,radii,bands){
  const positions=[],normals=[],indices=[],count=64;
  for(let i=0;i<=count;i++){
    const theta=i/count*Math.PI*2;
    for(const r of radii){
      positions.push(Math.cos(theta)*r*radius,0,Math.sin(theta)*r*radius);
      normals.push(0,1,0);
    }
    const k=i*2;
    if(i<count)indices.push(k,k+1,k+2,k+1,k+3,k+2);
  }
  const geo=new Geometry(positions,normals,indices);
  return {geo,m:coat(bands,.8)};
}

function radialFace(inner,outer){
  const positions=[],normals=[],indices=[],pieces=12;
  for(let j=0;j<pieces;j++){
    const start=(j+.07)*Math.PI*2/pieces,end=(j+.93)*Math.PI*2/pieces;
    const offset=positions.length/3;
    for(let k=0;k<4;k++){
      const a=start+(end-start)*k/3;
      for(const r of [outer,inner]){
        positions.push(r*Math.cos(a),r*Math.sin(a),0);
        normals.push(0,0,1);
      }
      const p=offset+k*2;
      if(k<3)indices.push(p,p+2,p+1,p+1,p+2,p+3);
    }
  }
  return new Geometry(positions,normals,indices);
}

export function design(scene){
  const unitBox=box(1,1,1);
  function make(geometry,m,position=[0,0,0],parent=null){
    return scene.createMesh().setGeometry(geometry).setMaterial(m).setPosition(position).setParent(parent);
  }
  function boxAt(size,m,position,parent){
    return make(unitBox,m,position,parent).setScale(size);
  }
  const cylinderZ=(geo,m,p,parent)=>make(geo,m,p,parent).setRotation([Math.PI/2,0,0]);
  const bevel=(size,b,m,p,parent)=>make(chamfer(...size,b),m,p,parent);
  function xyRod(a,b,z,width,depth,m,parent){
    const dx=b[0]-a[0],dy=b[1]-a[1];
    boxAt([Math.hypot(dx,dy),width,depth],m,[(a[0]+b[0])/2,(a[1]+b[1])/2,z],parent)
      .setRotation([0,0,Math.atan2(dy,dx)]);
  }

  const palette=['#88b4b5','#b7c1c6','#d4cdb8'];
  starfield().forEach((geometry,i)=>make(geometry,coat(palette[i],.8)));
  const world=make(null,material.iron,[-26,14.5,-119]);
  world.setRotation([-.24,.16,-.24]);
  const bands=[[-Math.PI/2,-.88,'#a18e98'],[-.88,-.59,'#a79aa7'],[-.59,-.39,'#d0ada0'],
    [-.39,-.25,'#e2c2aa'],[-.25,-.08,'#b497a6'],[-.08,.09,'#d6b1a3'],[.09,.27,'#e2c4ac'],
    [.27,.39,'#b4a3ad'],[.39,.66,'#d0bcae'],[.66,.83,'#d4b1aa'],[.83,Math.PI/2,'#b9a9b0']];
  for(const [a,b,color] of bands)make(planetBand(15.2,a,b),coat(color,.85),[0,0,0],world);
  for(const spec of [
    rings(15.2,[1.535,1.61],'#a68393'),rings(15.2,[1.65,1.71],'#d2b098'),
    rings(15.2,[1.718,1.79],'#aa8e9d'),rings(15.2,[1.805,1.86],'#c6a5a2'),
  ]){
    spec.m.set({doubleSided:true});
    make(spec.geo,spec.m,[0,0,0],world);
  }

  const base=bevel([12.72,.68,115],.054,material.iron,[0,-.43,-44.5]);
  base.name='Inspection deck shell';
  boxAt([11.85,.105,115],material.tile,[0,-.065,-44.4]);
  for(let i=-1;i<=1;i++){
    const x=i*laneWidth;
    boxAt([2.68,.027,113.9],material.surface,[x,-.003,-44.4]);
    for(const side of [-1,1]){
      boxAt([.085,.035,112],material.cut,[x+side*1.34,.012,-44.4]);
      boxAt([.033,.018,111.7],material.edge,[x+side*1.39,.030,-44.4]);
    }
  }
  const equipment=chamfer(.70,.42,1.28,.061);
  const railCap=chamfer(.32,.30,.78,.038);
  for(const side of [-1,1]){
    const x=side*6.22;
    boxAt([.40,.32,115],material.structural,[x,.22,-44.6]);
    boxAt([.12,.067,115],material.edge,[x,.407,-44.6]);
    boxAt([.285,.20,115],material.cut,[x+side*.20,-.16,-44.6]);
    boxAt([.105,.070,115],material.brass,[x-side*.17,.073,-44.6]);
    for(let i=0;i<17;i++){
      const z=7-i*6.25;
      make(railCap,material.gunmetal,[x,.49,z]);
      boxAt([.16,.04,.28],i%3===0?material.brass:material.cyan,[x,.66,z]);
      boxAt([.40,.08,1.14],material.cut,[x-side*.28,.10,z]);
      if(i%3===0){
        make(equipment,material.iron,[x+side*.48,.03,z]);
        boxAt([.43,.025,.42],material.copper,[x+side*.48,.25,z]);
      }
    }
  }
  for(let i=0;i<31;i++){
    const z=9-i*3.63;
    boxAt([11.74,.009,.048],material.cut,[0,.014,z]);
    for(const x of [-laneWidth,0,laneWidth]){
      boxAt([.15,.013,.49],i%4===0?material.brass:material.port,[x,.027,z-.45]);
      if(i%4===0)for(const sign of [-1,1]){
        boxAt([.29,.014,.044],material.brass,[x+sign*.25,.027,z-.45]);
      }
    }
  }
  const pillar=chamfer(.43,3.48,.86,.047);
  const pillarBase=chamfer(.85,.25,1.15,.044);
  const lockTube=cylinder(.37,.44,.38);
  const gateRing=shape(torusGeometry(1.92,.118,8,16));
  const rimRing=radialFace(1.85,2.19);
  const gates=[];
  for(const [index,gate] of course.entries()){
    const root=make(null,material.edge,[0,0,gate.z]);
    root.name='Gate '+(index+1)+' structural frame';
    for(const sign of [-1,1]){
      const x=sign*5.58;
      make(pillar,material.gunmetal,[x,1.72,0],root).setRotation([0,0,sign*.14]);
      make(pillarBase,material.port,[x,.122,0],root);
      boxAt([.102,2.19,.025],material.brass,[x+sign*.07,1.47,.445],root);
      boxAt([.52,.45,.62],material.structural,[sign*5.21,3.33,.09],root);
      xyRod([sign*5.33,3.47],[sign*4.12,4.45],0,.34,.52,material.structural,root);
      boxAt([.40,.088,.07],material.cyan,[sign*5.15,3.42,.38],root);
    }
    boxAt([8.62,.25,.60],material.structural,[0,4.38,0],root);
    boxAt([7.9,.065,.022],material.edge,[0,4.47,.311],root);
    boxAt([1.79,.29,.72],material.iron,[gate.x,4.11,0],root);
    boxAt([.24,1.28,.22],material.structural,[gate.x,3.34,0],root);
    for(const sign of [-1,1]){
      boxAt([.09,.74,.12],material.edge,[gate.x+sign*.55,3.72,.18],root);
      boxAt([.28,.44,.42],material.copper,[gate.x+sign*1.94,elevation,.05],root);
      cylinderZ(lockTube,material.gunmetal,[gate.x+sign*1.89,elevation,-.10],root);
    }
    make(gateRing,material.copper,[gate.x,elevation,0],root);
    const rim=make(rimRing,material.cyan,[gate.x,elevation,.164],root);
    boxAt([.84,.065,.08],material.brass,[gate.x,4.12,.396],root);
    for(let mark=0;mark<=index;mark++){
      boxAt([.085,.091,.052],material.ice,[gate.x+(mark-index*.5)*.137,3.98,.392],root);
    }
    const strips=[];
    for(const side of [-1,1]){
      strips.push(boxAt([.24,.018,1.4],material.cyan,[gate.x+side*1.18,.043,1.96],root));
    }
    gates.push({rim,strips});
  }

  const dock=make(null,material.iron,[0,0,-98.8]);
  dock.name='Terminal transfer lock';
  bevel([9.03,4.37,.91],.20,material.iron,[0,2.19,0],dock);
  bevel([8.07,3.48,.19],.084,material.cut,[0,2.01,.50],dock);
  bevel([5.41,2.69,.28],.089,material.structural,[0,1.66,.63],dock);
  bevel([4.88,2.33,.19],.068,material.cut,[0,1.53,.79],dock);
  for(const side of [-1,1]){
    bevel([.85,3.11,.52],.073,material.structural,[side*3.53,1.8,.70],dock);
    boxAt([.22,1.24,.068],material.brass,[side*3.49,2.26,1],dock);
    boxAt([.18,.43,.11],material.cyan,[side*2.36,1.18,.94],dock);
  }
  for(let i=0;i<7;i++){
    boxAt([.28,.071,.033],i%2?material.cyan:material.brass,[(i-3)*.43,3.43,1.18],dock);
  }

  const shuttle=make(null,material.white,[0,elevation,0]);
  shuttle.name='Courier shuttle';
  const hull=skin([
    cross(1.53,.54,.23,-.05),cross(1.19,.65,.31,-.04),
    cross(-.36,.59,.34,.015),cross(-1.40,.39,.25,.055),cross(-2.0,.15,.095,.082),
  ].reverse());
  // Rings along front-to-back z give a closed, outward-facing hull.
  make(hull,material.white,[0,0,0],shuttle);
  const cockpit=skin([cross(-1.31,.184,.07,.237),cross(-.67,.34,.19,.352),
    cross(.14,.32,.15,.373),cross(.46,.22,.093,.295)]);
  make(cockpit,material.glass,[0,0,0],shuttle);
  const nacelle=cylinder(.255,.29,.48,24), nozzle=cylinder(.179,.232,.20,24),
    motor=cylinder(.126,.149,.085,24),rim=cylinder(.178,.182,.056,24);
  for(const side of [-1,1]){
    const signed=points=>side===1?points:points.map(([x,z])=>[-x,z]).reverse();
    const wing=profile(signed([[.52,-.54],[1.27,.53],[1.15,1.23],[.57,1.03]]),-.06,.107);
    make(wing,material.iron,[0,0,0],shuttle);
    make(profile(signed([[.65,-.06],[1.17,.55],[1.10,.92],[.70,.82]]),.008,.04),
      material.copper,[0,0,0],shuttle);
    const pod=bevel([.37,.46,1.53],.078,material.white,[side*.70,-.10,.57],shuttle);
    boxAt([.255,.029,.74],material.brass,[side*.69,.146,.41],shuttle);
    cylinderZ(nacelle,material.gunmetal,[side*.70,-.085,1.38],shuttle);
    cylinderZ(nozzle,material.graphite,[side*.70,-.085,1.637],shuttle);
    cylinderZ(rim,material.edge,[side*.70,-.085,1.744],shuttle);
    cylinderZ(motor,material.bright,[side*.70,-.085,1.773],shuttle);
    boxAt([.073,.115,.206],side===-1?material.red:material.cyan,[side*1.23,-.04,.60],shuttle);
    boxAt([.050,.071,.39],material.gunmetal,[side*.50,.263,.66],shuttle);
    pod.name=side<0?'Port propulsion nacelle':'Starboard propulsion nacelle';
  }
  const panel=bevel([.44,.07,.42],.030,material.copper,[0,.323,.80],shuttle);
  panel.name='Telemetry access panel';
  for(const x of [-.112,0,.112])boxAt([.024,.017,.16],material.ice,[x,.374,.80],shuttle);
  cylinderZ(cylinder(.27,.29,.065),material.rubber,[0,-.095,1.55],shuttle);
  for(const x of [-.13,.13])boxAt([.057,.079,.030],material.ice,[x,-.10,1.59],shuttle);
  const skids=shape(sphereGeometry(1,24,8));
  const contact=make(skids,material.shadowMark,[0,.032,0]).setScale([1.32,.011,1.86]);
  const lamps=[coat('#f2ce96',.64),coat('#589d9d',.74),coat('#b1e2c7',.64),coat('#c07a80',.66)];
  function pose(state){
    const hover=.025*Math.sin(state.elapsed*5.2),angle=state.bank;
    shuttle.setPosition([state.position,elevation+hover,state.z]).setRotation([.006,angle*.16,angle]);
    contact.setPosition([state.position,.036,state.z+.04]);
    for(const [i,gate] of gates.entries()){
      const status=state.gates[i];
      const highlight=status>0?lamps[2]:status<0?lamps[3]:i===state.next?lamps[0]:lamps[1];
      if(gate.rim.material!==highlight){
        gate.rim.setMaterial(highlight);
        for(const strip of gate.strips)strip.setMaterial(highlight);
      }
    }
  }
  return {pose,meshCount:scene.meshes.size};
}
