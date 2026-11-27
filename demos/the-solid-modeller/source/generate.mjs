import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
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

const asset = gzipSync(JSON.stringify(states), { level: 9 });
await writeFile(new URL('./assets/bracket.bin', import.meta.url), asset);
console.log(JSON.stringify({ transfer: asset.byteLength, states: states.map(x => ({
  volume: x.volume, faces: x.faces, triangles: x.index.length / 3,
})) }));
