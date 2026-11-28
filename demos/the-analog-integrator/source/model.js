import { applyMatrix4, latheGeometry, mergeGeometries } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { carriageLimit, diskRadius, wheelRadius } from './mechanism.js';

const up = [0,1,0], right = [1,0,0], front = [0,0,1];
const tau = Math.PI * 2;
const bed = [-.176,.281,.026];
const axleY = bed[1] + wheelRadius;
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = (v) => v.map((value) => value / Math.hypot(...v));

const finish = {
  floor: {color:[.066,.095,.103],roughness:.94},
  foundation: {color:[.113,.170,.178],roughness:.52},
  graphite: {color:[.071,.098,.108],roughness:.50},
  enamel: {color:[.515,.603,.570],roughness:.34},
  shadowEnamel: {color:[.237,.328,.314],roughness:.43},
  contactFace: {color:[.404,.467,.466],roughness:.49},
  aluminum: {color:[.688,.735,.724],roughness:.28,metalness:1},
  bright: {color:[.830,.889,.855],roughness:.29,metalness:1},
  gunmetal: {color:[.379,.470,.474],roughness:.37,metalness:1},
  amber: {color:[.669,.332,.091],roughness:.40},
  rubber: {color:[.058,.065,.064],roughness:.76},
  teal: {color:'#559492',roughness:.66},
  whiteMark: {color:'#d9e5d4',shading:'basic'},
  aquaMark: {color:'#81c6bf',shading:'basic'},
  amberMark: {color:'#ffbd68',shading:'basic'},
};

function place(geometry,p,axis=up) {
  const x = unit(cross(axis,Math.abs(axis[2])>.85?right:front));
  const z = cross(x,axis);
  return applyMatrix4(geometry,[...x,0,...axis,0,...z,0,...p,1]);
}

function annulus(inner,outer,depth,bevel,segments) {
  const bottom = -depth/2, top = depth/2;
  return latheGeometry([
    [inner+bevel,bottom],[outer-bevel,bottom],[outer,bottom+bevel],[outer,top-bevel],
    [outer-bevel,top],[inner+bevel,top],[inner,top-bevel],[inner,bottom+bevel],[inner+bevel,bottom],
  ],segments);
}

function sector(inner,outer,start,end,y) {
  const positions=[], normals=[], uvs=[], indices=[];
  const segments = Math.ceil((end-start)*40);
  for(let i=0;i<=segments;i++) {
    const t = start+(end-start)*i/segments;
    for(const r of [inner,outer]) {
      const x = r*Math.cos(t), z = -r*Math.sin(t);
      positions.push(x,y,z);
      normals.push(0,1,0);
      uvs.push(.5+x,.5+z);
    }
    if(i>0) {
      const n = i*2;
      indices.push(n-2,n-1,n,n,n-1,n+1);
    }
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}

export function prepareIntegrator() {
  const batches = new Map();
  function add(group,material,data) {
    const key = group+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(data);
  }
  function box(group,material,p,size,bevel,axis=up) {
    add(group,material,place(roundedBoxGeometry(...size,2,bevel),p,axis));
  }
  function ring(group,material,p,inner,outer,depth,bevel,axis=up,segments=60) {
    add(group,material,place(annulus(inner,outer,depth,bevel,segments),p,axis));
  }
  function barrel(group,material,p,r,depth,axis=up,segments=48) {
    const h=depth/2, b=Math.min(r*.14,depth*.14);
    const profile=[[0,-h],[r-b,-h],[r,-h+b],[r,h-b],[r-b,h],[0,h]];
    add(group,material,place(latheGeometry(profile,segments),p,axis));
  }
  function brace(group,material,a,b,width,thickness,bevel) {
    const delta=b.map((v,i)=>v-a[i]);
    box(group,material,a.map((v,i)=>(v+b[i])/2),[width,Math.hypot(...delta),thickness],bevel,unit(delta));
  }
  function bolt(group,p,r,axis=up) {
    barrel(group,'gunmetal',p,r*1.44,.0035,axis,18);
    barrel(group,'bright',p.map((v,i)=>v+axis[i]*.004),r,.007,axis,6);
  }

  box('world','floor',[0,-.071,0],[60,.12,60],.009);
  box('world','foundation',[.003,.033,.014],[1.243,.085,.673],.029);
  box('world','graphite',[0,.086,.023],[1.200,.026,.627],.012);
  box('world','shadowEnamel',[0,.106,.023],[1.157,.021,.583],.010);
  box('world','enamel',[0,.028,.349],[1.093,.052,.017],.007);
  box('world','enamel',[0,.025,-.320],[1.075,.051,.018],.007);
  box('world','graphite',[-.384,.030,.359],[.207,.031,.007],.003);
  for(let i=0;i<12;i++) box('world','shadowEnamel',[-.469+.0153*i,.030,.364],[.005,.019,.006],.0015);
  for(const x of [-.542,.547]) for(const z of [-.243,.270]) bolt('world',[x,.119,z],.010);
  box('world','graphite',[.385,.035,.366],[.309,.026,.009],.004);
  box('world','aquaMark',[.385,.035,.372],[.278,.005,.006],.002);

  // Low-drive pedestal leaves the constant-speed disk and its central axle visible.
  barrel('world','shadowEnamel',[bed[0],.139,bed[2]],.151,.053,up,88);
  barrel('world','enamel',[bed[0],.181,bed[2]],.115,.070,up,88);
  ring('world','gunmetal',[bed[0],.214,bed[2]],.075,.111,.017,.0038,up,75);
  barrel('world','gunmetal',[bed[0],.234,bed[2]],.059,.045,up,65);
  for(let i=0;i<18;i++) {
    const t=i*tau/18;
    barrel('world','graphite',[bed[0]+.092*Math.cos(t),.220,bed[2]+.092*Math.sin(t)],.0045,.009,up,12);
  }

  barrel('disk','gunmetal',[0,-.018,0],diskRadius-.018,.023,up,132);
  ring('disk','bright',[0,-.013,0],diskRadius-.030,diskRadius,.024,.004,up,144);
  barrel('disk','contactFace',[0,-.0064,0],diskRadius-.002,.0128,up,144);
  for(const r of [.064,.105,.150,.202,.219]) {
    ring('disk','gunmetal',[0,.00035,0],r-.00075,r+.00075,.00045,.00016,up,128);
  }
  add('disk','teal',sector(.175,.207,.15,1.07,.00064));
  add('disk','teal',sector(.174,.207,.15+Math.PI,1.07+Math.PI,.00064));
  add('disk','amberMark',sector(.209,.218,.17,.49,.00072));
  for(let i=0;i<72;i++) {
    const t=i*tau/72;
    add('disk','graphite',sector(i%6===0?.222:.227,.234,t,t+(i%6===0?.012:.007),.00068));
  }
  barrel('disk','aluminum',[0,-.0014,0],.021,.0028,up,52);
  add('disk','teal',sector(.002,.023,0,tau,.00055));
  barrel('disk','bright',[0,.00044,0],.004,.00048,up,24);

  // Exposed carriage ways, keyed shaft, and a fixed center witness mark.
  for(const x of [-.524,.295]) {
    box('world','enamel',[x,.133,-.087],[.130,.043,.168],.012);
    brace('world','shadowEnamel',[x,.148,-.151],[x,.302,-.058],.066,.069,.013);
    box('world','enamel',[x,.306,-.028],[.102,.083,.140],.018);
    barrel('world','gunmetal',[x,axleY,bed[2]],.038,.102,right,64);
    ring('world','aluminum',[x+.061,axleY,bed[2]],.016,.032,.015,.003,right,62);
    for(const z of [-.106,-.181]) bolt('world',[x,.156,z],.0062);
  }
  for(const z of [-.126,-.171]) barrel('world','bright',[-.123,axleY+.037,z],.0107,.832,right,40);
  box('world','graphite',[-.136,axleY+.063,-.189],[.831,.025,.018],.006);
  for(let i=-9;i<=9;i++) {
    const x=bed[0]+.021*i;
    box('world',i===0?'amberMark':i%3===0?'whiteMark':'gunmetal',[x,axleY+.064,-.178],
      [i===0?.0043:.0017,i%3===0?.018:.011,.003],.0007);
  }
  for(const x of [-1,1]) box('world','shadowEnamel',
    [bed[0]+x*(carriageLimit+.014),axleY+.038,-.148],[.011,.039,.078],.004);
  box('world','amberMark',[bed[0],.1195,.237],[.005,.003,.088],.001);
  for(const side of [-1,1]) {
    box('world','graphite',[bed[0]+side*.131,.119,.297],[.207,.004,.020],.0015);
    for(let i=0;i<7;i++) {
      const x=bed[0]+side*(.048+.027*i);
      box('world',side>0?'aquaMark':'whiteMark',[x,.122,.298],[.0026,.002,i%3===0?.012:.008],.00055);
    }
  }

  for(const z of [-.126,-.171]) ring('carriage','gunmetal',[0,.037,z],.011,.022,.038,.004,right,46);
  box('carriage','amber',[0,.051,-.147],[.061,.028,.087],.009);
  brace('carriage','enamel',[-.024,.041,-.157],[-.024,.006,.012],.028,.030,.006);
  brace('carriage','enamel',[.024,.041,-.157],[.024,.006,.012],.028,.030,.006);
  box('carriage','amberMark',[0,.067,-.158],[.012,.002,.056],.0009);
  barrel('roller','gunmetal',[0,0,0],.030,.042,right,74);
  ring('roller','amber',[0,0,0],.020,.045,.025,.003,right,96);
  ring('roller','rubber',[0,0,0],.042,wheelRadius,.010,.0014,right,96);
  for(const side of [-1,1]) {
    ring('roller','bright',[.013*side,0,0],.018,.034,.004,.001,right,70);
    for(let i=0;i<8;i++) {
      const t=i*tau/8;
      barrel('roller',i===0?'amberMark':'graphite',[.016*side,.028*Math.cos(t),.028*Math.sin(t)],.0028,.0025,right,16);
    }
  }

  // The sliding roller is keyed to one rigid shaft that also carries the readout dial.
  barrel('shaft','gunmetal',[-.013,0,0],.013,.961,right,64);
  box('shaft','bright',[-.078,.012,0],[.831,.004,.004],.0006);
  barrel('shaft','bright',[.422,0,0],.040,.063,right,70);
  ring('shaft','shadowEnamel',[.439,0,0],.101,.149,.036,.006,right,100);
  barrel('shaft','gunmetal',[.448,0,0],.118,.014,right,96);
  ring('shaft','bright',[.454,0,0],.131,.145,.013,.0023,right,100);
  ring('shaft','aluminum',[.458,0,0],.104,.109,.006,.0017,right,100);
  barrel('shaft','aluminum',[.459,0,0],.054,.012,right,82);
  barrel('shaft','graphite',[.467,0,0],.029,.009,right,60);
  bolt('shaft',[.473,0,0],.013,right);
  for(let i=0;i<48;i++) {
    const t=i*tau/48, y=Math.cos(t), z=Math.sin(t);
    const radius=i%4===0?.122:.1265;
    brace('shaft',i===0?'amberMark':'whiteMark',
      [.461,y*radius,z*radius],[.461,y*.130,z*.130],i%4===0?.0035:.0018,.0021,.0005);
  }
  for(const [start,end,material] of [[.15,1.34,'aquaMark'],[1.47,2.02,'aquaMark'],[3.30,4.23,'amberMark']]) {
    // A second set of markings carries across the rim for the wide view.
    for(let i=Math.ceil(start*26);i<end*26;i++) {
      const t=i/26;
      box('shaft',material,[.438,.1498*Math.cos(t),.1498*Math.sin(t)],[.026,.0035,.0067],
        .0007,[0,Math.cos(t),Math.sin(t)]);
    }
  }
  brace('world','enamel',[.540,.126,.158],[.482,.305,.176],.054,.056,.009);
  brace('world','shadowEnamel',[.482,.305,.176],[.475,.403,.153],.026,.035,.006);
  box('world','amberMark',[.475,.409,.143],[.008,.009,.018],.0018);
  box('world','graphite',[.540,.136,.180],[.094,.017,.097],.006);
  bolt('world',[.548,.146,.212],.008);

  const objects=Array.from(batches,([key,pieces])=>[
    key,pieces.length===1?pieces[0]:mergeGeometries(pieces),
  ]);
  return (engine,shadows) => {
    const world=engine.createMesh();
    const disk=engine.createMesh().setParent(world).setPosition(bed);
    const carriage=engine.createMesh().setParent(world);
    const roller=engine.createMesh().setParent(carriage).setPosition([0,0,bed[2]]);
    const shaft=engine.createMesh().setParent(world).setPosition([0,axleY,bed[2]]);
    const groups={world,disk,carriage,roller,shaft};
    const materials=new Map(Object.entries(finish).map(([key,options])=>[key,new Material(options)]));
    for(const [key,data] of objects) {
      const [group,material]=key.split(':');
      const object=createMesh(engine,data,materials.get(material));
      object.root.name=key;
      object.root.setParent(groups[group]);
      shadows.add(object,{static:group==='world',castShadow:material!=='floor'&&!material.endsWith('Mark')});
    }
    return (state) => {
      disk.setRotation([0,(state.diskTurns%1)*tau,0]);
      carriage.setPosition([bed[0]+state.radius,axleY,0]);
      const angle=(state.outputTurns%1)*tau;
      roller.setRotation([angle,0,0]);
      shaft.setRotation([angle,0,0]);
    };
  };
}
