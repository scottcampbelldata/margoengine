import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.env.MARGO_ENGINE_CHECKOUT;
if (!checkout) throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const { model } = await import(pathToFileURL(resolve(checkout, 'packages/brep/dist/index.js')));
const { frameOf, extrude, fillet, shell, cylinder, boolean, checkBody, massProperties, meshBodies } = model;

const halfWidth = .066;
const corners = [
  [-halfWidth, 0, -.046], [-halfWidth, 0, .053], [-halfWidth, .016, .053],
  [-halfWidth, .016, -.028], [-halfWidth, .083, -.028], [-halfWidth, .083, -.046],
];
const outline = {
  name: 'Bracket section',
  start: corners[0],
  normal: [1, 0, 0],
  segments: [...corners.slice(1), corners[0]].map(to => ({ kind: 'line', to })),
};
const billet = extrude('bracket-billet', outline, [2 * halfWidth, 0, 0]);
const rounded = fillet('rounded-heel', billet, [
  'bracket-billet/edge:side:0',
  'bracket-billet/edge:side:1',
], .0046);
const hollow = shell('open-core', rounded, ['bracket-billet/face:top'], -.0035);
let drilled = hollow;
for (const [i, x] of [-.033, .033].entries()) {
  const drill = cylinder('bore-' + (i + 1), .0062, .035, frameOf([x, -.010, .023], [0, 1, 0], [1, 0, 0]));
  drilled = boolean('drilled-' + (i + 1), 'subtract', drilled, drill);
}

const round = (value, digits) => +value.toFixed(digits);
const states = [billet, rounded, hollow, drilled].map(body => {
  const problems = checkBody(body);
  if (problems.length) throw new Error(body.name + ' is invalid: ' + JSON.stringify(problems));
  const { volume } = massProperties(body);
  const display = meshBodies([body], { deflection: .00008, angle: .16, interiorDeflection: .00018 });
  const [mesh] = display.meshes;
  if (mesh.failures.length) throw new Error('Bracket tessellation failed: ' + JSON.stringify(mesh.failures));
  return {
    volume, faces: body.faces.length,
    position: Array.from(mesh.positions, p => round(p, 7)),
    normal: Array.from(mesh.normals, n => round(n, 6)),
    index: Array.from(mesh.indices),
  };
});

for (let i = 1; i < states.length; i++) {
  if (!(states[i].volume < states[i - 1].volume)) throw new Error('Expected stock removal at stage ' + i);
}
const massLoss = states[2].volume - states[3].volume;
const twoBores = 2 * Math.PI * .0062 ** 2 * .007;
if (Math.abs(massLoss - twoBores) > 1e-10) throw new Error('Drilled volume disagrees with the analytic bore volumes.');

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
const { glb: packed } = await compressMeshopt(exportGLB({ nodes: glbNodes }, { generator: 'Margo Engine the-solid-modeller' }), { normalBits: 16 });
await mkdir(new URL('./assets/', import.meta.url), { recursive: true });
await writeFile(new URL('./assets/bracket.glb', import.meta.url), packed);
await writeFile(new URL('./facts.json', import.meta.url), JSON.stringify(facts, null, 1) + String.fromCharCode(10));
console.log(JSON.stringify({ bytes: packed.byteLength, facts: facts.map((f) => ({ volume: f.volume, faces: f.faces })) }));
