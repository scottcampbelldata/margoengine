import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, Texture, createMesh } from '@margoengine/materials';
import { camRadius, cutAt, modulation, rosettes, toolX } from './kinematics.js';

const tau=Math.PI*2;
const up=[0,1,0],front=[0,0,1],right=[1,0,0];
const centerY=.360;
const camZ=-.064;
const faceZ=.182;
const sampleCount=361;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));
const polar=(r,a,z=0)=>[r*Math.cos(a),r*Math.sin(a),z];

const finish={
  floor:{color:[.180,.139,.161],roughness:.96,metalness:0},
  feet:{color:[.061,.041,.047],roughness:.76,metalness:0},
  wood:{color:[.249,.140,.078],roughness:.51,metalness:0},
  woodEdge:{color:[.326,.185,.103],roughness:.46,metalness:0},
  plum:{color:[.208,.084,.136],roughness:.41,metalness:.08},
  trim:{color:[.309,.137,.214],roughness:.35,metalness:.11},
  iron:{color:[.067,.063,.069],roughness:.57,metalness:.22},
  bronze:{color:[.412,.240,.119],roughness:.40,metalness:.60},
  brass:{color:[.723,.480,.234],roughness:.32,metalness:.59},
  silver:{color:[.675,.690,.683],roughness:.33,metalness:.60},
  steel:{color:[.347,.384,.391],roughness:.42,metalness:.59},
  cream:{color:[.801,.745,.584],roughness:.62,metalness:0},
  face:{color:[1,1,1],roughness:.42,metalness:.24},
  engraved:{color:'#b77c31',shading:'basic'},
  cutting:{color:'#f5b960',shading:'basic'},
};

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function walnutGrain() {
  const width=128,height=96;
  const data=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const u=x/(width-1),v=y/(height-1);
    const knot=Math.exp(-19*(u-.32)**2-66*(v-.51)**2);
    const warp=v+.022*Math.sin(tau*(u+v*.2))+.062*knot;
    const annual=.5+.5*Math.cos(tau*(warp*22+.28*Math.sin(tau*u)));
    const pores=.5+.5*Math.sin(tau*(warp*39+.11*Math.cos(tau*4*u)));
    const band=.5+.5*Math.sin(tau*(warp*4+.13*u));
    const tone=Math.round(234-36*annual**5-12*pores**3-20*band);
    data.set([tone,tone-4,tone-10,255],(y*width+x)*4);
  }
  return new Texture({data,width,height},{colorSpace:'linear'});
}

function strut(from,to,w,d,bevel) {
  const delta=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(w,Math.hypot(...delta),d,2,bevel),
    from.map((value,i)=>(value+to[i])*.5),unit(delta));
}

function annulus(inner,outer,depth,bevel,segments=68) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
    [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],segments);
}

function mesh(positions,normals,uvs,indices,colors) {
  const data={positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
  if(colors) data.colors=Float32Array.from(colors);
  return data;
}

function rosetteVolume(rosette) {
  const segments=rosette.lobes*32;
  const edge=Array.from({length:segments},(_,i)=>cutAt(rosette,i*tau/segments,camRadius));
  const loops=[[camZ-.022,.979],[camZ-.016,1],[camZ+.015,1],[camZ+.020,.978]]
    .map(([z,scale])=>edge.map(([x,y])=>[x*scale,y*scale,z]));
  const p=[],n=[],uv=[],idx=[];
  function vertex(at,normal) { p.push(...at); n.push(...normal); uv.push(.5+at[0],.5+at[1]); }
  for(const [loop,sign] of [[loops[0],-1],[loops.at(-1),1]]) {
    const base=p.length/3;
    vertex([0,0,loop[0][2]],[0,0,sign]);
    for(const c of loop) vertex(c,[0,0,sign]);
    for(let i=0;i<segments;i++) {
      const a=base+1+i,b=base+1+(i+1)%segments;
      idx.push(base,sign>0?a:b,sign>0?b:a);
    }
  }
  for(let k=0;k<loops.length-1;k++) {
    const low=loops[k],high=loops[k+1];
    for(let i=0;i<segments;i++) {
      const j=(i+1)%segments,base=p.length/3;
      const direction=low[j].map((v,o)=>v-low[i][o]);
      const slope=high[i].map((v,o)=>v-low[i][o]);
      const normal=unit(cross(direction,slope));
      for(const v of [low[i],low[j],high[j],high[i]]) vertex(v,normal);
      idx.push(base,base+1,base+2,base,base+2,base+3);
    }
  }
  return mesh(p,n,uv,idx);
}

function finishedWork(rosette) {
  const size=288;
  const light=[.72,.748,.735],shadow=[.229,.276,.281];
  const rows=[{radius:.006,gain:0,level:0,color:light}];
  for(const r of [.049,.061,.073,.085,.097,.109]) {
    for(const [offset,level,color] of [
      [-.0017,0,light],[-.00058,-.00092,shadow],
      [.00058,-.00092,shadow],[.0017,0,light],
    ]) rows.push({radius:r+offset,gain:1,level,color});
  }
  rows.push({radius:.160,gain:0,level:0,color:light});
  const positions=[],normals=[],uvs=[],indices=[],colors=[];
  const levels=rows.map(({radius,gain,level})=>Array.from({length:size},(_,i)=>{
    const t=i*tau/size;
    return polar(radius+gain*modulation(rosette,t),t,faceZ+level);
  }));
  for(let j=0;j<levels.length;j++) {
    for(let i=0;i<size;i++) {
      const point=levels[j][i],next=(i+1)%size,previous=(i+size-1)%size;
      const radial=levels[Math.min(j+1,levels.length-1)][i].map((v,k)=>v-levels[Math.max(0,j-1)][i][k]);
      const tangent=levels[j][next].map((v,k)=>v-levels[j][previous][k]);
      const normal=unit(cross(radial,tangent));
      positions.push(...point); normals.push(...normal); colors.push(...rows[j].color);
      uvs.push(.5+point[0],.5+point[1]);
      if(j>0) {
        const a=(j-1)*size+i,b=(j-1)*size+next,c=j*size+i,d=j*size+next;
        indices.push(a,c,d,a,d,b);
      }
    }
  }
  return mesh(positions,normals,uvs,indices,colors);
}

function makeTrace() {
  const positions=Float32Array.from({length:sampleCount*6},(_,i)=>i%3===2?faceZ+.0013:0);
  const normals=Float32Array.from(positions,(_,i)=>i%3===2?1:0);
  const uvs=new Float32Array(sampleCount*4);
  const indices=[];
  for(let i=1;i<sampleCount;i++) {
    const j=i*2;
    indices.push(j-2,j,j-1,j,j+1,j-1);
  }
  return {positions,normals,uvs,indices:Uint32Array.from(indices)};
}

function writeTrace(geometry,rosette,cut,start) {
  for(let i=start;i<sampleCount;i++) {
    const p=-Math.min(cut,i)*tau/360,delta=tau/720;
    const [x,y]=cutAt(rosette,p);
    const [ax,ay]=cutAt(rosette,p+delta),[bx,by]=cutAt(rosette,p-delta);
    const dx=bx-ax,dy=by-ay,scale=.0011/Math.hypot(dx,dy);
    const a=i*6;
    geometry.positions[a]=x+dy*scale;
    geometry.positions[a+1]=y-dx*scale;
    geometry.positions[a+3]=x-dy*scale;
    geometry.positions[a+4]=y+dx*scale;
  }
}

export function prepareRoseEngine() {
  const batches=new Map();
  function add(owner,material,geometry) {
    const key=owner+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(geometry);
  }
  function box(owner,material,p,size,bevel,axis=up) {
    add(owner,material,place(roundedBoxGeometry(...size,2,bevel),p,axis));
  }
  function plinth(material,p,size,bevel) {
    const board=place(roundedBoxGeometry(...size,2,bevel),p);
    for(let i=0;i<board.positions.length/3;i++) {
      const [x,y,z]=board.positions.subarray(i*3,i*3+3);
      board.uvs[i*2]=.48+x;
      board.uvs[i*2+1]=.44+y*2.5+z*.85;
    }
    add('world',material,board);
  }
  function barrel(owner,material,p,radius,depth,segments=38,axis=front,bottom=radius) {
    add(owner,material,place(cylinderGeometry(radius,bottom,depth,segments),p,axis));
  }
  function ring(owner,material,p,inner,outer,depth,bevel,segments=70) {
    add(owner,material,place(annulus(inner,outer,depth,bevel,segments),p,front));
  }
  function screw(owner,p,r,axis=up) {
    barrel(owner,'iron',p,r*1.19,.0035,18,axis);
    const head=p.map((v,i)=>v+axis[i]*.0028);
    barrel(owner,'silver',head,r,.0058,14,axis);
    const slot=head.map((v,i)=>v+axis[i]*.0031);
    box(owner,'iron',slot,[r*1.33,.00085,r*.27],.00024,axis);
  }

  box('world','floor',[0,-.085,0],[92,.030,92],.006);
  box('world','feet',[.030,-.049,.023],[.910,.043,.568],.020);
  plinth('woodEdge',[.032,-.021,.027],[.944,.028,.605],.014);
  plinth('wood',[.031,.006,.028],[.937,.049,.594],.016);
  plinth('woodEdge',[.031,.031,.028],[.913,.015,.567],.0060);
  box('world','iron',[.018,.045,.019],[.834,.021,.503],.0074);
  for(const x of [-.345,.379]) for(const z of [-.174,.212]) screw('world',[x,.057,z],.0090,up);

  // Linear guide for the moving headstock and fixed spindle housing.
  for(const x of [-.286,.256]) {
    box('world','plum',[x,.079,-.160],[.121,.049,.183],.011);
    for(const z of [-.210,-.110]) {
      box('world','trim',[x,.105,z],[.081,.051,.064],.0094);
      barrel('world','bronze',[x,.123,z],.026,.052,36,right);
      screw('world',[x,.138,z],.0060,up);
    }
  }
  for(const z of [-.210,-.110]) barrel('world','silver',[-.015,.123,z],.0123,.560,42,right);
  for(const z of [-.211,-.108]) barrel('slide','bronze',[0,.124-centerY,z],.025,.132,48,right);
  box('slide','plum',[0,.159-centerY,-.163],[.234,.065,.201],.014);
  add('slide','plum',strut([-.078,.180-centerY,-.215],[-.043,-.009,-.176],.070,.069,.012));
  add('slide','plum',strut([.078,.181-centerY,-.215],[.042,-.009,-.176],.070,.069,.012));
  box('slide','trim',[0,-.015,-.183],[.152,.111,.137],.018);
  ring('slide','bronze',[0,0,-.143],.024,.057,.060,.0050,62);
  ring('slide','silver',[0,0,-.112],.022,.048,.010,.0030,62);
  for(const x of [-.056,.056]) screw('slide',[x,.032,-.154],.0083,up);

  // Back handwheel and stepped chuck share the rosette's rotation.
  barrel('spindle','steel',[0,0,-.104],.024,.358,58);
  ring('spindle','steel',[0,0,-.255],.119,.147,.026,.0061,75);
  ring('spindle','brass',[0,0,-.239],.130,.144,.0076,.0018,75);
  for(let i=0;i<5;i++) {
    const a=i*tau/5;
    add('spindle','bronze',strut(polar(.029,a,-.256),polar(.125,a+.143,-.255),.025,.015,.0048));
  }
  barrel('spindle','brass',[0,0,-.258],.033,.030,54);
  barrel('spindle','wood',[.119,.048,-.283],.0177,.056,38);
  ring('spindle','brass',[.119,.048,-.315],.009,.016,.010,.0017,40);
  ring('spindle','bronze',[0,0,-.032],.024,.056,.041,.0056,62);
  barrel('spindle','plum',[0,0,.031],.064,.105,65);
  ring('spindle','steel',[0,0,.071],.041,.069,.030,.0045,64);
  barrel('spindle','bronze',[0,0,.111],.112,.059,84);
  ring('spindle','steel',[0,0,.126],.096,.145,.016,.0040,82);
  barrel('spindle','silver',[0,0,.153],.166,.053,112);
  ring('spindle','brass',[0,0,.180],.1577,.165,.0083,.0020,106);
  ring('spindle','silver',[0,0,.186],.1618,.1658,.0043,.0012,106);
  ring('spindle','bronze',[0,0,.1813],.021,.029,.0031,.00093,65);
  barrel('spindle','brass',[0,0,.1816],.020,.0057,64);
  screw('spindle',[0,0,.184],.0098,front);
  for(let j=0;j<48;j++) {
    const t=tau*j/48,large=j%4===0;
    add('spindle','bronze',strut(polar(large?.151:.153,t,.1831),polar(.157,t,.1831),large?.0019:.0012,.00090,.00015));
  }

  // Point follower at the rosette's nominal radius and the fixed front tool.
  box('world','plum',[.299,.081,-.067],[.206,.052,.160],.011);
  add('world','plum',strut([.346,.107,-.094],[.319,.335,-.087],.060,.067,.010));
  add('world','trim',strut([.364,.126,-.061],[.340,.323,-.060],.014,.012,.0026));
  box('world','trim',[.320,.346,camZ],[.121,.057,.087],.013);
  barrel('world','steel',[.272,centerY,camZ],.019,.101,48,right);
  barrel('world','brass',[.238,centerY,camZ],.012,.050,44,right);
  barrel('world','cream',[camRadius+.012,centerY,camZ],0,.024,34,[-1,0,0],.009);
  screw('world',[.336,.377,camZ],.0091,up);

  box('world','iron',[.308,.077,.196],[.172,.042,.176],.013);
  box('world','plum',[.307,.100,.195],[.139,.035,.141],.0085);
  add('world','plum',strut([.338,.122,.206],[.287,.317,.234],.053,.058,.0094));
  box('world','trim',[.267,.329,.228],[.139,.055,.057],.010);
  add('world','steel',strut([.284,.350,.230],[.148,centerY,.216],.023,.023,.0049));
  barrel('world','silver',[toolX,centerY,faceZ+.016],0,.032,33,[0,0,-1],.0075);
  add('world','steel',strut([.163,centerY,.217],[toolX,centerY,.207],.010,.010,.0028));
  barrel('world','brass',[.313,.344,.230],.016,.020,35,right);
  for(const x of [.277,.336]) for(const z of [.147,.246]) screw('world',[x,.116,z],.0058,up);

  const variants=rosettes.map((rosette)=>({cam:rosetteVolume(rosette),engraving:finishedWork(rosette)}));
  const currentTrace=makeTrace();
  writeTrace(currentTrace,rosettes[0],0,0);
  const pieces=Array.from(batches,([key,data])=>({key,data:data.length===1?data[0]:mergeGeometries(data)}));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const slide=engine.createMesh().setParent(world);
    const spindle=engine.createMesh().setParent(slide);
    const parents={world,slide,spindle};
    const grain=walnutGrain();
    const materials=new Map(Object.entries(finish).map(([name,value])=>[
      name,new Material(name==='wood'||name==='woodEdge'?{...value,map:grain}:value),
    ]));
    function addMesh(data,material,parent,name,cast,stationary=false) {
      const mesh=createMesh(engine,data,materials.get(material));
      mesh.root.name=name;
      mesh.root.setParent(parent);
      if(cast!==null) shadows.add(mesh,{static:stationary,castShadow:cast});
      return mesh;
    }
    for(const {key,data} of pieces) {
      const [group,material]=key.split(':');
      addMesh(data,material,parents[group],key,material!=='floor',group==='world');
    }
    const rosetteMeshes=variants.map((data,i)=>[
      addMesh(data.cam,'brass',spindle,rosettes[i].lobes+'-lobe rosette',true).root,
      addMesh(data.engraving,'face',spindle,rosettes[i].lobes+'-lobe engraved face',false).root,
    ]);
    const live=addMesh(currentTrace,'engraved',spindle,'Current cut',null);
    addMesh(place(torusGeometry(.0048,.0008,6,30),[toolX,centerY,faceZ+.0055]),'cutting',world,'Cutter witness',null);
    let previous=-1,previousCount=0;
    return (pose,index,count)=>{
      slide.setPosition([pose.shift,centerY,0]);
      spindle.setRotation([0,0,pose.angle]);
      if(index!==previous) {
        rosetteMeshes.forEach((nodes,i)=>{ for(const node of nodes) node.visible=i===index; });
      }
      const start=index===previous?Math.min(previousCount,count):0;
      writeTrace(currentTrace,rosettes[index],count,start);
      live.setGeometry(currentTrace,{start:start*2,count:(sampleCount-start)*2});
      live.root.visible=count>0;
      previous=index;
      previousCount=count;
    };
  };
}
