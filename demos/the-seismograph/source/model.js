import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { windowSeconds } from './motion.js';

const tau=Math.PI*2;
const paperPlane=.206;
const baseline=.264;
const left=-.480;
const right=.158;
const chartRadius=.024;
const crown=.563;
const eye=.317;
const sampleCount=217;
const up=[0,1,0];
const forward=[0,0,1];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=(v)=>v.map((c)=>c/Math.hypot(...v));

const finishes={
  floor:{color:[.120,.137,.113],roughness:.96,metalness:0},
  feet:{color:[.056,.057,.050],roughness:.82,metalness:0},
  cast:{color:[.095,.192,.236],roughness:.42,metalness:.02},
  enamel:{color:[.183,.290,.327],roughness:.35,metalness:0},
  dark:{color:[.070,.073,.063],roughness:.48,metalness:.11},
  nickel:{color:[.55,.59,.57],roughness:.31,metalness:.56},
  brass:{color:[.73,.442,.194],roughness:.31,metalness:.66},
  bronze:{color:[.48,.287,.142],roughness:.43,metalness:.52},
  cream:{color:[.833,.780,.63],roughness:.84,metalness:0},
  paper:{color:[.87,.799,.633],roughness:.88,metalness:0},
  grid:{color:'#a49877',shading:'basic'},
  gridHeavy:{color:'#847354',shading:'basic'},
  trace:{color:'#823323',shading:'basic'},
  roller:{color:[.095,.094,.079],roughness:.66,metalness:0},
  red:{color:[.62,.104,.067],roughness:.38,metalness:.02},
};

function stamp(geometry,p,axis=up) {
  const r=normal(cross(axis,Math.abs(axis[2])>.87?[1,0,0]:forward));
  const z=cross(r,axis);
  return applyMatrix4(geometry,[...r,0,...axis,0,...z,0,...p,1]);
}

function strut(from,to,width,other,radius) {
  const dv=to.map((value,i)=>value-from[i]);
  return stamp(roundedBoxGeometry(width,Math.hypot(...dv),other,2,radius),to.map((value,i)=>(value+from[i])*.5),normal(dv));
}

function helicalWire() {
  const divisions=132, sides=9;
  const positions=[],normals=[],uvs=[],indices=[];
  // Standard Y-axis helical centerline with a circular wire cross-section.
  for(let i=0;i<=divisions;i++) {
    const f=i/divisions, angle=f*tau*8;
    const across=[Math.cos(angle),0,Math.sin(angle)];
    const tangent=normal([-.023*tau*8*Math.sin(angle),.23,.023*tau*8*Math.cos(angle)]);
    const around=cross(tangent,across);
    for(let j=0;j<=sides;j++) {
      const s=j/sides*tau;
      const n=across.map((a,k)=>a*Math.cos(s)+around[k]*Math.sin(s));
      const last=positions.length/3;
      positions.push(across[0]*.023+n[0]*.0036,f+n[1]*.0036/.23,across[2]*.023+n[2]*.0036);
      normals.push(...n); uvs.push(f,j/sides);
      if(i&&j) indices.push(last,last-1,last-sides-2,last,last-sides-2,last-sides-1);
    }
  }
  return makeGeometry(positions,normals,uvs,indices);
}

function makeGeometry(positions,normals,uvs,indices) {
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}

function stripMesh(count) {
  const vertices=Float32Array.from({length:count*6},(_,i)=>i%3===2?paperPlane+.0022:0);
  const normals=Float32Array.from(vertices,(_,i)=>i%3===2?1:0);
  const uvs=new Float32Array(count*4);
  const indices=[];
  for(let i=1;i<count;i++) {
    const v=i*2;
    indices.push(v-2,v,v-1,v,v+1,v-1);
  }
  return {positions:vertices,normals,uvs,indices:Uint32Array.from(indices)};
}

function writeTrace(mesh,samples) {
  const xs=(right-left)/(samples.length-1);
  for(let i=0;i<samples.length;i++) {
    const dx=i===0||i===samples.length-1?xs:2*xs;
    const dy=samples[Math.min(samples.length-1,i+1)]-samples[Math.max(0,i-1)];
    const d=.00135/Math.hypot(dx,dy);
    const x=left+i*xs, y=baseline+samples[i];
    mesh.positions[i*6]=x+dy*d; mesh.positions[i*6+1]=y-dx*d;
    mesh.positions[i*6+3]=x-dy*d; mesh.positions[i*6+4]=y+dx*d;
  }
}

const letters={
  S:[[1,0,0,0],[0,0,0,.51],[0,.51,1,.51],[1,.51,1,1],[1,1,0,1]],
  E:[[1,0,0,0],[0,0,0,1],[0,.50,.82,.50],[0,1,1,1]],
  I:[[0,0,1,0],[.5,0,.5,1],[0,1,1,1]],
  '-':[[.18,.52,.82,.52]],
  '0':[[.17,0,.83,0],[.83,0,1,.17],[1,.17,1,.83],[1,.83,.83,1],[.83,1,.17,1],[.17,1,0,.83],[0,.83,0,.17],[0,.17,.17,0]],
  '1':[[.18,.22,.5,0],[.5,0,.5,1],[.16,1,.84,1]],
};

export function prepareInstrument() {
  const batches=new Map();
  function add(group,material,geometry) {
    const key=group+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(geometry);
  }

  function box(group,material,location,size,bevel,axis=up) {
    add(group,material,stamp(roundedBoxGeometry(...size,2,bevel),location,axis));
  }

  function cylinder(group,material,location,radius,length,segments=32,axis=up,bottom=radius) {
    add(group,material,stamp(cylinderGeometry(radius,bottom,length,segments),location,axis));
  }

  function ring(group,material,location,radius,wire,axis=forward) {
    const torus=torusGeometry(radius,wire,7,62);
    const oriented=axis===up?applyMatrix4(torus,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]):torus;
    add(group,material,stamp(oriented,location));
  }

  function screw(group,p,r,face=up) {
    cylinder(group,'dark',p,r*1.21,.0031,18,face);
    const head=p.map((v,i)=>v+face[i]*.003);
    cylinder(group,'nickel',head,r,.0055,18,face);
    const slot=head.map((v,i)=>v+face[i]*.003);
    box(group,'dark',slot,[r*1.33,.0010,r*.30],.00035,face);
  }

  function faceStroke(group,material,from,to,z,width,depth=.00115) {
    const length=Math.hypot(to[0]-from[0],to[1]-from[1]);
    const a=Math.atan2(to[1]-from[1],to[0]-from[0]), c=Math.cos(a), s=Math.sin(a);
    add(group,material,applyMatrix4(roundedBoxGeometry(length+width*.12,width,depth,1,.00018),
      [c,s,0,0,-s,c,0,0,0,0,1,0,(from[0]+to[0])*.5,(from[1]+to[1])*.5,z,1]));
  }

  box('world','floor',[0,-.159,0],[85,.04,85],.006);
  box('world','feet',[0,-.125,.012],[1.246,.029,.53],.014);
  box('world','dark',[0,-.101,.012],[1.274,.036,.554],.010);
  box('world','nickel',[0,-.080,.012],[1.233,.012,.523],.005);
  for(const x of [-.49,.49]) for(const z of [-.180,.211]) {
    cylinder('world','dark',[x,-.067,z],.035,.018,30);
    cylinder('world','brass',[x,-.058,z],.023,.010,30);
    cylinder('world','nickel',[x,-.029,z],.014,.077,28);
  }
  for(const x of [-.36,.37]) box('world','cast',[x,-.048,0],[.139,.041,.214],.010);

  box('frame','dark',[0,-.038,.010],[1.211,.024,.498],.011);
  box('frame','cast',[0,-.014,.010],[1.234,.044,.513],.017);
  box('frame','enamel',[0,.011,.010],[1.208,.014,.487],.005);
  box('frame','cast',[0,.025,.010],[1.129,.018,.426],.004);
  for(const x of [-.551,.551]) for(const z of [-.183,.209]) screw('frame',[x,.028,z],.0095);
  box('frame','dark',[.339,-.015,.266],[.153,.025,.0078],.0037);
  for(const x of [.271,.407]) screw('frame',[x,-.015,.272],.0052,forward);
  [...'SEIS-01'].forEach((d,i)=>{
    for(const [x1,y1,x2,y2] of letters[d]) {
      const start=.339+(i-3)*.010-.0031;
      faceStroke('frame','cream',[start+x1*.0064,-.009-y1*.0101],[start+x2*.0064,-.009-y2*.0101],.271,.0010);
    }
  });

  // The paper is pulled horizontally between two vertical drums, across a stiff backing plate.
  const drumLeft=-.527, drumRight=.202, drumZ=paperPlane-chartRadius;
  for(const x of [-.472,.166]) {
    box('frame','dark',[x,.051,.156],[.090,.032,.121],.009);
    box('frame','cast',[x,.090,.144],[.053,.063,.047],.006);
    box('frame','enamel',[x,.124,.156],[.085,.022,.088],.005);
    screw('frame',[x-.029,.136,.178],.0057);
    screw('frame',[x+.029,.136,.178],.0057);
  }
  box('frame','cast',[-.162,.264,.161],[.743,.277,.047],.013);
  box('frame','bronze',[-.162,.265,.190],[.734,.268,.023],.0057);
  box('frame','paper',[-.162,.264,.203],[.735,.246,.0056],.0018);
  box('frame','nickel',[-.163,.393,.200],[.730,.010,.020],.0024);
  box('frame','dark',[-.163,.135,.198],[.730,.012,.027],.0035);
  for(const x of [drumLeft,drumRight]) {
    cylinder('frame','bronze',[x,.398,drumZ],.036,.016,45);
    cylinder('frame','nickel',[x,.411,drumZ],.023,.013,36);
    cylinder('frame','dark',[x,.125,drumZ],.036,.016,44);
    cylinder('frame','brass',[x,.112,drumZ],.025,.013,36);
    screw('frame',[x,.419,drumZ],.0107);
  }
  for(let i=-5;i<=5;i++) {
    const y=baseline+i*.020;
    faceStroke('frame',i===0?'gridHeavy':'grid',[left-.017,y],[right+.017,y],paperPlane+.00065,i===0?.0014:.00085);
    for(const x of [left-.012,right+.014])
      faceStroke('frame','gridHeavy',[x-.009,y],[x,y],paperPlane+.00069,.00145);
  }
  for(const y of [.147,.381]) faceStroke('frame','gridHeavy',[left-.018,y],[right+.016,y],paperPlane+.00065,.00115);
  const dashes={positions:[],normals:[],uvs:[],indices:[]};
  for(let i=0;i<12;i++) {
    const y=.152+i*.019,z=paperPlane+.00080;
    const k=i*4;
    dashes.positions.push(-.00052,y,z,.00052,y,z,.00052,y+.0085,z,-.00052,y+.0085,z);
    dashes.normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
    dashes.uvs.push(0,0,1,0,1,1,0,1);
    dashes.indices.push(k,k+1,k+2,k,k+2,k+3);
  }
  const dashGeometry=makeGeometry(dashes.positions,dashes.normals,dashes.uvs,dashes.indices);
  const drumCore=stamp(cylinderGeometry(chartRadius,chartRadius,.238,52),[0,baseline,0]);
  const drumParts=[];
  for(let i=0;i<12;i++) {
    const a=tau*i/12,c=Math.cos(a),s=Math.sin(a);
    drumParts.push(applyMatrix4(roundedBoxGeometry(.0032,.235,.0018,1,.0005),
      [c,0,-s,0,0,1,0,0,s,0,c,0,s*chartRadius,baseline,c*chartRadius,1]));
  }
  const drumFlutes=mergeGeometries(drumParts);

  // Boxed vertical carriage, micrometer head and a spring with visible end shackles.
  const bobX=.367, bobZ=.110;
  box('frame','dark',[.398,.052,.072],[.347,.036,.321],.010);
  for(const x of [.282,.510]) for(const z of [-.055,.187]) screw('frame',[x,.074,z],.0081);
  for(const p of [[.475,.071,-.045],[.514,.074,.161]]) {
    const top=[.480,.440,p[2]-.029];
    add('frame','cast',strut(p,top,.047,.062,.0071));
    add('frame','enamel',strut(p.map((v,i)=>v+(i===2?.019:0)),top.map((v,i)=>v+(i===2?.019:0)),.013,.009,.003));
  }
  add('frame','cast',strut([.483,.416,.015],[.48,.550,.054],.071,.099,.015));
  box('frame','cast',[.393,.543,.110],[.252,.058,.135],.011);
  box('frame','enamel',[.390,.575,.110],[.223,.012,.104],.0047);
  box('frame','bronze',[bobX,.514,.110],[.101,.018,.080],.005);
  for(const x of [.300,.454]) screw('frame',[x,.583,.112],.0083);
  cylinder('frame','nickel',[bobX,.536,bobZ],.028,.044,40);
  cylinder('frame','dark',[bobX,.594,bobZ],.034,.023,48);
  cylinder('frame','brass',[bobX,.610,bobZ],.039,.011,54);
  for(let i=0;i<24;i++) {
    const a=i*tau/24;
    cylinder('frame','bronze',[bobX+Math.cos(a)*.037,.606,bobZ+Math.sin(a)*.037],.0021,.015,8);
  }
  cylinder('frame','brass',[bobX,.522,bobZ],.010,.071,26);
  ring('frame','nickel',[bobX,.510,bobZ],.009,.0026);
  box('frame','bronze',[.504,.271,.176],[.031,.233,.019],.0043);
  box('frame','cream',[.505,.271,.189],[.022,.218,.005],.0015);
  for(let i=-8;i<=8;i++) faceStroke('frame','gridHeavy',[.494,.271+i*.011],[i%4===0?.513:.505,.271+i*.011],.1925,i%4===0?.0013:.00085);
  cylinder('frame','nickel',[.469,.278,.131],.007,.395,26);
  cylinder('frame','brass',[.469,.094,.131],.016,.022,26);
  cylinder('frame','brass',[.469,.472,.131],.016,.021,26);

  const b=[bobX,baseline,bobZ];
  add('mass','brass',stamp(latheGeometry([
    [0,-.046],[.050,-.046],[.063,-.040],[.067,-.030],[.067,.025],
    [.061,.035],[.052,.042],[.018,.042],[.012,.047],[0,.047],
  ],80),b));
  for(const y of [baseline-.030,baseline+.026]) ring('mass','bronze',[bobX,y,bobZ],.067,.0013,up);
  ring('mass','nickel',[bobX,baseline+.0378,bobZ],.050,.00165,up);
  cylinder('mass','bronze',[bobX,.315,bobZ],.014,.023,28);
  ring('mass','nickel',[bobX,.321,bobZ],.009,.0030);
  box('mass','dark',[.436,.268,.133],[.066,.020,.027],.005);
  cylinder('mass','bronze',[.469,.267,.131],.013,.026,24);
  add('mass','brass',strut([.437,.269,.148],[.503,.271,.198],.007,.007,.0018));
  add('mass','red',strut([.499,.272,.199],[.517,.272,.199],.005,.005,.0011));
  add('mass','nickel',strut([.322,baseline,.149],[.266,baseline,.173],.012,.013,.0026));
  add('mass','bronze',strut([.266,baseline,.173],[.187,baseline,.205],.008,.008,.0018));
  add('mass','red',strut([.200,baseline,.208],[right+.003,baseline,.208],.009,.008,.0016));
  add('mass','dark',strut([right+.014,baseline,.209],[right,baseline,.208],.003,.003,.00055));
  screw('mass',[.320,baseline,.166],.0072,forward);

  const parts=Array.from(batches,([key,geometries])=>({key,geometry:geometries.length===1?geometries[0]:mergeGeometries(geometries)}));
  const coilGeometry=helicalWire();
  const traceGeometry=stripMesh(sampleCount);
  const samples=new Float32Array(sampleCount);
  writeTrace(traceGeometry,samples);
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const frame=engine.createMesh().setParent(world);
    const mass=engine.createMesh().setParent(frame);
    const parents={world,frame,mass};
    const materials=new Map(Object.entries(finishes).map(([name,value])=>[name,new Material(value)]));
    function model(group,material,data,parent,cast=true) {
      const mesh=createMesh(engine,data,materials.get(material));
      mesh.root.name=group+' '+material;
      mesh.root.setParent(parent);
      if(cast||!['grid','gridHeavy','trace'].includes(material)) {
        shadows.add(mesh,{static:parent===world,castShadow:cast});
      }
      return mesh;
    }
    for(const {key,geometry} of parts) {
      const [group,material]=key.split(':');
      model(group,material,geometry,parents[group],!['floor','grid','gridHeavy'].includes(material));
    }
    const coil=model('Suspension spring','nickel',coilGeometry,frame).root;
    const trace=model('Pen trace','trace',traceGeometry,frame,false);
    const columns=Array.from({length:9},()=>model('Moving time tick','grid',dashGeometry,frame,false).root);
    const drums=[drumLeft,drumRight].map((x)=>{
      const node=engine.createMesh().setParent(frame).setPosition([x,0,drumZ]);
      model('Paper transport roller','roller',drumCore,node);
      model('Roller grip flutes','bronze',drumFlutes,node);
      return node;
    });
    return (simulation,t)=>{
      const {ground,relative}=simulation.pose(t);
      frame.setPosition([0,ground,0]);
      mass.setPosition([0,relative,0]);
      const lower=eye+relative;
      coil.setPosition([bobX,lower,bobZ]).setScale([1,crown-.056-lower,1]);
      simulation.trace(t,samples);
      writeTrace(traceGeometry,samples);
      trace.setGeometry(traceGeometry,{start:0,count:sampleCount*2});
      const paperSpeed=(right-left)/windowSeconds;
      const interval=.48, advance=((t%interval)+interval)%interval;
      columns.forEach((column,i)=>{
        const x=right-paperSpeed*(advance+i*interval);
        column.visible=x>=left&&x<=right;
        column.setPosition([x,0,0]);
      });
      const angle=t*paperSpeed/chartRadius;
      drums.forEach((drum)=>drum.setRotation([0,-angle,0]));
    };
  };
}
