import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { openIFC } from '../dist/index.js';
import { readIFCData } from '../dist/data.js';
import { parseIDS, writeIDS, checkIDS, bcfTopicsFromIDS } from '../dist/ids.js';
import { readBCF, writeBCF } from '../dist/bcf.js';

const api = new IfcAPI();
await api.Init();
const root = new URL('./fixtures/ids/', import.meta.url);
const folders = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const cases = folders.flatMap((folder) =>
  readdirSync(new URL(`${folder}/`, root))
    .filter((f) => f.endsWith('.ids'))
    .sort()
    .map((f) => ({ folder, name: f.slice(0, -4), expect: f.split('-')[0] })),
);

function run({ folder, name }) {
  const ids = parseIDS(readFileSync(new URL(`${folder}/${name}.ids`, root)));
  using model = openIFC(api, new Uint8Array(readFileSync(new URL(`${folder}/${name}.ifc`, root))));
  return checkIDS(model, ids);
}

test('the buildingSMART IDS 1.0 test cases: every pass case passes, every fail and invalid case fails', () => {
  assert.equal(cases.length, 334);
  const wrong = [];
  for (const c of cases) {
    let pass;
    try {
      pass = run(c).pass;
    } catch (error) {
      // An invalid IDS may also be refused while reading it.
      if (c.expect === 'invalid' && error.code === 'syntax') continue;
      throw error;
    }
    if (pass !== (c.expect === 'pass')) wrong.push(`${c.folder}/${c.name}`);
  }
  assert.deepEqual(wrong, []);
});

test('writeIDS writes what parseIDS reads back unchanged, for every test case document', () => {
  for (const c of cases) {
    let ids;
    try {
      ids = parseIDS(readFileSync(new URL(`${c.folder}/${c.name}.ids`, root), 'utf8'));
    } catch {
      continue;
    }
    assert.deepEqual(parseIDS(writeIDS(ids)), ids, `${c.folder}/${c.name}`);
  }
});

test('a report names each applicable entity, what passed and why each requirement failed', async () => {
  const ids = parseIDS(`<?xml version="1.0"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Walls</title></info>
  <specifications>
    <specification name="Fire rated walls" ifcVersion="IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <property dataType="IFCLABEL"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><xs:restriction base="xs:string"><xs:enumeration value="2HR"/><xs:enumeration value="3HR"/></xs:restriction></value></property>
        <attribute><name><simpleValue>Tag</simpleValue></name></attribute>
      </requirements>
    </specification>
    <specification name="Only in IFC2X3" ifcVersion="IFC2X3">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
    </specification>
  </specifications>
</ids>`);
  using model = openIFC(api, new Uint8Array(readFileSync(new URL('./fixtures/building.ifc', import.meta.url))));
  const data = readIFCData(model);
  const report = checkIDS(model, ids, { data });
  assert.equal(report.pass, false);
  assert.equal(report.schema, 'IFC4');
  const [walls, other] = report.specifications;
  assert.deepEqual(walls.applicable, [25]);
  assert.deepEqual(walls.passed, []);
  assert.equal(walls.status, 'fail');
  assert.deepEqual(walls.failures, [
    {
      id: 25,
      type: 'IfcWall',
      globalId: '1kTvXnbbzCWw8lcMd1dR4o',
      name: data.elements.get(25).name,
      requirement: 0,
      reason: 'Pset_WallCommon.FireRating is 1HR, expected one of 2HR, 3HR',
    },
  ]);
  // The failures travel as BCF: one topic per failed specification, the failing wall selected, one comment each.
  const topics = bcfTopicsFromIDS(report, { author: 'checker@example.com', date: '2026-11-16T12:00:00Z' });
  assert.equal(topics.length, 1);
  const back = (await readBCF(writeBCF({ topics }, { version: '2.1' }))).topics[0];
  assert.equal(back.title, 'IDS: Fire rated walls');
  assert.deepEqual(back.labels, ['IDS']);
  assert.match(back.description, /1 of 1 applicable entities fail/);
  assert.deepEqual(back.viewpoints[0].selection, [{ ifcGuid: '1kTvXnbbzCWw8lcMd1dR4o' }]);
  assert.equal(back.comments.length, 1);
  assert.match(
    back.comments[0].comment,
    /^.+ \(1kTvXnbbzCWw8lcMd1dR4o\): Pset_WallCommon.FireRating is 1HR, expected one of 2HR, 3HR$/,
  );
  assert.equal(back.comments[0].viewpoint, back.viewpoints[0].guid);
  assert.throws(() => bcfTopicsFromIDS(report, {}), { code: 'range', message: /author/ });
  const camera = {
    type: 'perspective',
    position: [10, -10, 8],
    direction: [-0.6, 0.6, -0.5],
    up: [0, 0, 1],
    fieldOfView: 60,
    aspectRatio: 1.5,
  };
  const v3 = (await readBCF(writeBCF({ topics: bcfTopicsFromIDS(report, { author: 'checker@example.com', camera }) })))
    .topics[0];
  assert.deepEqual(v3.viewpoints[0].camera.position, [10, -10, 8]);
  // A specification for another schema is still checked, with a warning.
  assert.equal(other.status, 'pass');
  assert.deepEqual(other.applicable, [25]);
  assert.deepEqual(other.warnings, ['the model is IFC4; the specification is written for IFC2X3']);
  assert.deepEqual(walls.warnings, []);
});

test('IDS errors are coded: malformed XML, a missing title, a closed model, an aborted check', () => {
  assert.throws(() => parseIDS('<ids'), { code: 'syntax' });
  assert.throws(() => parseIDS('<ids xmlns="http://standards.buildingsmart.org/IDS"><info/><specifications/></ids>'), {
    code: 'syntax',
    message: /title/,
  });
  assert.throws(() => parseIDS('<other/>'), { code: 'syntax', message: /not an IDS/ });
  assert.throws(() => parseIDS(42), { code: 'range' });
  const ids = parseIDS(readFileSync(new URL('ids/pass-a_minimal_ids_can_check_a_minimal_ifc_2_2.ids', root)));
  const model = openIFC(
    api,
    new Uint8Array(readFileSync(new URL('ids/pass-a_minimal_ids_can_check_a_minimal_ifc_2_2.ifc', root))),
  );
  assert.throws(() => checkIDS(model, ids, { signal: AbortSignal.abort() }), { code: 'aborted' });
  model.close();
  assert.throws(() => checkIDS(model, ids), { code: 'range', message: /closed/ });
});
