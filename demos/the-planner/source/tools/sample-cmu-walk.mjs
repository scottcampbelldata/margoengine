import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as nodeModule from 'node:module';

const [checkout,folder,destination]=process.argv.slice(2);
if(!destination)throw new Error('Pass the Margo checkout, source Acclaim folder, and output module.');
const {registerHooks}=nodeModule;
if(typeof registerHooks!=='function')throw new Error('This tool needs Node 22.15 or newer (module.registerHooks).');
registerHooks({resolve(specifier,context,next){
  if(!specifier.startsWith('@margoengine/'))return next(specifier,context);
  const [,name,...pieces]=specifier.split('/');
  const packageDir=resolve(checkout,'packages',name), manifest=JSON.parse(readFileSync(resolve(packageDir,'package.json'),'utf8'));
  const entry=manifest.exports[pieces.length?'./'+pieces.join('/'):'.'];
  assert.ok(entry,specifier);
  return {url:pathToFileURL(resolve(packageDir,typeof entry==='string'?entry:entry.import)).href,shortCircuit:true};
}});

const {parseASF,parseAMC}=await import('@margoengine/loaders/mocap');
const {Skeleton,createKeyframeClip,applyKeyframeClip}=await import('@margoengine/animation');
const asf=readFileSync(resolve(folder,'35.asf')), amc=readFileSync(resolve(folder,'35_02.amc'));
const reference=parseASF(asf,{scale:.0254/.45});
const clipSource=parseAMC(amc,reference,{name:'CMU 35_02 ordinary walk'});
const skeleton=new Skeleton(clipSource.bones),clip=createKeyframeClip(clipSource.clip);
const names=new Map(clipSource.bones.map((bone,index)=>[bone.name,index]));
const point=name=>Array.from(skeleton.worldMatrix(names.get(name))).slice(12,15);
const pelvisAt=frame=>{
  applyKeyframeClip(clip,skeleton,frame*clipSource.frameTime);
  return point('root');
};
const begin=191,end=326,frameCount=40,duration=(end-begin)*clipSource.frameTime;
const start=pelvisAt(begin),finish=pelvisAt(end),delta=finish.map((p,i)=>p-start[i]);
const heading=Math.atan2(delta[0],delta[2]),c=Math.cos(heading),s=Math.sin(heading);
const project=(a,b)=>[c*(a[0]-b[0])-s*(a[2]-b[2]),a[1]-b[1],s*(a[0]-b[0])+c*(a[2]-b[2])];
function joint(name){return project(point(name),start);}
const footSamples=[];
for(let t=0;t<=frameCount;t++){
  applyKeyframeClip(clip,skeleton,(begin+(end-begin)*t/frameCount)*clipSource.frameTime);
  const root=joint('root'),hipL=joint('lfemur'),hipR=joint('rfemur');
  const shoulderL=joint('lhumerus'),shoulderR=joint('rhumerus');
  const rib=joint('thorax'),head=joint('head');
  const hipYaw=Math.atan2(hipR[2]-hipL[2],hipL[0]-hipR[0]);
  const shoulderYaw=Math.atan2(shoulderR[2]-shoulderL[2],shoulderL[0]-shoulderR[0]);
  const torsoRoll=Math.atan2(head[0]-rib[0],head[1]-rib[1]);
  const torsoPitch=Math.atan2(head[2]-rib[2],head[1]-rib[1]);
  const raw=[root[0],root[1],hipYaw,shoulderYaw,torsoRoll,torsoPitch];
  const rootWorld=point('root');
  for(const side of ['l','r']){
    const ankle=point(side+'foot'), toes=point(side+'toes');
    const foot=project(ankle,rootWorld), toeDirection=project(toes,ankle);
    const knee=project(point(side+'tibia'),rootWorld);
    const lift=joint(side+'foot')[1], pitch=Math.atan2(toeDirection[1],toeDirection[2]);
    const humerus=point(side+'humerus'),elbow=project(point(side+'radius'),humerus),wrist=project(point(side+'hand'),humerus);
    const clearance=Math.min(lift-.067,joint(side+'toes')[1]-.023);
    raw.push(foot[0],lift,foot[2],pitch,knee[2],clearance,...elbow,...wrist);
  }
  footSamples.push(raw);
}
const samples=footSamples.map((entry,t)=>entry.map((v,c)=>v+(footSamples[0][c]-footSamples.at(-1)[c])*t/frameCount));
const average=c=>samples.slice(0,frameCount).reduce((n,p)=>n+p[c],0)/frameCount;
const floors=[7,11,19,23].map(c=>Math.min(...samples.map(p=>p[c])));
const center=[average(0),average(1)];
for(const sample of samples){
  sample[0]-=center[0];sample[1]-=center[1];
  for(const [i,at] of [7,11,19,23].entries())sample[at]-=floors[i];
}
const quantized=samples.map(row=>row.map(v=>Math.round(v*10000)));
const digest=createHash('sha256').update(amc).digest('hex');
const content=[
  '// Position samples from CMU Graphics Lab trial 35_02, frames 191–326 at 120 Hz.',
  '// Local and world samples have been expressed in the direction of the original walk.',
  'export const captureDuration = '+duration.toFixed(6)+';',
  'export const captureSpeed = '+(Math.hypot(delta[0],delta[2])/duration).toFixed(6)+';',
  'export const captureSamples = [',
  ...quantized.map(row=>'  ['+row.join(',')+'],'),
  '];',
  '',
].join('\n');
writeFileSync(destination,content);
console.log(JSON.stringify({trial:'35_02',digest,begin,end,frames:frameCount,duration,velocity:Math.hypot(delta[0],delta[2])/duration,heightRanges:[7,19].map(c=>Math.max(...samples.map(p=>p[c]))),joined:quantized[0].every((v,i)=>v===quantized.at(-1)[i])}));
