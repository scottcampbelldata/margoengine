import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public Margo checkout.');
const { model } = await import(pathToFileURL(resolve(checkout,'packages/brep/dist/index.js')));
const { box, frameOf, fillet, chamfer, checkBody, massProperties, meshBodies } = model;
const stock = box('stock',[.120,.062,.086],frameOf([-.060,0,-.043],[0,0,1],[1,0,0]));
const edges = stock.edges.map(edge => edge.name);
const sizes = [2,4,6,8,10,12,14,16,18];
const states = [];
const q = value => +value.toFixed(6);
for (const [operation,blend] of [['round',fillet],['bevel',chamfer]]) {
  let previous = massProperties(stock).volume;
  for (const mm of sizes) {
    const body = blend(operation+'-'+mm,stock,edges,mm/1000);
    const problems = checkBody(body);
    if (problems.length) throw new Error(body.name+' failed validation: '+JSON.stringify(problems));
    const { volume } = massProperties(body);
    if (!(volume > 0 && volume < previous)) throw new Error(body.name+' failed the expected stock removal check.');
    previous = volume;
    const result = meshBodies([body],{deflection:.00013,angle:.23,interiorDeflection:.00029,interiorAngle:.36});
    const [mesh] = result.meshes;
    if (mesh.failures.length) throw new Error(body.name+' failed tessellation.');
    states.push({operation,mm,volume,faces:body.faces.length,
      position:Array.from(mesh.positions,q), normal:Array.from(mesh.normals,q),index:Array.from(mesh.indices)});
  }
}
const contents = gzipSync(JSON.stringify(states),{level:9});
await writeFile(new URL('./assets/blends.bin',import.meta.url),contents);
console.log(JSON.stringify({states:states.length,bytes:contents.byteLength,
  triangles:states.map(s=>s.index.length/3), max:states.at(-1).volume}));
