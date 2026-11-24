import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { IfcAPI } from 'web-ifc';
import { openIFC } from '../dist/index.js';
import { readIFCData } from '../dist/data.js';
import {
  findElements,
  groupElements,
  effectivePredefinedType,
  ancestorsOf,
  descendantsOf,
  nearlyEqual,
  isSubtypeOf,
  subtypesOf,
  supertypesOf,
} from '../dist/query.js';

const api = new IfcAPI();
await api.Init();
const model = openIFC(api, new Uint8Array(await readFile(new URL('./fixtures/building.ifc', import.meta.url))));
const data = readIFCData(model);
model.close();

test('findElements by class, storey, type object, name, GlobalId, material and classification', () => {
  assert.deepEqual(findElements(data, { type: 'IFCWINDOW' }), [60, 61, 62]);
  assert.deepEqual(findElements(data, { type: ['IfcWall', 'IfcWindow'], storey: 'Level 1' }), [25, 60, 61, 62]);
  assert.deepEqual(findElements(data, { storey: 40, type: 'IfcSpace' }), [45]);
  assert.deepEqual(findElements(data, { typeObject: 'Concrete 200' }), [25]);
  assert.deepEqual(findElements(data, { typeObject: 80 }), [25]);
  assert.deepEqual(findElements(data, { name: /^Window [AB]$/ }), [60, 61]);
  assert.deepEqual(findElements(data, { globalId: '3vB7J2KqH0kR1hxtVXtD$Q' }), [62]);
  assert.deepEqual(findElements(data, { material: 'Insulation' }), [25]);
  assert.deepEqual(findElements(data, { material: 'glass' }), [60, 61, 62]);
  assert.deepEqual(findElements(data, { classification: { system: /Uniclass/, code: 'EF_25_10' } }), [25]);
  assert.deepEqual(findElements(data, { within: 32, type: 'IfcWall' }), [25]);
  assert.deepEqual(findElements(data, { type: 'IfcWallType' }), []);
  assert.deepEqual(findElements(data, { type: 'IfcWallType', occurrencesOnly: false }), [80]);
});

test('findElements property conditions compare SI values with the IDS tolerance, type properties included', () => {
  assert.deepEqual(findElements(data, { where: [{ set: 'Pset_WallCommon', name: 'FireRating', value: '1HR' }] }), [25]);
  assert.deepEqual(findElements(data, { where: [{ name: 'IsExternal', value: true }] }), [25]);
  assert.deepEqual(findElements(data, { where: [{ name: 'Width', op: '=', value: 0.2 }] }), [25]);
  assert.deepEqual(findElements(data, { where: [{ name: 'Width', op: '=', value: 0.2000001 }] }), [25]);
  assert.deepEqual(findElements(data, { where: [{ name: 'Width', op: '<', value: 0.2 }] }), []);
  assert.deepEqual(findElements(data, { where: [{ name: 'NetSideArea', op: '>=', value: 12 }] }), [25]);
  assert.deepEqual(findElements(data, { where: [{ name: 'Status', value: 'NEW' }] }), [60, 61, 62]);
  assert.deepEqual(findElements(data, { where: [{ name: /Thermal/, op: '<=', value: 1.5 }] }), [60, 61, 62]);
  assert.deepEqual(findElements(data, { where: [{ name: 'FireRating', op: 'contains', value: 'hr' }] }), [25]);
  assert.deepEqual(findElements(data, { type: 'IfcWindow', where: [{ name: 'FireRating', op: 'missing' }] }), [60, 61, 62]);
  assert.deepEqual(findElements(data, { where: [{ name: 'FireRating', op: 'matches', value: '^[0-9]HR$' }] }), [25]);
  assert.ok(nearlyEqual(-10.000005, -10) && !nearlyEqual(-10.0001, -10) && !nearlyEqual(0.0000011, 0));
  // Negative targets get the same band as positive ones, v -/+ (|v| 1e-6 + 1e-6): -1 equals itself and -1.0000015.
  assert.ok(nearlyEqual(-1, -1) && nearlyEqual(-1.0000015, -1) && nearlyEqual(-0.9999985, -1) && !nearlyEqual(-1.0000021, -1));
  assert.ok(nearlyEqual(-10.00001, -10) && nearlyEqual(-9.99999, -10) && !nearlyEqual(-10.0000111, -10));
});

test('effective predefined types, ancestors, descendants and classifier groups', () => {
  assert.equal(effectivePredefinedType(data, 25), 'SOLIDWALL');
  assert.equal(effectivePredefinedType(data, 60), 'WINDOW');
  // USERDEFINED takes the occurrence's ObjectType when it has one; this window has none.
  assert.equal(effectivePredefinedType(data, 62), 'USERDEFINED');
  assert.deepEqual(findElements(data, { predefinedType: 'solidwall' }), [25]);
  assert.deepEqual(ancestorsOf(data, 25), [40, 32, 30, 1]);
  assert.deepEqual(descendantsOf(data, 32), [25, 40, 45, 60, 61, 62]);
  assert.deepEqual([...groupElements(data, 'type')], [
    ['IfcProject', [1]],
    ['IfcWall', [25]],
    ['IfcSite', [30]],
    ['IfcBuilding', [32]],
    ['IfcBuildingStorey', [40]],
    ['IfcSpace', [45]],
    ['IfcWindow', [60, 61, 62]],
  ]);
  assert.deepEqual(groupElements(data, 'storey', [25, 60, 30]), new Map([['Level 1', [25, 60]], ['', [30]]]));
  assert.deepEqual(groupElements(data, 'material', [25, 60]), new Map([['Concrete', [25]], ['Insulation', [25]], ['Glass', [60]]]));
  assert.deepEqual(groupElements(data, { set: 'Pset_WallCommon', name: 'IsExternal' }, [25, 60]), new Map([['true', [25]], ['', [60]]]));
  assert.deepEqual(groupElements(data, 'typeObject', [25]), new Map([['Concrete 200', [25]]]));
});

test('class filters match subtypes by the schema inheritance, or the exact class with subtypes: false', () => {
  // IFC4: IfcBuildingElement is the abstract parent of walls and windows; spatial classes share IfcSpatialStructureElement.
  assert.deepEqual(findElements(data, { type: 'IfcBuildingElement' }), [25, 60, 61, 62]);
  assert.deepEqual(findElements(data, { type: 'IfcSpatialStructureElement' }), [30, 32, 40, 45]);
  assert.deepEqual(findElements(data, { type: 'IfcBuildingElement', subtypes: false }), []);
  assert.deepEqual(findElements(data, { type: 'IfcElementType', occurrencesOnly: false }), [80]);
  // IFC2X3: the fixture's wall is an IfcWallStandardCase, which an IfcWall filter finds.
  const feet = openIFC(api, new Uint8Array(readFileSync(new URL('./fixtures/feet-2x3.ifc', import.meta.url))));
  const old = readIFCData(feet);
  feet.close();
  assert.equal(old.elements.get(30).type, 'IfcWallStandardCase');
  assert.deepEqual(findElements(old, { type: 'IfcWall' }), [30]);
  assert.deepEqual(findElements(old, { type: 'ifcwall', subtypes: false }), []);
  assert.deepEqual(findElements(old, { type: 'IfcWallStandardCase', subtypes: false }), [30]);
  // Each schema's own tree: IFC4X3 renames the parent to IfcBuiltElement and puts IfcBuilding under IfcFacility.
  assert.ok(isSubtypeOf('IFC4X3', 'IfcWallStandardCase', 'IfcBuiltElement'));
  assert.ok(!isSubtypeOf('IFC4', 'IfcWall', 'IfcBuiltElement'));
  assert.ok(isSubtypeOf('IFC4X3_ADD2', 'IFCBUILDING', 'IfcFacility') && !isSubtypeOf('IFC4', 'IfcBuilding', 'IfcFacility'));
  assert.ok(isSubtypeOf('IFC2X3', 'IfcUnknownClass', 'IFCUNKNOWNCLASS') && !isSubtypeOf('IFC2X3', 'IfcUnknownClass', 'IfcProduct'));
  // IFC2X3 models follow the IFC4 tree for the classes both schemas share.
  assert.deepEqual(supertypesOf('IFC2X3', 'IfcWallStandardCase'), [
    'IfcWall',
    'IfcBuildingElement',
    'IfcElement',
    'IfcProduct',
    'IfcObject',
    'IfcObjectDefinition',
  ]);
  assert.deepEqual(subtypesOf('IFC4', 'IfcWall'), ['IfcWallElementedCase', 'IfcWallStandardCase']);
  assert.deepEqual(subtypesOf('IFC2X3', 'IfcWall'), ['IfcWallElementedCase', 'IfcWallStandardCase']);
  assert.ok(subtypesOf('IFC4X3', 'IfcBuiltElement').includes('IfcWallStandardCase'));
});

test('no IFC2X3 schema data ships: IFC2X3 models use the IFC4 tree, and IFC2X3-only classes match exactly', async () => {
  // The IFC2X3 TC1 EXPRESS file reserves all rights, so the package holds nothing derived from it.
  const dist = new URL('../dist/', import.meta.url);
  for (const file of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
    const shipped = readFileSync(new URL(file, dist), 'utf8');
    for (const only2x3 of ['ElectricalElement', 'EquipmentElement', 'BuildingElementComponent', 'GasTerminalType', 'IFC2X3_TREE'])
      assert.ok(!shipped.includes(only2x3), `dist/${file} holds the IFC2X3-only name ${only2x3}`);
  }
  assert.ok(!isSubtypeOf('IFC2X3', 'IfcElectricalElement', 'IfcElement'));
  assert.ok(isSubtypeOf('IFC2X3', 'IfcElectricalElement', 'IFCELECTRICALELEMENT'));
  assert.deepEqual(supertypesOf('IFC2X3', 'IfcElectricalElement'), []);
  // An IFC2X3 model's subtype query: the wall (an IfcWallStandardCase) is a building element and a product.
  const feet = openIFC(api, new Uint8Array(readFileSync(new URL('./fixtures/feet-2x3.ifc', import.meta.url))));
  const old = readIFCData(feet);
  feet.close();
  assert.equal(old.schema, 'IFC2X3');
  assert.deepEqual(findElements(old, { type: 'IfcBuildingElement' }), [30]);
  assert.ok(findElements(old, { type: 'IfcProduct' }).includes(30));
});

test('a USERDEFINED process or resource type resolves to its ProcessType or ResourceType', () => {
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCTASKTYPE('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,'TASKY',.USERDEFINED.,$);",
    "#2=IFCCONSTRUCTIONEQUIPMENTRESOURCETYPE('0eA6m4fELI9QBIhP3wiLAp',$,$,$,$,$,$,$,'CRANEY',$,$,.USERDEFINED.);",
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
  const model = openIFC(api, new TextEncoder().encode(step));
  const tasks = readIFCData(model);
  model.close();
  assert.equal(tasks.elements.get(1).elementType, 'TASKY');
  assert.equal(effectivePredefinedType(tasks, 1), 'TASKY');
  assert.equal(tasks.elements.get(2).elementType, 'CRANEY');
  assert.equal(effectivePredefinedType(tasks, 2), 'CRANEY');
});

test("an IFC2X3 model's class filter follows the open runtime's inheritance for IFC2X3-only classes", () => {
  const step = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','2026-11-16T00:00:00',(),(),'','','');",
    "FILE_SCHEMA(('IFC2X3'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCREINFORCINGBAR('2GRxkn9cv1ARqsCRbeAZOv',$,'Bar',$,$,$,$,$,'B500',0.012,$,1.,.MAIN.,.TEXTURED.);",
    "#2=IFCELECTRICALELEMENT('0KbkTRUr9AIBRgD7WOV8v1',$,'Panel',$,$,$,$,$);",
    "#3=IFCCHAMFEREDGEFEATURE('3aJ3gfHvH1Ifu9eDFqsYbZ',$,'Chamfer',$,$,$,$,$,0.5,0.01,0.01);",
    "#4=IFCWALLSTANDARDCASE('1wQ5Tj1k98QxUq6P0xGWcK',$,'Wall',$,$,$,$,$);",
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
  const model = openIFC(api, new TextEncoder().encode(step));
  // Count the runtime lookups readIFCData makes, to hold the inheritance pass to one inherited lookup per entity type.
  const entities = api.GetIfcEntityList(model.id).length;
  const lookups = api.GetLineIDsWithType;
  let calls = 0;
  api.GetLineIDsWithType = (...args) => (calls++, lookups.apply(api, args));
  let old;
  try {
    old = readIFCData(model);
  } finally {
    api.GetLineIDsWithType = lookups;
    model.close();
  }
  assert.ok(old.inheritance instanceof Map);
  assert.ok(calls <= entities + 40, `${calls} lookups for ${entities} entity types`);
  // IFC2X3 chains a reinforcing bar under IfcBuildingElementComponent and IfcBuildingElement, unlike IFC4.
  assert.deepEqual(findElements(old, { type: 'IfcBuildingElementComponent' }), [1]);
  assert.deepEqual(findElements(old, { type: 'IfcBuildingElement' }), [1, 4]);
  assert.deepEqual(findElements(old, { type: 'IfcElementComponent' }), []);
  assert.deepEqual(findElements(old, { type: 'ifcelement' }), [1, 2, 3, 4]);
  assert.deepEqual(findElements(old, { type: 'IfcElectricalElement' }), [2]);
  assert.deepEqual(findElements(old, { type: ['IfcEdgeFeature', 'IfcWall'] }), [3, 4]);
  assert.deepEqual(findElements(old, { type: 'IfcFeatureElementSubtraction' }), [3]);
  assert.deepEqual(findElements(old, { type: 'IfcBuildingElement', subtypes: false }), []);
  assert.ok(isSubtypeOf(old, 'IfcReinforcingBar', 'IfcBuildingElementComponent'));
  assert.ok(!isSubtypeOf('IFC2X3', 'IfcReinforcingBar', 'IfcBuildingElementComponent'));
  // The record is per model and structured-cloneable; IFC4 and IFC4X3 data use their shipped trees instead.
  assert.deepEqual(structuredClone(old.inheritance), old.inheritance);
  assert.equal(data.inheritance, undefined);
});
