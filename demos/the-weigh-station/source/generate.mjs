import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const { model } = await import(pathToFileURL(resolve(checkout, 'packages/brep/dist/index.js')));
const { frameOf, cylinder, boolean, extrude, checkBody, massProperties, meshBodies } = model;
const vertical = (x, y, z) => frameOf([x, y, z], [0, 1, 0], [1, 0, 0]);
const cutBore = (name, blank, x, z, r) => boolean(name, 'subtract', blank, cylinder(name+'-tool',r,.091,vertical(x,-.010,z)));

const wheel = cutBore('flywheel', cylinder('flywheel-blank',.064,.026,vertical(0,0,0)),0,0,.016);
const cam = cutBore('eccentric-cam', cylinder('cam-blank',.055,.044,vertical(0,0,0)),-.020,.013,.018);
const points = [[-.069,0,-.043],[-.050,0,-.056],[.066,0,-.037],[.056,0,.009],[.029,0,.049],[-.055,0,.037]];
const rawYoke = extrude('yoke-blank',{
  name:'yoke-profile', start:points[0], normal:[0,1,0],
  segments:[...points.slice(1),points[0]].map(to => ({kind:'line',to})),
},[0,.023,0]);
const yoke = cutBore('yoke',cutBore('yoke-first-bore',rawYoke,-.037,-.015,.012),.027,-.010,.016);

const display = [wheel,cam,yoke].map(body => {
  const problems = checkBody(body);
  assert.equal(problems.length,0,body.name+': '+JSON.stringify(problems));
  const mass = massProperties(body);
  assert.ok(mass.volume>0 && mass.inertia.slice(0,3).every(i=>i>0));
  const { meshes:[ mesh ] } = meshBodies([body],{deflection:.000085,angle:.13,interiorDeflection:.0002});
  assert.equal(mesh.failures.length,0,body.name+' failed tessellation');
  return {
    ...mass,
    top:mesh.positions.reduce((top,value,i)=>i%3===1?Math.max(top,value):top,0),
    position:Array.from(mesh.positions,v=>+v.toFixed(7)),
    normal:Array.from(mesh.normals,v=>+v.toFixed(6)),
    index:Array.from(mesh.indices),
  };
});
const [ring,offsetCam] = display;
const [r,b,h]=[.064,.016,.026];
const value=Math.PI*(r*r-b*b)*h;
assert.ok(Math.abs(ring.volume-value)<1e-11);
assert.ok(Math.abs(ring.inertia[1]-value*(r*r+b*b)/2)<1e-11);
assert.ok(Math.abs(ring.centroid[0])<1e-10 && Math.abs(ring.centroid[2])<1e-10);
assert.ok(offsetCam.centroid[0]>0 && offsetCam.centroid[2]<0);
const states = display;
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
  facts.push({ ...rest, lift: r(lift), box: { min: [r(min[0]), 0, r(min[2])], max: [r(max[0]), r(max[1] + lift), r(max[2])] } });
}
// glTF 2.0 binary with EXT_meshopt_compression and KHR_mesh_quantization (16-bit normals keep smooth metal smooth).
const { exportGLB } = await import(pathToFileURL(resolve(process.env.MARGO_ENGINE_CHECKOUT, 'packages/exporters/dist/gltf.js')));
const { compressMeshopt } = await import(pathToFileURL(resolve(process.env.MARGO_ENGINE_CHECKOUT, 'packages/exporters/dist/meshopt.js')));
const { glb: packed } = await compressMeshopt(exportGLB({ nodes: glbNodes }, { generator: 'Margo Engine the-weigh-station' }), { normalBits: 16 });
await mkdir(new URL('./assets/', import.meta.url), { recursive: true });
await writeFile(new URL('./assets/bodies.glb', import.meta.url), packed);
await writeFile(new URL('./facts.json', import.meta.url), JSON.stringify(facts, null, 1) + String.fromCharCode(10));
console.log(JSON.stringify({ bytes: packed.byteLength, facts: facts.map((f) => ({ volume: f.volume, faces: f.faces })) }));
