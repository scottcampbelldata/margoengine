import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const engine = process.env.MARGO_ENGINE_CHECKOUT;
if (!engine) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public Margo checkout.');
const { model } = await import(pathToFileURL(resolve(engine,'packages/brep/dist/index.js')));
const { box, frameOf, chamfer, boolean, checkBody, massProperties, meshBodies } = model;
const basis = frameOf([-.070,0,-.038],[0,0,1],[1,0,0]);
const block = box('base',[.115,.052,.075],basis);
const vertical = block.edges.filter(e => Math.abs(e.start.point[1]-e.end.point[1])>.045);
const base = chamfer('operator-a',block,vertical.map(e=>e.name),.010);
const cross = box('operator-b',[.087,.054,.064],
  frameOf([-.026,.019,-.006],[0,0,1],[Math.cos(.37),Math.sin(.37),0]));

const regions = ['union','subtract','intersect'].map(op => boolean(op,op,base,cross));
for(const body of [base,cross,...regions]) {
  const problems=checkBody(body);
  if(problems.length) throw new Error(body.name+' failed exact topology checks: '+JSON.stringify(problems));
}
const measure = body => massProperties(body).volume;
const [u,d,i] = regions.map(measure);
const a = measure(base), b = measure(cross);
const small = 1e-10;
if (!(i > 0 && i < Math.min(a,b) && d>0 && u>Math.max(a,b)) ||
    Math.abs(u+i-a-b)>small || Math.abs(d+i-a)>small) throw new Error('Boolean volumes violate conservation.');

const quantize = v => +v.toFixed(7);
const states = regions.map(body => {
  const { meshes } = meshBodies([body],{deflection:.0001,angle:.20});
  const [mesh] = meshes;
  if(mesh.failures.length) throw new Error(JSON.stringify(mesh.failures));
  const edgePoints=[];
  for(const edge of body.edges) {
    if(edge.curve.kind!=='line') throw new Error('The line-edge display requires planar operand edges.');
    edgePoints.push(...edge.start.point.map(quantize), ...edge.end.point.map(quantize));
  }
  return {
    volume:measure(body), faces:body.faces.length, edges:body.edges.length, edgePoints,
    position:Array.from(mesh.positions,quantize), normal:Array.from(mesh.normals,quantize),
    index:Array.from(mesh.indices),
  };
});
const asset=gzipSync(JSON.stringify(states),{level:9});
await writeFile(new URL('./assets/operations.bin',import.meta.url),asset);
console.log(JSON.stringify({transfer:asset.byteLength,inputs:[a,b],volumes:[u,d,i],edges:states.map(x=>x.edges)}));
