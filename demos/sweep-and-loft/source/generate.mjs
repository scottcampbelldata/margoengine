import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public Margo checkout.');
const { model }=await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const { sweep, loft, boolean, checkBody, massProperties, meshBodies }=model;
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
const q=value=>+value.toFixed(7);
const assets = [bottle,duct].map((body,index) => {
  const problems = checkBody(body);
  if(problems.length) throw new Error(body.name+' invalid: '+JSON.stringify(problems));
  const {volume} = massProperties(body);
  const [mesh]=meshBodies([body],{deflection:.00011,angle:.18,interiorDeflection:.00028,interiorAngle:.28}).meshes;
  if(mesh.failures.length) throw new Error('Mesh failed: '+JSON.stringify(mesh.failures));
  return {volume,faces:body.faces.length,sections:index===0?profileSizes.length:3,
    position:Array.from(mesh.positions,q),normal:Array.from(mesh.normals,q),index:Array.from(mesh.indices)};
});
const exactDuct = (4*.025*.028-4*.021*.024)*((join-start)+Math.PI*bend*.5+(finish-bend));
if (Math.abs(exactDuct-assets[1].volume)>2e-8)throw new Error('Swept duct volume failed its closed-form check.');
const buffer=gzipSync(JSON.stringify(assets),{level:9});
await writeFile(new URL('./assets/sweep-loft.bin',import.meta.url),buffer);
console.log(JSON.stringify({bytes:buffer.byteLength,volume:assets.map(a=>a.volume),faces:assets.map(a=>a.faces)}));
