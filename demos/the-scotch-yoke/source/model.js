import { applyMatrix4, cylinderGeometry, extrudeGeometry, latheGeometry, mergeGeometries, Path, Shape } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { crankRadius, rollerRadius, slotEndRadius, slotHalfHeight, slotHalfWidth } from './mechanism.js';

const tau=Math.PI*2;
const up=[0,1,0],xAxis=[1,0,0],zAxis=[0,0,1];
const crankX=-.125;
const shaftY=.329,shaftZ=.163;
const pistonX=.524;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));

const finishes={
  floor:{color:[.112,.143,.178],roughness:.93,metalness:0},
  feet:{color:[.044,.056,.069],roughness:.86,metalness:0},
  powder:{color:[.124,.172,.215],roughness:.46,metalness:0},
  railBlue:{color:[.101,.246,.423],roughness:.35,metalness:.03},
  cobalt:{color:[.066,.232,.466],roughness:.34,metalness:.04},
  blueDark:{color:[.043,.090,.176],roughness:.44,metalness:.20},
  steel:{color:[.593,.641,.664],roughness:.34,metalness:.68},
  brushed:{color:[.315,.376,.409],roughness:.43,metalness:.58},
  charcoal:{color:[.054,.067,.079],roughness:.52,metalness:.22},
  orange:{color:[.70,.138,.066],roughness:.37,metalness:.12},
  darkRed:{color:[.37,.078,.044],roughness:.46,metalness:.22},
  brass:{color:[.68,.440,.193],roughness:.39,metalness:.53},
  powderWhite:{color:[.77,.798,.776],roughness:.55,metalness:.04},
  marker:{color:'#e9a271',shading:'basic'},
};

function place(data,position,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?xAxis:zAxis));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...position,1]);
}

function brace(from,to,width,depth,bevel) {
  const v=to.map((c,i)=>c-from[i]);
  return place(roundedBoxGeometry(width,Math.hypot(...v),depth,2,bevel),
    to.map((c,i)=>(c+from[i])*.5),unit(v));
}

function annulus(inner,outer,depth,fillet,segments=64) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+fillet,a],[outer-fillet,a],[outer,a+fillet],[outer,b-fillet],[outer-fillet,b],
    [inner+fillet,b],[inner,b-fillet],[inner,a+fillet],[inner+fillet,a],
  ],segments);
}

function profile(shape,points) {
  points.forEach(([x,y],i)=>i===0?shape.moveTo(x,y):shape.lineTo(x,y));
  shape.closePath();
  return shape;
}

function roundRectangle(width,height,radius) {
  const points=[];
  const origins=[[width-radius,height-radius],[-width+radius,height-radius],[-width+radius,-height+radius],[width-radius,-height+radius]];
  for(let i=0;i<4;i++) {
    for(let j=0;j<=8;j++) {
      const a=(i+j/8)*Math.PI*.5;
      points.push([origins[i][0]+radius*Math.cos(a),origins[i][1]+radius*Math.sin(a)]);
    }
  }
  return points.filter(([x,y],i)=>i===0||Math.hypot(x-points[i-1][0],y-points[i-1][1])>1e-9);
}

function yokeBody() {
  const body=profile(new Shape(),roundRectangle(.065,.198,.018));
  body.holes.push(profile(new Path(),roundRectangle(slotHalfWidth,slotHalfHeight,slotEndRadius)));
  return extrudeGeometry(body,{depth:.045,bevelEnabled:true,bevelSegments:2,bevelSize:.0035,bevelOffset:-.0035,bevelThickness:.004});
}

function cylinderCut(inner,outer,length,x,bevel) {
  const start=tau*.318,end=tau*.970,steps=54;
  const arc=(radius,a,b)=>Array.from({length:steps+1},(_,i)=>{
    const t=a+(b-a)*i/steps;
    return [radius*Math.cos(t),radius*Math.sin(t)];
  });
  const shape=profile(new Shape(),[...arc(outer,start,end),...arc(inner,end,start)]);
  const solid=extrudeGeometry(shape,{depth:length,bevelEnabled:true,bevelThickness:bevel,bevelOffset:-bevel,bevelSize:bevel,bevelSegments:1});
  return applyMatrix4(solid,[0,1,0,0,0,0,1,0,1,0,0,0,x,shaftY,shaftZ,1]);
}

export function prepareYoke() {
  const batches=new Map();
  function add(group,finish,geometry) {
    const key=group+':'+finish;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(geometry);
  }

  function box(group,finish,p,dimensions,bevel,axis=up) {
    add(group,finish,place(roundedBoxGeometry(...dimensions,2,bevel),p,axis));
  }

  function barrel(group,finish,p,radius,length,segments=36,axis=up,back=radius) {
    add(group,finish,place(cylinderGeometry(radius,back,length,segments),p,axis));
  }

  function ring(group,finish,p,inner,outer,depth,bevel,axis,segments=64) {
    add(group,finish,place(annulus(inner,outer,depth,bevel,segments),p,axis));
  }

  function bolt(group,p,radius,axis=up) {
    barrel(group,'charcoal',p,radius*1.21,.0033,16,axis);
    const head=p.map((value,i)=>value+axis[i]*.0035);
    barrel(group,'steel',head,radius,.0055,6,axis);
    const tip=head.map((value,i)=>value+axis[i]*.003);
    barrel(group,'charcoal',tip,radius*.37,.0015,7,axis);
  }

  // Layered cast base and a transverse support for each bearing.
  box('world','floor',[0,-.082,0],[105,.034,105],.006);
  box('world','feet',[0,-.046,.075],[1.581,.037,.544],.017);
  box('world','brushed',[0,-.027,.075],[1.596,.016,.561],.0083);
  box('world','powder',[0,.003,.075],[1.629,.055,.584],.021);
  box('world','railBlue',[0,.031,.075],[1.572,.016,.552],.0071);
  box('world','blueDark',[0,.041,.075],[1.531,.012,.510],.0041);
  for(const x of [-.734,.734]) for(const z of [-.141,.288]) bolt('world',[x,.049,z],.0088);
  for(const x of [-.694,.695]) for(const z of [-.135,.263]) barrel('world','feet',[x,-.059,z],.038,.013,30,up,.042);

  // Fixed crankshaft pedestal and the guide rails for the translating frame.
  box('world','powder',[crankX,.065,-.058],[.273,.041,.252],.012);
  box('world','railBlue',[crankX,.100,-.058],[.232,.032,.216],.0088);
  add('world','railBlue',brace([crankX,.102,-.084],[crankX,shaftY,-.053],.133,.112,.020));
  barrel('world','cobalt',[crankX,shaftY,-.042],.068,.131,64,zAxis);
  ring('world','steel',[crankX,shaftY,.031],.025,.058,.016,.0034,zAxis);
  barrel('world','steel',[crankX,shaftY,.049],.029,.058,44,zAxis);
  for(const x of [-.377,.182]) {
    box('world','powder',[x,.072,.080],[.103,.045,.143],.0080);
    add('world','powder',brace([x,.092,.040],[x,.494,.095],.056,.051,.0074));
    for(const y of [shaftY-.181,shaftY+.181]) {
      barrel('world','cobalt',[x,y,.118],.025,.067,32,xAxis);
      ring('world','steel',[x+.033,y,.118],.012,.024,.0083,.0022,xAxis,34);
    }
  }
  for(const y of [shaftY-.181,shaftY+.181]) barrel('world','steel',[-.099,y,.118],.0118,.643,36,xAxis);

  // Counterweighted flywheel. The roller reaches through the yoke from behind.
  ring('crank','brushed',[0,0,.057],.174,.214,.031,.0061,zAxis,84);
  ring('crank','steel',[0,0,.074],.191,.212,.0074,.0018,zAxis,84);
  ring('crank','charcoal',[0,0,.051],.177,.216,.0090,.0018,zAxis,84);
  for(let i=0;i<5;i++) {
    const a=i*tau/5+.47, b=a+.113;
    const from=[Math.cos(a)*.035,Math.sin(a)*.035,.054];
    const to=[Math.cos(b)*.190,Math.sin(b)*.190,.054];
    add('crank','powder',brace(from,to,.039,.023,.0064));
    add('crank','brushed',brace([from[0],from[1],.068],[to[0],to[1],.068],.008,.0049,.0015));
  }
  barrel('crank','charcoal',[0,0,.057],.058,.033,48,zAxis);
  barrel('crank','steel',[0,0,.076],.039,.014,48,zAxis);
  bolt('crank',[0,0,.083],.019,zAxis);
  add('crank','brushed',brace([-.076,0,.083],[crankRadius,0,.083],.059,.024,.010));
  add('crank','steel',brace([.022,0,.099],[crankRadius-.025,0,.099],.022,.0067,.0024));
  barrel('crank','charcoal',[-.087,0,.090],.033,.026,38,zAxis);
  bolt('crank',[-.086,0,.106],.012,zAxis);
  barrel('crank','steel',[crankRadius,0,.119],.013,.076,44,zAxis);
  barrel('crank','steel',[crankRadius,0,shaftZ],rollerRadius,.052,54,zAxis);
  ring('crank','brushed',[crankRadius,0,.197],.008,.0188,.012,.0029,zAxis,46);
  barrel('crank','brass',[crankRadius,0,.208],.0155,.011,38,zAxis);
  barrel('crank','charcoal',[crankRadius,0,.216],.0069,.0087,17,zAxis);

  // One continuous milled frame with a true slotted opening.
  add('slide','orange',place(yokeBody(),[0,0,.138]));
  for(const x of [-.049,.049]) for(const y of [-.179,.179]) bolt('slide',[x,y,.185],.00535,zAxis);
  for(const y of [-.181,.181]) {
    box('slide','darkRed',[0,y,.128],[.086,.030,.033],.0064);
    ring('slide','brass',[0,y,.118],.0123,.023,.060,.0033,xAxis,40);
  }
  for(const sign of [-1,1]) {
    barrel('slide','brushed',[sign*.069,0,shaftZ],.032,.031,45,xAxis);
    ring('slide','steel',[sign*.082,0,shaftZ],.0207,.0306,.009,.0019,xAxis);
  }

  // The moving piston rod runs through two static bearings into an open cylinder.
  barrel('slide','steel',[.347,0,shaftZ],.0196,.564,52,xAxis);
  barrel('slide','brushed',[-.302,0,shaftZ],.0155,.488,44,xAxis);
  barrel('slide','brass',[-.551,0,shaftZ],.023,.015,44,xAxis);
  barrel('slide','charcoal',[-.565,0,shaftZ],.018,.015,34,xAxis);
  for(const [x,r] of [[-.413,.0183],[.247,.0228]]) {
    box('world','powder',[x,.064,shaftZ],[.114,.038,.180],.0098);
    add('world','cobalt',brace([x,.084,shaftZ],[x,shaftY-.034,shaftZ],.072,.068,.013));
    ring('world','cobalt',[x,shaftY,shaftZ],r,.050,.081,.0070,xAxis);
    ring('world','brass',[x+.041,shaftY,shaftZ],r,.040,.015,.0033,xAxis);
    ring('world','steel',[x-.043,shaftY,shaftZ],r,.044,.017,.0028,xAxis);
    bolt('world',[x-.029,shaftY+.049,shaftZ],.0062);
  }

  const piston=pistonX-crankX;
  barrel('slide','steel',[piston,0,shaftZ],.058,.053,64,xAxis);
  barrel('slide','steel',[piston+.0295,0,shaftZ],.053,.009,56,xAxis,.0575);
  barrel('slide','brushed',[piston-.032,0,shaftZ],.052,.012,56,xAxis,.049);
  for(const x of [-.020,.019]) ring('slide','charcoal',[piston+x,0,shaftZ],.054,.059,.0048,.0014,xAxis);
  ring('slide','brass',[piston+.008,0,shaftZ],.053,.0588,.0066,.0015,xAxis);
  bolt('slide',[piston+.038,0,shaftZ],.019,xAxis);

  for(const x of [.338,.706]) {
    box('world','powder',[x,.068,shaftZ],[.117,.044,.195],.011);
    add('world','railBlue',brace([x,.084,shaftZ],[x,.258,shaftZ],.083,.089,.014));
    ring('world','cobalt',[x,shaftY,shaftZ],.062,.109,.035,.0061,xAxis,72);
    ring('world','steel',[x+.020,shaftY,shaftZ],.062,.099,.009,.0030,xAxis,70);
    ring('world','brushed',[x-.021,shaftY,shaftZ],.063,.093,.009,.0017,xAxis,70);
    for(let i=0;i<6;i++) {
      const a=i*tau/6+.17;
      bolt('world',[x+.022,shaftY+.087*Math.cos(a),shaftZ+.087*Math.sin(a)],.0067,xAxis);
    }
  }
  add('world','cobalt',cylinderCut(.066,.086,.337,.354,.0034));
  add('world','brushed',cylinderCut(.0618,.067,.335,.355,.0015));
  for(const a of [tau*.318,tau*.97]) {
    const y=shaftY+.076*Math.cos(a),z=shaftZ+.076*Math.sin(a);
    add('world','steel',brace([.355,y,z],[.690,y,z],.0060,.0055,.0015));
  }
  for(const x of [.413,.592]) {
    box('world','blueDark',[x,.231,shaftZ-.060],[.067,.052,.064],.0065);
    for(const shift of [-.024,.024]) bolt('world',[x+shift,.240,shaftZ-.087],.0060,zAxis);
  }

  // A witness scale at the front follows the piston position one-for-one.
  box('world','charcoal',[crankX,.073,.306],[.374,.034,.018],.0061);
  box('world','brushed',[crankX,.083,.321],[.354,.023,.007],.0037);
  for(let i=-10;i<=10;i++) {
    const dx=i*crankRadius/10;
    const h=i%5===0?.011:.006;
    box('world',i%5===0?'powderWhite':'charcoal',[crankX+dx,.084+h*.12,.325],[.0013,h,.0008],.00025);
  }
  bolt('world',[crankX-.166,.084,.324],.0047,zAxis);
  bolt('world',[crankX+.166,.084,.324],.0047,zAxis);
  add('slide','darkRed',brace([0,-.191,.162],[0,-.232,.300],.013,.012,.0022));
  box('slide','orange',[0,.088-shaftY,.337],[.009,.031,.013],.0028);
  box('slide','marker',[0,.083-shaftY,.344],[.004,.018,.001],.00025);

  const parts=Array.from(batches,([key,geometries])=>({
    key, geometry:geometries.length===1?geometries[0]:mergeGeometries(geometries),
  }));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const crank=engine.createMesh().setPosition([crankX,shaftY,0]).setParent(world);
    const slide=engine.createMesh().setParent(world);
    const owners={world,crank,slide};
    const materials=new Map(Object.entries(finishes).map(([name,value])=>[name,new Material(value)]));
    for(const {key,geometry} of parts) {
      const [group,finish]=key.split(':');
      const mesh=createMesh(engine,geometry,materials.get(finish));
      mesh.root.name=group+' '+finish;
      mesh.root.setParent(owners[group]);
      shadows.add(mesh,{static:group==='world',castShadow:finish!=='floor'&&finish!=='marker'});
    }
    return ({angle,slide:x})=>{
      crank.setRotation([0,0,angle]);
      slide.setPosition([crankX+x,shaftY,0]);
    };
  };
}
