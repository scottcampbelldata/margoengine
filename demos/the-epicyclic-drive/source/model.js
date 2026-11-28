import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { assemblyAngles, orbitRadius, teeth } from './kinematics.js';
import { gearOutline } from './profiles.js';

const tau=Math.PI*2;
const up=[0,1,0],front=[0,0,1],right=[1,0,0];
const center=[0,.400,0];
const gearZ=.047;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));
const polar=(radius,t,z=0)=>[radius*Math.cos(t),radius*Math.sin(t),z];

const finishes={
  floor:{color:[.154,.218,.201],roughness:.96,metalness:0},
  foot:{color:[.074,.100,.089],roughness:.72,metalness:0},
  plinth:{color:[.677,.681,.521],roughness:.54,metalness:0},
  ivory:{color:[.697,.704,.597],roughness:.42,metalness:0},
  case:{color:[.102,.196,.180],roughness:.44,metalness:.05},
  cavity:{color:[.147,.186,.156],roughness:.69,metalness:0},
  caseEdge:{color:[.177,.292,.257],roughness:.34,metalness:.08},
  teal:{color:[.087,.449,.351],roughness:.34,metalness:.08},
  steel:{color:[.625,.670,.643],roughness:.29,metalness:.65},
  steelDark:{color:[.316,.389,.363],roughness:.40,metalness:.61},
  black:{color:[.069,.093,.080],roughness:.55,metalness:.22},
  bronze:{color:[.503,.291,.158],roughness:.36,metalness:.62},
  copper:{color:[.744,.397,.224],roughness:.36,metalness:.53},
  brass:{color:[.796,.516,.207],roughness:.32,metalness:.60},
  enamel:{color:[.832,.795,.601],roughness:.50,metalness:0},
  red:{color:[.661,.206,.122],roughness:.45,metalness:0},
};

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function web(from,to,width,depth,edge) {
  const v=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(width,Math.hypot(...v),depth,2,edge),
    from.map((value,i)=>(value+to[i])*.5),unit(v));
}

function annulus(inner,outer,depth,bevel,count) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
    [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],count);
}

function solidGear(count,internal=false) {
  const outline=gearOutline(count,internal),n=outline.length;
  const positions=[],normals=[],uvs=[],indices=[];
  const thick=.0355, bevel=.0015, outer=.2846;
  const layer=(z,offset)=>{
    const inner=outline.map(([x,y])=>{
      const scale=1+offset/Math.hypot(x,y);
      return [x*scale,y*scale,z+gearZ];
    });
    if(!internal) return [inner,null];
    const far=outline.map(([x,y])=>{
      const scale=(outer-offset)/Math.hypot(x,y);
      return [x*scale,y*scale,z+gearZ];
    });
    return [inner,far];
  };
  const layers=[
    layer(-thick*.5,internal?bevel:-bevel),
    layer(-thick*.5+bevel,0),
    layer(thick*.5-bevel,0),
    layer(thick*.5,internal?bevel:-bevel),
  ];
  function vertex(p,normal) {
    positions.push(...p); normals.push(...normal); uvs.push(.5+p[0],.5+p[1]);
  }
  function quad(p,q,r,s,normal,reverse=false) {
    const o=positions.length/3;
    for(const v of [p,q,r,s]) vertex(v,normal);
    if(reverse) indices.push(o,o+2,o+1,o,o+3,o+2);
    else indices.push(o,o+1,o+2,o,o+2,o+3);
  }
  function cap([teethEdge,far],sign) {
    if(internal) {
      for(let i=0;i<n;i++) {
        const j=(i+1)%n;
        quad(teethEdge[i],far[i],far[j],teethEdge[j],[0,0,sign],sign<0);
      }
      return;
    }
    const origin=positions.length/3;
    vertex([0,0,teethEdge[0][2]],[0,0,sign]);
    for(const p of teethEdge) vertex(p,[0,0,sign]);
    for(let i=0;i<n;i++) {
      const a=origin+1+i,b=origin+1+(i+1)%n;
      indices.push(origin,sign>0?a:b,sign>0?b:a);
    }
  }
  cap(layers[0],-1);
  cap(layers.at(-1),1);
  for(let k=0;k<layers.length-1;k++) {
    const first=layers[k],second=layers[k+1];
    for(let side=0;side<(internal?2:1);side++) {
      const inward=internal&&side===0;
      const low=first[side],high=second[side];
      for(let i=0;i<n;i++) {
        const j=(i+1)%n,p=low[i],q=low[j],s=high[i];
        const ab=q.map((value,index)=>value-p[index]);
        const ad=s.map((value,index)=>value-p[index]);
        const normal=unit(cross(ab,ad)).map((value)=>inward?-value:value);
        quad(p,q,high[j],s,normal,inward);
      }
    }
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}

export function prepareDrive() {
  const batches=new Map();
  function add(owner,finish,data) {
    const key=owner+':'+finish;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(data);
  }
  function slab(owner,finish,p,dimensions,bevel,axis=up) {
    add(owner,finish,place(roundedBoxGeometry(...dimensions,2,bevel),p,axis));
  }
  function barrel(owner,finish,p,radius,depth,segments=34,axis=front,back=radius) {
    add(owner,finish,place(cylinderGeometry(radius,back,depth,segments),p,axis));
  }
  function ring(owner,finish,p,inner,outer,depth,bevel,segments=76) {
    add(owner,finish,place(annulus(inner,outer,depth,bevel,segments),p,front));
  }
  function screw(owner,p,r,axis=front) {
    barrel(owner,'black',p,r*1.21,.0034,18,axis);
    const head=p.map((value,i)=>value+axis[i]*.0027);
    barrel(owner,'steel',head,r,.0050,12,axis);
    const cut=head.map((value,i)=>value+axis[i]*.0028);
    slab(owner,'black',cut,[r*1.31,.0008,r*.255],.00025,axis);
  }

  // Powder-coated presentation base and a two-foot mounting yoke.
  slab('world','floor',[0,-.084,0],[95,.035,95],.007);
  slab('world','foot',[0,-.047,.047],[.821,.035,.555],.016);
  slab('world','case',[0,-.017,.047],[.858,.029,.596],.010);
  slab('world','plinth',[0,.009,.047],[.854,.034,.596],.016);
  slab('world','ivory',[0,.029,.047],[.801,.014,.551],.0064);
  for(const x of [-.363,.363]) for(const z of [-.159,.259]) screw('world',[x,.038,z],.0085,up);
  for(const side of [-1,1]) {
    const x=side*.184;
    slab('world','case',[x,.054,.020],[.176,.045,.338],.010);
    add('world','case',web([x,.059,-.058],[x*.91,.154,-.051],.091,.173,.011));
    add('world','caseEdge',web([x+side*.018,.085,.093],[x*.91+side*.016,.164,.038],.031,.023,.0042));
    for(const dx of [-.064,.064]) for(const z of [-.106,.138]) screw('world',[x+dx,.077,z],.0073,up);
  }

  const housing='frame';
  // Turned backplate and outer bearing seat. The front stays open to expose the train.
  barrel(housing,'case',[0,0,-.089],.298,.046,112);
  barrel(housing,'caseEdge',[0,0,-.073],.302,.014,112);
  ring(housing,'case',[0,0,-.020],.2859,.313,.111,.008,108);
  ring(housing,'steelDark',[0,0,-.012],.306,.317,.026,.004,108);
  ring(housing,'caseEdge',[0,0,.042],.2863,.312,.027,.004,108);
  ring(housing,'ivory',[0,0,.052],.294,.310,.011,.0028,108);
  ring(housing,'steel',[0,0,.061],.2856,.2922,.0085,.002,108);
  barrel(housing,'cavity',[0,0,-.054],.279,.019,108);
  for(let i=0;i<12;i++) {
    const a=(i+.25)*tau/12;
    const radial=polar(.306,a,-.019);
    barrel(housing,'case',radial,.023,.080,37);
    barrel(housing,'caseEdge',polar(.309,a,.036),.0161,.014,29);
    screw(housing,polar(.311,a,.045),.0071);
  }
  for(let i=0;i<60;i++) {
    const a=i*tau/60;
    const major=i%5===0;
    add(housing,major?'enamel':'steelDark',web(polar(major?.298:.301,a,.0582),polar(.306,a,.0582),
      major?.0019:.0011,.0012,.00032));
  }
  // Fixed lacquered witness at twelve o'clock.
  add(housing,'red',web(polar(.289,Math.PI/2,.067),polar(.306,Math.PI/2,.067),.0056,.0028,.0010));

  // Actual common-module involute gears. Cosmetic caps stay inside the root circles.
  add('sun','brass',solidGear(teeth.sun));
  ring('sun','bronze',[0,0,.0658],.035,.081,.0058,.0016,67);
  ring('sun','brass',[0,0,.0696],.050,.076,.006,.0019,67);
  barrel('sun','bronze',[0,0,.080],.041,.028,56);
  barrel('sun','steel',[0,0,.105],.024,.037,48);
  screw('sun',[0,0,.122],.012);
  for(let i=0;i<9;i++) {
    const a=i*tau/9;
    barrel('sun','black',polar(.063,a,.074),.0052,.0029,15);
    barrel('sun','brass',polar(.063,a,.0756),.0037,.0024,13);
  }
  add('sun','enamel',web(polar(.046,.22,.078),polar(.079,.22,.078),.0048,.0025,.0008));

  add('planet','copper',solidGear(teeth.planet));
  ring('planet','bronze',[0,0,.0657],.029,.065,.009,.0020,60);
  ring('planet','copper',[0,0,.0715],.036,.058,.0064,.0017,60);
  ring('planet','steelDark',[0,0,.075],.024,.034,.0071,.0017,48);
  for(let i=0;i<6;i++) {
    const a=i*tau/6;
    screw('planet',polar(.047,a,.074),.0040);
  }
  add('planet','enamel',web(polar(.055,.20,.0744),polar(.066,.20,.0744),.0034,.0018,.00060));

  add('ring','steelDark',solidGear(teeth.ring,true));
  ring('ring','steel',[0,0,.065],.2693,.2841,.0084,.0020,112);
  ring('ring','caseEdge',[0,0,.067],.2732,.2819,.0065,.0018,112);
  for(let i=0;i<28;i++) {
    const a=i*tau/28+.08;
    add('ring',i===0?'enamel':'brass',web(polar(.2704,a,.071),polar(.2831,a,.071),
      i===0?.0062:.0013,.0017,.00052));
  }

  // The three-spoke carrier runs behind the teeth, with turquoise axle caps on the face.
  barrel('carrier','teal',[0,0,-.023],.070,.028,58);
  ring('carrier','steelDark',[0,0,-.006],.032,.066,.0073,.002,56);
  ring('carrier','teal',[0,0,.112],.0256,.045,.020,.0036,62);
  ring('carrier','steel',[0,0,.123],.026,.043,.006,.0017,62);
  for(const [i,a] of assemblyAngles.entries()) {
    const start=polar(.053,a-.135,-.008);
    const mid=polar(.130,a+.20,-.008);
    const end=polar(orbitRadius,a,-.006);
    add('carrier','teal',web(start,mid,.053,.022,.0068));
    add('carrier','teal',web(mid,end,.055,.021,.0066));
    add('carrier','caseEdge',web(polar(.066,a-.11,.004),polar(.137,a+.17,.004),.013,.005,.0022));
    barrel('carrier','teal',polar(orbitRadius,a,-.003),.039,.031,45);
    ring('carrier','steelDark',polar(orbitRadius,a,.016),.012,.036,.010,.0026,46);
    const facePath=[
      polar(.041,a-.53,.109),polar(.087,a-.61,.112),
      polar(.128,a-.48,.112),polar(.159,a-.22,.109),
      polar(orbitRadius,a,.106),
    ];
    for(let j=0;j<facePath.length-1;j++) {
      add('carrier','teal',web(facePath[j],facePath[j+1],.017,.013,.0041));
    }
    add('carrier','caseEdge',web(polar(.092,a-.57,.120),polar(.125,a-.48,.120),.0050,.0028,.0009));
    barrel('carrier','steel',polar(orbitRadius,a,.057),.0159,.087,40);
    barrel('carrier','teal',polar(orbitRadius,a,.104),.023,.016,46);
    ring('carrier','steel',polar(orbitRadius,a,.114),.013,.020,.007,.0019,40);
    screw('carrier',polar(orbitRadius,a,.118),.0108);
    if(i===0) add('carrier','teal',web(polar(orbitRadius+.019,a,.110),polar(orbitRadius+.037,a,.110),.007,.0032,.0010));
  }

  const parts=Array.from(batches,([key,geometries])=>({
    key,data:geometries.length===1?geometries[0]:mergeGeometries(geometries),
  }));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const housing=engine.createMesh().setParent(world).setPosition(center);
    const node=(parent=housing)=>engine.createMesh().setParent(parent);
    const sun=node(),ring=node(),carrier=node();
    const planets=assemblyAngles.map((a)=>node(carrier).setPosition(polar(orbitRadius,a)));
    const owners={world:[world],frame:[housing],sun:[sun],ring:[ring],carrier:[carrier],planet:planets};
    const materials=new Map(Object.entries(finishes).map(([name,value])=>[name,new Material(value)]));
    for(const {key,data} of parts) {
      const [group,name]=key.split(':');
      for(const owner of owners[group]) {
        const mesh=createMesh(engine,data,materials.get(name));
        mesh.root.name=group+' '+name;
        mesh.root.setParent(owner);
        shadows.add(mesh,{static:group==='world'||group==='frame',castShadow:name!=='floor'});
      }
    }
    return (pose)=>{
      sun.setRotation([0,0,pose.sun]);
      ring.setRotation([0,0,pose.ring]);
      carrier.setRotation([0,0,pose.carrier]);
      planets.forEach((planet,i)=>planet.setRotation([0,0,pose.planet-pose.carrier+assemblyAngles[i]+Math.PI/teeth.planet]));
    };
  };
}
