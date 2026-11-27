// parse3MFMaterials: textures, per-corner coordinates, colour groups, composites, layers, parts and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        `${TEXTURE}${COORDS}<basematerials id="3"><base name="red" displaycolor="#FF0000"/></basematerials><m:colorgroup id="6"><m:color color="#0000FF80"/></m:colorgroup><multiproperties id="7" pids="3 2 6"><multi pindices="0 1 0"/></multiproperties>`,
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

test('a multiproperties keeps its whole stack: every texture layer, colours, blend methods and default indices', async () => {
  const second =
    '<texture2d id="4" path="/3D/Texture/b.png" contenttype="image/png"/><texture2dgroup id="5" texid="4"><tex2coord u="0.25" v="0.5"/><tex2coord u="0.75" v="0.125"/></texture2dgroup>';
  const result = await parse3MFMaterials(
    pack(
      model(
        `${TEXTURE}${COORDS}${second}<colorgroup id="6"><color color="#00FF0080"/><color color="#FF000040"/></colorgroup>` +
          '<multiproperties id="7" pids="6 2 5" blendmethods="mix multiply"><multi pindices="1 2 1"/><multi pindices="0 3"/></multiproperties>',
        '<triangle v1="0" v2="1" v3="2" pid="7" p1="0" p2="1" p3="0"/><triangle v1="0" v2="2" v3="3"/>',
      ),
      { '3D/Texture/a.png': PNG, '3D/Texture/b.png': PNG },
    ),
  );
  const [layeredGroup, plain] = result.groups;
  assert.deepEqual(layeredGroup.layers, [
    { kind: 'color', attribute: 'layerColor0', blend: 'mix' },
    { kind: 'texture', texture: 0, attribute: 'layerUV1', blend: 'mix' },
    { kind: 'texture', texture: 1, attribute: 'layerUV2', blend: 'multiply' },
  ]);
  assert.equal(layeredGroup.texture, 0);
  assert.equal(plain.layers, undefined);
  const { layerColor0, layerUV1, layerUV2 } = result.attributes;
  // Corners 0 and 2 use row 0 (colour 1, coordinate 2, coordinate 1); corner 1 uses row 1, whose missing index is 0.
  near(layerColor0.subarray(0, 12), [1, 0, 0, 0x40 / 255, 0, 1, 0, 0x80 / 255, 1, 0, 0, 0x40 / 255]);
  near(layerUV1.subarray(0, 6), [1, 0, 0, 0, 1, 0]);
  near(layerUV2.subarray(0, 6), [0.75, 0.875, 0.25, 0.5, 0.75, 0.875]);
  // The plain triangle's corners hold zeros.
  near(layerColor0.subarray(12), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  near(layerUV2.subarray(6), [0, 0, 0, 0, 0, 0]);
});

const SAMPLES = new URL('./fixtures/3mf-samples/', import.meta.url);
const sample = (name) => readFile(new URL(name, SAMPLES));

test("the 3MF Consortium's multiproperties samples keep a colour under two texture layers", async () => {
  for (const [file, base] of [
    ['multiprop-opaque.3mf', [0, 0x90 / 255, 1, 1]],
    ['multiprop-metallic.3mf', [0xc0 / 255, 0xc0 / 255, 0xc0 / 255, 1]],
  ]) {
    const result = await parse3MFMaterials(await sample(file));
    assert.deepEqual(
      result.textures.map((t) => t.path),
      ['/3D/Texture/Star.png', '/3D/Texture/Smiley.png'],
    );
    const [front, rest] = result.groups;
    assert.deepEqual(front.layers, [
      { kind: 'color', attribute: 'layerColor0', blend: 'mix' },
      { kind: 'texture', texture: 0, attribute: 'layerUV1', blend: 'mix' },
      { kind: 'texture', texture: 1, attribute: 'layerUV2', blend: 'mix' },
    ]);
    assert.equal(front.count, 6);
    near(rest.color, base);
    const { layerColor0, layerUV1, layerUV2 } = result.attributes;
    for (let v = 0; v < 6; v++) near(layerColor0.subarray(v * 4, v * 4 + 4), base);
    // Triangles (0 1 4) with rows 0 1 2 and (5 4 1) with rows 3 2 1: tex2coords (0,0) (1,0) (0,1) (1,1), v flipped.
    const uv = [0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1];
    near(layerUV1.subarray(0, 12), uv);
    near(layerUV2.subarray(0, 12), uv);
  }
});

test("the 3MF Consortium's validation files: multiproperties rules refuse, valid stacks load", async () => {
  for (const [file, message] of [
    ['MUSTFAIL_3MF100_Extension_Chapter5b_MultipleReferenceToBaseAndCompositeMatterials.3mf', /one material group/],
    ['MUSTFAIL_3MF100_Extension_Chapter5b_MultipleReferenceToBaseMatterials.3mf', /one material group/],
    ['MUSTFAIL_3MF100_Extension_Chapter5b_ReferToAnotherMultiProperties.3mf', /property group 2 is not defined/],
    ['MUSTFAIL_3MF100_Extension_Chapter5c_MultipleReferenceToColorgroup.3mf', /one colour group/],
    ['MUSTFAIL_3MF100_Extension_Chapter5d_MultipleReferenceToCompositeMaterials.3mf', /one material group/],
    ['MUSTFAIL_3MF100_Extension_Chapter5e_ReferenceToMultiProperties.3mf', /must not name a multiproperties/],
  ])
    await assert.rejects(
      parse3MFMaterials(await sample(file)),
      (error) => error instanceof LoaderError && error.code === 'syntax' && message.test(error.message),
      file,
    );
  for (const file of [
    'MUSTPASS_Chapter5.1a_MaterialResources_CompositeAndMultiProperties.3mf',
    'MUSTPASS_Chapter5.1b_MaterialResources_MultiObjects_CompositeAndMultiProperties.3mf',
  ]) {
    const { groups } = await parse3MFMaterials(await sample(file));
    const stacks = groups.filter((g) => g.layers);
    assert.ok(stacks.length >= 1, file);
    for (const g of stacks)
      assert.deepEqual(
        g.layers.map((l) => l.kind),
        ['color', 'color'],
      );
  }
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

test('create3MFMesh refuses what one materials mesh cannot draw, before it touches the engine', async () => {
  const { create3MFMesh } = await import('../dist/threemf-mesh.js');
  const engine = {},
    saved = globalThis.createImageBitmap;
  // Node has no image decoder: a 1 x 1 RGBA image stands in, so the layer checks after decoding run.
  globalThis.createImageBitmap = async () => ({ data: new Uint8Array(4), width: 1, height: 1 });
  try {
    await refuses(
      create3MFMesh(engine, { kind: 'points', positions: new Float32Array(3), textures: [] }),
      'unsupported',
    );
    const loaded = await parse3MFMaterials(await sample('multiprop-opaque.3mf'));
    await refuses(create3MFMesh(engine, loaded, { normals: 'faceted' }), 'range');
    // Three different coordinate sets in one stack: UV0 and UV1 hold two.
    const three = structuredClone(loaded);
    three.groups[0].layers.push({ kind: 'texture', texture: 0, attribute: 'layerUV3', blend: 'mix' });
    three.attributes.layerUV3 = three.attributes.layerUV1.map((v) => v * 0.5);
    three.attributes.layerUV2 = three.attributes.layerUV1.map((v) => 1 - v);
    await assert.rejects(create3MFMesh(engine, three), /more than two sets of texture coordinates/);
    // A colour layer above a texture layer must be one colour across the group.
    const varied = structuredClone(loaded);
    varied.groups[0].layers.push({ kind: 'color', attribute: 'layerColor3', blend: 'mix' });
    varied.attributes.layerColor3 = new Float32Array((varied.positions.length / 3) * 4).map((_, k) =>
      k > 4 ? 0.5 : 0.25,
    );
    await assert.rejects(create3MFMesh(engine, varied), /must hold one colour across the group/);
    const missing = structuredClone(loaded);
    delete missing.attributes.layerUV2;
    await refuses(create3MFMesh(engine, missing), 'range');
  } finally {
    globalThis.createImageBitmap = saved;
  }
});

const METALS =
  '<m:pbmetallicdisplayproperties id="20"><m:pbmetallic name="Steel" metallicness="1" roughness="0.25"/><m:pbmetallic name="Paint" metallicness="0" roughness="0.5"/><m:pbmetallic name="Default"/></m:pbmetallicdisplayproperties>';
const TRIO = '<base name="a" displaycolor="#FF0000"/>'.repeat(3);
const finishes = (result) =>
  result.groups.map(({ count, metallic }) => [
    count / 3,
    metallic && [metallic.name, metallic.metalness, metallic.roughness],
  ]);

test('pbmetallic values follow the property index of base materials, colour groups and composites', async () => {
  const triangles = (pid) =>
    [0, 1, 2, 1].map((p) => `<triangle v1="0" v2="1" v3="2" pid="${pid}" p1="${p}"/>`).join('');
  const expected = [
    [1, ['Steel', 1, 0.25]],
    [2, ['Paint', 0, 0.5]],
    [1, ['Default', 0, 1]],
  ];
  for (const [resources, pid] of [
    [`${METALS}<basematerials id="4" displaypropertiesid="20">${TRIO}</basematerials>`, 4],
    [
      `${METALS}<m:colorgroup id="6" displaypropertiesid="20">${'<m:color color="#00FF00"/>'.repeat(3)}</m:colorgroup>`,
      6,
    ],
    [
      `${METALS}<basematerials id="4">${TRIO}</basematerials><m:compositematerials id="5" matid="4" matindices="0 1" displaypropertiesid="20">${'<m:composite values="1 1"/>'.repeat(3)}</m:compositematerials>`,
      5,
    ],
  ]) {
    // One colour throughout, so only the finish splits the groups; the last triangle joins the second.
    const result = await parse3MFMaterials(pack(model(resources, triangles(pid))));
    assert.deepEqual(finishes(result), expected, `property group ${pid}`);
  }
});

test('equal finishes stay one group, and a file without display properties has no metallic', async () => {
  const twice =
    '<m:pbmetallicdisplayproperties id="20"><m:pbmetallic name="a" metallicness="1" roughness="0.2"/><m:pbmetallic name="b" metallicness="1" roughness="0.2"/></m:pbmetallicdisplayproperties><basematerials id="4" displaypropertiesid="20"><base name="a" displaycolor="#FF0000"/><base name="b" displaycolor="#FF0000"/></basematerials>';
  const triangles = '<triangle v1="0" v2="1" v3="2" pid="4" p1="0"/><triangle v1="0" v2="2" v3="3" pid="4" p1="1"/>';
  assert.deepEqual(finishes(await parse3MFMaterials(pack(model(twice, triangles)))), [[2, ['a', 1, 0.2]]]);
  const bare = await parse3MFMaterials(pack(model(`<basematerials id="4">${TRIO}</basematerials>`, triangles)));
  assert.ok(bare.groups.every((group) => !('metallic' in group)));
});

const MAPS =
  '<m:texture2d id="30" path="/3D/Texture/m.png" contenttype="image/png"/><m:texture2d id="31" path="/3D/Texture/r.png" contenttype="image/png"/>';
const mapped = (extra) =>
  `<m:pbmetallictexturedisplayproperties id="21" name="Worn" metallictextureid="30" roughnesstextureid="31" ${extra}/>`;
const PARTS = { '3D/Texture/a.png': PNG, '3D/Texture/m.png': PNG, '3D/Texture/r.png': PNG };
const shownCoords = COORDS.replace('texid="1"', 'texid="1" displaypropertiesid="21"');
const CORNER = '<triangle v1="0" v2="1" v3="2" pid="2" p1="0"/>';

test('metallic texture properties name their maps, factors and base colour factor', async () => {
  for (const [extra, expected] of [
    ['', { metalness: 1, roughness: 1 }],
    [
      'metallicfactor="0.5" roughnessfactor="2" basecolorfactor="#80FF40"',
      { metalness: 0.5, roughness: 2, baseColorFactor: [0x80 / 255, 1, 0x40 / 255, 1] },
    ],
    ['basecolorfactor="#FFFFFF"', { metalness: 1, roughness: 1 }],
  ]) {
    const result = await parse3MFMaterials(pack(model(MAPS + mapped(extra) + TEXTURE + shownCoords, CORNER), PARTS));
    // Textures are listed in the file's order: the two maps, then the colour texture.
    assert.deepEqual(result.groups[0].metallic, {
      name: 'Worn',
      ...expected,
      metalnessTexture: 0,
      roughnessTexture: 1,
    });
    assert.equal(result.groups[0].texture, 2);
  }
});

test('a stack takes the lowest layer that has display properties, named by its place', async () => {
  const resources = `${MAPS}${mapped('')}${TEXTURE}${shownCoords}${METALS}<m:colorgroup id="6"><m:color color="#FFFFFF"/></m:colorgroup><basematerials id="4" displaypropertiesid="20">${TRIO}</basematerials>`;
  const stack = async (pids, row) => {
    const layers = `<m:multiproperties id="7" pids="${pids}"><m:multi pindices="${row}"/></m:multiproperties>`,
      xml = model(resources + layers, '<triangle v1="0" v2="1" v3="2" pid="7" p1="0"/>');
    return (await parse3MFMaterials(pack(xml, PARTS))).groups[0].metallic;
  };
  const over = await stack('6 2', '0 1');
  assert.deepEqual([over.name, over.layer, over.roughnessTexture], ['Worn', 1, 1]);
  const under = await stack('4 2', '1 0');
  assert.deepEqual([under.name, under.layer, under.metalness], ['Paint', 0, 0]);
});

test("display properties after their group, and on one base as the Consortium's sample writes them, are read", async () => {
  const late = `<basematerials id="4" displaypropertiesid="20">${TRIO}</basematerials>${METALS}`;
  const result = await parse3MFMaterials(pack(model(late, '<triangle v1="0" v2="1" v3="2" pid="4" p1="0"/>')));
  assert.equal(result.groups[0].metallic.name, 'Steel');
  const metallic = await parse3MFMaterials(await sample('multiprop-metallic.3mf'));
  assert.deepEqual(
    metallic.groups.map((group) => group.metallic),
    [
      { name: 'MetalProp', metalness: 1, roughness: 0.2, layer: 0 },
      { name: 'MetalProp', metalness: 1, roughness: 0.2 },
    ],
  );
});

const SPECULARS =
  '<m:pbspeculardisplayproperties id="20"><m:pbspecular name="Gold" specularcolor="#FFD060" glossiness="0.75"/><m:pbspecular name="Plain"/></m:pbspeculardisplayproperties>';
const GLASS =
  '<m:translucentdisplayproperties id="22"><m:translucent name="Resin" attenuation="0.5 2 4" refractiveindex="1.48 1.5 1.53" roughness="0.1"/><m:translucent name="Water" attenuation="0 0 0"/></m:translucentdisplayproperties>';
const TWO = '<base name="a" displaycolor="#FF0000"/><base name="b" displaycolor="#00FF00"/>';
const both = '<triangle v1="0" v2="1" v3="2" pid="4" p1="0"/><triangle v1="0" v2="2" v3="3" pid="4" p1="1"/>';

test('pbspecular values follow the property index, with the default specular colour and glossiness', async () => {
  const xml = model(`${SPECULARS}<basematerials id="4" displaypropertiesid="20">${TWO}</basematerials>`, both),
    result = await parse3MFMaterials(pack(xml));
  assert.deepEqual(
    result.groups.map((group) => group.specular),
    [
      { name: 'Gold', specularColor: [1, 0xd0 / 255, 0x60 / 255], glossiness: 0.75 },
      { name: 'Plain', specularColor: [56 / 255, 56 / 255, 56 / 255], glossiness: 0 },
    ],
  );
  assert.ok(result.groups.every((group) => !group.metallic && !group.translucent));
});

test('translucent values follow the property index, on base materials and composites', async () => {
  const expected = [
    { name: 'Resin', attenuation: [0.5, 2, 4], refractiveIndex: [1.48, 1.5, 1.53], roughness: 0.1 },
    { name: 'Water', attenuation: [0, 0, 0], refractiveIndex: [1, 1, 1], roughness: 0 },
  ];
  for (const [resources, pid] of [
    [`${GLASS}<basematerials id="4" displaypropertiesid="22">${TWO}</basematerials>`, 4],
    [
      `${GLASS}<basematerials id="3">${TWO}</basematerials><m:compositematerials id="4" matid="3" matindices="0 1" displaypropertiesid="22">${'<m:composite values="1 1"/>'.repeat(2)}</m:compositematerials>`,
      4,
    ],
  ]) {
    const result = await parse3MFMaterials(pack(model(resources, both.replaceAll('pid="4"', `pid="${pid}"`))));
    assert.deepEqual(
      result.groups.map((group) => group.translucent),
      expected,
    );
    assert.ok(result.groups.every((group) => !group.metallic && !group.specular));
  }
});

test("metresPerUnit tells a mesh's unit, whatever the attenuation's metres", async () => {
  const xml = model(`<basematerials id="4">${TWO}</basematerials>`, both);
  assert.equal((await parse3MFMaterials(pack(xml))).metresPerUnit, 1);
  assert.equal((await parse3MFMaterials(pack(xml), { units: 'file' })).metresPerUnit, 0.001);
});

const SPECULAR_MAPS = (extra) =>
  `<m:pbspeculartexturedisplayproperties id="21" name="Lacquer" speculartextureid="30" glossinesstextureid="31" ${extra}/>`;

test('specular texture properties name their maps, factors and diffuse factor', async () => {
  for (const [extra, expected] of [
    ['', { specularColor: [1, 1, 1], glossiness: 1 }],
    [
      'specularfactor="#80FF40" glossinessfactor="0.5" diffusefactor="#40C080"',
      {
        specularColor: [0x80 / 255, 1, 0x40 / 255],
        glossiness: 0.5,
        diffuseFactor: [0x40 / 255, 0xc0 / 255, 0x80 / 255, 1],
      },
    ],
  ]) {
    const result = await parse3MFMaterials(
      pack(model(MAPS + SPECULAR_MAPS(extra) + TEXTURE + shownCoords, CORNER), PARTS),
    );
    assert.deepEqual(result.groups[0].specular, {
      name: 'Lacquer',
      ...expected,
      specularTexture: 0,
      glossinessTexture: 1,
    });
    assert.equal(result.groups[0].metallic, undefined);
  }
});

test('a stack takes one kind of display properties, from its lowest layer that has any', async () => {
  const resources = `${GLASS}${MAPS}${SPECULAR_MAPS('')}${TEXTURE}${shownCoords}<basematerials id="4" displaypropertiesid="22">${TWO}</basematerials><m:colorgroup id="6"><m:color color="#FFFFFF"/></m:colorgroup>`;
  const stack = async (pids, row) => {
    const layers = `<m:multiproperties id="7" pids="${pids}"><m:multi pindices="${row}"/></m:multiproperties>`,
      xml = model(resources + layers, '<triangle v1="0" v2="1" v3="2" pid="7" p1="0"/>');
    return (await parse3MFMaterials(pack(xml, PARTS))).groups[0];
  };
  const under = await stack('4 2', '0 0');
  assert.deepEqual([under.translucent.name, under.translucent.layer, under.specular], ['Resin', 0, undefined]);
  const over = await stack('6 2', '0 0');
  assert.deepEqual([over.specular.name, over.specular.layer, over.translucent], ['Lacquer', 1, undefined]);
});

test('broken specular and translucent display properties are named errors', async () => {
  const base = `<basematerials id="4" displaypropertiesid="20">${TWO}</basematerials>`,
    specular = (attributes) =>
      `<m:pbspeculardisplayproperties id="20"><m:pbspecular name="x" ${attributes}/></m:pbspeculardisplayproperties>`,
    translucent = (attributes) =>
      `<m:translucentdisplayproperties id="20"><m:translucent name="x" ${attributes}/></m:translucentdisplayproperties>`;
  for (const [display, code] of [
    [specular('glossiness="1.5"'), 'range'],
    [specular('specularcolor="gold"'), 'syntax'],
    [translucent(''), 'syntax'],
    [translucent('attenuation="1 1"'), 'syntax'],
    [translucent('attenuation="1 -1 1"'), 'range'],
    [translucent('attenuation="1 1 1" refractiveindex="1.5 0 1.5"'), 'range'],
    [translucent('attenuation="1 1 1" refractiveindex="1.5"'), 'syntax'],
    [translucent('attenuation="1 1 1" roughness="2"'), 'range'],
  ])
    await refuses(parse3MFMaterials(pack(model(display + base, both))), code);
  const textured = (display) => parse3MFMaterials(pack(model(display + TEXTURE + shownCoords, CORNER), PARTS));
  await refuses(textured(SPECULAR_MAPS('')), 'syntax');
  await refuses(textured(MAPS + SPECULAR_MAPS('glossinessfactor="-1"')), 'range');
  await refuses(textured(MAPS + SPECULAR_MAPS('diffusefactor="red"')), 'syntax');
  // A translucent resource may not describe a texture group (section 7.5.1).
  await refuses(textured(translucent('attenuation="1 1 1"').replace('id="20"', 'id="21"')), 'syntax');
});

test('broken display properties are named errors', async () => {
  const triangle = (p) => `<triangle v1="0" v2="1" v3="2" pid="4" p1="${p}"/>`;
  const base = (reference) => `<basematerials id="4" displaypropertiesid="${reference}">${TRIO}</basematerials>`;
  const one = (attributes) =>
    `<m:pbmetallicdisplayproperties id="20"><m:pbmetallic name="x" ${attributes}/></m:pbmetallicdisplayproperties>${base(20)}`;
  for (const [resources, code, p = 0] of [
    [base(99), 'syntax'],
    [one('metallicness="1" roughness="0.5"'), 'range', 1],
    [one('metallicness="1.5"'), 'range'],
    [one('roughness="-0.1"'), 'range'],
    [one('roughness="rough"'), 'range'],
    // A texture's properties on a base material group.
    [MAPS + mapped('') + base(21), 'syntax'],
  ])
    await refuses(parse3MFMaterials(pack(model(resources, triangle(p)), PARTS)), code);
  const textured = (display, coords = shownCoords) =>
    parse3MFMaterials(pack(model(display + TEXTURE + coords, CORNER), PARTS));
  await refuses(textured(mapped('')), 'syntax');
  await refuses(textured(MAPS + mapped('metallicfactor="-1"')), 'range');
  await refuses(textured(MAPS + mapped('basecolorfactor="red"')), 'syntax');
  await refuses(textured(METALS, COORDS.replace('texid="1"', 'texid="1" displaypropertiesid="20"')), 'syntax');
});

const COLOURS = '<colorgroup id="3"><color color="#FF0000"/><color color="#00FF00"/></colorgroup>';
test('two property resources of one id are refused instead of the second replacing the first', async () => {
  const base = '<basematerials id="3"><base name="a" displaycolor="#0000FF"/></basematerials>',
    triangle = '<triangle v1="0" v2="1" v3="2" pid="3" p1="0"/>';
  for (const [parse, resources] of [
    [parse3MF, COLOURS + COLOURS],
    [parse3MF, base + COLOURS],
    [parse3MFMaterials, COLOURS + base],
    [parse3MFMaterials, TEXTURE + COORDS + COORDS + COLOURS],
    [parse3MFMaterials, TEXTURE + COORDS.replace('id="2"', 'id="1"') + COLOURS],
  ])
    await assert.rejects(
      parse(pack(model(resources, triangle), { '3D/Texture/a.png': PNG })),
      (error) => error.code === 'syntax' && /duplicate property resource id/.test(error.message),
      resources,
    );
});

test('a build of beam lattices alone says which reader makes their triangles', async () => {
  const lattice = `<model unit="millimeter"><resources><object id="4" type="model"><mesh>${VERTICES}<triangles/><beamlattice radius="0.1" minlength="0.01"><beams><beam v1="0" v2="1"/></beams></beamlattice></mesh></object></resources><build><item objectid="4"/></build></model>`;
  for (const parse of [parse3MF, parse3MFMaterials])
    await assert.rejects(
      parse(pack(lattice)),
      (error) => error.code === 'syntax' && /object 4 is a beam lattice.*parse3MFEvaluated/.test(error.message),
    );
});
