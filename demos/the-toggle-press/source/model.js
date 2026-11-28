import { applyMatrix4, cylinderGeometry, extrudeGeometry, latheGeometry, mergeGeometries, Shape, sphereGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { linkLength, pivotY, stopOffset } from './mechanism.js';

const tau=Math.PI*2;
const up=[0,1,0],right=[1,0,0],front=[0,0,1];
const hingeZ=.124,ramZ=.105;
const screwY=.608,screwZ=.168;
const screwLead=.025;
const nutX=.420;
const stopFace=.479;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));

const finishes={
  studio:{color:[.270,.237,.183],roughness:.96,metalness:0},
  feet:{color:[.096,.070,.051],roughness:.73,metalness:0},
  wood:{color:[.211,.112,.054],roughness:.46,metalness:0},
  woodEdge:{color:[.305,.166,.075],roughness:.43,metalness:0},
  iron:{color:[.102,.079,.062],roughness:.51,metalness:.30},
  enamel:{color:[.293,.065,.044],roughness:.39,metalness:0},
  redEdge:{color:[.387,.101,.059],roughness:.38,metalness:0},
  brass:{color:[.713,.426,.165],roughness:.31,metalness:.59},
  bronze:{color:[.414,.260,.118],roughness:.45,metalness:.55},
  steel:{color:[.599,.581,.496],roughness:.31,metalness:.63},
  darkSteel:{color:[.326,.321,.284],roughness:.39,metalness:.54},
  paper:{color:[.812,.746,.562],roughness:.77,metalness:0},
  dialInk:{color:'#553d2c',shading:'basic'},
  marker:{color:'#9d3b28',shading:'basic'},
};

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function beam(from,to,width,depth,edge) {
  const line=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(width,Math.hypot(...line),depth,2,edge),
    from.map((value,i)=>(value+to[i])*.5),unit(line));
}

function turnedRing(inner,outer,length,bevel,segments=62) {
  const a=-length*.5,b=length*.5;
  return latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
    [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],segments);
}

function frameShape() {
  const shape=new Shape();
  shape.moveTo(-.345,.079);
  shape.bezierCurveTo(-.419,.091,-.407,.243,-.392,.351);
  shape.bezierCurveTo(-.366,.562,-.318,.755,-.190,.806);
  shape.bezierCurveTo(-.124,.836,.041,.827,.114,.814);
  shape.bezierCurveTo(.126,.796,.131,.759,.111,.740);
  shape.bezierCurveTo(.075,.727,-.101,.739,-.155,.690);
  shape.bezierCurveTo(-.225,.634,-.247,.516,-.245,.413);
  shape.bezierCurveTo(-.243,.320,-.217,.247,-.146,.211);
  shape.bezierCurveTo(-.102,.187,.044,.181,.142,.177);
  shape.bezierCurveTo(.161,.155,.156,.109,.142,.089);
  shape.bezierCurveTo(.077,.072,-.241,.064,-.345,.079);
  shape.closePath();
  return shape;
}

function alloyThread() {
  const turns=18.5, divisions=222, faces=6;
  const positions=[],normals=[],uvs=[],indices=[];
  const tube=.0028,r=.0135;
  for(let i=0;i<=divisions;i++) {
    const t=i*turns/divisions;
    const a=t*tau;
    const radial=[0,Math.cos(a),Math.sin(a)];
    const tangent=unit([screwLead,-r*tau*Math.sin(a),r*tau*Math.cos(a)]);
    const binormal=cross(tangent,radial);
    for(let j=0;j<=faces;j++) {
      const q=j*tau/faces;
      const n=radial.map((value,k)=>value*Math.cos(q)+binormal[k]*Math.sin(q));
      const vertex=positions.length/3;
      positions.push(.034+screwLead*t+n[0]*tube,screwY+radial[1]*r+n[1]*tube,screwZ+radial[2]*r+n[2]*tube);
      normals.push(...n);
      uvs.push(i/divisions,j/faces);
      if(i&&j) indices.push(vertex,vertex-1,vertex-faces-2,vertex,vertex-faces-2,vertex-faces-1);
    }
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}

export function preparePress() {
  const batches=new Map();
  function add(owner,material,data) {
    const key=owner+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(data);
  }
  function slab(owner,material,p,dimensions,bevel,axis=up) {
    add(owner,material,place(roundedBoxGeometry(...dimensions,2,bevel),p,axis));
  }
  function barrel(owner,material,p,radius,length,segments=34,axis=up,base=radius) {
    add(owner,material,place(cylinderGeometry(radius,base,length,segments),p,axis));
  }
  function ring(owner,material,p,inner,outer,depth,bevel,axis=up,segments=62) {
    add(owner,material,place(turnedRing(inner,outer,depth,bevel,segments),p,axis));
  }
  function bolt(owner,p,r,axis=up) {
    barrel(owner,'iron',p,r*1.19,.0037,18,axis);
    const head=p.map((c,i)=>c+axis[i]*.0034);
    barrel(owner,'steel',head,r,.0064,6,axis);
    const cap=head.map((c,i)=>c+axis[i]*.0038);
    barrel(owner,'darkSteel',cap,r*.37,.0021,12,axis);
  }
  function mark(owner,material,from,to,z,width) {
    const line=[to[0]-from[0],to[1]-from[1]];
    const length=Math.hypot(...line),c=line[0]/length,s=line[1]/length;
    add(owner,material,applyMatrix4(roundedBoxGeometry(length,width,.00085,1,.00023),
      [c,s,0,0,-s,c,0,0,0,0,1,0,(from[0]+to[0])*.5,(from[1]+to[1])*.5,z,1]));
  }

  slab('fixed','studio',[0,-.097,0],[82,.03,82],.006);
  for(const x of [-.39,.48]) for(const z of [-.16,.26])
    barrel('fixed','feet',[x,-.064,z],.036,.031,24,up,.041);
  slab('fixed','woodEdge',[.046,-.049,.067],[1.107,.030,.55],.015);
  slab('fixed','wood',[.044,-.019,.065],[1.118,.041,.551],.018);
  slab('fixed','woodEdge',[.047,.004,.065],[1.077,.013,.517],.0061);
  slab('fixed','iron',[.004,.030,.062],[.967,.042,.478],.016);
  slab('fixed','enamel',[-.009,.058,.052],[.915,.030,.414],.0089);
  for(const x of [-.391,.396]) for(const z of [-.099,.207]) bolt('fixed',[x,.073,z],.0095);

  // The paired castings carry the crown cross-shaft and the bed saddle.
  const casting=extrudeGeometry(frameShape(),{depth:.050,bevelEnabled:true,bevelSize:.010,bevelThickness:.008,
    bevelSegments:2,curveSegments:13});
  for(const z of [-.156,.040]) {
    add('fixed','enamel',place(casting,[0,0,z]));
    for(const [x,y] of [[-.330,.146],[-.342,.267],[-.256,.654],[-.146,.778],[.083,.780]]) {
      barrel('fixed','redEdge',[x,y,z+.053],.028,.008,34,front);
      bolt('fixed',[x,y,z+.059],.0096,front);
    }
    const bracePath=[[-.331,.150],[-.353,.247],[-.349,.378],[-.323,.509],[-.274,.627],[-.204,.730],[-.124,.771],[.007,.785]];
    for(let i=0;i<bracePath.length-1;i++) {
      add('fixed','redEdge',beam([...bracePath[i],z+.054],[...bracePath[i+1],z+.054],.023,.013,.0047));
    }
  }
  for(const [x,y,r] of [[-.321,.253,.035],[-.283,.590,.026],[-.152,.760,.031],[.064,.782,.030]]) {
    barrel('fixed','enamel',[x,y,-.028],r,.190,38,front);
    ring('fixed','bronze',[x,y,.076],r*.57,r*.93,.009,.0020,front,42);
  }
  slab('fixed','redEdge',[.015,.783,-.020],[.228,.084,.174],.015);
  slab('fixed','enamel',[.013,.821,.030],[.199,.023,.235],.0069);
  for(const x of [-.066,.083]) for(const z of [-.016,.131]) bolt('fixed',[x,.833,z],.0080);
  for(const z of [.088,.163]) {
    barrel('fixed','bronze',[0,pivotY,z],.026,.028,44,front);
    ring('fixed','steel',[0,pivotY,z+.016],.012,.025,.008,.0019,front);
  }
  barrel('fixed','steel',[0,pivotY,.135],.011,.128,38,front);
  bolt('fixed',[0,pivotY,.201],.0108,front);

  // Bed and die, with an unloaded clearance at the stop.
  slab('fixed','iron',[-.024,.111,.084],[.287,.066,.250],.012);
  slab('fixed','enamel',[-.013,.148,.098],[.263,.045,.227],.011);
  slab('fixed','darkSteel',[0,.166,.105],[.210,.020,.208],.0060);
  barrel('fixed','bronze',[0,.182,.112],.084,.017,56);
  ring('fixed','steel',[0,.190,.112],.056,.084,.011,.0024,up,60);
  barrel('fixed','brass',[0,.197,.112],.058,.004,62,up,.059);
  ring('fixed','bronze',[0,.199,.112],.047,.049,.0019,.00043,up);
  for(const x of [-.092,.092]) for(const z of [.020,.185]) bolt('fixed',[x,.178,z],.0061);
  // The crosshead slides on rear guide rods and leaves the toggle pivots exposed.
  for(const y of [.244,.536]) {
    add('fixed','enamel',beam([-.239,y,.025],[.062,y,.025],.036,.028,.006));
    for(const x of [-.052,.052]) {
      barrel('fixed','bronze',[x,y,.060],.016,.022,38);
      bolt('fixed',[x,y+.014,.060],.006);
    }
  }
  for(const x of [-.052,.052]) {
    barrel('fixed','steel',[x,.390,.060],.0087,.291,38);
    ring('ram','bronze',[x,0,.060],.0092,.017,.035,.0032,up,40);
    ring('ram','steel',[x,.020,.060],.0092,.015,.006,.0014,up,34);
  }
  slab('ram','darkSteel',[0,0,.073],[.122,.023,.026],.0055);
  // Stationary scale for the ram and a needle on the ram bridge.
  const gaugeX=-.132,gaugeZ=.218;
  slab('fixed','bronze',[gaugeX,.399,gaugeZ-.010],[.056,.228,.016],.0038);
  slab('fixed','paper',[gaugeX,.399,gaugeZ],[.044,.215,.0057],.0019);
  for(let i=0;i<=18;i++) {
    const y=.307+i*.0100;
    mark('fixed','dialInk',[gaugeX-.018,y],[gaugeX+(i%5===0?.013:.006),y],gaugeZ+.0037,i%5===0?.0018:.00105);
  }
  for(const y of [.297,.503]) bolt('fixed',[gaugeX,y,gaugeZ],.0039,front);
  add('fixed','bronze',beam([-.247,.401,.074],[gaugeX,.401,gaugeZ-.022],.019,.018,.0036));

  barrel('ram','steel',[0,-.036,ramZ],.0207,.123,52);
  ring('ram','bronze',[0,-.060,ramZ],.021,.030,.014,.0018,up,38);
  barrel('ram','darkSteel',[0,-.076,ramZ],.041,.026,48);
  barrel('ram','steel',[0,-.092,ramZ],.061,.020,60,up,.058);
  ring('ram','brass',[0,-.103,ramZ],.031,.060,.004,.001,up,60);
  slab('ram','iron',[0,0,.105],[.049,.042,.087],.0073);
  barrel('ram','bronze',[0,0,.134],.019,.041,44,front);
  barrel('ram','steel',[0,0,.166],.0095,.026,36,front);
  bolt('ram',[0,0,.183],.0087,front);
  add('ram','brass',beam([-.024,0,.126],[gaugeX+.020,0,gaugeZ+.006],.0069,.0071,.0021));
  slab('ram','marker',[gaugeX+.014,0,gaugeZ+.006],[.019,.004,.0045],.001);

  // Two cheek plates above, one link below, and a shared knee pin.
  for(const z of [-.024,.024]) {
    slab('upper','brass',[0,0,z],[.032,linkLength,.016],.007);
    slab('upper','bronze',[0,0,z+.010],[.008,linkLength-.046,.0046],.0022);
    for(const y of [-linkLength*.5,linkLength*.5])
      barrel('upper','brass',[0,y,z],.022,.018,38,front);
  }
  slab('lower','bronze',[0,0,0],[.031,linkLength,.024],.0070);
  slab('lower','steel',[0,0,.013],[.0065,linkLength-.037,.0062],.0020);
  for(const y of [-linkLength*.5,linkLength*.5])
    barrel('lower','bronze',[0,y,0],.022,.026,42,front);
  barrel('knee','steel',[0,0,.012],.0108,.129,42,front);
  barrel('knee','bronze',[0,0,.053],.0122,.045,44,front);
  ring('knee','steel',[0,0,.074],.0063,.0134,.0080,.0018,front);
  bolt('knee',[0,0,.082],.0071,front);

  // A translating brass crosshead applies horizontal input to the knee roller.
  const yokeZ=.183;
  for(const x of [-.026,.026]) {
    slab('feed','brass',[x,.579,yokeZ],[.022,.156,.025],.0044);
    slab('feed','steel',[x,.579,yokeZ+.014],[.007,.122,.0038],.0017);
  }
  for(const y of [.501,.657]) {
    slab('feed','bronze',[0,y,yokeZ],[.075,.025,.026],.0056);
    for(const x of [-.026,.026]) bolt('feed',[x,y,yokeZ+.016],.0049,front);
  }
  slab('feed','bronze',[.033,screwY,screwZ],[.045,.043,.031],.0057);
  barrel('feed','darkSteel',[.265,screwY,screwZ],.0122,.462,38,right);
  add('feed','steel',alloyThread());
  barrel('feed','steel',[.502,screwY,screwZ],.0124,.018,42,right);
  ring('feed','bronze',[stopFace-stopOffset+.008,screwY,screwZ],.0124,.0205,.016,.0020,right,44);
  ring('feed','steel',[stopFace-stopOffset+.015,screwY,screwZ],.0124,.0202,.004,.0011,right,44);
  slab('fixed','iron',[.345,.081,.142],[.231,.039,.216],.0099);
  slab('fixed','enamel',[.343,.110,.142],[.181,.038,.182],.0090);
  for(const x of [.283,.405]) for(const z of [.080,.200]) bolt('fixed',[x,.133,z],.0063);
  add('fixed','enamel',beam([.346,.119,.113],[.393,.580,.104],.056,.065,.0094));
  add('fixed','redEdge',beam([.371,.151,.155],[.409,.550,.135],.015,.010,.0034));
  slab('fixed','enamel',[.392,.572,.139],[.147,.040,.155],.0084);
  ring('fixed','enamel',[nutX-.035,screwY,screwZ],.017,.048,.082,.009,right,58);
  ring('fixed','brass',[nutX-.074,screwY,screwZ],.017,.039,.013,.0021,right);
  ring('fixed','bronze',[stopFace-.010,screwY,screwZ],.0166,.027,.020,.0024,right,54);
  ring('fixed','steel',[nutX-.014,screwY,screwZ],.017,.041,.010,.0020,right,52);
  for(const z of [.124,.213]) bolt('fixed',[nutX-.033,screwY+.039,z],.0056);

  ring('wheel','bronze',[0,0,0],.090,.108,.018,.0041,right,72);
  ring('wheel','brass',[.011,0,0],.096,.109,.008,.0022,right,72);
  ring('wheel','bronze',[-.002,0,0],.0164,.034,.037,.0046,right);
  ring('wheel','steel',[.014,0,0],.017,.029,.009,.0016,right);
  for(let i=0;i<5;i++) {
    const a=tau*i/5, b=a+.15;
    add('wheel','brass',beam([0,.027*Math.cos(a),.027*Math.sin(a)],
      [0,.096*Math.cos(b),.096*Math.sin(b)],.013,.016,.0040));
    bolt('wheel',[.015,.092*Math.cos(b),.092*Math.sin(b)],.0049,right);
  }
  const gripAngle=.56,gripY=Math.cos(gripAngle)*.103,gripZ=Math.sin(gripAngle)*.103;
  barrel('wheel','steel',[.030,gripY,gripZ],.0069,.037,26,right);
  add('wheel','wood',place(latheGeometry([
    [0,-.038],[.009,-.038],[.014,-.033],[.016,-.020],[.016,.021],[.013,.035],[.008,.039],[0,.040],
  ],40),[.067,gripY,gripZ],right));
  ring('wheel','brass',[.035,gripY,gripZ],.006,.012,.007,.0019,right,38);
  add('wheel','woodEdge',place(sphereGeometry(.010,22,14),[.101,gripY,gripZ]));

  const groups=Array.from(batches,([key,faces])=>({key,data:faces.length===1?faces[0]:mergeGeometries(faces)}));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const build=(parent)=>engine.createMesh().setParent(parent);
    const upper=build(world),lower=build(world),knee=build(world),ram=build(world),feed=build(world);
    const wheel=build(world).setPosition([nutX,screwY,screwZ]);
    const roots={fixed:world,upper,lower,knee,ram,feed,wheel};
    const materials=new Map(Object.entries(finishes).map(([name,value])=>[name,new Material(value)]));
    for(const {key,data} of groups) {
      const [group,name]=key.split(':');
      const mesh=createMesh(engine,data,materials.get(name));
      mesh.root.name=group+' '+name;
      mesh.root.setParent(roots[group]);
      shadows.add(mesh,{static:group==='fixed',castShadow:!['studio','dialInk','marker'].includes(name)});
    }
    function link(mesh,from,to) {
      const dx=to[0]-from[0],dy=to[1]-from[1];
      mesh.setPosition([(from[0]+to[0])*.5,(from[1]+to[1])*.5,hingeZ])
        .setRotation([0,0,Math.atan2(-dx,dy)]);
    }
    return ({input,kneeX,kneeY,ramY})=>{
      const pin=[kneeX,kneeY];
      link(upper,[0,pivotY],pin);
      link(lower,[0,ramY],pin);
      knee.setPosition([kneeX,kneeY,hingeZ]);
      ram.setPosition([0,ramY,0]);
      feed.setPosition([kneeX,0,0]);
      wheel.setRotation([input*tau/screwLead,0,0]);
    };
  };
}
