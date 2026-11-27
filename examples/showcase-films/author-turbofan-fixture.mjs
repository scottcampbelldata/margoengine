// An original transport cradle's bored support feet. Distances are in metres.
import { writeFile } from 'node:fs/promises';
import { model } from '@margoengine/brep';

const { box, cylinder, boolean, frameOf, bodiesToSTEP } = model;
const bodies = [];
for (const x of [-0.543, 0.543]) {
  for (const z of [-1.02, 0.85]) {
    const name = 'Transport saddle ' + (bodies.length + 1);
    const blank = box(name, [0.276, 0.12, 0.279], frameOf([x - 0.138, 0.875, z - 0.1395], [0, 0, 1], [1, 0, 0]));
    const bores = [-0.088, 0.088].map((offset, i) =>
      cylinder(name + ' bolt ' + i, 0.02, 0.18, frameOf([x + offset, 0.842, z], [0, 1, 0], [1, 0, 0])),
    );
    bodies.push(boolean(name, 'subtract', boolean(name + ' first bore', 'subtract', blank, bores[0]), bores[1]));
  }
}
await writeFile(new URL('./assets/technical-films/transport-saddles.step', import.meta.url), bodiesToSTEP(bodies));
