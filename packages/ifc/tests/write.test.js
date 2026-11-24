import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcAPI } from 'web-ifc';
import { openIFC } from '../dist/index.js';
import { readIFCData, propertyOf, propertiesOf } from '../dist/data.js';
import { editIFC, saveIFC, newIFCGuid, ifcGuidFromUUID, uuidFromIFCGuid } from '../dist/write.js';

const api = new IfcAPI();
await api.Init();
const bytes = async (name) => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
const NOW = new Date('2026-11-16T12:00:00Z');
const STAMP = Math.floor(NOW.getTime() / 1000);
const code = (error, c) => error?.code === c;

/** Reopens saved bytes in a fresh web-ifc and checks the file: every reference resolves, GUIDs are valid and unique. */
async function reopen(saved) {
  const fresh = new IfcAPI();
  await fresh.Init();
  const model = openIFC(fresh, saved);
  const textLines = new Map();
  for (const m of new TextDecoder().decode(saved).matchAll(/^#(\d+)=(.*);\r?$/gm)) textLines.set(Number(m[1]), m[2]);
  for (const [id, line] of textLines)
    for (const r of line.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#(\d+)/g))
      assert.ok(textLines.has(Number(r[1])), `#${id} refers to #${r[1]}, which is not in the file`);
  const roots = fresh.GetLineIDsWithType(model.id, fresh.GetTypeCodeFromName('IFCROOT'), true);
  const guids = new Set();
  for (let i = 0; i < roots.size(); i++) {
    const l = fresh.GetLine(model.id, roots.get(i));
    assert.match(l.GlobalId.value, /^[0-3][0-9A-Za-z_$]{21}$/);
    assert.ok(!guids.has(l.GlobalId.value), `GlobalId ${l.GlobalId.value} is unique`);
    guids.add(l.GlobalId.value);
    if (model.schema === 'IFC2X3') assert.equal(typeof l.OwnerHistory?.value, 'number', `#${l.expressID} has an owner history`);
  }
  return { model, data: readIFCData(model), textLines, api: fresh };
}

test('IFC GUIDs: the 128-bit number in base 64, first digit 0 to 3, and back', () => {
  assert.equal(ifcGuidFromUUID('00000000-0000-0000-0000-000000000000'), '0'.repeat(22));
  assert.equal(ifcGuidFromUUID('ffffffff-ffff-ffff-ffff-ffffffffffff'), `3${'$'.repeat(21)}`);
  // 2^64 is 1 followed by 64 zero bits: base-64 digit 1 at position 64 / 6 = 10 r 4, so 16 (G) eleven places from the end.
  assert.equal(ifcGuidFromUUID('00000000-0000-0001-0000-000000000000'), `${'0'.repeat(11)}G${'0'.repeat(10)}`);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const guid = newIFCGuid();
    assert.match(guid, /^[0-3][0-9A-Za-z_$]{21}$/);
    const uuid = uuidFromIFCGuid(guid);
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(ifcGuidFromUUID(uuid), guid);
    seen.add(guid);
  }
  assert.equal(seen.size, 1000);
  // web-ifc's own generator encodes the same way.
  const model = api.CreateModel({ schema: 'IFC4' });
  const theirs = api.CreateIFCGloballyUniqueId(model).value;
  assert.equal(ifcGuidFromUUID(uuidFromIFCGuid(theirs)), theirs);
  api.CloseModel(model);
  assert.throws(() => uuidFromIFCGuid('4' + '0'.repeat(21)), (e) => code(e, 'range'));
  assert.throws(() => ifcGuidFromUUID('not a uuid'), (e) => code(e, 'range'));
});

/**
 * Whether a STEP text holds a real with no decimal point before its exponent (1E-07), outside quoted strings: a
 * GlobalId is 22 base-64 characters and may hold "9E8" by chance (a new property set's id once did).
 */
const bareExponent = (text) => /[0-9]E[-+]?[0-9]/.test(text.replace(/'(?:[^']|'')*'/g, "''"));

test('the bare exponent check reads numbers, not the letters of a GlobalId', () => {
  assert.equal(bareExponent("#128=IFCPROPERTYSET('11BXCSfCT9E8M3x6tM1v14',$,'Pset_Custom',$,(#127));"), false);
  assert.equal(bareExponent("#131=IFCPROPERTYSINGLEVALUE('Tiny',$,IFCREAL(1E-07),$);"), true);
  assert.equal(bareExponent("#131=IFCPROPERTYSINGLEVALUE('Tiny',$,IFCREAL(1.E-07),$);"), false);
});

test('IFC4: set, add and remove properties and quantities; rename; attributes; round trip through SaveModel', async () => {
  using model = openIFC(api, await bytes('building.ifc'));
  const before = readIFCData(model);
  const edit = editIFC(model, { now: NOW });
  // A plain number keeps the property's measure type and is SI: 0.25 m in a millimetre project is 250.
  edit.setProperty(25, 'Pset_WallCommon', 'Width', 0.25);
  edit.setProperty(25, 'Pset_WallCommon', 'AcousticRating', 'Rw 52');
  edit.setProperty(25, 'Pset_WallCommon', 'Combustible', false);
  edit.setProperty(25, 'Pset_WallCommon', 'Height', { type: 'IfcLengthMeasure', value: 2.7 });
  edit.setProperty(25, 'Pset_Custom', 'WindLoad', { type: 'IfcPressureMeasure', value: 1500, unit: 'kPa' });
  edit.setProperty(25, 'Pset_Custom', 'Layers', [1, 2, 3]);
  edit.setProperty(25, 'Pset_Custom', 'Tiny', 1e-7);
  edit.setProperty(25, 'Pset_Custom', 'Count', { type: 'IfcInteger', raw: 12 });
  assert.equal(edit.removeProperty(25, 'Pset_WallCommon', 'LoadBearing'), true);
  assert.equal(edit.removeProperty(25, 'Pset_WallCommon', 'NoSuch'), false);
  edit.setQuantity(25, 'Qto_WallBaseQuantities', 'Length', 5);
  edit.setQuantity(25, 'Qto_WallBaseQuantities', 'GrossFootprintArea', { kind: 'area', value: 1.2, formula: 'Length * Width' });
  edit.removeQuantity(25, 'Qto_WallBaseQuantities', 'Openings');
  edit.rename(25, 'Renamed wall');
  edit.setAttribute(25, 'Description', 'Edited in a test');
  edit.setAttribute(25, 'PredefinedType', 'PARTITIONING');
  edit.setAttribute(25, 'Tag', 'W-02');
  // Pset_WindowCommon is shared by windows 60, 61 and 62: editing 60 copies it, removing it from 61 detaches only 61.
  edit.setProperty(60, 'Pset_WindowCommon', 'Status', 'EXISTING');
  edit.setProperty(60, 'Pset_WindowCommon', 'ThermalTransmittance', 1.1);
  assert.equal(edit.removePropertySet(61, 'Pset_WindowCommon'), true);
  assert.equal(edit.removePropertySet(61, 'Pset_WindowCommon'), false);
  // The type's set: editing the type object changes it for every occurrence.
  edit.setProperty(80, 'Pset_WallCommon', 'FireRating', '2HR');

  const check = (data) => {
    const wall = (set, name) => propertyOf(data, 25, set, name);
    assert.deepEqual([wall('Pset_WallCommon', 'Width').raw, wall('Pset_WallCommon', 'Width').value], [250, 0.25]);
    assert.equal(wall('Pset_WallCommon', 'Width').dataType, 'IFCPOSITIVELENGTHMEASURE');
    assert.deepEqual([wall('Pset_WallCommon', 'AcousticRating').value, wall('Pset_WallCommon', 'AcousticRating').dataType], ['Rw 52', 'IFCLABEL']);
    assert.deepEqual([wall('Pset_WallCommon', 'Combustible').value, wall('Pset_WallCommon', 'Combustible').dataType], [false, 'IFCBOOLEAN']);
    assert.deepEqual([wall('Pset_WallCommon', 'Height').raw, wall('Pset_WallCommon', 'Height').value], [2700, 2.7]);
    assert.deepEqual([wall('Pset_Custom', 'WindLoad').raw, wall('Pset_Custom', 'WindLoad').value, wall('Pset_Custom', 'WindLoad').unit], [1.5, 1500, 'Pa']);
    assert.deepEqual([wall('Pset_Custom', 'Layers').kind, wall('Pset_Custom', 'Layers').value], ['list', [1, 2, 3]]);
    assert.equal(wall('Pset_Custom', 'Tiny').value, 1e-7);
    assert.deepEqual([wall('Pset_Custom', 'Count').value, wall('Pset_Custom', 'Count').dataType], [12, 'IFCINTEGER']);
    assert.equal(wall('Pset_WallCommon', 'LoadBearing'), undefined);
    assert.equal(wall('Pset_WallCommon', 'IsExternal').value, true);
    assert.deepEqual([wall('Qto_WallBaseQuantities', 'Length').raw, wall('Qto_WallBaseQuantities', 'Length').value], [5000, 5]);
    assert.deepEqual([wall('Qto_WallBaseQuantities', 'GrossFootprintArea').value, wall('Qto_WallBaseQuantities', 'GrossFootprintArea').dataType], [1.2, 'IFCQUANTITYAREA']);
    assert.equal(wall('Qto_WallBaseQuantities', 'Openings'), undefined);
    const element = data.elements.get(25);
    assert.deepEqual([element.name, element.description, element.predefinedType, element.tag], ['Renamed wall', 'Edited in a test', 'PARTITIONING', 'W-02']);
    assert.equal(element.globalId, '1kTvXnbbzCWw8lcMd1dR4o');
    // The occurrence's set still overrides the type's, and the type's edit reaches it.
    assert.equal(propertiesOf(data, 25).Pset_WallCommon.FireRating.value, '2HR');
    assert.deepEqual(propertyOf(data, 60, 'Pset_WindowCommon', 'Status').value, ['EXISTING']);
    assert.equal(propertyOf(data, 60, 'Pset_WindowCommon', 'ThermalTransmittance').value, 1.1);
    assert.deepEqual(propertyOf(data, 62, 'Pset_WindowCommon', 'Status').value, ['NEW']);
    assert.equal(propertyOf(data, 62, 'Pset_WindowCommon', 'ThermalTransmittance').value, 1.4);
    assert.equal(propertyOf(data, 61, 'Pset_WindowCommon', 'Status'), undefined);
    const window60 = data.elements.get(60).psets.find((s) => s.name === 'Pset_WindowCommon');
    const window62 = data.elements.get(62).psets.find((s) => s.name === 'Pset_WindowCommon');
    assert.equal(window62.globalId, '3qSq1d9tL7nPGrWwI4Hc0b');
    assert.notEqual(window60.globalId, window62.globalId);
    assert.match(window60.globalId, /^[0-3][0-9A-Za-z_$]{21}$/);
    // What was not edited reads the same.
    assert.deepEqual(data.spatial, before.spatial);
    assert.deepEqual(data.georeference, before.georeference);
    assert.deepEqual(data.elements.get(30), before.elements.get(30));
  };
  check(readIFCData(model));
  const saved = saveIFC(model);
  const text = new TextDecoder().decode(saved);
  // ISO 10303-21 reals need their decimal point; web-ifc writes 1E-07.
  assert.match(text, /IFCREAL\(1\.E-07\)/);
  assert.equal(bareExponent(text), false);
  const { data, textLines, model: again } = await reopen(saved);
  check(data);
  // An IFC4 file without owner histories gets none: its new property set has OwnerHistory $.
  const created = data.elements.get(25).psets.find((s) => s.name === 'Pset_Custom');
  assert.match(textLines.get(created.id), /^IFCPROPERTYSET\('[^']{22}',\$,'Pset_Custom',\$,\(/);
  for (const id of edit.created) assert.doesNotMatch(textLines.get(id).replace(/'(?:[^']|'')*'/g, "''").replace(/^IFCSIUNIT\(\*,/, ''), /\*/, `#${id} has no derived (*) value but IfcSIUnit.Dimensions`);
  for (const id of edit.deleted) assert.equal(textLines.has(id), false, `#${id} was deleted`);
  assert.ok(edit.deleted.includes(87), 'the removed LoadBearing property is deleted');
  again.close();
});

test('IFC2X3: owner histories, copy on write of a shared set, enumerations and the editing application', async () => {
  using model = openIFC(api, await bytes('edit-2x3.ifc'));
  const edit = editIFC(model, {
    now: NOW,
    application: { name: 'Fixture Editor', version: '2.0', identifier: 'fixture-editor', developer: 'Fixture Org' },
  });
  // Pset_WallCommon is shared by Wall A (#40) and Wall B (#41).
  edit.setProperty(40, 'Pset_WallCommon', 'FireRating', 'REI90');
  edit.setProperty(40, 'Pset_WallCommon', 'Status', 'EXISTING');
  edit.setProperty(40, 'Pset_WallCommon', 'Temperature', { type: 'IfcThermodynamicTemperatureMeasure', value: 293.15, unit: 'degC' });
  edit.setQuantity(40, 'BaseQuantities', 'Length', 4.5);
  edit.rename(41, 'Wall B renamed');
  const saved = saveIFC(model);
  const { data, textLines, api: fresh, model: again } = await reopen(saved);
  assert.equal(propertyOf(data, 40, 'Pset_WallCommon', 'FireRating').value, 'REI90');
  assert.deepEqual([propertyOf(data, 40, 'Pset_WallCommon', 'Status').kind, propertyOf(data, 40, 'Pset_WallCommon', 'Status').value], ['enumerated', ['EXISTING']]);
  const temperature = propertyOf(data, 40, 'Pset_WallCommon', 'Temperature');
  assert.deepEqual([temperature.raw, temperature.value, temperature.unit], [20, 293.15, 'K']);
  assert.equal(propertyOf(data, 40, 'Pset_WallCommon', 'Width').value, 0.2);
  assert.equal(propertyOf(data, 41, 'Pset_WallCommon', 'FireRating').value, 'REI60');
  assert.deepEqual(propertyOf(data, 41, 'Pset_WallCommon', 'Status').value, ['NEW']);
  assert.equal(propertyOf(data, 41, 'Pset_WallCommon', 'Temperature'), undefined);
  assert.deepEqual([propertyOf(data, 40, 'BaseQuantities', 'Length').raw, propertyOf(data, 40, 'BaseQuantities', 'Length').value], [4500, 4.5]);
  assert.equal(data.elements.get(41).name, 'Wall B renamed');
  // Wall B keeps the original set and GUID; Wall A's copy has a new GUID and an ADDED history.
  const setOf = (id) => data.elements.get(id).psets.find((s) => s.name === 'Pset_WallCommon');
  assert.equal(setOf(41).globalId, '0Fw0kD8uP1Cfh4QsN2tW3a');
  assert.notEqual(setOf(40).globalId, setOf(41).globalId);
  const history = (id) => fresh.GetLine(again.id, fresh.GetLine(again.id, id).OwnerHistory.value);
  const added = history(setOf(40).id);
  assert.deepEqual([added.ChangeAction.value, added.CreationDate.value, added.LastModifiedDate.value], ['ADDED', STAMP, STAMP]);
  assert.equal(added.OwningUser.value, 3, 'the model user owns new entities');
  const app = fresh.GetLine(again.id, added.OwningApplication.value);
  assert.equal(app.ApplicationFullName.value, 'Fixture Editor');
  assert.equal(fresh.GetLine(again.id, app.ApplicationDeveloper.value).Name.value, 'Fixture Org');
  // The renamed wall's history is MODIFIED and keeps the owning user, application and creation date.
  const changed = history(41);
  assert.deepEqual([changed.ChangeAction.value, changed.OwningUser.value, changed.OwningApplication.value, changed.CreationDate.value], ['MODIFIED', 3, 4, 1700000000]);
  assert.deepEqual([changed.LastModifiedDate.value, changed.LastModifyingApplication.value], [STAMP, added.OwningApplication.value]);
  // The shared relationship now relates Wall B alone, and the untouched project keeps its original history.
  assert.match(textLines.get(53), /\(#41\),#52\)$/);
  assert.equal(fresh.GetLine(again.id, 23).OwnerHistory.value, 5);
  assert.match(textLines.get(5), /\.ADDED\.,\$,\$,\$,1700000000\)$/);
  again.close();
});

test('removing a property set deletes what nothing else uses; a shared one is only detached', async () => {
  using model = openIFC(api, await bytes('edit-2x3.ifc'));
  const edit = editIFC(model, { now: NOW });
  assert.equal(edit.removePropertySet(40, 'BaseQuantities'), true);
  assert.deepEqual(edit.deleted.sort((a, b) => a - b), [54, 55, 56]);
  assert.equal(edit.removePropertySet(40, 'Pset_WallCommon'), true);
  // web-ifc still lists deleted lines by type; a second editor and readIFCData on the edited model skip them.
  assert.equal(readIFCData(model).elements.get(40).psets.length, 0);
  editIFC(model, { now: NOW }).setQuantity(40, 'BaseQuantities', 'Length', { kind: 'length', value: 1 });
  assert.equal(editIFC(model, { now: NOW }).removePropertySet(40, 'BaseQuantities'), true);
  const { data } = await reopen(saveIFC(model));
  assert.deepEqual(data.elements.get(40).psets, []);
  assert.equal(propertyOf(data, 41, 'Pset_WallCommon', 'FireRating').value, 'REI60');
  // Removing the last property of a set removes the set.
  using second = openIFC(api, await bytes('edit-2x3.ifc'));
  const edit2 = editIFC(second, { now: NOW });
  edit2.removeQuantity(40, 'BaseQuantities', 'Length');
  assert.equal(readIFCData(second).elements.get(40).psets.some((s) => s.name === 'BaseQuantities'), false);
});

test('edits reject wrong input with coded errors and leave the model valid', async () => {
  using model = openIFC(api, await bytes('edit-2x3.ifc'));
  const edit = editIFC(model, { now: NOW });
  const range = (fn, pattern) => assert.throws(fn, (e) => code(e, 'range') && pattern.test(e.message));
  range(() => editIFC(model, { now: '2026-11-16' }), /valid Date/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcLengthMeasure', value: 1, unit: 'kg' }), /MASSUNIT/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcLengthMeasure', value: 1, unit: 'furlong' }), /unknown unit/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcPositiveLengthMeasure', value: -1 }), /above 0/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcInteger', raw: 1.5 }), /integer/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcLabel', value: 3 }), /not a valid IFCLABEL/);
  range(() => edit.setProperty(40, 'P', 'X', Number.NaN), /finite/);
  range(() => edit.setProperty(40, 'P', 'X', { type: 'IfcNoSuchMeasure', value: 1 }), /no defined type/);
  range(() => edit.setProperty(40, 'Pset_WallCommon', 'Status', 'UNKNOWNSTATE'), /not one of NEW, EXISTING, DEMOLISH/);
  range(() => edit.setProperty(10, 'P', 'X', 1), /not an object/);
  range(() => edit.setQuantity(40, 'BaseQuantities', 'Height', 3), /needs kind/);
  range(() => edit.setQuantity(40, 'BaseQuantities', 'Length', -1), /negative/);
  range(() => edit.setAttribute(40, 'ObjectPlacement', 'x'), /references/);
  range(() => edit.setAttribute(40, 'GlobalId', 'x'), /no attribute/);
  range(() => edit.setAttribute(30, 'CompositionType', 'not upper'), /enumeration/);
  range(() => edit.setAttribute(30, 'Elevation', null), /cannot be cleared/);
  assert.throws(() => edit.setQuantity(40, 'BaseQuantities', 'Length', { value: 1, formula: 'x' }), (e) => code(e, 'unsupported'));
  // A long string becomes IfcText; IfcLabel holds 255 characters.
  edit.setProperty(40, 'P', 'Long', 'x'.repeat(300));
  range(() => edit.setProperty(40, 'P', 'Label', { type: 'IfcLabel', value: 'x'.repeat(256) }), /255/);
  assert.equal(readIFCData(model).elements.get(40).psets.find((s) => s.name === 'P').properties.Long.dataType, 'IFCTEXT');
  await reopen(saveIFC(model));
  // saveIFC takes an AbortSignal and rejects closed models.
  assert.throws(() => saveIFC(model, { signal: AbortSignal.abort() }), (e) => code(e, 'aborted'));
  model.close();
  assert.throws(() => saveIFC(model), (e) => code(e, 'range'));
  assert.throws(() => editIFC(model), (e) => code(e, 'range'));
});
