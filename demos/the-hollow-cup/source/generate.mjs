import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public Margo checkout.');
const { model } = await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const { cylinder, frameOf, draft, shell, checkBody, massProperties, meshBodies } = model;
const normal = [0,1,0];
const origin = [0,0,0];
const blank = cylinder('cup-stock',.046,.082,frameOf(origin,normal,[1,0,0]));
const lateral = blank.faces.find(face => face.surface.kind === 'cylinder');
const mouth = blank.faces.find(face => /(?:\+z|top)$/.test(face.name));
if(!lateral || !mouth) throw new Error('Expected a cylindrical wall and a named top face.');
const q = value => +value.toFixed(6);
const states = [];

for (const deg of [0,2,4,6,8]) {
  const outside = deg ? draft('cast-'+deg,blank,[lateral.name],{origin,normal},normal,-deg*Math.PI/180) : blank;
  const outerVolume = massProperties(outside).volume;
  let previous = 0;
  for (const mm of [2,3,4,5,6]) {
    const body = shell('cup-'+deg+'-'+mm,outside,[mouth.name],-mm/1000);
    const problems = checkBody(body);
    if(problems.length) throw new Error(body.name+' failed validity: '+JSON.stringify(problems));
    const { volume } = massProperties(body);
    if (!(volume > previous && volume < outerVolume)) throw new Error('Wall thickness did not increase material.');
    previous = volume;
    const [mesh] = meshBodies([body],{deflection:.00019,angle:.26,interiorDeflection:.00032,interiorAngle:.36}).meshes;
    if (mesh.failures.length) throw new Error(body.name+' failed tessellation.');
    states.push({deg,mm,volume,faces:body.faces.length,
      position:Array.from(mesh.positions,q),normal:Array.from(mesh.normals,q),index:Array.from(mesh.indices)});
  }
}
const files = states.map(state => gzipSync(JSON.stringify(state), {level:9}));
await Promise.all(files.map((file,index)=>writeFile(new URL('./assets/cup-'+index+'.bin',import.meta.url),file)));
console.log(JSON.stringify({states:states.length,openingBytes:files[12].byteLength,totalBytes:files.reduce((sum,file)=>sum+file.byteLength,0)}));
