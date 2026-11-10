// parse3MFMaterials: textures, per-corner coordinates, colour groups, composites, layers, parts and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MFMaterials } from '../dist/threemf-materials.js';
import { parse3MF } from '../dist/index.js';
import { crc32, LoaderError } from '../dist/common.js';

const text = (value) => new TextEncoder().encode(value);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A stored zip of `{ name: bytes or text }`. */
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? text(content) : content,
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

const VERTICES =
  '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="1" y="1" z="0"/><vertex x="0" y="1" z="0"/></vertices>';
const model = (resources, triangles, object = '') =>
  `<model unit="millimeter"><resources>${resources}<object id="9" type="model" ${object}><mesh>${VERTICES}<triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="9"/></build></model>`;
const pack = (xml, extra = {}) => zip({ '3D/3dmodel.model': xml, ...extra });
const TEXTURE =
  '<texture2d id="1" path="/3D/Texture/a.png" contenttype="image/png" tilestyleu="clamp" filter="nearest"/>';
const COORDS =
  '<texture2dgroup id="2" texid="1"><tex2coord u="0" v="0"/><tex2coord u="1" v="0"/><tex2coord u="1" v="1"/><tex2coord u="0" v="1"/></texture2dgroup>';
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  [...actual].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5, `${[...actual]} against ${expected}`));
};
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === '3MF' && error.code === code);

test('a textured triangle gets its image, flipped coordinates and a group naming the texture', async () => {
  const result = await parse3MFMaterials(
    pack(model(TEXTURE + COORDS, '<triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/>'), {
      '3D/Texture/a.png': PNG,
    }),
  );
  assert.deepEqual([...result.textures[0].data], [...PNG]);
  assert.equal(result.textures[0].contentType, 'image/png');
  assert.equal(result.textures[0].tileStyleU, 'clamp');
  assert.equal(result.textures[0].tileStyleV, 'wrap');
  assert.equal(result.textures[0].filter, 'nearest');
  near(result.uvs, [0, 1, 1, 1, 1, 0]);
  assert.equal(result.groups[0].texture, 0);
  assert.equal(result.colors, undefined);
});

test('two corners of one vertex keep different coordinates across a seam', async () => {
  const result = await parse3MFMaterials(
    pack(
      model(
        TEXTURE + COORDS,
        '<triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/><triangle v1="0" v2="2" v3="3" pid="2" p1="3" p2="2" p3="1"/>',
      ),
      { '3D/Texture/a.png': PNG },
    ),
  );
  assert.equal(result.positions.length / 3, 6);
  near(result.positions.subarray(0, 3), result.positions.subarray(9, 12));
  near(result.uvs, [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 1, 1]);
});

test('an object pid gives every plain triangle its texture coordinate', async () => {
  const result = await parse3MFMaterials(
    pack(model(TEXTURE + COORDS, '<triangle v1="0" v2="1" v3="2"/>', 'pid="2" pindex="3"'), {
      '3D/Texture/a.png': PNG,
    }),
  );
  near(result.uvs, [0, 0, 0, 0, 0, 0]);
  assert.equal(result.groups[0].texture, 0);
});

test('textured and plain triangles fall into separate groups, and a mirror keeps uvs on their corners', async () => {
  const xml = model(
    TEXTURE + COORDS,
    '<triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/><triangle v1="0" v2="2" v3="3"/>',
  ).replace('<item objectid="9"/>', '<item objectid="9" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>');
  const result = await parse3MFMaterials(pack(xml, { '3D/Texture/a.png': PNG }));
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].texture, 0);
  assert.equal(result.groups[1].texture, undefined);
  // The mirror reverses corners 0, 2, 1, and each uv stays with its point.
  const [i0, i1, i2] = result.indices;
  const uvOf = (i) => [result.uvs[i * 2], result.uvs[i * 2 + 1]];
  const xOf = (i) => result.positions[i * 3];
  assert.deepEqual(
    [xOf(i0), xOf(i1), xOf(i2)].map((x) => Math.round(x * 1000) + 0),
    [0, -1, -1],
  );
  near(uvOf(i0), [0, 1]);
  near(uvOf(i1), [1, 0]);
  near(uvOf(i2), [1, 1]);
});

test('per-corner colour groups read as they do in parse3MF, with one vertex per corner', async () => {
  const xml = model(
    '<m:colorgroup id="3"><m:color color="#FF0000"/><m:color color="#00FF00"/><m:color color="#0000FF"/></m:colorgroup>',
    '<triangle v1="0" v2="1" v3="2" pid="3" p1="0" p2="1" p3="2"/>',
  );
  const result = await parse3MFMaterials(pack(xml));
  near(result.colors, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  near(result.colors, (await parse3MF(pack(xml))).colors);
  assert.deepEqual(result.textures, []);
});

test('a uniform colour stays on the group and leaves colors absent', async () => {
  const result = await parse3MFMaterials(
    pack(
      model(
        '<basematerials id="4"><base name="a" displaycolor="#FF0000FF"/></basematerials>',
        '<triangle v1="0" v2="1" v3="2" pid="4" p1="0"/>',
      ),
    ),
  );
  assert.equal(result.colors, undefined);
  near(result.groups[0].color, [1, 0, 0, 1]);
});

test('composite materials mix their base colours by weight', async () => {
  const result = await parse3MFMaterials(
    pack(
      model(
        '<basematerials id="4"><base name="a" displaycolor="#FF0000"/><base name="b" displaycolor="#0000FF"/></basematerials><compositematerials id="5" matid="4" matindices="0 1"><composite values="3 1"/></compositematerials>',
        '<triangle v1="0" v2="1" v3="2" pid="5" p1="0"/>',
      ),
    ),
  );
  near(result.groups[0].color, [0.8808250210902997, 0, 0.5370987304831942, 1]);
});

test('multiproperties carry a texture and a colour, mixed by alpha over the layer below', async () => {
  const result = await parse3MFMaterials(
    pack(
      model(
        `${TEXTURE}${COORDS}<m:colorgroup id="3"><m:color color="#FF0000"/></m:colorgroup><m:colorgroup id="6"><m:color color="#0000FF80"/></m:colorgroup><multiproperties id="7" pids="2 3 6"><multi pindices="1 0 0"/></multiproperties>`,
        '<triangle v1="0" v2="1" v3="2" pid="7" p1="0"/>',
      ),
      { '3D/Texture/a.png': PNG },
    ),
  );
  near(result.uvs, [1, 1, 1, 1, 1, 1]);
  assert.equal(result.groups[0].texture, 0);
  const a = 0x80 / 255;
  const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  near(result.colors.subarray(0, 3), [srgb(1 - a), 0, srgb(a)]);
});

test('a texture in a production part is found by that part', async () => {
  const part = `<model unit="millimeter"><resources>${TEXTURE}${COORDS}<object id="9" type="model"><mesh>${VERTICES}<triangles><triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/></triangles></mesh></object></resources><build/></model>`;
  const root =
    '<model unit="millimeter"><resources><object id="1" type="model"><components><component objectid="9" p:path="/3D/part.model"/></components></object></resources><build><item objectid="1"/></build></model>';
  const result = await parse3MFMaterials(pack(root, { '3D/part.model': part, '3D/Texture/a.png': PNG }));
  assert.equal(result.groups[0].texture, 0);
  near(result.uvs, [0, 1, 1, 1, 1, 0]);
});

test('parse3MF still reads the same file, ignoring what it does not know', async () => {
  const xml = model(TEXTURE + COORDS, '<triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/>');
  const plain = await parse3MF(pack(xml, { '3D/Texture/a.png': PNG }));
  assert.equal(plain.uvs, undefined);
  assert.equal(plain.positions.length, 12);
  assert.equal(plain.indices.length, 3);
});

test('bad references and values are named errors', async () => {
  const triangle = '<triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/>';
  const image = { '3D/Texture/a.png': PNG };
  await refuses(parse3MFMaterials(pack(model(TEXTURE + COORDS, triangle))), 'syntax');
  await refuses(parse3MFMaterials(pack(model(COORDS, triangle))), 'syntax');
  await refuses(parse3MFMaterials(pack(model('<texture2d id="1"/>', triangle))), 'syntax');
  await refuses(parse3MFMaterials(pack(model('<texture2d path="a"/>', triangle))), 'syntax');
  await refuses(parse3MFMaterials(pack(model('<texture2dgroup id="2"/>', triangle))), 'syntax');
  await refuses(
    parse3MFMaterials(
      pack(
        model(`${TEXTURE}<texture2dgroup id="2" texid="1"><tex2coord u="x" v="0"/></texture2dgroup>`, triangle),
        image,
      ),
    ),
    'syntax',
  );
  await refuses(
    parse3MFMaterials(
      pack(model(TEXTURE + COORDS, '<triangle v1="0" v2="1" v3="2" pid="2" p1="9" p2="1" p3="2"/>'), image),
    ),
    'range',
  );
  const composite = (body) =>
    `<basematerials id="4"><base name="a" displaycolor="#FF0000"/></basematerials><compositematerials id="5" matid="4" matindices="0 1">${body}</compositematerials>`;
  await refuses(parse3MFMaterials(pack(model(composite('<composite values="1 1"/>'), triangle))), 'range');
  await refuses(
    parse3MFMaterials(pack(model('<compositematerials id="5" matid="8" matindices="0"/>', triangle))),
    'syntax',
  );
  const negative =
    '<basematerials id="4"><base name="a" displaycolor="#FF0000"/></basematerials><compositematerials id="5" matid="4" matindices="0"><composite values="-1"/></compositematerials>';
  await refuses(parse3MFMaterials(pack(model(negative, triangle))), 'range');
  await refuses(
    parse3MFMaterials(
      pack(
        model(
          `${TEXTURE}${COORDS}<multiproperties id="7" pids="2"><multi pindices="0"/></multiproperties>`,
          '<triangle v1="0" v2="1" v3="2" pid="7" p1="3"/>',
        ),
        image,
      ),
    ),
    'range',
  );
});
