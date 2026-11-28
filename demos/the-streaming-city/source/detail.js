import { Geometry, PbrMaterial } from '@margoengine/core';

const makeBuffer=()=>({positions:[],normals:[],indices:[]});
const subtract=(a,b)=>a.map((value,i)=>value-b[i]);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const scale=(a,n)=>a.map(value=>value*n);
const norm=p=>scale(p,1/Math.hypot(...p));

function rectangle(part,point,u,v,normal,s0,s1,t0,t1,off) {
  const start=part.positions.length/3;
  const corners=[[s0,t0],[s1,t0],[s1,t1],[s0,t1]];
  for(const [s,t] of corners) {
    part.positions.push(...point.map((value,i)=>value+s*u[i]+t*v[i]+off*normal[i]));
    part.normals.push(...normal);
  }
  part.indices.push(start,start+1,start+2,start,start+2,start+3);
}


function crown(part,at,east,north,up,scaleBy) {
  function vertex(height,angle,radius) {
    return at.map((v,i)=>v+height*scaleBy*up[i]+radius*scaleBy*(east[i]*Math.cos(angle)+north[i]*Math.sin(angle)));
  }
  const levels=[[.12,.22],[.75,1],[1.45,.73],[1.8,.025]];
  for(let level=1;level<levels.length;level++)for(let i=0;i<7;i++){
    const [y0,r0]=levels[level-1],[y1,r1]=levels[level];
    const a=i*Math.PI*2/7,b=(i+1)*Math.PI*2/7;
    const points=[vertex(y0,a,r0),vertex(y0,b,r0),vertex(y1,b,r1),vertex(y1,a,r1)];
    const middle=(a+b)*.5;
    const normal=norm(east.map((e,k)=>e*Math.cos(middle)+north[k]*Math.sin(middle)+(r0-r1)*.85*up[k]));
    const start=part.positions.length/3;
    for(const point of points){part.positions.push(...point);part.normals.push(...normal);}
    part.indices.push(start,start+1,start+2,start,start+2,start+3);
  }
}

function layers(geometry,up) {
  const roof=makeBuffer(), brass=makeBuffer(), glazing=makeBuffer(), frames=makeBuffer(),
    edge=makeBuffer(), grout=makeBuffer(), base=makeBuffer(), garden=makeBuffer(), trees=makeBuffer();
  const vertex=geometry.vertices;
  const extract=id=>Array.from(vertex.subarray(id*6,id*6+3));
  // The pinned samples use four unique vertices per planar face and six faces per building.
  for(let i=0;i<vertex.length/6;i+=4) {
    const a=extract(i),b=extract(i+1),d=extract(i+3);
    const n=norm(Array.from(vertex.subarray(i*6+3,i*6+6)));
    const vertical=dot(n,up);
    let u=subtract(b,a),v=subtract(d,a), origin=a;
    const primary=Math.hypot(...u),secondary=Math.hypot(...v);
    if(vertical>.80) {
      const insetU=Math.min(.13,.58/primary),insetV=Math.min(.13,.58/secondary);
      rectangle(roof,a,u,v,n,insetU,1-insetU,insetV,1-insetV,.029);
      rectangle(edge,a,u,v,n,insetU,1-insetU,insetV,insetV+.025,.047);
      rectangle(edge,a,u,v,n,insetU,1-insetU,1-insetV-.025,1-insetV,.047);
      rectangle(edge,a,u,v,n,insetU,insetU+.025,insetV,1-insetV,.047);
      rectangle(edge,a,u,v,n,1-insetU-.025,1-insetU,insetV,1-insetV,.047);
      for(let row=0;row<3;row++) {
        const start=.31+row*.146;
        rectangle(grout,a,u,v,n,.235,.765,start,start+.018,.038);
      }
      continue;
    }
    if(vertical<-.80) {
      const marginU=3.4/primary,marginV=3.4/secondary;
      rectangle(base,a,u,v,up,-marginU,1+marginU,-marginV,1+marginV,.075);
      for(const [s0,s1,t0,t1] of [[-marginU,-marginU*.38,-marginV*.77,1+marginV*.74],
          [1+marginU*.38,1+marginU,-marginV*.77,1+marginV*.74],
          [-marginU*.26,1+marginU*.28,-marginV,-marginV*.52]]) {
        rectangle(garden,a,u,v,up,s0,s1,t0,t1,.094);
      }
      for(const [s,t,f] of [[-.71*marginU,.20,1.21],[-.69*marginU,.82,1.02],[1+.68*marginU,.39,.95]]) {
        const point=a.map((value,axis)=>value+s*u[axis]+t*v[axis]+.095*up[axis]);
        crown(trees,point,norm(u),norm(v),up,f);
      }
      continue;
    }
    if(Math.abs(dot(norm(u),up))>.73) [u,v]=[v,u];
    if(dot(v,up)<0) {
      origin=origin.map((value,axis)=>value+v[axis]);
      v=scale(v,-1);
    }
    const tall=Math.hypot(...v),wide=Math.hypot(...u);
    const floorCount=Math.max(1,Math.floor(tall/3.2)),bays=Math.max(2,Math.floor(wide/2.5));
    for(let row=0;row<floorCount;row++) {
      const bottom=(row+.22)/floorCount,top=(row+.72)/floorCount;
      for(let bay=0;bay<bays;bay++) {
        const x0=(bay+.16)/bays,x1=(bay+.87)/bays;
        rectangle((i+bay*31+row*17)%11===0?brass:glazing,origin,u,v,n,x0,x1,bottom,top,.050);
        rectangle(frames,origin,u,v,n,x0,x1,bottom-.017,bottom,.071);
        rectangle(frames,origin,u,v,n,(x1+x0)/2-.016,(x1+x0)/2+.016,bottom,top,.071);
      }
      const floor=(row+.035)/floorCount;
      rectangle(grout,origin,u,v,n,.046,.954,floor,floor+.016,.022);
    }
    rectangle(edge,origin,u,v,n,.028,.972,.94,.972,.055);
  }
  return [
    [roof,'#546875',.73], [edge,'#bc9c6d',.56], [glazing,'#536c73',.57],
    [brass,'#b7a16f',.55], [frames,'#788788',.67], [grout,'#a08d75',.86],
    [base,'#94a29a',.88], [garden,'#687f67',.94], [trees,'#6c866e',.92],
  ];
}

export function dressSample(engine,mesh,tile) {
  const region=tile.bounds.region, lon=(region[0]+region[2])*.5,lat=(region[1]+region[3])*.5;
  const up=[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];
  const parts=[];
  for(const [data,color,roughness] of layers(mesh.geometry,up)) {
    if(!data.indices.length)continue;
    parts.push(engine.createMesh(mesh)
      .setGeometry(new Geometry(data.positions,data.normals,data.indices))
      .setMaterial(new PbrMaterial({color,roughness,metalness:0,doubleSided:true})));
  }
  return ()=>{for(const node of parts)node.dispose();};
}
