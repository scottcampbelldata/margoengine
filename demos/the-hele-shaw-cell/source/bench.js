import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry, torusGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { Material, MatcapMaterial, Texture } from '@margoengine/materials';
import { centerX, length, width } from './pressure.js';

export const dyeY=.1114;

const turn=(shape,[x,y,z],angles=[0,0])=>{
  const [yaw,roll]=angles,c=Math.cos(yaw),s=Math.sin(yaw),d=Math.cos(roll),e=Math.sin(roll);
  return applyMatrix4(shape,[c*d,e,-s*d,0,-c*e,d,s*e,0,s,0,c,0,x,y,z,1]);
};
const block=(w,h,d,p,r=.005,angles)=>turn(roundedBoxGeometry(w,h,d,1,r),p,angles);
const cylinder=(radius,height,p,n=32)=>turn(cylinderGeometry(radius,radius,height,n,1),p);
const profile=(points,p,n=56,angles)=>turn(latheGeometry(points,n),p,angles);
const elbow=(radius,tube,p,roll)=>turn(torusGeometry(radius,tube,9,22,Math.PI/2),p,[0,roll]);

export function color(hex){
  return Array.from({length:3},(_,i)=>{
    const x=parseInt(hex.slice(2*i+1,2*i+3),16)/255;
    return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
  });
}
const mix=(a,b,k)=>a.map((x,i)=>x+(b[i]-x)*k);

function backdrop(){
  const mesh={positions:[],normals:[],colors:[],indices:[]};
  const indigo=color('#42585b'),fog=color('#7b8e89'),putty=color('#afb1a0');
  const rows=[[-.015,4,0,putty],[-.015,.4,0,putty],[-.015,-.39,0,indigo]];
  for(let j=1;j<=18;j++){
    const t=j*Math.PI/36;
    rows.push([-.015+.73*(1-Math.cos(t)),-.39-.73*Math.sin(t),t,mix(indigo,fog,Math.sin(t))]);
  }
  rows.push([4,-1.12,Math.PI/2,fog]);
  for(const [i,[y,z,t,c]] of rows.entries()){
    for(const x of [-6,6]){
      mesh.positions.push(x,y,z);mesh.normals.push(0,Math.cos(t),Math.sin(t));mesh.colors.push(...c);
    }
    if(i){const v=(i-1)*2;mesh.indices.push(v,v+1,v+2,v+1,v+3,v+2);}
  }
  return mesh;
}

function reflection(){
  const size=64,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=2*(x+.5)/size-1,v=2*(y+.5)/size-1;
    const key=Math.exp(-2.29*((u+.47)/.31)**4-1.6*((v-.21)/.68)**4);
    const rim=Math.exp(-2.21*((u-.51)/.17)**4-1.17*((v-.02)/.72)**4);
    const fx=Math.exp(-2*((u+.14)/.57)**4-2.5*((v+.58)/.08)**4);
    const at=4*(x+y*size);
    for(let i=0;i<3;i++)data[at+i]=Math.min(251,[91,90,86][i]+[151,142,126][i]*key+[52,88,107][i]*rim+[28,38,36][i]*fx);
    data[at+3]=255;
  }
  return new Texture({width:size,height:size,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

function underplate(){
  const shape={positions:[],normals:[],colors:[],indices:[]};
  const d=color('#869d89'),a=color('#d3dbb1'),h=color('#ededcc');
  const rows=20,cols=35;
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const u=i/cols,v=j/rows;
    const x=(u-.5)*(length+.008),z=(v-.5)*(width+.008);
    const rim=Math.max(Math.abs(u*2-1)**6,Math.abs(v*2-1)**5);
    const hotspot=Math.exp(-2.5*((u-.27)/.81)**2-2.5*((v-.33)/.81)**2);
    shape.positions.push(x,.11015,z);shape.normals.push(0,1,0);
    shape.colors.push(...mix(mix(a,d,rim*.65),h,.68*hotspot));
    if(i&&j){
      const c=i+j*(cols+1),b=c-(cols+1);
      shape.indices.push(b-1,c-1,b,b,c-1,c);
    }
  }
  return shape;
}


function glassReflection(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const nx=32,nz=20,light=color('#f3f5e7');
  for(let j=0;j<=nz;j++)for(let i=0;i<=nx;i++){
    const u=i/nx,x=(u-.5)*.437,z=(j/nz-.5)*.253;
    const main=Math.exp(-.95*((z+.31*x+.063)/.010)**2);
    const spill=Math.exp(-.80*((z+.32*x+.043)/.020)**2);
    const end=Math.sin(Math.PI*u)**.42;
    g.positions.push(x,.11973,z);g.normals.push(0,1,0);
    g.colors.push(...light,(.29*main+.11*spill)*end);
    if(i&&j){
      const d=i+j*(nx+1),c=d-1,b=d-(nx+1),a=b-1;
      g.indices.push(a,c,b,b,c,d);
    }
  }
  return g;
}

function kit(join,m){
  join(backdrop(),m.studio,'Infinite studio sweep','receive');
  join([
    block(.664,.055,.402,[0,.016,.011],.018),
    block(.642,.012,.375,[0,.050,.011],.022),
  ],m.base,'Smoked oak specimen plinth','cast');
  join([
    block(.623,.003,.365,[0,.024,.016],.015),
    block(.145,.021,.003,[-.171,.024,.211],.005),
    ...[-.23,-.114].map(x=>block(.003,.003,.002,[x,.024,.213],.0007)),
    ...[-.275,.275].flatMap(x=>[-.145,.164].map(z=>cylinder(.017,.019,[x,.057,z],18))),
  ],m.chrome,'Satin brass inlay, serial plate and footings');
  join([
    block(.522,.026,.306,[0,.076,0],.010),
    block(.486,.022,.288,[0,.096,0],.007),
    ...[-.256,.256].flatMap(x=>[-.144,.144].map(z=>block(.038,.024,.039,[x,.074,z],.006))),
  ],m.enamel,'Cast powder-coated chassis','cast');
  join([
    block(.448,.008,.263,[0,.105,0],.003),
    ...[-.127,.127].map(z=>block(.441,.006,.010,[0,.112,z],.002)),
    ...[-.216,.216].map(x=>block(.011,.007,.245,[x,.111,0],.004)),
  ],m.edge,'Narrow glass gap and graphite spacer edges');
  join(underplate(),m.platen,'Backlit opaline lower plate');
  join(block(.447,.0074,.265,[0,.1160,0],.0028),m.glass,'Bevelled top glass',undefined,9);
  join(glassReflection(),m.reflectedLight,'Broad overhead reflection',undefined,11);
  join([
    ...[-.131,.131].map(z=>block(.442,.0027,.004,[0,.1174,z],.0012)),
    ...[-.224,.224].map(x=>block(.004,.0027,.268,[x,.1174,0],.0012)),
  ],m.highlight,'Ground-glass rim and catching edges',undefined,10);

  const bolts=[],clamps=[],washers=[];
  for(const z of [-.140,.140])for(const x of [-.191,-.086,.086,.191]){
    bolts.push(cylinder(.0075,.006,[x,.132,z],8));
    clamps.push(block(.029,.018,.019,[x,.120,z],.003));
    washers.push(cylinder(.010,.002,[x,.128,z],22));
  }
  join(clamps,m.enamel,'Glass frame load clamps');
  join(washers,m.chrome,'Satin load washers');
  join(bolts,m.brass,'Eight hexagon-headed retaining screws');

  const manifold=[];
  for(const s of [-1,1]){
    const x=s*.242;
    manifold.push(block(.035,.030,.265,[x,.112,0],.005));
    for(const z of [-.109,.109])manifold.push(cylinder(.012,.017,[x,.128,z],22));
  }
  join(manifold,m.enamel,'Inlet and outlet manifold blocks','cast');
  const valves=[],knurls=[];
  for(const [s,z] of [[-1,-.073],[1,.080]]){
    const x=s*.244;
    valves.push(profile([[.013,0],[.016,.002],[.016,.007],[.012,.008],[.012,.019],[.009,.021],
      [.009,.034],[.017,.035],[.017,.043],[.012,.045],[0,.046]],[x,.126,z],36));
    for(let i=0;i<12;i++){
      const t=i*Math.PI/6;
      knurls.push(block(.003,.006,.003,[x+.015*Math.cos(t),.166,z+.015*Math.sin(t)],.001,[t,0]));
    }
  }
  join(valves,m.brass,'Inlet and outlet micrometer valves');
  join(knurls,m.chrome,'Machined knurls and handwheel tips');

  const nozzles=[],collars=[];
  for(let j=0;j<18;j++){
    const z=-width/2+(.035+.93*j/17)*width;
    nozzles.push(block(.014,.0028,.0028,[-.213,.112,z],.0006));
    collars.push(block(.004,.0038,.0046,[-.219,.113,z],.0008));
  }
  join(nozzles,m.chrome,'Dye sample ports');
  join(collars,m.brass,'Port ferrules');
  join(block(.003,.0025,.222,[.215,.112,0],.0009),m.chrome,'Continuous collection slit');

  const fittings=[],tubes=[];
  for(const [x,z] of [[-.277,-.072],[.279,.080]]){
    const side=Math.sign(x),p=[x,.110,z];
    fittings.push(profile([[.008,-.017],[.010,-.017],[.010,-.011],[.008,-.010],[.008,.013],
      [.011,.014],[.011,.018],[.007,.018]],p,24,[0,-Math.PI/2]));
    tubes.push(elbow(.024,.0058,[x+side*.017,.086,z],side===1?0:Math.PI/2),
      cylinder(.0058,.052,[x+side*.041,.061,z],16));
  }
  join(fittings,m.brass,'Pressure-side barrel hose couplers');
  join(tubes,m.hose,'Reinforced supply and return bends');
}

function rotor(add,m){
  const barrel=add(profile([[0,0],[.977,0],[.997,.0007],[1,.003],[1,.0070],[.984,.0084],[.959,.009],
    [.930,.009],[.919,.0084],[0,.0084]],[0,0,0],76),m.obstacle,'Polished removable ceramic obstruction');
  const rim=add(profile([[.906,.00842],[.922,.00853],[.927,.0090],[.927,.0098],[.904,.0098],[.906,.00842]],
    [0,0,0],74),m.brass,'Brass outer calibration lip');
  const mids=add(profile([[0,.009],[.166,.009],[.179,.0101],[.178,.0131],[.162,.014],[.050,.014],[.045,.012],[0,.012]],
    [0,0,0],42),m.chrome,'Threaded lift boss');
  const fixed=[barrel,rim,mids];
  fixed.forEach(mesh=>mesh.root.setPosition([centerX,.1073,0]));
  return radius=>fixed.forEach(mesh=>mesh.root.setScale([radius,1,radius]));
}

export function assemble(add){
  const reflect=reflection();
  const m={
    studio:new Material({color:'#e4e4cb',roughness:.88}),
    base:new Material({color:'#353633',roughness:.62}),
    enamel:new Material({color:'#263738',roughness:.38}),
    edge:new Material({color:'#327866',roughness:.35}),
    platen:new Material({shading:'basic',color:'#edf2d7'}),
    obstacle:new Material({color:'#d9b98c',roughness:.24}),
    chrome:new MatcapMaterial({color:'#c2dfd7',matcap:reflect}),
    brass:new MatcapMaterial({color:'#e7b574',matcap:reflect}),
    reflectedLight:new Material({shading:'basic',color:'#e7efdf',transparent:true,opacity:.47,depthWrite:false}),
    glass:new MatcapMaterial({color:'#bbdfcd',matcap:reflect,opacity:.062,transparent:true,depthWrite:false}),
    highlight:new MatcapMaterial({color:'#8fdccb',matcap:reflect,opacity:.60,transparent:true,depthWrite:false}),
    hose:new Material({color:'#55433c',roughness:.41}),
  };
  const join=(geometry,...args)=>add(Array.isArray(geometry)?mergeGeometries(geometry):geometry,...args);
  kit(join,m);
  return {radius:rotor(add,m),dispose(){for(const mat of Object.values(m))mat.dispose();reflect.dispose();}};
}
