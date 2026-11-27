import { Geometry, PbrMaterial } from '@margoengine/core';
import { bevelPolygonMesh, compilePolygonMesh, createPrimitiveMesh } from '@margoengine/mesh-edit';
import { boxPolygon } from './workpiece.mjs';

const cross=([a,b,c],[x,y,z])=>[b*z-c*y,c*x-a*z,a*y-b*x];
const unit=(vec)=>{
  const length=Math.hypot(...vec);
  return vec.map(value=>value/length);
};
const combine=(parts)=>{
  const positions=[],normals=[],indices=[];
  for(const part of parts){
    const start=positions.length/3;
    positions.push(...part.positions);
    normals.push(...part.normals);
    indices.push(...part.indices.map(value=>value+start));
  }
  return new Geometry(Float32Array.from(positions),Float32Array.from(normals),Uint32Array.from(indices));
};

export function filledGeometry(draw){
  return new Geometry(Float32Array.from(draw.positions),Float32Array.from(draw.normals),Uint32Array.from(draw.indices));
}

export function edgeGeometry(segments,width){
  const vertices=[],normals=[],indices=[];
  for(const [start,end] of segments){
    const axis=unit(end.map((value,i)=>value-start[i]));
    const across=unit(cross(Math.abs(axis[1])>.82?[1,0,0]:[0,1,0],axis));
    const other=cross(axis,across);
    const offsets=[across,other,across.map(value=>-value),other.map(value=>-value)];
    for(let side=0;side<4;side++){
      const a=offsets[side], b=offsets[(side+1)%4], n=unit(a.map((v,i)=>v+b[i]));
      const index=vertices.length/3;
      for(const [point,out] of [[start,a],[start,b],[end,b],[end,a]]){
        vertices.push(...point.map((value,i)=>value+width*out[i]));
        normals.push(...n);
      }
      indices.push(index,index+1,index+2,index,index+2,index+3);
    }
  }
  return new Geometry(Float32Array.from(vertices),Float32Array.from(normals),Uint32Array.from(indices));
}

function roundedBox(name,center,dimensions,amount){
  let serial=0;
  const solid=boxPolygon(name,center,dimensions);
  return bevelPolygonMesh(solid,amount,{createId:()=>name+'-bevel-'+(++serial)}).mesh;
}

function cylinder(name,center,[w,h,d],axis='y'){
  const normal=createPrimitiveMesh('cylinder',name);
  return {...normal,vertices:normal.vertices.map(([x,y,z])=>{
    const shift=axis==='y'?[x*w,y*h,z*d]:[x*w,z*d,y*h];
    return shift.map((value,i)=>value+center[i]);
  }),faces:axis==='y'?normal.faces:normal.faces.map(f=>({...f,vertices:[...f.vertices].reverse(),uv:[...f.uv].reverse()}))};
}

function batch(engine,shade,solids,roughness=.68,metalness=0){
  engine.createMesh().setGeometry(combine(solids.map(compilePolygonMesh)))
    .setMaterial(new PbrMaterial({color:shade,roughness,metalness}));
}

export function buildFixture(engine){
  batch(engine,'#4d5b5b',[
    roundedBox('table',[0,-.117,-.005],[2.88,.126,1.634],.057),
    roundedBox('light-table',[0,-.187,-.005],[3.06,.022,1.74],.044),
  ]);
  batch(engine,'#35484b',[
    roundedBox('tool-plate',[-.18,-.027,-.025],[2.17,.073,1.12],.025),
    roundedBox('left-foot',[-.84,.09,-.057],[.18,.118,.61],.038),
    roundedBox('right-foot',[.645,.079,-.086],[.27,.134,.57],.038),
    roundedBox('fairing-cradle',[.586,.325,-.147],[.34,.48,.368],.033),
    roundedBox('bridge-spine',[.67,1.14,-.244],[.074,.62,.086],.038),
    roundedBox('upper-collar-clamp',[.67,1.31,-.189],[.072,.041,.126],.035),
  ]);
  batch(engine,'#b79d6d',[
    roundedBox('front-label',[-.534,.084,.523],[.59,.041,.11],.048),
    roundedBox('trim',[.408,-.046,.541],[.536,.013,.032],.043),
    ...[-.89,.32,.76].flatMap((x,i)=>[
      cylinder('deck-bolt-f'+i,[x,.029,.424],[.046,.038,.046]),
      cylinder('deck-bolt-r'+i,[x,.029,-.438],[.046,.038,.046]),
    ]),
  ],.46,0);
  batch(engine,'#426465',[
    roundedBox('top-air-plate',[-.325,1.064,-.223],[.898,.032,.273],.034),
    roundedBox('front-return',[-.311,.206,.303],[1.19,.04,.061],.033),
  ]);
  batch(engine,'#263a40',[
    ...Array.from({length:11},(_,i)=>boxPolygon('roof-slot-'+i,[-.68+i*.071,1.084,-.225],[.032,.008,.205])),
    ...[-.865,.231].flatMap((x,i)=>[.50,.78].map((y,j)=>cylinder('anchor-'+i+j,[x,y,.342],[.039,.025,.039],'z'))),
    ...Array.from({length:5},(_,i)=>boxPolygon('floor-tick-'+i,[.272+i*.081,-.054,.546],[.036,.012,.019])),
  ]);
}
