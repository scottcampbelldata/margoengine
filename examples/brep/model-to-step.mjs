// Builds a small part (a filleted plate with four holes) with the B-rep modeler, writes it as STEP, reads the file back and meshes it.
// Run from the repository root after `npm run build:packages`:
//   node examples/brep/model-to-step.mjs [out.step]
import { writeFileSync } from 'node:fs';
import { model, parseSTEP, tessellateSTEP } from '@margoengine/brep';

const { box, cylinder, boolean, fillet, frameOf, massProperties, bodiesToSTEP, bodiesFromSTEP } = model;
const mm = 0.001;
const at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]);

// A 60 x 40 x 10 mm plate with rounded vertical edges and four 6 mm holes.
const plate = box('plate', [60 * mm, 40 * mm, 10 * mm]);
const vertical = plate.edges.filter((e) => e.name.includes(':side:')).map((e) => e.name);
let part = fillet('plate', plate, vertical, 4 * mm);
for (const [x, y] of [
  [10, 10],
  [50, 10],
  [10, 30],
  [50, 30],
])
  part = boolean('plate', 'subtract', part, cylinder('hole', 3 * mm, 20 * mm, at(x, y, -5)));

const { volume, area } = massProperties(part);
console.log(`modeled: volume ${(volume / mm ** 3).toFixed(1)} mm^3, area ${(area / mm ** 2).toFixed(1)} mm^2`);

const step = bodiesToSTEP([part]);
const out = process.argv[2];
if (out) writeFileSync(out, step);
console.log(`STEP: ${step.length} bytes${out ? `, written to ${out}` : ''}`);

const read = parseSTEP(step);
const meshes = tessellateSTEP(read, { relativeDeflection: 0.0005 });
for (const [i, mesh] of meshes.entries())
  console.log(
    `body ${i}: ${read.bodies[i].faces.length} faces, ${mesh.indices.length / 3} triangles, ${mesh.failures.length} failed faces`,
  );
const [back] = bodiesFromSTEP(read).bodies;
console.log(`read back: volume ${(massProperties(back).volume / mm ** 3).toFixed(1)} mm^3`);
