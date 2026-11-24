import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcAPI } from 'web-ifc';
import { openIFC, readIFCGeometry } from '../dist/index.js';
import {
  readIFCData,
  propertiesOf,
  propertyOf,
  materialsOf,
  classificationsOf,
  modelToMap,
  mapToModel,
  engineToIFC,
  ifcToEngine,
} from '../dist/data.js';

const api = new IfcAPI();
await api.Init();
const bytes = async (name) => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('IFC4 data: attributes, occurrence and type property sets, quantities in SI, materials, classification', async () => {
  const model = openIFC(api, await bytes('building.ifc'));
  const data = readIFCData(model);
  assert.equal(data.schema, 'IFC4');
  assert.equal(data.units.byType.LENGTHUNIT.scale, 0.001);
  const wall = data.elements.get(25);
  assert.equal(wall.type, 'IfcWall');
  assert.equal(wall.tag, 'W-01');
  assert.equal(wall.predefinedType, 'STANDARD');
  assert.equal(wall.typeId, 80);
  assert.equal(wall.container, 40);
  assert.equal(wall.storey, 40);
  assert.equal(data.byGlobalId.get('1kTvXnbbzCWw8lcMd1dR4o'), 25);
  const width = propertyOf(data, 25, 'Pset_WallCommon', 'Width');
  assert.deepEqual([width.value, width.raw, width.unit, width.dataType], [0.2, 200, 'm', 'IFCPOSITIVELENGTHMEASURE']);
  // The occurrence's IsExternal overrides the type's; FireRating comes from the type.
  const merged = propertiesOf(data, 25).Pset_WallCommon;
  assert.equal(merged.IsExternal.value, true);
  assert.equal(merged.FireRating.value, '1HR');
  assert.equal(merged.LoadBearing.value, false);
  const qto = propertiesOf(data, 25).Qto_WallBaseQuantities;
  assert.deepEqual([qto.Length.value, qto.Length.unit, qto.Length.kind], [4, 'm', 'quantity']);
  assert.deepEqual([qto.NetSideArea.value, qto.NetSideArea.unit], [12, 'm2']);
  assert.deepEqual([qto.NetVolume.value, qto.NetVolume.unit], [2.4, 'm3']);
  assert.deepEqual([qto.Openings.value, qto.Openings.unit], [0, undefined]);
  assert.equal(wall.psets.find((s) => s.name === 'Qto_WallBaseQuantities').quantities, true);
  assert.deepEqual(materialsOf(data, 25), [
    { name: 'Concrete', category: 'concrete', kind: 'layer', part: 'Core', set: 'Wall 200', thickness: 0.15 },
    { name: 'Insulation', category: 'insulation', kind: 'layer', part: 'Insulation layer', set: 'Wall 200', thickness: 0.05 },
  ]);
  assert.deepEqual(classificationsOf(data, 25), [{ system: 'Uniclass 2015', code: 'EF_25_10', name: 'Walls' }]);
  const window = data.elements.get(62);
  assert.equal(window.predefinedType, 'USERDEFINED');
  assert.equal(window.attributes.UserDefinedPartitioningType, 'Pivot');
  const status = propertyOf(data, 62, 'Pset_WindowCommon', 'Status');
  assert.deepEqual([status.kind, status.value], ['enumerated', ['NEW']]);
  const u = propertyOf(data, 62, 'Pset_WindowCommon', 'ThermalTransmittance');
  assert.deepEqual([u.value, u.unit], [1.4, 'W/(m2.K)']);
  assert.deepEqual(materialsOf(data, 60), [{ name: 'Glass', category: 'glass', kind: 'material' }]);
  // Three windows share one property set object.
  assert.equal(data.elements.get(60).psets[0], data.elements.get(61).psets[0]);
  // The result is plain data: it survives structured cloning (worker transfer).
  assert.deepEqual(structuredClone(data).elements.get(25).psets.length, 2);
  model.close();
  assert.equal(model.closed, true);
  assert.equal(api.IsModelOpen(model.id), false);
  assert.throws(() => readIFCData(model), /closed/);
});

test('IFC4 spatial tree: project, site, building, storey elevation in meters, space, contained elements', async () => {
  const model = openIFC(api, await bytes('building.ifc'));
  try {
    const { spatial } = readIFCData(model);
    assert.equal(spatial.type, 'IfcProject');
    const site = spatial.children[0],
      building = site.children[0],
      storey = building.children[0];
    assert.deepEqual([site.type, building.type, storey.type, storey.name], ['IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'Level 1']);
    assert.equal(storey.elevation, 3);
    assert.deepEqual(storey.elements, [25, 60, 61, 62]);
    assert.deepEqual(storey.children.map((n) => [n.type, n.name, n.longName]), [['IfcSpace', '101', 'Office 101']]);
  } finally {
    model.close();
  }
});

test('IFC4 georeference: IfcMapConversion with a projected CRS; map and engine axes round trip', async () => {
  const model = openIFC(api, await bytes('building.ifc'));
  const data = readIFCData(model);
  const geo = data.georeference;
  model.close();
  assert.equal(geo.source, 'IfcMapConversion');
  assert.equal(geo.crs.name, 'EPSG:28356');
  assert.equal(geo.crs.geodeticDatum, 'GDA94');
  assert.equal(geo.crs.mapUnit, 1);
  assert.deepEqual([geo.eastings, geo.northings, geo.orthogonalHeight, geo.scale, geo.lengthUnit], [333780.622, 6246775.891, 97.457, 0.001, 0.001]);
  close(geo.rotation, Math.atan2(-0.138731399, 0.990330045));
  assert.deepEqual(modelToMap(geo, [0, 0, 0]), [333780.622, 6246775.891, 97.457]);
  // One meter along local x lands one map unit along the rotated axis (Scale 0.001 per millimetre).
  const [e, n, h] = modelToMap(geo, [1, 0, 2]);
  close(e - geo.eastings, Math.cos(geo.rotation), 1e-9);
  close(n - geo.northings, Math.sin(geo.rotation), 1e-9);
  close(h, 99.457);
  const back = mapToModel(geo, [e, n, h]);
  for (let i = 0; i < 3; i++) close(back[i], [1, 0, 2][i], 1e-9);
  assert.equal(geo.latitude, 51.5);
  assert.equal(geo.longitude, -7);
  assert.equal(geo.elevation, 0.012);
  assert.deepEqual(ifcToEngine(engineToIFC([1, 2, 3], [10, 20, 30]), [10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(engineToIFC([1, 2, 3]), [1, -3, 2]);
});

test('IFC2X3 data: feet, square feet, centi cubic metres and degrees Celsius to SI; ePSet_MapConversion; true north', async () => {
  const model = openIFC(api, await bytes('feet-2x3.ifc'));
  const data = readIFCData(model);
  model.close();
  assert.equal(data.schema, 'IFC2X3');
  const qto = propertiesOf(data, 30).BaseQuantities;
  close(qto.Length.value, 3.048);
  close(qto.NetSideArea.value, 9.290304);
  close(qto.NetVolume.value, 2);
  assert.equal(qto.NetVolume.raw, 2000000);
  const custom = propertiesOf(data, 30).Pset_Custom;
  close(custom.DesignTemperature.value, 293.15);
  assert.equal(custom.DesignTemperature.unit, 'K');
  assert.equal(custom.Span.kind, 'bounded');
  close(custom.Span.lower, 3.048);
  close(custom.Span.upper, 6.096);
  assert.deepEqual(materialsOf(data, 30).map((m) => [m.name, m.kind]), [['Brick', 'material'], ['Mortar', 'material']]);
  assert.deepEqual(classificationsOf(data, 30), [{ system: 'MasterFormat', code: '04 21 00', name: 'Clay Unit Masonry' }]);
  close(data.spatial.children[0].children[0].elevation, 3.048);
  assert.equal(data.elements.get(30).storey, 23);
  const geo = data.georeference;
  assert.equal(geo.source, 'ePSet_MapConversion');
  assert.deepEqual([geo.eastings, geo.northings, geo.orthogonalHeight], [1000000, 2000000, 50]);
  close(geo.rotation, Math.PI / 2);
  assert.equal(geo.crs.name, 'EPSG:2263');
  close(geo.crs.mapUnit, 1200 / 3937);
  close(geo.lengthUnit, 0.3048);
  close(geo.latitude, -(33 + 52 / 60 + 7.2 / 3600));
  close(geo.longitude, 151 + 12 / 60 + 30 / 3600);
  close(geo.trueNorth, Math.PI / 4);
});

test('readIFCGeometry rebases onto an origin in float64 so far-from-origin models keep precision', async () => {
  const model = openIFC(api, await bytes('building.ifc'));
  try {
    const plain = readIFCGeometry(model);
    assert.deepEqual(plain.origin, [0, 0, 0]);
    const auto = readIFCGeometry(model, { origin: 'auto' });
    assert.deepEqual(auto.origin, [1, 5, -2]);
    for (let i = 0; i < plain.positions.length; i++) close(auto.positions[i] + auto.origin[i % 3], plain.positions[i], 1e-6);
    const fixed = readIFCGeometry(model, { origin: [1, 2, 3] });
    assert.deepEqual(fixed.origin, [1, 2, 3]);
    assert.throws(() => readIFCGeometry(model, { origin: [1, 2] }), /origin/);
    assert.equal(api.IsModelOpen(model.id), true);
  } finally {
    model.close();
  }
  assert.throws(() => readIFCGeometry(model), /closed/);
});
