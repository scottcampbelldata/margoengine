// File parsers in Node (@margoengine/loaders): the package's test files (packages/loaders/tests/fixtures) and a
// generated 500,000-triangle OBJ. Each sample is the median time of one parse.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from '../lib/env.mjs';
import { ms, nodeCase, timed } from '../lib/node.mjs';

const fixture = (name) => readFileSync(resolve(root, 'packages/loaders/tests/fixtures', name));

/** OBJ text of a side x side quad grid (2 * side^2 triangles) with normals and UVs. */
function objGrid(side) {
  const lines = [];
  for (let y = 0; y <= side; y++)
    for (let x = 0; x <= side; x++) lines.push(`v ${x / side} ${Math.sin(x * 0.1) * 0.05} ${y / side}`);
  for (let y = 0; y <= side; y++) for (let x = 0; x <= side; x++) lines.push(`vt ${x / side} ${y / side}`);
  lines.push('vn 0 1 0');
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const a = y * (side + 1) + x + 1,
        b = a + 1,
        c = a + side + 1,
        d = c + 1;
      lines.push(`f ${a}/${a}/1 ${c}/${c}/1 ${b}/${b}/1`, `f ${b}/${b}/1 ${c}/${c}/1 ${d}/${d}/1`);
    }
  return lines.join('\n');
}

const FILES = [
  ['ply-binary', 'dolphins.ply', 'parsePLY', 'PLY binary little-endian (dolphins)'],
  ['ply-colored', 'dolphins_colored.ply', 'parsePLY', 'PLY with vertex colours'],
  ['3mf-gears', 'cube_gears.3mf', 'parse3MF', '3MF (zip + XML), gears'],
  ['off-knight', 'decimated-knight.off', 'parseOFF', 'OFF text (knight)'],
  ['vtk-fran', 'fran_cut.vtk', 'parseVTK', 'VTK legacy (fran)'],
  ['pcd-bunny', 'bunny.pcd', 'parsePCD', 'PCD point cloud (bunny)'],
];

export default {
  name: 'loaders',
  title: 'File parsers: PLY, 3MF, OFF, VTK, PCD, OBJ (Node)',
  uses: 'cpu',
  async cases() {
    const loaders = await import('../../packages/loaders/dist/index.js');
    const cases = FILES.map(([id, file, parser, title]) => {
      const bytes = fixture(file),
        buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return nodeCase(
        id,
        `${title}, ${bytes.length.toLocaleString('en-US')} B`,
        { parseMs: ms(), bytes: { unit: 'B', exact: true } },
        async () => {
          // 3MF parses asynchronously (zip inflate); the rest return directly.
          const parse = loaders[parser],
            reps = 20;
          for (let i = 0; i < 3; i++) await parse(buffer.slice(0));
          const t = [];
          for (let i = 0; i < reps; i++) {
            const copy = buffer.slice(0),
              s = performance.now();
            await parse(copy);
            t.push(performance.now() - s);
          }
          t.sort((a, b) => a - b);
          return { parseMs: t[reps >> 1], bytes: bytes.length };
        },
      );
    });
    let obj;
    cases.push(
      nodeCase(
        'obj-500k',
        'OBJ text, generated 500,000-triangle grid with UVs and normals',
        { parseMs: ms(), bytes: { unit: 'B', exact: true } },
        () => {
          obj ??= objGrid(500);
          return { parseMs: timed(() => loaders.parseOBJ(obj), { reps: 5, warm: 1 }), bytes: Buffer.byteLength(obj) };
        },
      ),
    );
    return cases;
  },
};
