import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public Margo checkout.');
const { model }=await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const { sweep, loft, boolean, checkBody, massProperties, meshBodies }=model;
const { exportGLB }=await import(pathToFileURL(resolve(checkout,'packages/exporters/dist/gltf.js')));
const { compressMeshopt }=await import(pathToFileURL(resolve(checkout,'packages/exporters/dist/meshopt.js')));
function circle(name,y,r) {
  const points=[[r,y,0],[0,y,-r],[-r,y,0],[0,y,r]];
  return {name,start:points[0],normal:[0,1,0],
    segments:[...points.slice(1),points[0]].map(to=>({kind:'arc',to,center:[0,y,0]}))};
}
const profileSizes = [[0,.040],[.012,.047],[.078,.046],[.117,.044],[.145,.027],[.168,.018],[.185,.018]];
const bottle = loft('bottle-blank',profileSizes.map(([y,r],i)=>circle('level-'+i,y,r)));
const height=.033;
const bend=.056;
const join=-.037;
const start=-.102;
const finish=.111;
const path = (first,last) => ({name:'right-angle-run',start:[first,height,0],segments:[
  {kind:'line',to:[join,height,0]}, {kind:'arc',center:[join,height,bend],to:[join+bend,height,bend],axis:[0,-1,0]},
  {kind:'line',to:[join+bend,height,last]},
]});
function rectangle(name,x,halfA,halfB) {
  const points=[[x,height-halfA,-halfB],[x,height+halfA,-halfB],[x,height+halfA,halfB],[x,height-halfA,halfB]];
  return {name,start:points[0],normal:[1,0,0],segments:[...points.slice(1),points[0]].map(to=>({kind:'line',to}))};
}
const sweepOuter = sweep('outer-sweep',rectangle('duct-section',start,.025,.028),path(start,finish));
const sweepBore = sweep('inner-sweep',rectangle('duct-core',start-.010,.021,.024),path(start-.010,finish+.010));
const duct = boolean('open-duct','subtract',sweepOuter,sweepBore);
const assets = [bottle,duct].map((body,index) => {
  const problems = checkBody(body);
  if(problems.length) throw new Error(body.name+' invalid: '+JSON.stringify(problems));
  const {volume} = massProperties(body);
  const [mesh]=meshBodies([body],{deflection:.00011,angle:.18,interiorDeflection:.00028,interiorAngle:.28}).meshes;
  if(mesh.failures.length) throw new Error('Mesh failed: '+JSON.stringify(mesh.failures));
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<mesh.positions.length;i++){const a=i%3;min[a]=Math.min(min[a],mesh.positions[i]);max[a]=Math.max(max[a],mesh.positions[i]);}
  // Each solid rests on the plate: its node lifts or lowers it so its lowest point is at y 0.
  const lift=-min[1];min[1]=0;max[1]+=lift;
  return {name:body.name,volume,faces:body.faces.length,sections:index===0?profileSizes.length:3,box:{min,max},lift,mesh};
});
const exactDuct = (4*.025*.028-4*.021*.024)*((join-start)+Math.PI*bend*.5+(finish-bend));
if (Math.abs(exactDuct-assets[1].volume)>2e-8)throw new Error('Swept duct volume failed its closed-form check.');
// glTF 2.0 binary with EXT_meshopt_compression and KHR_mesh_quantization (16-bit normals keep smooth metal smooth).
const glb=exportGLB({nodes:assets.map(({name,mesh,lift})=>({name,translation:[0,lift,0],
  geometry:{positions:mesh.positions,normals:mesh.normals,indices:mesh.indices}}))},{generator:'Margo Engine sweep-and-loft'});
const {glb:packed}=await compressMeshopt(glb,{normalBits:16});
await mkdir(new URL('./assets/',import.meta.url),{recursive:true});
await writeFile(new URL('./assets/sweep-loft.glb',import.meta.url),packed);
const r=v=>+v.toFixed(6);
const facts=assets.map(({name,volume,faces,sections,box})=>({name,volume,faces,sections,box:{min:box.min.map(r),max:box.max.map(r)}}));
await writeFile(new URL('./facts.json',import.meta.url),JSON.stringify(facts,null,1)+String.fromCharCode(10));
console.log(JSON.stringify({bytes:packed.byteLength,volume:facts.map(a=>a.volume),faces:facts.map(a=>a.faces)}));
