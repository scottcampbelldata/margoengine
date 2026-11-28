import { mkdir, writeFile } from 'node:fs/promises';
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
const { glb: packed } = await compressMeshopt(exportGLB({ nodes: glbNodes }, { generator: 'Margo Engine the-hollow-cup' }), { normalBits: 16 });
await mkdir(new URL('./assets/', import.meta.url), { recursive: true });
await writeFile(new URL('./assets/cups.glb', import.meta.url), packed);
await writeFile(new URL('./facts.json', import.meta.url), JSON.stringify(facts, null, 1) + String.fromCharCode(10));
console.log(JSON.stringify({ bytes: packed.byteLength, facts: facts.map((f) => ({ volume: f.volume, faces: f.faces })) }));
