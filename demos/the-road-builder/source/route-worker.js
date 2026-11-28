import {Geometry} from '@margoengine/core';
import {Spline} from '@margoengine/splines';
import {bankedRoad} from '@margoengine/road/banking';
import {junctions} from '@margoengine/road/junctions';
import {fitTerrain} from '@margoengine/road/terrain';
import {markings} from '@margoengine/road/markings';
import {heightfieldGeometry} from '@margoengine/terrain';
import {bounds,crossing,mainWest,mainEast,naturalHeight,terrainColor,earthPaint,roadPaint} from './terrain-art.js';

const fullWidth=7.2,curbWidth=.64;
const basisY=naturalHeight(...crossing)+.57;
const out=([x,z],height)=>[x,height,z];
const make=()=>({p:[],n:[],i:[],map:new Map()});
function vertex(batch,data,id){
  const v=id*6;
  let index=batch.map.get(id);
  if(index!==undefined)return index;
  index=batch.p.length/3;
  batch.p.push(data[v],data[v+1],data[v+2]);
  batch.n.push(data[v+3],data[v+4],data[v+5]);
  batch.map.set(id,index);
  return index;
}
function append(batch,data,indices,select=()=>true){
  batch.map.clear();
  for(let i=0;i<indices.length;i+=3)if(select(i)){
    for(let j=0;j<3;j++)batch.i.push(vertex(batch,data,indices[i+j]));
  }
}
function quad(batch,points){
  const k=batch.p.length/3;
  for(const p of points){batch.p.push(...p);batch.n.push(0,1,0);}
  batch.i.push(k,k+1,k+2,k,k+2,k+3);
}
function mesh(b){
  return new Geometry(b.p,b.n,b.i);
}
function pack(batches){
  return batches.map(b=>({p:new Float32Array(b.p),n:new Float32Array(b.n),i:new Uint32Array(b.i)}));
}
function roadHeight(point,distance){
  const t=Math.min(1,distance/15),blend=t*t*(3.-2.*t);
  return basisY+(naturalHeight(...point)+.48-basisY)*blend;
}
function path(line,index,bank){
  const touch=index===0?line.length-1:0,source=line[touch];
  const points=line.map(p=>out(p,roadHeight(p,Math.hypot(p[0]-source[0],p[1]-source[1]))));
  const curve=new Spline(points,{kind:'catmull-rom',divisions:192});
  const segments=Math.max(24,Math.min(92,Math.round(curve.length)));
  const phase=index===0?1:-1,amplitude=bank*Math.PI/180;
  const banks=Array.from({length:13},(_,j)=>phase*amplitude*Math.sin(j*Math.PI/12)*Math.sin(.41+j*.38));
  return {curve,segments,work:bankedRoad(curve,{width:fullWidth,segments,curbWidth,curbHeight:.34,bank:banks})};
}
function linePaint(batch,curve){
  const before=new Float64Array(3),after=new Float64Array(3),position=new Float64Array(3),spec=[],grads=[];
  for(let d=3;d<curve.length-3;d+=5.2){
    curve.atDistance(d,position);
    curve.atDistance(d-.26,before);curve.atDistance(d+.26,after);
    grads.push((after[1]-before[1])/Math.hypot(after[0]-before[0],after[2]-before[2]));
    spec.push({kind:'line',position:[...position],angle:Math.atan2(after[0]-before[0],after[2]-before[2]),width:.19,length:2.65});
  }
  const paint=markings(spec,{color:[.97,.76,.41],depth:.3});
  for(const [i,{position:p,up,width,height}] of paint.entries()){
    const side=[up[2],0,-up[0]];
    const along=height/2,w=width/2;
    quad(batch,[[-1,-1],[-1,1],[1,1],[1,-1]].map(([a,b])=>[
      p[0]+side[0]*a*w+up[0]*b*along,p[1]+.093+grads[i]*b*along,p[2]+side[2]*a*w+up[2]*b*along
    ]));
  }
}
function runGrid(data){
  const groups=earthPaint.map(make),{positions,normals,indices}=data;
  const v=new Float32Array(positions.length*2);
  for(let at=0;at<positions.length;at+=3){
    v.set(positions.subarray(at,at+3),at*2);
    v.set(normals.subarray(at,at+3),at*2+3);
  }
  for(let at=0;at<indices.length;at+=3){
    const i=indices[at],j=indices[at+1],k=indices[at+2];
    const point=[0,1,2].map(n=>(positions[i*3+n]+positions[j*3+n]+positions[k*3+n])/3);
    const group=groups[terrainColor(...point)];
    for(const id of [i,j,k])group.i.push(vertex(group,v,id));
  }
  return groups;
}
function edgeWall(groups,field){
  const [left,north]=bounds.origin,right=left+bounds.width,south=north+bounds.depth;
  const corners=[[left,north],[right,north],[right,south],[left,south]];
  const shaded=[groups[9],groups[10]];
  const intervals=112;
  for(let side=0;side<4;side++){
    const a=corners[side],b=corners[(side+1)%4],step=[(b[0]-a[0])/intervals,(b[1]-a[1])/intervals];
    const length=Math.hypot(...step),normal=[step[1]/length,0,-step[0]/length];
    for(let j=0;j<intervals;j++){
      const x=a[0]+step[0]*j,z=a[1]+step[1]*j,xx=x+step[0],zz=z+step[1];
      const top=field(x,z),next=field(xx,zz),shoulder=-1.93+.45*Math.sin(x*.17+z*.13),shoulderNext=-1.93+.45*Math.sin(xx*.17+zz*.13);
      const append=(g,at,bt,ab,bb)=>{
        const offset=g.p.length/3;
        g.p.push(x,ab,z,xx,bb,zz,xx,bt,zz,x,at,z);
        for(let k=0;k<4;k++)g.n.push(...normal);
        g.i.push(offset,offset+2,offset+1,offset,offset+3,offset+2);
      };
      append(shaded[0],top,next,shoulder,shoulderNext);
      append(shaded[1],shoulder,shoulderNext,-3.45,-3.45);
    }
  }
}
async function build({spur,bank}){
  const lines=spur?[mainWest,mainEast,spur]:[mainWest,mainEast];
  const choices=lines.map((line,i)=>path(line,i,bank));
  const stems=[[[mainWest.at(-1),crossing],fullWidth+curbWidth*2],[[crossing,mainEast[0]],fullWidth+curbWidth*2]];
  if(spur)stems.push([[crossing,spur[0]],fullWidth+curbWidth*2]);
  const [seam,sweeps]=await Promise.all([
    junctions(stems.map(([points,width])=>({points,width})),{elevation:basisY,uvMeters:3}),
    Promise.all(choices.map(r=>r.work))
  ]);
  const unified=make();
  append(unified,seam.geometry.vertices,seam.geometry.indices);
  const road=roadPaint.map(make);
  append(road[0],seam.geometry.vertices,seam.geometry.indices);
  for(let i=0;i<sweeps.length;i++){
    const {geometry:g,section}=sweeps[i];
    const cols=section.length-1;
    append(unified,g.vertices,g.indices);
    append(road[0],g.vertices,g.indices,k=>Math.floor(k/6)%cols===3);
    append(road[1],g.vertices,g.indices,k=>Math.floor(k/6)%cols!==3);
    linePaint(road[3],choices[i].curve);
  }
  const fit=await fitTerrain(mesh(unified),{base:naturalHeight,shoulder:4.8,depth:.42});
  const field=heightfieldGeometry(fit,{size:[bounds.width,bounds.depth],origin:bounds.origin,resolution:112});
  const groups=runGrid(field);
  edgeWall(groups,fit);
  const packA=pack(road),packB=pack(groups);
  return {rows:packA,earth:packB,junctionArea:seam.area,total:choices.reduce((sum,p)=>sum+p.curve.length,0),pts:lines};
}
self.addEventListener('message',async({data})=>{
  const {id}=data;
  try{
    const value=await build(data);
    const buffers=[...value.rows,...value.earth].flatMap(b=>[b.p.buffer,b.n.buffer,b.i.buffer]);
    self.postMessage({id,value},buffers);
  }catch(error){self.postMessage({id,error:error.message});}
});
