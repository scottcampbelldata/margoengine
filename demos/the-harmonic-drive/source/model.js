import { applyMatrix4, latheGeometry, mergeGeometries } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { bend, ellipseRadius, fixedRootRadius, fixedTeeth, fixedToothDepth, flexTeeth,
  flexToothDepth, major, minor, nominalRadius, tau, toothProfile } from './mechanism.js';

const up=[0,1,0], front=[0,0,1], right=[1,0,0];
const center=[-.014,.351,.027];
const polar=(r,a,z=0)=>[r*Math.cos(a),r*Math.sin(a),z];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize=(v)=>v.map((value)=>value/Math.hypot(...v));

const finishes={
  floor:{color:[.084,.113,.147],roughness:.92},
  foot:{color:[.046,.068,.087],roughness:.68},
  housing:{color:[.164,.277,.393],roughness:.39},
  caseEdge:{color:[.285,.414,.490],roughness:.31},
  steel:{color:[.436,.535,.594],roughness:.35,metalness:1},
  alumina:{color:[.489,.550,.563],roughness:.47},
  bright:{color:[.694,.749,.775],roughness:.26,metalness:1},
  graphite:{color:[.074,.105,.126],roughness:.43},
  copper:{color:[.704,.339,.173],roughness:.45},
  copperEdge:{color:[.792,.432,.238],roughness:.34},
  enamel:{color:[.162,.484,.496],roughness:.37},
  contact:{color:'#a0f5ef',shading:'basic'},
  witness:{color:'#ffd195',shading:'basic'},
  ticks:{color:'#8fafb5',shading:'basic'},
};

function place(data,p,axis=up) {
  const x=normalize(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function profileRing(inner,outer,z0,z1,bevel) {
  return [[inner+bevel,z0],[outer-bevel,z0],[outer,z0+bevel],[outer,z1-bevel],
    [outer-bevel,z1],[inner+bevel,z1],[inner,z1-bevel],[inner,z0+bevel]];
}

// Closed axial section swept between angular stations, with explicit end caps on a cut section.
function sweep(rows,segments,{start=0,end=tau,closed=true}={}) {
  const stations=closed?segments:segments+1;
  const baseCount=rows.length*stations;
  const size=baseCount+(closed?0:rows.length*2);
  const positions=new Float32Array(size*3),normals=new Float32Array(size*3),uvs=new Float32Array(size*2);
  const indices=[];
  for(let row=0;row<rows.length;row++) {
    const lower=row*stations,upper=((row+1)%rows.length)*stations;
    for(let i=0;i<segments;i++) {
      const j=(i+1)%stations;
      indices.push(lower+i,lower+j,upper+i,upper+i,lower+j,upper+j);
    }
  }
  if(!closed) {
    for(let k=1;k<rows.length-1;k++) {
      const a=baseCount,b=baseCount+rows.length;
      indices.push(a,a+k,a+k+1,b,b+k+1,b+k);
    }
  }
  function update(point) {
    for(let row=0;row<rows.length;row++) {
      for(let i=0;i<stations;i++) {
        const theta=start+(end-start)*i/segments;
        const [r,a,z]=point(rows[row],theta);
        const index=row*stations+i;
        positions[index*3]=r*Math.cos(a);
        positions[index*3+1]=r*Math.sin(a);
        positions[index*3+2]=z;
        uvs[index*2]=i/segments;
        uvs[index*2+1]=row/rows.length;
      }
    }
    for(let row=0;row<rows.length;row++) {
      const previous=(row+rows.length-1)%rows.length,next=(row+1)%rows.length;
      for(let i=0;i<stations;i++) {
        const left=closed?(i+stations-1)%stations:Math.max(0,i-1);
        const right=closed?(i+1)%stations:Math.min(stations-1,i+1);
        const a=(row*stations+left)*3,b=(row*stations+right)*3;
        const c=(previous*stations+i)*3,d=(next*stations+i)*3;
        const tx=positions[b]-positions[a],ty=positions[b+1]-positions[a+1];
        const sx=positions[d]-positions[c],sy=positions[d+1]-positions[c+1],sz=positions[d+2]-positions[c+2];
        const nx=ty*sz,ny=-tx*sz,nz=tx*sy-ty*sx;
        const scale=1/Math.hypot(nx,ny,nz);
        normals.set([nx*scale,ny*scale,nz*scale],(row*stations+i)*3);
      }
    }
    if(!closed) {
      for(let row=0;row<rows.length;row++) {
        const a=row*stations*3,b=(row*stations+segments)*3;
        const capA=(baseCount+row)*3,capB=(baseCount+rows.length+row)*3;
        positions.set(positions.subarray(a,a+3),capA);
        positions.set(positions.subarray(b,b+3),capB);
        normals.set([Math.sin(start),-Math.cos(start),0],capA);
        normals.set([-Math.sin(end),Math.cos(end),0],capB);
      }
    }
  }
  return {geometry:{positions,normals,uvs,indices:Uint32Array.from(indices)},update};
}

function roundShape(rows,count,displace,arc) {
  const mesh=sweep(rows,count,arc);
  mesh.update(([radius,z,depth=0],a)=>[radius+depth*displace(a),a,z]);
  return mesh.geometry;
}

export function prepareHarmonicDrive() {
  const groups=new Map();
  function add(group,material,geometry) {
    const key=group+':'+material;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(geometry);
  }
  function box(group,material,p,size,bevel,axis=up) {
    add(group,material,place(roundedBoxGeometry(...size,2,bevel),p,axis));
  }
  function cylinder(group,material,p,r,depth,axis=front,segments=64) {
    const h=depth/2,b=Math.min(r*.15,depth*.17);
    add(group,material,place(latheGeometry([[0,-h],[r-b,-h],[r,-h+b],[r,h-b],[r-b,h],[0,h]],segments),p,axis));
  }
  function ring(group,material,inner,outer,z0,z1,bevel,segments=116) {
    add(group,material,roundShape(profileRing(inner,outer,z0,z1,bevel),segments,()=>0));
  }
  function arc(group,material,inner,outer,z0,z1,bevel,start,end) {
    add(group,material,roundShape(profileRing(inner,outer,z0,z1,bevel),Math.ceil((end-start)*30),()=>0,
      {start,end,closed:false}));
  }
  function radialBlock(group,material,r,a,z,width,length,depth,bevel) {
    box(group,material,polar(r,a,z),[width,length,depth],bevel,[Math.cos(a),Math.sin(a),0]);
  }
  function bolt(group,p,r,axis=front) {
    cylinder(group,'graphite',p,r*1.43,.0045,axis,18);
    cylinder(group,'bright',p.map((value,i)=>value+axis[i]*.0043),r,.0075,axis,6);
  }

  box('world','floor',[0,-.065,0],[66,.11,66],.009);
  box('world','foot',[.006,.021,-.079],[.870,.059,.603],.020);
  box('world','housing',[.001,.055,-.073],[.896,.028,.620],.012);
  box('world','caseEdge',[.004,.076,-.072],[.815,.019,.544],.009);
  box('world','graphite',[.003,.091,-.072],[.768,.018,.513],.008);
  box('world','graphite',[.006,.047,.242],[.650,.027,.005],.002);
  for(let i=0;i<18;i++) box('world','caseEdge',[-.266+.0305*i,.047,.246],[.007,.014,.005],.0015);
  for(const x of [-.336,.344]) for(const z of [-.285,.139]) bolt('world',[x,.103,z],.0086,up);
  for(const x of [-.188,.177]) {
    box('world','housing',[x,.130,-.075],[.105,.068,.397],.013);
    box('world','caseEdge',[x,.165,-.084],[.069,.015,.354],.005);
  }

  // A low cradle carries the fixed ring. The shell is sectioned above the bearing seat.
  arc('fixed','housing',.265,.300,-.156,.031,.008,.93*Math.PI,2.10*Math.PI);
  arc('fixed','caseEdge',.286,.307,-.159,-.124,.004,.93*Math.PI,2.10*Math.PI);
  arc('fixed','caseEdge',.283,.305,-.018,.022,.004,.93*Math.PI,2.10*Math.PI);
  arc('fixed','graphite',.281,.296,-.118,-.102,.003,.94*Math.PI,2.09*Math.PI);
  for(let i=0;i<12;i++) {
    const a=Math.PI+(.073*i)*Math.PI;
    radialBlock('fixed','housing',.297,a,-.064,.048,.024,.058,.005);
    bolt('fixed',polar(.301,a,-.024),.0051);
  }
  for(const a of [.93*Math.PI,2.10*Math.PI]) {
    radialBlock('fixed','caseEdge',.279,a,-.069,.009,.037,.166,.003);
    radialBlock('fixed','contact',.285,a,-.075,.003,.003,.127,.001);
  }
  ring('fixed','graphite',.245,.283,.015,.079,.007);
  ring('fixed','housing',.246,.288,.047,.086,.006);
  ring('fixed','caseEdge',.251,.283,.081,.091,.003);
  ring('fixed','graphite',.272,.277,.090,.094,.0009);
  for(let i=0;i<16;i++) {
    const a=tau*i/16;
    bolt('fixed',polar(.260,a,.094),.0058);
  }
  const ringRows=[[.231,.040,-.002],[.252,.040,0],[.252,.082,0],[.233,.082,-.001],
    [fixedRootRadius,.078,-fixedToothDepth],[fixedRootRadius,.045,-fixedToothDepth]];
  add('fixed','alumina',roundShape(ringRows,fixedTeeth*8,(angle)=>toothProfile(angle,fixedTeeth,.5)));
  arc('fixed','alumina',.248,.267,-.203,-.190,.003,.05,2.97);
  for(let i=0;i<22;i++) {
    const a=.10+i*.128;
    radialBlock('fixed','ticks',.259,a,-.187,.0023,i%5===0?.011:.0055,.0019,.0006);
  }
  radialBlock('fixed','ticks',.266,.19,-.182,.0056,.0015,.013,.0007);

  // The output rear hub and copper flange are rigidly attached to the flexspline cup.
  cylinder('output','steel',[0,0,-.235],.092,.136,front,88);
  cylinder('output','graphite',[0,0,-.181],.137,.047,front,112);
  ring('output','copper',.126,.247,-.193,-.176,.006);
  ring('output','copperEdge',.235,.247,-.177,-.170,.0025);
  for(let i=0;i<8;i++) {
    const a=tau*i/8;
    radialBlock('output','graphite',.180,a,-.173,.016,.083,.002,.001);
    bolt('output',polar(.148,a,-.168),.0055);
  }
  radialBlock('output','witness',.230,.53,-.168,.0105,.033,.003,.0010);
  radialBlock('output','witness',.245,.53,-.178,.0091,.005,.016,.0016);

  const cupRows=[
    [.132,-.175,0],[.141,-.168,0],[.155,-.131,.23],[.171,-.093,.47],
    [.188,-.050,.68],[.202,-.018,.84],[.208,.016,1],[.208,.037,1],
    [.199,.039,1],[.195,.014,1],[.189,-.022,.84],[.176,-.052,.68],
    [.159,-.093,.47],[.145,-.132,.23],[.127,-.170,0],
  ];
  const collarRows=[
    [nominalRadius-.004,.035,1,0],[nominalRadius,.037,1,.0028],
    [nominalRadius,.043,1,flexToothDepth],[nominalRadius,.093,1,flexToothDepth],
    [nominalRadius-.001,.099,1,.0044],[nominalRadius-.007,.101,1,0],
    [nominalRadius-.013,.094,1,0],[nominalRadius-.013,.039,1,0],
  ];
  const cup=sweep(cupRows,144),collar=sweep(collarRows,flexTeeth*8);
  function deform(mesh,{input,output}) {
    mesh.update(([base,z,strength,depth=0],angle)=>{
      const p=bend(angle,input,output,strength);
      return [base+strength*p.offset+depth*toothProfile(angle,flexTeeth),p.angle,z];
    });
  }
  deform(cup,{input:0,output:0});
  deform(collar,{input:0,output:0});

  // The rotating elliptical cam and its thin bearing are inside the open end of the cup.
  const ellipseOffset=(angle)=>ellipseRadius(angle,major,minor)-nominalRadius;
  add('generator','steel',roundShape(profileRing(.110,.195,.043,.069,.004).map(([r,z])=>[r,z,1]),144,ellipseOffset));
  add('generator','bright',roundShape(profileRing(.188,.195,.068,.077,.003).map(([r,z])=>[r,z,1]),144,ellipseOffset));
  add('generator','graphite',roundShape(profileRing(.071,.176,.053,.077,.008).map(([r,z])=>[r,z,1]),128,ellipseOffset));
  add('generator','enamel',roundShape(profileRing(.169,.174,.078,.081,.001).map(([r,z])=>[r,z,1]),128,ellipseOffset));
  cylinder('generator','steel',[0,0,.078],.087,.060,front,82);
  cylinder('generator','graphite',[0,0,.116],.056,.035,front,8);
  cylinder('generator','bright',[0,0,.140],.027,.016,front,64);
  for(let i=0;i<8;i++) bolt('generator',polar(.071,tau*i/8,.109),.0054);
  for(const a of [0,Math.PI]) {
    radialBlock('generator','enamel',.120,a,.084,.026,.071,.014,.005);
    radialBlock('generator','contact',.154,a,.092,.008,.031,.003,.0011);
    radialBlock('generator','contact',.179,a,.089,.016,.009,.003,.0011);
  }

  const staticBatches=Array.from(groups,([key,parts])=>[key,parts.length===1?parts[0]:mergeGeometries(parts)]);
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const fixed=engine.createMesh().setParent(world).setPosition(center);
    const generator=engine.createMesh().setParent(fixed);
    const output=engine.createMesh().setParent(fixed);
    const parents={world,fixed,generator,output};
    const materials=new Map(Object.entries(finishes).map(([name,options])=>[name,new Material(options)]));
    function create(name,material,geometry,group) {
      const object=createMesh(engine,geometry,materials.get(material));
      object.root.name=name;
      object.root.setParent(parents[group]);
      const luminous=['contact','witness','ticks'].includes(material);
      shadows.add(object,{static:group==='world'||group==='fixed'&&!name.startsWith('Flexspline'),
        castShadow:material!=='floor'&&!luminous});
      return object;
    }
    for(const [key,geometry] of staticBatches) {
      const [group,material]=key.split(':');
      create(key,material,geometry,group);
    }
    const wall=create('Flexspline cup','copper',cup.geometry,'fixed');
    const teeth=create('Flexspline teeth','copperEdge',collar.geometry,'fixed');
    return (pose)=>{
      generator.setRotation([0,0,pose.input%tau]);
      output.setRotation([0,0,pose.output%tau]);
      deform(cup,pose);
      deform(collar,pose);
      wall.setGeometry(cup.geometry,{start:0,count:cup.geometry.positions.length/3});
      teeth.setGeometry(collar.geometry,{start:0,count:collar.geometry.positions.length/3});
    };
  };
}
