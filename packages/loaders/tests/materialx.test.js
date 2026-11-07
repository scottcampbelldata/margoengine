// parseMaterialX: reading a document, and turning each surface shader into a node material graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaterialX } from '../dist/materialx.js';
import { LoaderError } from '../dist/common.js';
import { materialGraphOutput } from '@margoengine/materials';

const refuses = (fn, code) =>
  assert.throws(fn, (error) => error instanceof LoaderError && error.format === 'MaterialX' && error.code === code);
const rejects = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof LoaderError && error.format === 'MaterialX' && error.code === code,
  );
const doc = (body, attributes = 'version="1.39"') =>
  `<?xml version="1.0"?>\n<materialx ${attributes}>${body}</materialx>`;
const material = (shader) =>
  `<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="${shader}"/></surfacematerial>`;
const texture = (file) => ({ view: { file } });
const emitOf = async (body, options, attributes) => {
  const { graph, skipped } = await parseMaterialX(doc(body, attributes)).toGraph(undefined, options);
  return { emit: graph.nodes[0], skipped };
};

test('a document lists its nodes, graphs, materials, looks and includes, and reads bytes as well as text', () => {
  const text = doc(
    `<xi:include href="lib.mtlx"/>
     <nodedef name="ND_x" node="x"/>
     <standard_surface name="S" type="surfaceshader">
       <input name="base" type="float" value="0.5"/>
       <input name="base_color" type="color3" value="0.1, 0.2, 0.3"/>
       <input name="thin_walled" type="boolean" value="true"/>
     </standard_surface>
     ${material('S')}
     <nodegraph name="G"><input name="i" type="float" value="1"/><constant name="c" type="float"/><output name="out" type="float" nodename="c"/></nodegraph>
     <look name="L"><materialassign name="a" material="M" geom="/body"/><materialassign name="b" material="M" collection="c"/></look>`,
    'version="1.38" colorspace="lin_rec709"',
  );
  for (const input of [text, new TextEncoder().encode(text)]) {
    const parsed = parseMaterialX(input);
    assert.equal(parsed.version, '1.38');
    assert.equal(parsed.colorspace, 'lin_rec709');
    assert.equal(parsed.nodes.S.category, 'standard_surface');
    assert.equal(parsed.nodes.S.inputs.base.value, 0.5);
    assert.deepEqual(parsed.nodes.S.inputs.base_color.value, [0.1, 0.2, 0.3]);
    assert.equal(parsed.nodes.S.inputs.thin_walled.value, true);
    assert.equal(parsed.nodes.ND_x, undefined);
    assert.equal(parsed.materials[0].shader, parsed.nodes.S);
    assert.equal(parsed.graphs.G.nodes.c.category, 'constant');
    assert.equal(parsed.graphs.G.outputs.out.nodename, 'c');
    assert.equal(parsed.graphs.G.inputs.i.value, 1);
    assert.deepEqual(parsed.assignments, [
      { look: 'L', material: 'M', geom: '/body' },
      { look: 'L', material: 'M', collection: 'c' },
    ]);
    assert.deepEqual(parsed.includes, ['lib.mtlx']);
  }
});

test('names from the file are ordinary keys', () => {
  const parsed = parseMaterialX(
    doc('<constant name="__proto__" type="float"/><constant name="constructor" type="float"/>'),
  );
  assert.equal(Object.getPrototypeOf(parsed.nodes), null);
  assert.equal(parsed.nodes.__proto__.category, 'constant');
  assert.equal(parsed.nodes.constructor.category, 'constant');
});

test("each surface shader maps its own inputs, and an unset one takes that shader's default", async () => {
  const cases = [
    ['standard_surface', [0.8, 0.8, 0.8, 1], 0, 0.2, 'mul'],
    ['open_pbr_surface', [0.8, 0.8, 0.8, 1], 0, 0.3, 'mul'],
    ['gltf_pbr', [1, 1, 1, 1], 1, 1, 'color'],
    ['UsdPreviewSurface', [0.18, 0.18, 0.18, 1], 0, 0.5, 'color'],
  ];
  for (const [shader, color, metal, roughness, kind] of cases) {
    const name = shader === 'standard_surface' ? 'base' : 'base_weight',
      weight = kind === 'mul' ? `<input name="${name}" type="float" value="0.5"/>` : '';
    const { emit, skipped } = await emitOf(
      `<${shader} name="S" type="surfaceshader">${weight}</${shader}>${material('S')}`,
    );
    assert.equal(emit.type, 'emit');
    assert.equal(emit.color.type, kind, shader);
    assert.deepEqual(kind === 'mul' ? emit.color.a.value : emit.color.value, color, shader);
    if (kind === 'mul') assert.equal(emit.color.b.value, 0.5);
    assert.equal(emit.metalRough.metal.value, metal, shader);
    assert.equal(emit.metalRough.roughness.value, roughness, shader);
    assert.equal(emit.clearcoat, undefined);
    assert.equal(emit.transmission, undefined);
    assert.deepEqual(skipped, []);
  }
});

test('constants convert: sRGB colours to linear, floats to scalars, coat and transmission lobes on', async () => {
  const { emit } = await emitOf(
    `<standard_surface name="S" type="surfaceshader">
       <input name="base_color" type="color3" value="0.5, 0.5, 1" colorspace="srgb_texture"/>
       <input name="metalness" type="float" value="0.25"/>
       <input name="specular_roughness" type="float" value="0.75"/>
       <input name="coat" type="float" value="1"/>
       <input name="coat_roughness" type="float" value="0.5"/>
       <input name="transmission" type="float" value="0.9"/>
       <input name="specular_IOR" type="float" value="1.3"/>
     </standard_surface>${material('S')}`,
  );
  assert.ok(Math.abs(emit.color.value[0] - 0.21404) < 1e-4);
  assert.equal(emit.color.value[2], 1);
  assert.equal(emit.metalRough.metal.value, 0.25);
  assert.equal(emit.metalRough.roughness.value, 0.75);
  assert.equal(emit.clearcoat.factor.value, 1);
  assert.equal(emit.clearcoat.roughness.value, 0.5);
  assert.equal(emit.transmission.factor.value, 0.9);
  assert.equal(emit.transmission.ior.value, 1.3);
});

test('the document colour space reaches a colour; one with no conversion is named in skipped', async () => {
  const body = `<standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" value="0.5, 0.5, 0.5"/></standard_surface>${material('S')}`;
  const srgb = await emitOf(body, undefined, 'version="1.39" colorspace="srgb_texture"');
  assert.ok(Math.abs(srgb.emit.color.value[0] - 0.21404) < 1e-4);
  const other = await emitOf(body, undefined, 'version="1.39" colorspace="acescg"');
  assert.equal(other.emit.color.value[0], 0.5);
  assert.match(other.skipped[0].reason, /acescg/);
});

test('images go through the hook once each, with fileprefix, colour space and address modes', async () => {
  const asked = [];
  const { emit, skipped } = await emitOf(
    `<tiledimage name="C" type="color3"><input name="file" type="filename" value="c.png" colorspace="srgb_texture"/></tiledimage>
     <image name="R" type="float" fileprefix="sub/"><input name="file" type="filename" value="r.png"/><input name="uaddressmode" type="string" value="clamp"/><input name="vaddressmode" type="string" value="mirror"/><input name="filtertype" type="string" value="closest"/></image>
     <image name="R2" type="float" fileprefix="sub/"><input name="file" type="filename" value="r.png"/></image>
     <gltf_pbr name="S" type="surfaceshader">
       <input name="base_color" type="color3" nodename="C"/>
       <input name="roughness" type="float" nodename="R"/>
       <input name="metallic" type="float" nodename="R2"/>
     </gltf_pbr>${material('S')}`,
    { texture: (request) => (asked.push(request), texture(request.file)) },
    'version="1.39" fileprefix="tex/"',
  );
  assert.equal(emit.color.type, 'texture');
  assert.equal(emit.color.texture.view.file, 'tex/c.png');
  assert.equal(emit.metalRough.roughness.texture.view.file, 'tex/sub/r.png');
  assert.equal(emit.metalRough.metal.texture, emit.metalRough.roughness.texture);
  assert.deepEqual(asked, [
    { file: 'tex/c.png', type: 'color3', colorspace: 'srgb_texture' },
    { file: 'tex/sub/r.png', type: 'float', addressU: 'clamp', addressV: 'mirror', filter: 'closest' },
  ]);
  assert.deepEqual(skipped, []);
});

test('with no hook an image is skipped by name and the default stands; uv tiling is named', async () => {
  const body = `<tiledimage name="C" type="color3"><input name="file" type="filename" value="c.png"/><input name="uvtiling" type="vector2" value="2, 2"/><input name="uvoffset" type="vector2" value="0.5, 0"/></tiledimage>
    <gltf_pbr name="S" type="surfaceshader"><input name="base_color" type="color3" nodename="C"/></gltf_pbr>${material('S')}`;
  const none = await emitOf(body);
  assert.deepEqual(none.emit.color.value, [1, 1, 1, 1]);
  assert.match(none.skipped[0].reason, /c\.png/);
  const tiled = await emitOf(body, { texture: (request) => texture(request.file) });
  assert.equal(tiled.emit.color.type, 'texture');
  assert.deepEqual(
    tiled.skipped.map((item) => item.reason.split(' ')[0]),
    ['uvtiling', 'uvoffset'],
  );
});

test('maths nodes map to add, mul and mix; subtract through both; dot and convert pass on', async () => {
  const { emit, skipped } = await emitOf(
    `<constant name="a" type="float"><input name="value" type="float" value="2"/></constant>
     <dot name="d" type="float"><input name="in" type="float" nodename="a"/></dot>
     <convert name="v" type="float"><input name="in" type="float" nodename="d"/></convert>
     <add name="s" type="float"><input name="in1" type="float" nodename="v"/><input name="in2" type="float" value="3"/></add>
     <multiply name="m" type="float"><input name="in1" type="float" nodename="s"/></multiply>
     <subtract name="u" type="float"><input name="in1" type="float" value="1"/><input name="in2" type="float" value="4"/></subtract>
     <mix name="x" type="color3"><input name="fg" type="color3" value="1, 0, 0"/><input name="bg" type="color3" value="0, 0, 1"/><input name="mix" type="float" nodename="m"/></mix>
     <gltf_pbr name="S" type="surfaceshader"><input name="base_color" type="color3" nodename="x"/><input name="roughness" type="float" nodename="u"/></gltf_pbr>${material('S')}`,
  );
  const { color, metalRough } = emit;
  assert.equal(color.type, 'mix');
  assert.deepEqual(color.a.value, [0, 0, 1, 1]);
  assert.deepEqual(color.b.value, [1, 0, 0, 1]);
  assert.equal(color.factor.type, 'mul');
  assert.equal(color.factor.b.value, 1);
  assert.equal(color.factor.a.type, 'add');
  assert.equal(color.factor.a.a.value, 2);
  assert.equal(color.factor.a.b.value, 3);
  const { roughness } = metalRough;
  assert.equal(roughness.type, 'add');
  assert.equal(roughness.a.value, 1);
  assert.equal(roughness.b.a.value, 4);
  assert.equal(roughness.b.b.value, -1);
  assert.deepEqual(skipped, []);
});

test('a node used twice is one object in the graph', async () => {
  const { emit } = await emitOf(
    `<add name="s" type="float"><input name="in1" type="float" value="1"/></add>
     <gltf_pbr name="S" type="surfaceshader"><input name="roughness" type="float" nodename="s"/><input name="metallic" type="float" nodename="s"/></gltf_pbr>${material('S')}`,
  );
  assert.equal(emit.metalRough.roughness, emit.metalRough.metal);
});

test('node graphs: an output connection, the first output by default, and interface inputs', async () => {
  const { emit } = await emitOf(
    `<nodegraph name="G">
       <input name="tint" type="float" value="0.5"/>
       <multiply name="m" type="float"><input name="in1" type="float" interfacename="tint"/><input name="in2" type="float" value="2"/></multiply>
       <constant name="k" type="float"><input name="value" type="float" value="0.125"/></constant>
       <output name="first" type="float" nodename="k"/>
       <output name="second" type="float" nodename="m"/>
     </nodegraph>
     <gltf_pbr name="S" type="surfaceshader">
       <input name="roughness" type="float" nodegraph="G" output="second"/>
       <input name="metallic" type="float" nodegraph="G"/>
     </gltf_pbr>${material('S')}`,
  );
  assert.equal(emit.metalRough.roughness.type, 'mul');
  assert.equal(emit.metalRough.roughness.a.value, 0.5);
  assert.equal(emit.metalRough.metal.value, 0.125);
});

test('a normal map converts with its scale; a normal from anything else is named', async () => {
  const image = `<image name="N" type="vector3"><input name="file" type="filename" value="n.png"/></image>`;
  const { emit } = await emitOf(
    `${image}<normalmap name="Q" type="vector3"><input name="in" type="vector3" nodename="N"/><input name="scale" type="float" value="0.5"/></normalmap>
     <standard_surface name="S" type="surfaceshader"><input name="normal" type="vector3" nodename="Q"/></standard_surface>${material('S')}`,
    { texture: (request) => texture(request.file) },
  );
  assert.equal(emit.normal.type, 'normalMap');
  assert.equal(emit.normal.texture.texture.view.file, 'n.png');
  assert.equal(emit.normal.scale.value, 0.5);
  const raw = await emitOf(
    `${image}<standard_surface name="S" type="surfaceshader"><input name="normal" type="vector3" nodename="N"/></standard_surface>${material('S')}`,
    { texture: (request) => texture(request.file) },
  );
  assert.equal(raw.emit.normal, undefined);
  assert.match(raw.skipped[0].reason, /normalmap/);
});

test('what has no node material form is named, and the rest converts', async () => {
  const { emit, skipped } = await emitOf(
    `<noise2d name="n" type="float"/>
     <standard_surface name="S" type="surfaceshader">
       <input name="specular_roughness" type="float" nodename="n"/>
       <input name="emission" type="float" value="1"/>
       <input name="opacity" type="color3" value="0.5, 0.5, 0.5"/>
       <input name="tangent" type="vector3" value="1, 0, 0"/>
     </standard_surface>${material('S')}`,
  );
  assert.equal(emit.metalRough.roughness.value, 0.2);
  assert.deepEqual(
    skipped.map((item) => item.input),
    ['specular_roughness', 'emission', 'opacity'],
  );
  assert.match(skipped[0].reason, /noise2d/);
});

test('materials pick by name, and asking for what is not there is refused', async () => {
  const parsed = parseMaterialX(
    doc(`<gltf_pbr name="A" type="surfaceshader"/><gltf_pbr name="B" type="surfaceshader"><input name="roughness" type="float" value="0.5"/></gltf_pbr>
      <surfacematerial name="MA" type="material"><input name="surfaceshader" type="surfaceshader" nodename="A"/></surfacematerial>
      <surfacematerial name="MB" type="material"><input name="surfaceshader" type="surfaceshader" nodename="B"/></surfacematerial>
      <surfacematerial name="none" type="material"/>
      <surfacematerial name="other" type="material"><input name="surfaceshader" type="surfaceshader" nodename="X"/></surfacematerial>
      <disney_principled name="X" type="surfaceshader"/>`),
  );
  const { graph } = await parsed.toGraph('MB');
  assert.equal(graph.nodes[0].metalRough.roughness.value, 0.5);
  await rejects(parsed.toGraph('nope'), 'range');
  await rejects(parsed.toGraph('none'), 'syntax');
  await rejects(parsed.toGraph('other'), 'unsupported');
  await rejects(parseMaterialX(doc('')).toGraph(), 'range');
});

test('a surface shader reached through a node graph is found', () => {
  const parsed = parseMaterialX(
    doc(`<nodegraph name="G"><gltf_pbr name="S" type="surfaceshader"/><output name="o" type="surfaceshader" nodename="S"/></nodegraph>
      <surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodegraph="G"/></surfacematerial>`),
  );
  assert.equal(parsed.materials[0].shader.category, 'gltf_pbr');
});

test('loops and broken connections are refused', async () => {
  const shader = (input) => `<gltf_pbr name="S" type="surfaceshader">${input}</gltf_pbr>${material('S')}`;
  await rejects(
    parseMaterialX(
      doc(`<add name="a" type="float"><input name="in1" type="float" nodename="b"/></add>
           <add name="b" type="float"><input name="in1" type="float" nodename="a"/></add>
           ${shader('<input name="roughness" type="float" nodename="a"/>')}`),
    ).toGraph(),
    'range',
  );
  await rejects(
    parseMaterialX(doc(shader('<input name="roughness" type="float" nodename="no"/>'))).toGraph(),
    'syntax',
  );
  await rejects(
    parseMaterialX(doc(shader('<input name="roughness" type="float" nodegraph="no"/>'))).toGraph(),
    'syntax',
  );
  await rejects(
    parseMaterialX(
      doc(`<nodegraph name="G"/>${shader('<input name="roughness" type="float" nodegraph="G" output="x"/>')}`),
    ).toGraph(),
    'syntax',
  );
  await rejects(
    parseMaterialX(
      doc(`<nodegraph name="G"><add name="a" type="float"><input name="in1" type="float" interfacename="nope"/></add><output name="o" type="float" nodename="a"/></nodegraph>
           ${shader('<input name="roughness" type="float" nodegraph="G"/>')}`),
    ).toGraph(),
    'syntax',
  );
});

test('a converted graph compiles through the node material, every lobe on', async () => {
  const { graph } = await parseMaterialX(
    doc(`<image name="T" type="color3"><input name="file" type="filename" value="a.png"/></image>
      <image name="N" type="vector3"><input name="file" type="filename" value="n.png"/></image>
      <normalmap name="Q" type="vector3"><input name="in" type="vector3" nodename="N"/><input name="scale" type="float" value="0.5"/></normalmap>
      <mix name="x" type="color3"><input name="fg" type="color3" nodename="T"/><input name="bg" type="color3" value="0, 0, 1"/><input name="mix" type="float" value="0.5"/></mix>
      <standard_surface name="S" type="surfaceshader">
        <input name="base_color" type="color3" nodename="x"/><input name="base" type="float" value="0.5"/>
        <input name="normal" type="vector3" nodename="Q"/><input name="coat" type="float" value="1"/><input name="transmission" type="float" value="0.5"/>
      </standard_surface>${material('S')}`),
  ).toGraph(undefined, { texture: (request) => texture(request.file) });
  const output = materialGraphOutput(graph, { opaqueColor: {} });
  for (const lobe of ['normal', 'metalRough', 'clearcoat', 'transmission']) assert.ok(output[lobe], lobe);
});

test('abort stops a conversion', async () => {
  const controller = new AbortController();
  controller.abort();
  const body = `<gltf_pbr name="S" type="surfaceshader"><input name="roughness" type="float" value="1"/></gltf_pbr>${material('S')}`;
  await rejects(parseMaterialX(doc(body)).toGraph(undefined, { signal: controller.signal }), 'aborted');
});

test('what is not a usable document is refused with its code', () => {
  const constant = (type, value) =>
    doc(`<constant name="c" type="${type}"><input name="value" type="${type}" value="${value}"/></constant>`);
  refuses(() => parseMaterialX('<notx/>'), 'header');
  refuses(() => parseMaterialX(doc('<constant type="float"/>')), 'syntax');
  refuses(() => parseMaterialX(doc('<constant name="c" type="float"><input type="float"/></constant>')), 'syntax');
  refuses(() => parseMaterialX(doc('<nodegraph/>')), 'syntax');
  refuses(() => parseMaterialX(constant('float', 'x')), 'syntax');
  refuses(() => parseMaterialX(constant('float', '')), 'syntax');
  refuses(() => parseMaterialX(constant('boolean', '1')), 'syntax');
  refuses(() => parseMaterialX(constant('color3', '1, 2')), 'syntax');
  refuses(() => parseMaterialX(doc('<material name="old"><shaderref name="s"/></material>')), 'unsupported');
});

test('vector values may be separated by spaces, as real files write them', () => {
  const parsed = parseMaterialX(
    doc(`<tiledimage name="T" type="color3">
       <input name="realworldimagesize" type="vector2" value="0.5 0.5"/>
       <input name="uvtiling" type="vector2" value=" 1.0, 2.0 "/>
     </tiledimage>`),
  );
  assert.deepEqual(parsed.nodes.T.inputs.realworldimagesize.value, [0.5, 0.5]);
  assert.deepEqual(parsed.nodes.T.inputs.uvtiling.value, [1, 2]);
});

test('a type or shader named after an Object member is simply unknown', async () => {
  const parsed = parseMaterialX(
    doc(`<constructor name="S" type="surfaceshader"><input name="x" type="constructor" value="1"/></constructor>
     <surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial>`),
  );
  assert.equal(parsed.nodes.S.inputs.x.value, '1');
  await assert.rejects(parsed.toGraph('M'), (error) => error.name === 'LoaderError' && /constructor/.test(error.message));
});

test('the colour spaces of the specification that replaced the old names read the same', async () => {
  const value = async (space) => {
    const { emit, skipped } = await emitOf(
      `<standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" value="0.5, 0.5, 0.5" colorspace="${space}"/></standard_surface>${material('S')}`,
    );
    assert.deepEqual(skipped, []);
    return emit.color.value[0];
  };
  assert.equal(await value('srgb_rec709_scene'), await value('srgb_texture'));
  assert.equal(await value('lin_rec709_scene'), await value('lin_rec709'));
  assert.equal(await value('data'), await value('none'));
});

// Published nodedefs: standard_surface 1.0.1 and 1.0.0, open_pbr_surface 1.1.2, gltf_pbr 2.0.1 and UsdPreviewSurface 2.6.
const PUBLISHED = {
  standard_surface: { color: [0.8, 0.8, 0.8], roughness: 0.2, metal: 0, coat: ['coat', 0.1], ior: ['transmission', 'specular_IOR'] },
  open_pbr_surface: { color: [0.8, 0.8, 0.8], roughness: 0.3, metal: 0, coat: ['coat_weight', 0], ior: ['transmission_weight', 'specular_ior'] },
  gltf_pbr: { color: [1, 1, 1], roughness: 1, metal: 1, coat: ['clearcoat', 0], ior: ['transmission', 'ior'] },
  UsdPreviewSurface: { color: [0.18, 0.18, 0.18], roughness: 0.5, metal: 0, coat: ['clearcoat', 0.01], ior: ['transmission', 'ior'] },
};

for (const [category, want] of Object.entries(PUBLISHED))
  test(`${category} with nothing set takes the defaults of its published definition`, async () => {
    const shader = (inputs) => `<${category} name="S" type="surfaceshader">${inputs}</${category}>${material('S')}`,
      { emit } = await emitOf(shader(''));
    assert.deepEqual(emit.color.value.slice(0, 3), want.color);
    assert.equal(emit.metalRough.roughness.value, want.roughness);
    assert.equal(emit.metalRough.metal.value, want.metal);
    assert.equal(emit.clearcoat, undefined);
    assert.equal(emit.transmission, undefined);
    const on = (name) => `<input name="${name}" type="float" value="0.5" />`,
      lobes = (await emitOf(shader(on(want.coat[0]) + on(want.ior[0])))).emit;
    assert.ok(Math.abs(lobes.clearcoat.roughness.value - want.coat[1]) < 1e-9);
    assert.equal(lobes.transmission.ior.value, 1.5);
  });

test('a standard_surface that names the older definition takes its base and base colour', async () => {
  const older = async (attribute, inputs = '') =>
    (await emitOf(`<standard_surface name="S" type="surfaceshader" ${attribute}>${inputs}</standard_surface>${material('S')}`))
      .emit.color;
  for (const attribute of ['version="1.0.0"', 'nodedef="ND_standard_surface_surfaceshader_100"']) {
    const unset = await older(attribute);
    assert.equal(unset.type, 'mul');
    assert.deepEqual(unset.a.value.slice(0, 3), [1, 1, 1]);
    assert.equal(unset.b.value, 0.8);
    const red = await older(attribute, '<input name="base_color" type="color3" value="1, 0, 0" />');
    assert.deepEqual(red.a.value.slice(0, 3), [1, 0, 0]);
    assert.equal(red.b.value, 0.8);
  }
  const current = await older('version="1.0.1"', '<input name="base_color" type="color3" value="1, 0, 0" />');
  assert.deepEqual(current.value.slice(0, 3), [1, 0, 0]);
});
