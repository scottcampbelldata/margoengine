import { mkdir, writeFile } from 'node:fs/promises';
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
const glbNodes = [], facts = [];
for (const [i, state] of states.entries()) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < state.position.length; k++) {
    const a = k % 3;
    min[a] = Math.min(min[a], state.position[k]);
    max[a] = Math.max(max[a], state.position[k]);
  }
  // Each solid rests on the plate: its node moves it so its lowest point is at y 0.
  const lift = -min[1];
  glbNodes.push({ name: 'step-' + i, translation: [0, lift, 0],
    geometry: { positions: state.position, normals: state.normal, indices: state.index } });
  const { position, normal, index, edgePoints, ...rest } = state;
  const r = (v) => +v.toFixed(6);
  facts.push({ ...rest, box: { min: [r(min[0]), 0, r(min[2])], max: [r(max[0]), r(max[1] + lift), r(max[2])] } });
}
// glTF 2.0 binary with EXT_meshopt_compression and KHR_mesh_quantization (16-bit normals keep smooth metal smooth).
const { exportGLB } = await import(pathToFileURL(resolve(process.env.MARGO_ENGINE_CHECKOUT, 'packages/exporters/dist/gltf.js')));
const { compressMeshopt } = await import(pathToFileURL(resolve(process.env.MARGO_ENGINE_CHECKOUT, 'packages/exporters/dist/meshopt.js')));
const { glb: packed } = await compressMeshopt(exportGLB({ nodes: glbNodes }, { generator: 'Margo Engine the-fillet-bench' }), { normalBits: 16 });
await mkdir(new URL('./assets/', import.meta.url), { recursive: true });
await writeFile(new URL('./assets/blends.glb', import.meta.url), packed);
await writeFile(new URL('./facts.json', import.meta.url), JSON.stringify(facts, null, 1) + String.fromCharCode(10));
console.log(JSON.stringify({ bytes: packed.byteLength, facts: facts.map((f) => ({ volume: f.volume, faces: f.faces })) }));
