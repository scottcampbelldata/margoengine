import {box,Geometry,PbrMaterial as CorePaint} from '@margoengine/core';
import {createMesh,PbrMaterial,Texture} from '@margoengine/materials';

function face(points,normal,span){
  return {positions:points.flat(),normals:points.flatMap(()=>normal),uvs:[0,0,span[0],0,span[0],span[1],0,span[1]],indices:[0,1,2,0,2,3]};
}
function vaultCutout(){
  const p=[],n=[],uv=[],ix=[];
  const one=(a,b,c,d,normal,scaleU,scaleV)=>{
    const f=p.length/3;
    p.push(...a,...b,...c,...d);n.push(...normal,...normal,...normal,...normal);
    uv.push(0,0,scaleU,0,scaleU,scaleV,0,scaleV);ix.push(f,f+1,f+2,f,f+2,f+3);
  };
  const inside=.77,outside=1.14,span=35,centerX=.58,centerY=1.12;
  const front=.48,rear=-.43;
  for(let i=0;i<span;i++){
    const a=Math.PI*i/span,b=Math.PI*(i+1)/span,m=(a+b)/2;
    const at=(r,t,z)=>[centerX+r*Math.cos(t),centerY+r*Math.sin(t),z];
    one(at(inside,a,front),at(outside,a,front),at(outside,b,front),at(inside,b,front),[0,0,1],.38,.14);
    one(at(outside,a,rear),at(outside,b,rear),at(outside,b,front),at(outside,a,front),[Math.cos(m),Math.sin(m),0],.14,.96);
    one(at(inside,b,rear),at(inside,a,rear),at(inside,a,front),at(inside,b,front),[-Math.cos(m),-Math.sin(m),0],.12,.93);
  }
    const wallZ=.025,ceiling=3.252;
  for(let i=0;i<span;i++){
    const a=Math.PI*i/span,b=Math.PI*(i+1)/span;
    const lo=[centerX+outside*Math.cos(a),centerY+outside*Math.sin(a),wallZ];
    const hi=[centerX+outside*Math.cos(b),centerY+outside*Math.sin(b),wallZ];
    const up0=[lo[0],ceiling,wallZ],up1=[hi[0],ceiling,wallZ];
    one(hi,lo,up0,up1,[0,0,1],.13,.88);
  }
  const from=outside-inside;
  const legs=[centerX-outside,centerX+inside];
  for(const x of legs){
    const y=0,h=centerY;
    one([x,y,front],[x+from,y,front],[x+from,h,front],[x,h,front],[0,0,1],.4,1.1);
    for(const side of [-1,1]){
      const edge=x+(side>0?from:0);
      if(side>0)one([edge,y,front],[edge,y,rear],[edge,h,rear],[edge,h,front],[1,0,0],.9,1.1);
      else one([edge,y,rear],[edge,y,front],[edge,h,front],[edge,h,rear],[-1,0,0],.9,1.1);
    }
  }
  return {positions:p,normals:n,uvs:uv,indices:ix};
}
function roundedStone(){
  const p=[],n=[],uv=[],ix=[],slices=22,steps=9;
  const center=[2.26,0,-.42],r=.87;
  for(let i=0;i<=slices;i++){
    const a=-.69+i*2.13/slices;
    const nx=Math.sin(a),nz=Math.cos(a);
    for(let j=0;j<=steps;j++){
      const y=j*.31;
      p.push(center[0]+r*nx,y,center[2]+r*nz);
      n.push(nx,0,nz);
      uv.push(.91*nx,y*.93);
      if(i&&j){
        const d=i*(steps+1)+j,c=d-1,b=d-(steps+1),a=b-1;
        ix.push(a,c,d,a,d,b);
      }
    }
  }
  return {positions:p,normals:n,uvs:uv,indices:ix};
}
function stoneMaterial(raw,stone,all){
  const texture=(data,colorSpace)=>{
    const map=new Texture({data,width:raw.size,height:raw.size},{colorSpace,wrapS:'repeat',wrapT:'repeat',mipmaps:true});
    all.push(map);return map;
  };
  return new PbrMaterial({
    color:'#ddd7c8',map:texture(raw.albedo,'srgb'),normalMap:texture(raw.normal,'linear'),
    normalScale:stone?.37:.47,roughness:stone?.81:.86,metalness:0,
    parallaxMap:stone?null:texture(raw.height,'linear'),parallaxScale:.056,parallaxMode:'occlusion',parallaxSteps:16,
    triplanar:stone,triplanarScale:stone?.84:1,triplanarSharpness:4
  });
}
export function createVault(engine,asset){
  const all=[],bronze=new CorePaint({color:'#aa9167',roughness:.42,metalness:.49}),
    mortar=new CorePaint({color:'#786858',roughness:.94,metalness:0}),
    black=new CorePaint({color:'#39332c',roughness:.81,metalness:0}),
    wood=new CorePaint({color:'#785748',roughness:.87,metalness:0}),
    ochre=new CorePaint({color:'#e9c68b',roughness:.69,metalness:0}),
    floor=new CorePaint({color:'#736d5f',roughness:.91,metalness:0});
  const brick=stoneMaterial(asset.brick,false,all),stone=stoneMaterial(asset.stone,true,all);
  const sample=(data, material)=>createMesh(engine,data,material);
  const groups=new Map();
  const block=(extent,at,material)=>{
    let batch=groups.get(material);
    if(!batch){batch={positions:[],normals:[],indices:[]};groups.set(material,batch);}
    const geometry=box(...extent),base=batch.positions.length/3;
    for(let k=0;k<geometry.vertices.length;k+=6){
      const v=geometry.vertices;
      batch.positions.push(v[k]+at[0],v[k+1]+at[1],v[k+2]+at[2]);
      batch.normals.push(v[k+3],v[k+4],v[k+5]);
    }
    for(const i of geometry.indices)batch.indices.push(base+i);
  };
  sample(face([[-3.2,.0,.01],[-.46,.0,.01],[-.46,3.19,.01],[-3.2,3.19,.01]],[0,0,1],[2.3,2.59]),brick);
  sample(face([[-3.2,.0,.01],[-3.2,.0,-2.92],[-3.2,3.19,-2.92],[-3.2,3.19,.01]],[1,0,0],[2.43,2.59]),brick);
  sample(face([[1.72,0,-.34],[4,0,-.34],[4,3.19,-.34],[1.72,3.19,-.34]],[0,0,1],[1.83,2.55]),stone);
  sample(vaultCutout(),stone);
  sample(roundedStone(),stone);
  block([10,.19,8],[0,-.105,0],floor);
  block([8,.24,.25],[0,3.095,-.02],mortar);
  block([8,.070,.14],[0,3.025,.08],ochre);
  block([2.3,2.88,.14],[.57,1.42,-2.14],black);
  block([2.1,.14,2.39],[.58,2.04,-.97],black);
  block([.14,2.11,2.04],[-.271,1.03,-.77],mortar);
  block([.14,2.11,2.04],[1.427,1.03,-.77],black);
  block([9,.24,5.25],[.22,3.28,-1.86],mortar);
  block([.19,3.38,3.93],[3.88,1.6,-1.95],mortar);
  block([1.42,.07,.41],[.58,.032,.39],mortar);
  block([1.29,.043,.465],[.58,.009,.71],black);
  for(let i=0;i<7;i++)block([.039,2.02,.06],[.07+i*.16,1.02,-1.5],bronze);
  block([1.24,.065,.09],[.56,.53,-1.47],bronze);
  block([1.24,.063,.09],[.56,1.38,-1.47],bronze);
  for(const x of [-2.76,-.76,3.13]){
    block([.11,.35,.071],[x,2.48,.10],bronze);
    block([.071,.061,.243],[x,2.53,.22],black);
    block([.19,.068,.17],[x,2.46,.31],bronze);
    block([.126,.13,.119],[x,2.34,.31],ochre);
    block([.198,.059,.179],[x,2.25,.31],black);
  }
  for(let row=0;row<5;row++)for(let col=0;col<12;col++){
    const x=-3.9+col*.73+(row%2)*.37,z=.54+row*.55;
    block([.716,.027,.532],[x,.005,z],((row*131+col*37)%7<2)?mortar:floor);
  }
  for(const x of [-2.76,-.76,3.13]){
    block([.016,.13,.047],[x-.062,2.34,.329],bronze);
    block([.016,.13,.047],[x+.062,2.34,.329],bronze);
    block([.133,.013,.055],[x,2.355,.357],bronze);
  }
  for(const x of [-.45,1.64]){
    block([.46,.118,.17],[x,.096,.495],mortar);
    block([.46,.068,.138],[x,1.13,.488],ochre);
  }
  block([2.55,.075,.088],[-1.84,.107,.11],wood);
  block([2.55,.056,.064],[-1.84,.179,.081],bronze);
  for(const [material,batch] of groups){
    const geometry=new Geometry(batch.positions,batch.normals,batch.indices);
    engine.createMesh().setGeometry(geometry).setMaterial(material);
  }
  return {
    relief(value){brick.parallaxScale=value*.056;},
    projection(enabled){stone.triplanar=enabled;},
    dispose(){for(const texture of all)texture.dispose();}
  };
}
