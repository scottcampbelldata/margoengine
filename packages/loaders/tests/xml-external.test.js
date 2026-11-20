// Every format parser that reads XML takes `external` (the result of resolveDTD), so a document with an external DTD
// loads without dropping to readXMLTree. Each document uses an entity that only its external DTD declares, against
// XML 1.0 Fifth Edition (W3C, 2008), https://www.w3.org/TR/xml/, section 5.1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, LoaderError } from '../dist/common.js';
import { resolveDTD } from '../dist/xml.js';
import { parseAMF } from '../dist/amf.js';
import { parse3MF } from '../dist/threemf.js';
import { parseDAE } from '../dist/dae.js';
import { parseKML } from '../dist/geo.js';
import { parseMaterialX } from '../dist/materialx.js';
import { parseSVG } from '../dist/svg.js';
import { parseTMX } from '../dist/tmx.js';
import { parseVTKXML } from '../dist/vtk-xml.js';
import { parseX3D } from '../dist/vrml.js';

const text = (value) => new TextEncoder().encode(value);
const dtd = (entities) =>
  Object.entries(entities)
    .map(([name, value]) => `<!ENTITY ${name} "${value}">`)
    .join('\n');
const external = (xml, entities) => resolveDTD(xml, { resolve: () => dtd(entities) });
const unread = (e) => e instanceof LoaderError && e.code === 'unsupported' && /resolveDTD/.test(e.message);
const needsDTD = (fn) => assert.throws(fn, unread);
const needsDTDAsync = (promise) => assert.rejects(promise, unread);
const doctype = (root) => `<!DOCTYPE ${root} SYSTEM "entities.dtd">`;

/** A stored zip of `{ name: text }`. */
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = text(content),
      name = text(path),
      crc = crc32(data),
      local = new Uint8Array(30 + name.length + data.length),
      lv = new DataView(local.buffer),
      central = new Uint8Array(46 + name.length),
      cv = new DataView(central.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('regression: parseDAE reads an entity only the external DTD declares', async () => {
  const xml = `<?xml version="1.0"?>${doctype('COLLADA')}
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><up_axis>Y_UP</up_axis></asset>
  <library_visual_scenes><visual_scene id="S"><node id="n" name="&label;"/></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#S"/></scene>
</COLLADA>`;
  needsDTD(() => parseDAE(xml));
  const dae = parseDAE(xml, { external: await external(xml, { label: 'Wheel' }) });
  assert.equal(JSON.stringify(dae).includes('Wheel'), true);
});

test('regression: parseX3D reads an external entity in a field value', async () => {
  const xml = `<?xml version="1.0"?>${doctype('X3D')}
<X3D><Scene><Shape><IndexedFaceSet coordIndex="0 1 2 -1"><Coordinate point="&triangle;"/></IndexedFaceSet></Shape></Scene></X3D>`;
  needsDTD(() => parseX3D(xml));
  const scene = parseX3D(xml, { external: await external(xml, { triangle: '0 0 0, 1 0 0, 0 1 0' }) });
  assert.deepEqual([...scene.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('regression: parseSVG reads an external entity in a path', async () => {
  const xml = `<?xml version="1.0"?>${doctype('svg')}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="&square;"/></svg>`;
  needsDTD(() => parseSVG(xml));
  const svg = parseSVG(xml, { external: await external(xml, { square: 'M0 0 L4 0 L4 4 L0 4 Z' }) });
  assert.equal(svg.paths.length, 1);
});

test('regression: parseKML reads an external entity in coordinates', async () => {
  const xml = `<?xml version="1.0"?>${doctype('kml')}
<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>&where;</coordinates></Point></Placemark></kml>`;
  needsDTD(() => parseKML(xml));
  const result = parseKML(xml, { external: await external(xml, { where: '1,2,3' }) });
  assert.deepEqual(result.features[0].geometry.coordinates, [1, 2, 3]);
});

test('regression: parseMaterialX reads an external entity in a name', async () => {
  const xml = `<?xml version="1.0"?>${doctype('materialx')}
<materialx version="1.39"><surfacematerial name="&label;" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>`;
  needsDTD(() => parseMaterialX(xml));
  const doc = parseMaterialX(xml, { external: await external(xml, { label: 'Brass' }) });
  assert.equal(JSON.stringify(doc.materials.map((m) => m.name)), '["Brass"]');
});

test('regression: parseTMX reads an external entity in a layer name', async () => {
  const xml = `<?xml version="1.0"?>${doctype('map')}
<map version="1.10" orientation="orthogonal" renderorder="right-down" width="1" height="1" tilewidth="16" tileheight="16" infinite="0"><layer id="1" name="&label;" width="1" height="1"><data encoding="csv">0</data></layer></map>`;
  await needsDTDAsync(parseTMX(xml));
  const map = await parseTMX(xml, { external: await external(xml, { label: 'Ground' }) });
  assert.equal(map.layers[0].name, 'Ground');
});

test('regression: parseAMF reads an external entity in a coordinate', async () => {
  const xml = `<?xml version="1.0"?>${doctype('amf')}
<amf unit="millimeter"><object id="1"><mesh><vertices><vertex><coordinates><x>&x;</x><y>0</y><z>0</z></coordinates></vertex><vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex><vertex><coordinates><x>0</x><y>0</y><z>1</z></coordinates></vertex></vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object></amf>`;
  await needsDTDAsync(parseAMF(text(xml)));
  const model = await parseAMF(text(xml), { external: await external(xml, { x: '5' }) });
  assert.ok(Math.abs(model.positions[0] - 0.005) < 1e-7);
});

test('regression: parse3MF reads an external entity in a vertex', async () => {
  const xml = `<?xml version="1.0"?>${doctype('model')}
<model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices><vertex x="&x;" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const file = zip({ '3D/3dmodel.model': xml });
  await needsDTDAsync(parse3MF(file));
  const model = await parse3MF(file, { external: await external(xml, { x: '5' }) });
  assert.ok(Math.abs(model.positions[0] - 0.005) < 1e-7);
});

test('regression: parseVTKXML reads an external entity in point data', async () => {
  const xml = `<?xml version="1.0"?>${doctype('VTKFile')}
<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="3"><Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">&points;</DataArray></Points></Piece></PolyData></VTKFile>`;
  await needsDTDAsync(parseVTKXML(text(xml)));
  const model = await parseVTKXML(text(xml), { external: await external(xml, { points: '0 0 0 1 0 0 0 1 0' }) });
  assert.deepEqual([...model.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});
