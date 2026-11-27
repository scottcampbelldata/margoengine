import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { profiles } from './iris.mjs';
import { encodeIris } from './mesh-data.mjs';

const pin='0efd9cff8230507a32deb49907ecd499d46925f5';
const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout || execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin)
  throw new Error('MARGO_ENGINE_CHECKOUT must point to the built, verified public pin.');
const {model}=await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const {revolve,extrude,cylinder,frameOf,checkBody,meshBodies,massProperties,boolean}=model;
const direction=[0,1,0];

function ringBody(id,{outer,inner,height,bevel}){
  const points=[
    [inner+bevel,0],[outer-bevel,0],[outer,bevel],[outer,height-bevel],
    [outer-bevel,height],[inner+bevel,height],[inner,height-bevel],[inner,bevel],
  ].map(([x,y])=>[x,y,0]);
  return revolve(id,{name:id+'-profile',start:points[0],normal:[0,0,1],
    segments:[...points.slice(1),points[0]].map(to=>({kind:'line',to}))},
    {origin:[0,0,0],direction});
}

function leafBody(){
  const radiusPoint=(radius,angle)=>[radius*Math.cos(angle),0,radius*Math.sin(angle)];
  const origin=[0,0,0], start=radiusPoint(.0208,-.36);
  const innerEnd=radiusPoint(.0208,.49);
  const outerStart=radiusPoint(.0433,1.07), outerEnd=radiusPoint(.0433,-.33);
  const pivotTab=radiusPoint(.0485,-.38), point=radiusPoint(.037,-.48);
  return extrude('leaf',{name:'curved-leaf-profile',start,normal:direction,segments:[
    {kind:'arc',to:innerEnd,center:origin,clockwise:true},{kind:'line',to:outerStart},
    {kind:'arc',to:outerEnd,center:origin},{kind:'line',to:pivotTab},{kind:'line',to:point},{kind:'line',to:start},
  ]},[0,.00018,0]);
}

function camRing(shape) {
  let ring=ringBody('racer',shape);
  for(let i=0;i<8;i++){
    const angle=i*Math.PI/4-.34, x=.0446*Math.cos(angle), z=.0446*Math.sin(angle);
    const drill=cylinder('cam-drill-'+i,.0027,.008,frameOf([x,-.002,z],direction,[1,0,0]));
    ring=boolean('cam-hole-'+i,'subtract',ring,drill);
  }
  return ring;
}
const bodies=[...profiles.map(({id,shape})=>id==='racer'?camRing(shape):ringBody(id,shape)),leafBody(),
  cylinder('drive-pin',.00235,.0064,frameOf([0,0,0],direction,[1,0,0]))];
for(const body of bodies){
  const problems=checkBody(body);
  if(body.kind!=='solid'||problems.length)throw new Error(body.name+' '+JSON.stringify(problems));
}
const {meshes}=meshBodies(bodies,{deflection:.00011,angle:.19,interiorDeflection:.00025,interiorAngle:.27});
if(meshes.some(mesh=>mesh.failures.length))throw new Error(JSON.stringify(meshes.flatMap(mesh=>mesh.failures)));
const asset=gzipSync(encodeIris(meshes),{level:9});
const report=bodies.map((body,i)=>({id:body.name,faces:body.faces.length,volume:massProperties(body).volume,
  triangles:meshes[i].indices.length/3}));
await writeFile(new URL('./iris.mesh',import.meta.url),asset);
console.log(JSON.stringify({parts:report,bytes:asset.length}));
