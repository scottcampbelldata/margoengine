import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, sphereGeometry, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { grooveHalfWidth, hubRadius, tongueHalfLength, tongueHalfWidth } from './mechanism.js';

const tau=Math.PI*2;
const up=[0,1,0],right=[1,0,0],front=[0,0,1];
const axle=.321;
const gap=.118;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));
const orbitMark={shading:'basic',depthTest:false,depthWrite:false};

const finish={
  floor:{color:[.177,.212,.273],roughness:.95,metalness:0},
  feet:{color:[.062,.071,.097],roughness:.78,metalness:.03},
  base:{color:[.102,.147,.212],roughness:.47,metalness:.05},
  cobalt:{color:[.117,.261,.522],roughness:.37,metalness:.08},
  edge:{color:[.253,.385,.591],roughness:.36,metalness:.13},
  steel:{color:[.650,.678,.681],roughness:.31,metalness:.61},
  satin:{color:[.375,.422,.473],roughness:.40,metalness:.57},
  black:{color:[.067,.077,.084],roughness:.56,metalness:.15},
  tongue:{color:[.818,.503,.255],roughness:.33,metalness:.57},
  copper:{color:[.725,.310,.149],roughness:.34,metalness:.56},
  bronze:{color:[.424,.200,.089],roughness:.44,metalness:.57},
  cream:{color:[.789,.761,.608],roughness:.50,metalness:.04},
  inch:{color:'#3a4f65',shading:'basic'},
  index:{color:[.689,.228,.098],roughness:.43,metalness:0},
  cyan:{...orbitMark,color:'#7fe8ff'},
  darkCyan:{...orbitMark,color:'#1f4f66'},
};

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function brace(from,to,width,depth,bevel) {
  const line=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(width,Math.hypot(...line),depth,2,bevel),
    from.map((value,i)=>(value+to[i])*.5),unit(line));
}

function annulus(inner,outer,depth,bevel,segments=64) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
    [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],segments);
}

// One convex lobe left by cutting a diametral slot through the hub face.
function lobe(x0,x1,phase) {
  const phi=Math.asin(grooveHalfWidth/hubRadius);
  const outline=Array.from({length:47},(_,i)=>{
    const a=phi+(Math.PI-2*phi)*i/46;
    return [hubRadius*Math.cos(a),hubRadius*Math.sin(a)];
  });
  const center=[0,.079];
  const cs=Math.cos(phase),sn=Math.sin(phase);
  const at=(x,y,z)=>[x,cs*y-sn*z,sn*y+cs*z];
  const rings=[
    [x0,.971],[x0+.0038,1],[x1-.0038,1],[x1,.971],
  ].map(([x,s])=>outline.map(([u,v])=>at(x,center[0]+(u-center[0])*s,center[1]+(v-center[1])*s)));
  const v=[],n=[],uv=[],ind=[];
  function vertex(p,normal) { v.push(...p); n.push(...normal); uv.push(p[1]+.5,p[2]+.5); }
  for(const [sign,ring] of [[-1,rings[0]],[1,rings.at(-1)]]) {
    const start=v.length/3,normal=[sign,0,0];
    vertex(at(ring[0][0],...center),normal);
    for(const current of ring) vertex(current,normal);
    for(let i=0;i<ring.length;i++) {
      const a=start+1+i,b=start+1+(i+1)%ring.length;
      ind.push(start,sign>0?a:b,sign>0?b:a);
    }
  }
  for(let j=0;j<rings.length-1;j++) {
    const low=rings[j],high=rings[j+1];
    for(let i=0;i<low.length;i++) {
      const k=(i+1)%low.length,start=v.length/3;
      const p=low[i],q=low[k],r=high[k],s=high[i];
      const normal=unit(cross(q.map((value,i)=>value-p[i]),s.map((value,i)=>value-p[i])));
      for(const node of [p,q,r,s]) vertex(node,normal);
      ind.push(start,start+1,start+2,start,start+2,start+3);
    }
  }
  return {positions:Float32Array.from(v),normals:Float32Array.from(n),
    uvs:Float32Array.from(uv),indices:Uint32Array.from(ind)};
}

export function prepareCoupling() {
  const groups=new Map();
  function add(owner,material,geometry) {
    const key=owner+':'+material;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(geometry);
  }
  function box(owner,material,point,dimensions,bevel,axis=up) {
    add(owner,material,place(roundedBoxGeometry(...dimensions,2,bevel),point,axis));
  }
  function barrel(owner,material,p,radius,depth,segments=40,axis=right,bottom=radius) {
    add(owner,material,place(cylinderGeometry(radius,bottom,depth,segments),p,axis));
  }
  function ring(owner,material,p,inner,outer,depth,bevel,segments=64) {
    add(owner,material,place(annulus(inner,outer,depth,bevel,segments),p,right));
  }
  function screw(owner,p,radius,axis=up) {
    barrel(owner,'black',p,radius*1.18,.0034,16,axis);
    const stop=p.map((value,i)=>value+axis[i]*.0031);
    barrel(owner,'steel',stop,radius,.0059,12,axis);
    const slot=stop.map((value,i)=>value+axis[i]*.003);
    box(owner,'black',slot,[radius*1.39,.0009,radius*.27],.00025,axis);
  }

  box('world','floor',[0,-.091,0],[90,.034,90],.006);
  box('world','feet',[0,-.051,.060],[1.377,.047,.554],.020);
  box('world','steel',[0,-.028,.060],[1.399,.018,.570],.0079);
  box('world','base',[0,-.003,.060],[1.419,.048,.582],.015);
  box('world','cobalt',[0,.026,.060],[1.388,.025,.552],.0084);
  box('world','edge',[0,.046,.060],[1.328,.017,.519],.0062);
  for(const x of [-.614,.614]) for(const z of [-.144,.252]) screw('world',[x,.054,z],.0084,up);

  const inputStand=-.350,outputStand=.342;
  box('world','base',[inputStand,.070,.030],[.248,.034,.291],.0096);
  box('world','cobalt',[inputStand,.099,.030],[.200,.032,.240],.008);
  for(const x of [-.086,.086]) for(const z of [-.066,.124]) screw('world',[inputStand+x,.116,z],.0073,up);
  for(const z of [-.039,.052]) {
    add('world','cobalt',brace([inputStand,.105,z],[inputStand,axle-.047,z*.58],.074,.071,.010));
    add('world','edge',brace([inputStand+.030,.125,z],[inputStand+.030,axle-.046,z*.62],.014,.008,.0022));
  }
  ring('world','cobalt',[inputStand,axle,0],.027,.067,.119,.010,62);
  ring('world','steel',[inputStand+.063,axle,0],.026,.059,.013,.0036,64);
  ring('world','satin',[inputStand-.065,axle,0],.026,.061,.010,.0021,58);
  for(const v of [-.044,.044]) screw('world',[inputStand,axle+.044,v],.0066,up);

  box('world','base',[outputStand,.070,.029],[.248,.034,.304],.0096);
  box('world','cobalt',[outputStand,.099,.029],[.196,.036,.254],.0085);
  for(const x of [-.084,.084]) for(const z of [-.072,.123]) screw('world',[outputStand+x,.118,z],.0072,up);
  for(const z of [-.089,.086]) {
    barrel('world','steel',[outputStand,.318,z],.0124,.403,36,up);
    barrel('world','cobalt',[outputStand,.124,z],.026,.035,42,up);
    barrel('world','cobalt',[outputStand,.522,z],.025,.034,40,up);
    screw('world',[outputStand,.541,z],.0081,up);
    barrel('slide','satin',[outputStand,0,z],.024,.042,42,up);
    barrel('slide','steel',[outputStand,.021,z],.022,.0055,44,up);
  }
  box('world','cobalt',[outputStand,.535,-.001],[.140,.033,.229],.0091);
  box('slide','cobalt',[outputStand,-.016,0],[.082,.055,.212],.011);
  ring('slide','cobalt',[outputStand,0,0],.027,.064,.110,.0085,66);
  ring('slide','steel',[outputStand-.061,0,0],.0260,.053,.015,.0031,58);
  ring('slide','satin',[outputStand+.062,0,0],.0260,.055,.011,.0033,58);
  for(const z of [-.038,.038]) screw('slide',[outputStand,.046,z],.0059,up);
  // The fixed scale makes the actual output-bearing elevation legible.
  box('world','base',[outputStand+.024,.365,.149],[.094,.164,.018],.0057);
  box('world','cream',[outputStand+.024,.365,.161],[.070,.150,.006],.0026);
  for(let i=0;i<=13;i++) {
    const y=axle+i*.0080;
    box('world','inch',[outputStand+.044-(i%4===0?.014:.009),y,.1648],[i%4===0?.031:.020,.0011,.0007],.00022);
  }
  add('world','base',brace([outputStand+.071,.121,.141],[outputStand+.071,.370,.142],.022,.018,.0048));
  add('slide','satin',brace([outputStand+.059,.000,.069],[outputStand+.057,0,.175],.0085,.008,.0022));
  box('slide','index',[outputStand+.034,0,.177],[.042,.0059,.0058],.0017);

  for(const side of [-1,1]) {
    const owner=side<0?'input':'output';
    barrel(owner,'steel',[side*.314,0,0],.0249,.458,64);
    barrel(owner,'satin',[side*.109,0,0],.052,.091,64);
    ring(owner,'steel',[side*.111,0,0],.027,.058,.012,.0028,57);
    barrel(owner,'satin',[side*.083,0,0],hubRadius,.036,76);
    ring(owner,'steel',[side*.102,0,0],.111,.138,.0105,.0029,76);
    box(owner,'edge',[side*.0649,0,0],side<0?[.0018,.242,.029]:[.0018,.029,.242],.00062);
    for(const flip of [0,Math.PI]) {
      const x0=side<0?-.065:.0216,x1=side<0?-.0216:.065;
      const phase=flip+(side<0?0:Math.PI*.5);
      add(owner,side<0?'steel':'satin',lobe(x0,x1,phase));
      const mark=.110;
      const a=phase+Math.PI*.5;
      const yy=Math.cos(a)*mark,zz=Math.sin(a)*mark;
      screw(owner,[side*.020,yy,zz],.0079,side<0?right:[-1,0,0]);
    }
    for(let i=0;i<8;i++) {
      const a=i*tau/8;
      screw(owner,[side*.104,.105*Math.cos(a),.105*Math.sin(a)],.0052,side<0?[-1,0,0]:right);
    }
    barrel(owner,'cobalt',[side*.514,0,0],.0442,.038,62);
    ring(owner,'steel',[side*.536,0,0],.023,.043,.0088,.0022,56);
    barrel(owner,'satin',[side*.547,0,0],.0321,.019,50);
    screw(owner,[side*.560,0,0],.0139,side<0?[-1,0,0]:right);
    box(owner,'cream',[side*.515,.0439,0],[.027,.0022,.0060],.00055);
  }

  // The two machined tongues are perpendicular. Each faces its own hub's open slot.
  barrel('disk','copper',[0,0,0],.1285,.039,82);
  ring('disk','bronze',[0,0,0],.119,.130,.015,.0038,78);
  for(const side of [-1,1]) {
    const dim=side<0?[.026,tongueHalfLength*2,tongueHalfWidth*2]:[.026,tongueHalfWidth*2,tongueHalfLength*2];
    box('disk','tongue',[side*.032,0,0],dim,.0040);
    const burnish=side<0?[.0035,.136,.012]:[.0035,.012,.136];
    box('disk','cream',[side*.0454,0,0],burnish,.00115);
    for(let i=0;i<5;i++) {
      const t=(i+.122)*tau/5;
      ring('disk','bronze',[side*.0204,.104*Math.cos(t),.104*Math.sin(t)],.0031,.0067,.0020,.00050,17);
    }
  }
  box('disk','cream',[0,.1304,0],[.017,.0026,.0108],.00060);
  box('disk','index',[0,-.1297,.006],[.020,.0024,.0118],.00063);

  const overlayCircle=applyMatrix4(torusGeometry(1,.025,7,76),[0,1,0,0,0,0,1,0,1,0,0,0,0,0,0,1]);
  add('orbit','cyan',overlayCircle);
  add('center','darkCyan',place(sphereGeometry(.0082,17,12),[0,0,0]));
  add('center','cyan',place(sphereGeometry(.0054,17,12),[.0058,0,0]));

  const pieces=Array.from(groups,([key,geometry])=>({key,data:geometry.length===1?geometry[0]:mergeGeometries(geometry)}));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const group=()=>engine.createMesh().setParent(world);
    const input=group(),output=group(),disk=group(),slide=group(),orbit=group(),center=group();
    const owners={world,input,output,disk,slide,orbit,center};
    const guide=[];
    const materials=new Map(Object.entries(finish).map(([name,value])=>[name,new Material(value)]));
    for(const {key,data} of pieces) {
      const [owner,name]=key.split(':');
      const annotation=owner==='orbit'||owner==='center';
      const mesh=createMesh(engine,data,materials.get(name),{renderOrder:annotation?7:0});
      mesh.root.name=owner+' '+name;
      mesh.root.setParent(owners[owner]);
      if(annotation) guide.push(mesh.root);
      else shadows.add(mesh,{static:owner==='world',castShadow:name!=='floor'&&name!=='inch'});
    }
    return (pose,offset,exploded)=>{
      const spread=exploded?gap:0;
      input.setPosition([-spread,axle,0]).setRotation([pose.input,0,0]);
      output.setPosition([spread,axle+offset,0]).setRotation([pose.output,0,0]);
      disk.setPosition([0,axle+pose.center[0],pose.center[1]]).setRotation([pose.disc,0,0]);
      slide.setPosition([0,axle+offset,0]);
      orbit.setPosition([.008,axle+pose.orbitCenter[0],0])
        .setScale([.067,Math.max(.0005,pose.orbitRadius),Math.max(.0005,pose.orbitRadius)]);
      center.setPosition([.011,axle+pose.center[0],pose.center[1]]);
      for(const mesh of guide) mesh.visible=offset>0;
    };
  };
}
