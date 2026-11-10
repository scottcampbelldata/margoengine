import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parsePDB } from '../dist/pdb.js';
import { parseMMCIF } from '../dist/mmcif.js';
const fixture = new URL('../../sciviz/tests/fixtures/molecule/', import.meta.url);
const atomTags = [
  'group_PDB',
  'id',
  'type_symbol',
  'label_atom_id',
  'label_comp_id',
  'label_asym_id',
  'label_seq_id',
  'Cartn_x',
  'Cartn_y',
  'Cartn_z',
  'auth_seq_id',
  'auth_asym_id',
  'pdbx_PDB_ins_code',
  'label_alt_id',
  'pdbx_PDB_model_num',
];
const header = 'loop_\n' + atomTags.map((t) => '_atom_site.' + t).join('\n') + '\n';
const make = (rows, prefix = 'data_test\n') => prefix + header + rows.join('\n') + '\n';
const bonds = (m) =>
  Array.from({ length: m.bonds.length / 2 }, (_, i) => `${m.bonds[i * 2]}:${m.bonds[i * 2 + 1]}`).sort();

test('real CC0 1CRN PDB and mmCIF have all 327 identical atoms, 337 bonds and 46 residue ids', () => {
  const source=JSON.parse(readFileSync(new URL('source.json',fixture)));
  for(const [path,info] of Object.entries(source.files))assert.equal(createHash('sha256').update(readFileSync(new URL(path,fixture))).digest('hex'),info.sha256);
  const a = parsePDB(readFileSync(new URL('1crn.pdb', fixture))),
    b = parseMMCIF(readFileSync(new URL('1crn.cif', fixture)));
  assert.equal(a.atoms.length, 327);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.colors, b.colors);
  assert.deepEqual(a.radii, b.radii);
  assert.deepEqual(bonds(a), bonds(b));
  assert.equal(a.bonds.length / 2, 337);
  assert.deepEqual(
    a.atoms.map((a) => [a.name, a.element, a.residue, a.chain, a.sequence]),
    b.atoms.map((a) => [a.name, a.element, a.residue, a.chain, a.sequence]),
  );
  assert.equal(new Set(b.atoms.map((a) => JSON.stringify([a.chain, a.residueId, a.insertionCode]))).size, 46);
  assert.deepEqual(b.warnings, []);
});
test('CIF quotes, comments, semicolon fields, author ids, insertion codes, alternate locations and models', () => {
  const prefix = 'data_test\n_struct.title\n;A multiline\ncrystal title\n;\n# comment\n'.replace(/\n/g,'\r\n');
  const m = parseMMCIF(
    make(
      [
        "ATOM x1 C 'C A' ALA LONG 7 0 0 0 '7A' AUTH A A 1",
        "ATOM x2 C 'C A' ALA LONG 7 0.2 0 0 '7A' AUTH A B 1",
        "ATOM x3 N N ALA LONG 8 1.5 0 0 '7A' AUTH B . 1",
        "ATOM x4 N N ALA LONG 8 999 0 0 '7A' AUTH B . 2",
      ],
      prefix,
    ),
  );
  assert.equal(m.title, 'A multiline\ncrystal title');
  assert.equal(m.atoms.length, 2);
  assert.equal(m.atoms[0].id, 'x1');
  assert.equal(m.atoms[0].residueId, '7A');
  assert.equal(m.atoms[0].chain, 'AUTH');
  assert.equal(m.atoms[0].sequence, 7);
  assert.equal(m.atoms[0].insertionCode, 'A');
  assert.equal(m.atoms[1].insertionCode, 'B');
  assert.equal(m.atoms[0].alternateLocation, 'A');
  assert.deepEqual([...m.bonds], [0, 1]);
  assert.ok(m.warnings.includes('only the first MODEL is read'));
  const blocks =
    make(['ATOM 1 C C ALA A 1 0 0 0 1 A ? . 1']) + make(['ATOM 2 O O HOH B 1 9 0 0 1 B ? . 1'], 'data_other\n');
  assert.equal(parseMMCIF(blocks).atoms[0].element, 'C');
  assert.equal(parseMMCIF(blocks, { block: 'OTHER' }).atoms[0].element, 'O');
  const literal=parseMMCIF(make(["ATOM 1 C C ALA A 1 0 0 0 '.' '?' ? . 1"],"data_literal\n_struct.title '?'\n"));
  assert.equal(literal.title,'?');assert.equal(literal.atoms[0].residueId,'.');assert.equal(literal.atoms[0].chain,'?');
});
test('explicit identity struct_conn bonds survive disabled inference, symmetry mates do not join the asymmetric unit', () => {
  let text = make(['ATOM 1 S SG CYS A 1 0 0 0 1 A ? . 1', 'ATOM 2 S SG CYS A 2 20 0 0 2 A ? . 1']);
  text +=
    'loop_\n' +
    [
      'conn_type_id',
      'ptnr1_label_asym_id',
      'ptnr1_label_seq_id',
      'ptnr1_label_comp_id',
      'ptnr1_label_atom_id',
      'ptnr2_label_asym_id',
      'ptnr2_label_seq_id',
      'ptnr2_label_comp_id',
      'ptnr2_label_atom_id',
      'ptnr1_symmetry',
      'ptnr2_symmetry',
    ]
      .map((t) => '_struct_conn.' + t)
      .join('\n') +
    '\ndisulf A 1 CYS SG A 2 CYS SG 1_555 1_555\n';
  assert.deepEqual([...parseMMCIF(text, { guessBonds: false }).bonds], [0, 1]);
  const m = parseMMCIF(text.replace('1_555 1_555', '1_555 2_555'), { guessBonds: false });
  assert.equal(m.bonds.length, 0);
  assert.ok(m.warnings.some((w) => w.includes('symmetry')));
});
test('malformed CIF rows, numeric values, size limits and incomplete quotes fail with coded errors', () => {
  const row = 'ATOM 1 C C ALA A 1 0 0 0 1 A ? . 1';
  for (const value of [
    make([row.slice(0, -2)]),
    make([row.replace(' 0 0 0 ', ' NaN 0 0 ')]),
    "data_a\n_struct.title 'broken",
    'data_a\n_struct.title\n;broken',
    header,
    'data_a\nloop_\n_atom_site.id\n_atom_site.id\n1 1',
  ])
    assert.throws(
      () => parseMMCIF(value),
      (e) => e.format === 'mmCIF' && e.code === 'syntax',
    );
  assert.throws(
    () => parseMMCIF(make([row]), { maxVertices: 0 }),
    (e) => e.code === 'limit',
  );
});
test('PDB insertion codes and selected alternate locations are retained for residue picking', () => {
  const line = 'ATOM      1  CA AALA A   7B      1.000   2.000   3.000  1.00  0.00           C';
  const m = parsePDB(line);
  assert.equal(m.atoms[0].insertionCode, 'B');
  assert.equal(m.atoms[0].alternateLocation, 'A');
});
