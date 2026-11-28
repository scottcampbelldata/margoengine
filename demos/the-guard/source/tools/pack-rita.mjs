import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import * as nodeModule from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';

const [checkout,model,folder,destination]=process.argv.slice(2);
if(!destination)throw new Error('Pass the Margo checkout, Rita GLB, CMU data folder and packed output.');
assert.equal(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'0efd9cff8230507a32deb49907ecd499d46925f5');
const {findPython}=await import(pathToFileURL(resolve(checkout,'scripts/support/find-python.mjs')).href),python=findPython();
if(!python)throw new Error('Python 3 with Pillow is needed to read the albedo.');
const {registerHooks}=nodeModule;
if(typeof registerHooks!=='function')throw new Error('This tool needs Node 22.15 or newer (module.registerHooks).');
registerHooks({resolve(specifier,context,next){
  if(!specifier.startsWith('@margoengine/'))return next(specifier,context);
  const [,pkg,...sub]=specifier.split('/'),local=resolve(checkout,'packages',pkg);
  const entry=JSON.parse(readFileSync(resolve(local,'package.json'))).exports[sub.length?'./'+sub.join('/'):'.'];
  return {url:pathToFileURL(resolve(local,entry.import??entry)).href,shortCircuit:true};
}});
const {GLTFAsset}=await import('@margoengine/gltf/asset');
const {parseASF,parseAMC}=await import('@margoengine/loaders/mocap');
const {createKeyframeClip,Skeleton,sampleKeyframes}=await import('@margoengine/animation');
const {Retarget,retargetRig}=await import('@margoengine/animation/skeleton-utils');
const {prepareRetarget}=await import('@margoengine/rigging/retarget');
const {axisAngleToQuaternion,multiplyQuaternions,interpolateQuaternions,rotateByQuaternion}=await import('@margoengine/math/quat');
const {multiplyMatrices}=await import('@margoengine/math/mat4');
const raw=readFileSync(model),length=raw.readUInt32LE(12);
const doc=JSON.parse(raw.subarray(20,20+length)),asset=new GLTFAsset(doc,[],raw.subarray(28+length));
const albedo=JSON.parse(execFileSync(python,[fileURLToPath(new URL('./read-albedo.py',import.meta.url)),model],{encoding:'utf8'}))
  .map(([width,height,bytes])=>({width,height,bytes:Buffer.from(bytes,'base64')}));
const ASF=readFileSync(resolve(folder,'16.asf')),names=doc.nodes.map((node,i)=>node.name??'node'+i);
const bones=parseASF(ASF,{scale:.0254/.45});
const files=['16_16.amc','16_33.amc'].map(name=>readFileSync(resolve(folder,name)));
const recordings=files.map(file=>parseAMC(file,bones));
const source=retargetRig(new Skeleton(recordings[0].bones));
source.rest[1]=.982;
const parents=doc.nodes.map(()=>-1);
doc.nodes.forEach((node,i)=>{for(const child of node.children??[])parents[child]=i;});
const rest=doc.nodes.map(node=>({
  p:node.translation?.slice()??[0,0,0],q:node.rotation?.slice()??[0,0,0,1],s:node.scale?.slice()??[1,1,1],
}));
const target={names,parents,rest:new Float64Array(rest.flatMap(({p,q,s})=>[...p,...q,...s]))};
const plan=prepareRetarget(source,target,{from:'cmu',to:'mixamo',alignRest:true});
const retarget=new Retarget(source,plan.target,plan);
const hip=retarget.hip;
assert.equal(names[hip],'mixamorig:Hips');
const byName=new Map(names.map((name,index)=>[name,index]));
function yaw([x,y,z,w]){return Math.atan2(2*(x*z+y*w),1-2*(x*x+y*y));}
function normalized(recording){
  const hips=recording.clip.tracks.find(t=>t.target==='root'&&t.path==='translation').keys[0].value;
  const facing=recording.clip.tracks.find(t=>t.target==='root'&&t.path==='rotation').keys[0].value;
  const zero=axisAngleToQuaternion([0,1,0],-yaw(facing));
  return createKeyframeClip({name:'Gallery capture',tracks:recording.clip.tracks.map(track=>({
    target:track.target,path:track.path,
    keys:track.keys.map(({time,value})=>{
      if(track.target==='root'&&track.path==='rotation')value=multiplyQuaternions(zero,value);
      if(track.target==='root'&&track.path==='translation')value=rotateByQuaternion([value[0]-hips[0],value[1],value[2]-hips[2]],zero);
      return {time,value};
    }),
  }))});
}
const [walk,stop]=recordings.map(capture=>retarget.clip(normalized(capture),{fps:24}));
const rigAt=(clip,time)=>{
  const pose=rest.map(({p,q,s})=>({p:p.slice(),q:q.slice(),s:s.slice()}));
  for(const track of clip.tracks){
    const slot=track.path==='rotation'?'q':track.path==='translation'?'p':'s';
    pose[byName.get(track.target)][slot]=Array.from(sampleKeyframes(track,time));
  }
  return pose;
};
const steady=[];
for(let i=16;i<Math.floor((walk.duration-.19)*24);i++)steady[i]=rigAt(walk,i/24);
const similarity=(a,b)=>{
  let value=0;
  for(const name of ['LeftUpLeg','RightUpLeg','LeftLeg','RightLeg','LeftFoot','RightFoot','LeftArm','RightArm','Spine','Head']){
    const i=byName.get('mixamorig:'+name),d=Math.abs(a[i].q.reduce((total,x,j)=>total+x*b[i].q[j],0));
    value+=1-Math.min(1,d);
  }
  return value;
};
let best=null;
for(let i=16;i<steady.length;i++)for(let j=i+22;j<Math.min(i+33,steady.length);j++){
  const a=steady[i],b=steady[j];
  const mps=(b[hip].p[2]-a[hip].p[2])*24/(j-i);
  const drift=Math.abs(b[hip].p[0]-a[hip].p[0]);
  if(!(mps>.77&&mps<1.42&&drift<.22))continue;
  const score=similarity(a,b)+.05*drift;
  if(!best||score<best.score)best={i,j,score,mps};
}
assert.ok(best,'No repeating segment with steady forward travel');
const {i:begin,j:end}=best,span=end-begin;
const quiet=rigAt(stop,stop.duration);
quiet[hip].p[0]=0;quiet[hip].p[2]=0;
const zero=axisAngleToQuaternion([0,1,0],-yaw(quiet[hip].q));
quiet[hip].q=multiplyQuaternions(zero,quiet[hip].q);
const beginning=steady[begin][hip].p.slice(),ending=steady[end][hip].p.slice();
const loop=[];
for(let i=0;i<span;i++){
  const t=i/span,pose=steady[begin+i];
  pose[hip].p[0]-=beginning[0]+(ending[0]-beginning[0])*t;
  pose[hip].p[2]-=beginning[2]+(ending[2]-beginning[2])*t;
  if(i>=span-3){
    const alpha=(i-(span-4))/4;
    for(let j=0;j<pose.length;j++)pose[j].q=interpolateQuaternions(pose[j].q,steady[begin][j].q,alpha,.9995);
  }
  loop.push(pose);
}
const skin=doc.skins[0],inverse=asset.accessor(skin.inverseBindMatrices,'MAT4');
function transform({p,q:[x,y,z,w],s}){
  return [(1-2*(y*y+z*z))*s[0],2*(x*y+z*w)*s[0],2*(x*z-y*w)*s[0],0,
    2*(x*y-z*w)*s[1],(1-2*(x*x+z*z))*s[1],2*(y*z+x*w)*s[1],0,
    2*(x*z+y*w)*s[2],2*(y*z-x*w)*s[2],(1-2*(x*x+y*y))*s[2],0,...p,1];
}
function matrices(pose){
  const frames=[];
  function world(i){const t=transform(pose[i]);return frames[i]??=(parents[i]===-1?t:multiplyMatrices(world(parents[i]),t));}
  return skin.joints.map((joint,i)=>{
    const m=multiplyMatrices(world(joint),inverse.subarray(i*16,i*16+16));
    return [m[0],m[4],m[8],m[12],m[1],m[5],m[9],m[13],m[2],m[6],m[10],m[14]];
  });
}
const poseBooks=[quiet,...loop].map(matrices);
const palette={
  navy:'#3b5564',navyLight:'#4c6471',denim:'#52616a',denimDark:'#46545c',collar:'#81715c',hardware:'#b6a473',
  skin:'#965f4b',skinLight:'#ae7c61',skinDark:'#795044',lip:'#774952',hair:'#575352',hairLight:'#827a72',hairMid:'#6c645e',
  shoe:'#423d39',eye:'#6a5144',sclera:'#beaba2',shirt:'#ded5b8',tie:'#a37152',stitch:'#495d69',
};
const bins=new Map();
function shade(name,[x,y,z],normal,[r,g,b,a]){
  const tone=.22*r+.65*g+.13*b;
  if(name==='bob02'){
    if(a<.27)return null;
    return tone>.65?'hairLight':tone>.36?'hairMid':'hair';
  }
  if(name==='shoes02')return 'shoe';
  if(name==='low-poly')return tone>.6?'sclera':'eye';
  if(name==='body'){
    if(y>1.30&&y<1.47&&z>.060&&Math.abs(x)<.048&&r>g*1.24&&r>b*1.12&&tone<.44)return 'lip';
    return tone<.22?'skinDark':tone>.48&&normal[1]>.1?'skinLight':'skin';
  }
  if(tone>.62&&r/g<1.26)return 'shirt';
  if(r>g*1.19&&r>b*1.15&&r>.27&&tone<.54)return 'tie';
  if(y<.79)return Math.abs(normal[2])>.59?'denim':'denimDark';
  if(tone<.153)return 'stitch';
  if(tone>.44)return 'navyLight';
  return 'navy';
}
let vertexTotal=0,triangleTotal=0,shoeFloor=Infinity;
for(const node of doc.nodes.filter(node=>node.mesh!==undefined)){
  const name=node.name.split('.').at(-1),primitive=doc.meshes[node.mesh].primitives[0],attribute=primitive.attributes;
  const p=asset.accessor(attribute.POSITION,'VEC3'),n=asset.accessor(attribute.NORMAL,'VEC3');
  const j=asset.accessor(attribute.JOINTS_0,'VEC4'),w=asset.accessor(attribute.WEIGHTS_0,'VEC4');
  const indices=asset.accessor(primitive.indices,'SCALAR');
  const uv=asset.accessor(attribute.TEXCOORD_0,'VEC2');
  const mat=doc.materials[primitive.material],spec=doc.textures[mat.pbrMetallicRoughness.baseColorTexture.index];
  const sheet=albedo[spec.extensions?.EXT_texture_webp?.source??spec.source];
  function sample([u,v]){
    if(!sheet)return [.41,.39,.36,1];
    const x=Math.max(0,Math.min(sheet.width-1,Math.floor(u*sheet.width)));
    const y=Math.max(0,Math.min(sheet.height-1,Math.floor(v*sheet.height)));
    const i=4*(y*sheet.width+x);
    return Array.from(sheet.bytes.subarray(i,i+4),v=>v/255);
  }
  const vertex=i=>({p:Array.from(p.subarray(i*3,i*3+3)),n:Array.from(n.subarray(i*3,i*3+3)),
    j:Array.from(j.subarray(i*4,i*4+4)),w:Array.from(w.subarray(i*4,i*4+4)),uv:Array.from(uv.subarray(i*2,i*2+2))});
  const all=Array.from({length:p.length/3},(_,i)=>vertex(i));
  vertexTotal+=all.length;triangleTotal+=indices.length/3;
  if(name==='shoes02')shoeFloor=Math.min(...all.map(v=>v.p[1]));
  for(let i=0;i<indices.length;i+=3){
    const ids=[indices[i],indices[i+1],indices[i+2]],vertices=ids.map(index=>all[index]);
    const average=key=>vertices[0][key].map((a,j)=>(a+vertices[1][key][j]+vertices[2][key][j])/3);
    const key=shade(name,average('p'),average('n'),sample(average('uv')));
    if(key===null)continue;
    if(!bins.has(key))bins.set(key,{data:[],indices:[],seen:new Map()});
    const bin=bins.get(key);
    for(const [i,index] of ids.entries()){
      const id=name+':'+index;
      if(!bin.seen.has(id)){bin.seen.set(id,bin.data.length);bin.data.push(vertices[i]);}
      bin.indices.push(bin.seen.get(id));
    }
  }
}
assert.ok(Number.isFinite(shoeFloor));
const chunks=[],groups=[];
function encodeMesh(key,data,indices){
  groups.push({key,color:palette[key],vertices:data.length,indices:indices.length});
  const b=Buffer.alloc(data.length*(6+3+4+3)+indices.length*2);
  let offset=0;
  for(let axis=0;axis<3;axis++){
    let previous=0;
    for(const v of data){
      const value=Math.round(v.p[axis]*4096);
      b.writeInt16LE(value-previous,offset);offset+=2;previous=value;
    }
  }
  for(const v of data)for(const n of v.n)b.writeInt8(Math.max(-127,Math.min(127,Math.round(n*127))),offset++);
  for(let lane=0;lane<4;lane++)for(const v of data)b[offset++]=v.j[lane];
  for(let lane=0;lane<3;lane++)for(const v of data)b[offset++]=Math.round(v.w[lane]*255);
  let previous=0;
  for(const val of indices){b.writeInt16LE(val-previous,offset);offset+=2;previous=val;}
  chunks.push(b);
}
for(const [key,{data,indices}] of bins)encodeMesh(key,data,indices);
const matrixBytes=Buffer.alloc(poseBooks.length*skin.joints.length*12*2);
let at=0;
for(let j=0;j<skin.joints.length;j++)for(let entry=0;entry<12;entry++){
  let previous=0;
  for(const pose of poseBooks){
    const value=Math.round(pose[j][entry]*8192);
    matrixBytes.writeInt16LE(value-previous,at);at+=2;previous=value;
  }
}
chunks.push(matrixBytes);
const neck=skin.joints.map((id,i)=>names[id].endsWith(":Head")||names[id].endsWith(":Neck")?i:-1).filter(i=>i>=0);
const info={groups,neck,bones:skin.joints.length,frames:poseBooks.length,cycleMetres:ending[2]-beginning[2],shoeFloor};
const json=Buffer.from(JSON.stringify(info)),header=Buffer.alloc(4);
header.writeUInt32LE(json.length,0);
const packed=gzipSync(Buffer.concat([header,json,...chunks]),{level:9});
writeFileSync(destination,packed);
const SHA=input=>createHash('sha256').update(input).digest('hex');
console.log(JSON.stringify({bytes:packed.length,SHA256:SHA(packed),asf:SHA(ASF),captures:files.map(SHA),
  walkWindow:[begin/24,end/24],mps:best.mps,cycle:info.cycleMetres,frames:info.frames,vertexTotal,triangleTotal,groups,shoeFloor},null,2));
