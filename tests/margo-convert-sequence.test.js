// FG-11: `margo-convert sequence` turns a folder of per-frame meshes (a meshed fluid bake, one OBJ, PLY or STL a frame,
// as Blender's OBJ export with Animation on writes them) into one geometry cache. Frames are ordered by the last number
// in their names (frame 10 after frame 9), each file's triangles and positions come back exactly, a change of vertex
// count (a fluid surface changing topology) starts a new chunk, and the CLI writes the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readGeometryCache } from '../packages/animation/dist/geometry-cache.js';
import { convertSequence, sequenceFiles } from '../tools/margo-convert/pipeline/sequence.js';

const cli = resolve('tools/margo-convert/cli.js');

/** An OBJ of a fan of `sides` triangles at height z. */
function fanOBJ(sides, z) {
  const lines = [`v 0 0 ${z}`];
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    lines.push(`v ${Math.cos(a).toFixed(6)} ${Math.sin(a).toFixed(6)} ${z}`);
  }
  for (let s = 0; s < sides; s++) lines.push(`f 1 ${2 + s} ${2 + ((s + 1) % sides)}`);
  return lines.join('\n') + '\n';
}
/** An ASCII PLY of one triangle at height z. */
const trianglePLY = (z) =>
  `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 ${z}\n1 0 ${z}\n0 1 ${z}\n3 0 1 2\n`;
const collect = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};

test('frames are ordered by the last number in their names; other files are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-seq-'));
  try {
    for (const name of ['fluid_10.obj', 'fluid_9.obj', 'fluid_2.ply', 'readme.txt', 'v2_fluid_1.stl'])
      writeFileSync(join(dir, name), '');
    assert.deepEqual(
      sequenceFiles(dir).map((f) => f.slice(dir.length + 1)),
      ['v2_fluid_1.stl', 'fluid_2.ply', 'fluid_9.obj', 'fluid_10.obj'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fluid-like bake: frames come back exactly; a topology change starts a new chunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-seq-')),
    out = join(dir, '..', `${dir.split(/[\\/]/).pop()}.mgc`);
  try {
    // Frames 1..3 a fan of 6, 4..5 a fan of 9, 6 a PLY triangle.
    [6, 6, 6, 9, 9].forEach((sides, i) => writeFileSync(join(dir, `fluid_${i + 1}.obj`), fanOBJ(sides, i / 10)));
    writeFileSync(join(dir, 'fluid_6.ply'), trianglePLY(0.5));
    const result = await convertSequence(dir, out, { fps: 24 });
    assert.equal(result.frames, 6);
    const bytes = new Uint8Array(readFileSync(out));
    assert.equal(result.bytes, bytes.length);
    const chunks = await collect(readGeometryCache(bytes));
    assert.deepEqual(
      chunks.map((c) => [c.firstFrame, c.frameCount, c.vertexCount, c.indices.length / 3]),
      [
        [0, 3, 7, 6],
        [3, 2, 10, 9],
        [5, 1, 3, 1],
      ],
    );
    // Frame 5 (second of the 9-fan chunk) sits at height 0.4.
    const second = chunks[1].positions.subarray(10 * 3, 20 * 3);
    assert.ok(
      second.every((v, i) => i % 3 !== 2 || Math.abs(v - 0.4) < 1e-6),
      'frame 5 at z 0.4',
    );
    assert.deepEqual([...chunks[2].positions], [0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5]);

    // The CLI writes the same file.
    const viaCli = join(dir, '..', `${dir.split(/[\\/]/).pop()}-cli.mgc`);
    execFileSync(process.execPath, [cli, 'sequence', dir, '--out', viaCli, '--fps', '24', '--quiet']);
    assert.deepEqual(new Uint8Array(readFileSync(viaCli)), bytes);
    rmSync(viaCli, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});

test('an empty folder or a file of points is refused by name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-seq-'));
  try {
    await assert.rejects(convertSequence(dir, join(dir, 'x.mgc')), /holds no \.obj, \.ply, \.stl frames/);
    writeFileSync(join(dir, 'f_1.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\n');
    await assert.rejects(convertSequence(dir, join(dir, 'x.mgc')), /holds no triangles/);
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'sequence', dir, '--fps', '0'], { stdio: 'pipe' }),
      /--fps must be a number above 0/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
