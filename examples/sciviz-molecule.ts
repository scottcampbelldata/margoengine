import { Figure } from '@margoengine/sciviz';
import { molecule, type MoleculeLayer, type MoleculeStyle } from '@margoengine/sciviz/molecule';
import { parsePDB } from '@margoengine/loaders/pdb';
import { parseMMCIF } from '@margoengine/loaders/mmcif';
import { element } from './sciviz-demo.js';

export const figures: Record<string, Figure> = {},
  layers: Record<string, MoleculeLayer> = {};
export let atomCount = 0,
  bondCount = 0;
const signal = AbortSignal.timeout(180000),
  root = new URL('../packages/sciviz/tests/fixtures/molecule/source.json', import.meta.url);
try {
  const [pdb, cif] = await Promise.all(
      ['1crn.pdb', '1crn.cif'].map((path) =>
        fetch(new URL(path, root), { signal }).then((r) => {
          if (!r.ok) throw new Error(`${path}: ${r.status}`);
          return r.text();
        }),
      ),
    ),
    structures = [parsePDB(pdb), parseMMCIF(cif)];
  atomCount = structures[0].atoms.length;
  bondCount = structures[0].bonds.length / 2;
  const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < atomCount; i++)
    for (let k = 0; k < 3; k++) {
      const v = structures[0].positions[i * 3 + k];
      bounds[k * 2] = Math.min(bounds[k * 2], v - 2.5);
      bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], v + 2.5);
    }
  const spans = [0, 1, 2].map((k) => bounds[k * 2 + 1] - bounds[k * 2]),
    aspect = spans.map((v) => v / Math.max(...spans)) as [number, number, number];
  for (const [id, style, index] of [
    ['ball', 'ball-and-stick', 0],
    ['space', 'space-filling', 1],
    ['licorice', 'licorice', 1],
  ] as const) {
    const canvas = element<HTMLCanvasElement>(id),
      f = await Figure.create(canvas, {
        axes: false,
        theme: 'dark',
        aspect,
        limits: bounds as unknown as [number, number, number, number, number, number],
        signal,
      });
    figures[id] = f;
    layers[id] = molecule(f, structures[index], { style: style as MoleculeStyle });
    await f.ready();
    f.engine.render();
    canvas.dataset.ready = 'true';
    canvas.addEventListener('click', (event) => {
      const hit = layers[id].pick(event.offsetX, event.offsetY);
      element('picked').textContent = hit
        ? `${hit.residue.name} ${hit.residue.chain}:${hit.residue.id}${hit.residue.insertionCode}, atom ${hit.atom.name}${hit.bond ? ' (bond)' : ''}`
        : 'No molecular surface here.';
    });
  }
  element('status').textContent =
    `${atomCount} atoms, ${bondCount} bonds, ${layers.ball.residues.length} residues. PDB and mmCIF coordinates agree.`;
} catch (error) {
  element('ball').dataset.error = String(error);
  element('status').textContent = String(error);
  throw error;
}
