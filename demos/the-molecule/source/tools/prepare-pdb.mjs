import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';

const [, , original, output] = process.argv;
if (!original || !output) throw new Error('Pass the original 1EMA PDB and the output .pdbz path.');
const bytes = await readFile(original);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
assert.equal(sha(bytes), 'f1b9fdc2b871cc41f21f645a21b4948ce12d79b29197256330b108c9b503b088');
const lines = bytes.toString('ascii').split(/\r?\n/);
const atoms = lines.filter(row => /^(ATOM  |HETATM)/.test(row)
  && row[21] === 'A' && row.slice(17,20) !== 'HOH');
const serials = new Set(atoms.map(row => row.slice(6,11)));
const connects = [];
for (const row of lines.filter(row => row.startsWith('CONECT'))) {
  const origin = row.slice(6,11);
  if (!serials.has(origin)) continue;
  const targets = row.slice(11).trimEnd().match(/.{5}/g)?.filter(id => serials.has(id));
  if (targets?.length) connects.push('CONECT' + origin + targets.join(''));
}
const keep = lines.filter(row => /^(HEADER|TITLE |EXPDTA|REMARK   2 RESOLUTION)/.test(row));
const pdb = [...keep, ...atoms, ...connects, 'END'].map(row => row.trimEnd()).join('\n') + '\n';
const gzip = gzipSync(Buffer.from(pdb,'ascii'), {level:9});
assert.equal(atoms.length,1771);
await writeFile(output,gzip);
console.log({atoms:atoms.length,conect:connects.length,bytes:gzip.length,pdbSha256:sha(pdb),gzipSha256:sha(gzip)});
