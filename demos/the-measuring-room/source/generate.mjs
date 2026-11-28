import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const {model}=await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const {extrude,frameOf,cylinder,boolean,meshBodies,checkBody}=model;
const width=.174;
const half=width/2;
const corners=[[-half,0,-.065],[-half,.054,-.065],[-half,.054,-.007],[-half,.022,.049],[-half,.022,.063],[-half,0,.063]];
const outline={
  name:'Gauge body',
  start:corners[0],
  normal:[1,0,0],
  segments:[...corners.slice(1),corners[0]].map((to,i)=>({kind:'line',to,name:['back','datum','ramp','ledge','front','sole'][i]})),
};
const blank=extrude('coupon',outline,[width,0,0],{bottom:'left-end',top:'right-end'});
const cutters=[
  {name:'main bore',x:-.044,z:-.035,radius:.013},
  {name:'pilot bore',x:.041,z:-.034,radius:.009},
];
let part=blank;
for(const h of cutters){
  const frame=frameOf([h.x,-.01,h.z],[0,1,0],[1,0,0]);
  const tool=cylinder(h.name,h.radius,.085,frame);
  part=boolean('drill '+h.name,'subtract',part,tool);
}
const faults=checkBody(part);
assert.equal(faults.length,0,JSON.stringify(faults));
const prepared=meshBodies([part],{deflection:.000065,angle:.13});
const [mesh]=prepared.meshes;
assert.equal(mesh.failures.length,0);
const parts=mesh.faces.map(face=>{
  const vertices=new Map();
  const position=[], normal=[], index=[];
  for(const source of mesh.indices.subarray(face.first,face.first+face.count)){
    if(!vertices.has(source)){
      vertices.set(source,vertices.size);
      position.push(...mesh.positions.subarray(source*3,source*3+3).map(v=>+v.toFixed(7)));
      normal.push(...mesh.normals.subarray(source*3,source*3+3).map(v=>+v.toFixed(6)));
    }
    index.push(vertices.get(source));
  }
  return {name:prepared.faceName(face.id),position,normal,index};
});
const displayed=parts.map(face=>face.name);
assert.ok(displayed.some(name=>name.includes('ramp')),displayed.join(', '));
assert.ok(displayed.some(name=>name.includes('main bore')),displayed.join(', '));
const widthPoints=[[ -half,.054,-.012],[half,.054,-.012]];
assert.ok(Math.abs(widthPoints[1][0]-widthPoints[0][0]-.174)<1e-10);
// One GLB node per B-rep face (named after it), so a pick names the face it hit. The coupon's sole is at y 0 and the
// page keeps the plate's top at y 0, so positions stay unquantized and in the part's own millimetre-exact frame.
const glbNodes=parts.map(face=>({name:face.name,geometry:{positions:face.position,normals:face.normal,indices:face.index}}));
const {exportGLB}=await import(pathToFileURL(resolve(checkout,'packages/exporters/dist/gltf.js')));
const {compressMeshopt}=await import(pathToFileURL(resolve(checkout,'packages/exporters/dist/meshopt.js')));
const {glb:packed}=await compressMeshopt(exportGLB({nodes:glbNodes},{generator:'Margo Engine the-measuring-room'}),{quantize:false});
const faces=parts.map(face=>{
  const center=[0,0,0];
  for(let i=0;i<face.position.length;i++)center[i%3]+=face.position[i]*3/face.position.length;
  return {name:face.name,normal:face.normal.slice(0,3),center:center.map(v=>+v.toFixed(7))};
});
const facts={faces,widthPoints,cutters:cutters.map(h=>({...h,top:.054})),datum:corners[2],ramp:corners[3]};
await mkdir(new URL('./assets/',import.meta.url),{recursive:true});
await writeFile(new URL('./assets/coupon.glb',import.meta.url),packed);
await writeFile(new URL('./facts.json',import.meta.url),JSON.stringify(facts,null,1)+String.fromCharCode(10));
console.log(JSON.stringify({bytes:packed.byteLength,faces:displayed,triangles:mesh.indices.length/3}));
