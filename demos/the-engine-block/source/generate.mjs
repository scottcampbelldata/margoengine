import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { dimensions } from './dimensions.mjs';
import { encodeDisplayMesh } from './display-mesh.mjs';

const entry = process.env.MARGO_ENGINE_CHECKOUT
  ? pathToFileURL(resolve(process.env.MARGO_ENGINE_CHECKOUT, 'packages/brep/dist/index.js')).href
  : '@margoengine/brep';
const { model, parseSTEP } = await import(entry);
const { box, cylinder, frameOf, fillet, shell, boolean, checkBody, bodiesFromSTEP,
  bodiesToSTEP, massProperties, meshBodies, extrude } = model;
const { length, deck, crankcaseFloor, width, corner, shellWall, centers, outerRadius, boreRadius } = dimensions;
const yFrame = (x, y, z) => frameOf([x, y, z], [0, 1, 0], [1, 0, 0]);
const zFrame = (x, y, z) => frameOf([x, y, z], [0, 0, 1], [1, 0, 0]);
const worldBox = (name, size, origin) => box(name, size, zFrame(...origin));

const billet = worldBox('casting', [length, deck - crankcaseFloor, width],
  [-length / 2, crankcaseFloor, -width / 2]);
const uprights = billet.edges.filter(edge => Math.abs(edge.start.point[1] - edge.end.point[1]) > .1);
const round = fillet('casting-corners', billet, uprights.map(edge => edge.name), corner);
let block = shell('crankcase', round, ['casting/face:-y'], -shellWall);

for (const [i, x] of centers.entries()) {
  const cylinderBoss = cylinder('liner-' + (i + 1), outerRadius, .185, yFrame(x, .072, 0));
  block = boolean('join-liner-' + (i + 1), 'union', block, cylinderBoss);
}
for (const [i, x] of centers.entries()) {
  const drill = cylinder('bore-' + (i + 1), boreRadius, .249, yFrame(x, .025, 0));
  block = boolean('machine-bore-' + (i + 1), 'subtract', block, drill);
}
for (const z of [-.094, .094]) {
  const rail = worldBox('rail-' + z, [.435, .015, .029], [-.2175, .044, z - .0145]);
  block = boolean('pan-rail', 'union', block, rail);
}
for (const i of [-2, -1, 0, 1, 2]) {
  for (const z of [-.0697, .0697]) {
    const drill = cylinder('bolt-' + i + '-' + z, .0054, .042, yFrame(i * .0954, .224, z));
    block = boolean('head-bolt-drill', 'subtract', block, drill);
  }
}
for (const [i, x] of [-.103, .001, .103].entries()) {
  const drill = cylinder('jacket-port-' + i, .0132, .045, zFrame(x, .165, .071));
  block = boolean('drill-side-port-' + i, 'subtract', block, drill);
}
for (const [i, x] of [-.193, -.111, -.025, .067, .155, .194].entries()) {
  const stagger = i % 2;
  const y = .078 + stagger * .014;
  const start = [x, y, .089];
  const points = [[x, .217, .089], [x, y + .023, .116 + stagger * .005], [x, y - .010, .110], start];
  const profile = { name: 'web-' + i, start, normal: [1, 0, 0], segments: points.map(to => ({ kind: 'line', to })) };
  const rib = extrude('web-' + i, profile, [.008, 0, 0]);
  block = boolean('join-rib-' + i, 'union', block, rib);
}
const errors = checkBody(block);
if (errors.length) throw new Error(JSON.stringify(errors));
const volume = massProperties(block).volume;
const step = bodiesToSTEP([block]);
const imported = bodiesFromSTEP(parseSTEP(step));
const reimport = imported.bodies[0];
if (imported.bodies.length !== 1 || imported.problems.length || reimport.kind !== 'solid' ||
    checkBody(reimport).length || Math.abs(massProperties(reimport).volume - volume) > 1e-9) {
  throw new Error('The STEP round trip did not preserve the original solid.');
}
const options = { deflection: .00018, angle: .23, interiorDeflection: .00034, interiorAngle: .28 };
const display = meshBodies([block], options);
const mesh = display.meshes[0];
if (mesh.failures.length) throw new Error(JSON.stringify(mesh.failures));
function slotOf(name) {
  if (name.startsWith('bore-')) return 3 + Number(name[5]);
  if (name === 'casting/face:+y' || name.endsWith('face:+z') && name.startsWith('liner-')) return 1;
  if (name.startsWith('liner-')) return 2;
  if (name.startsWith('rail-') || name.startsWith('bolt-') || name.startsWith('jacket-port-')) return 3;
  return 0;
}
const manifest = { volume, faces: reimport.faces.length, triangles: mesh.indices.length / 3 };
await Promise.all([
  writeFile(new URL('./engine-block.step', import.meta.url), step),
  writeFile(new URL('./engine-block.bin', import.meta.url), encodeDisplayMesh(mesh, display.faceName, slotOf)),
  writeFile(new URL('./engine-block.json', import.meta.url), JSON.stringify(manifest) + '\n'),
]);
console.log(JSON.stringify({ ...manifest, bytes: Buffer.byteLength(step) }));