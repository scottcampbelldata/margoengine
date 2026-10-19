// COLLADA 1.4.1 writer: well-formed XML read back by a minimal reader written here, references, accessor counts and
// strides, index ranges, effects and the node hierarchy; then three.js ColladaLoader (a test oracle only) reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDAE } from '../dist/index.js';

/** A non-validating XML reader: elements with attributes, text and children; throws on bad nesting or syntax. */
function readXML(xml) {
  const root = { name: '#document', attributes: {}, children: [], text: '' },
    stack = [root];
  let at = 0;
  const decl = /^<\?xml[^?]*\?>\s*/.exec(xml);
  if (decl) at = decl[0].length;
  const tag = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<&]*")*)\s*(\/?)>/y;
  while (at < xml.length) {
    const lt = xml.indexOf('<', at);
    const text = xml.slice(at, lt < 0 ? xml.length : lt);
    assert.doesNotMatch(text, /[<&]/, 'text must not hold raw markup');
    stack.at(-1).text += text;
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(xml);
    assert.ok(m, `malformed tag at ${lt}: ${xml.slice(lt, lt + 40)}`);
    at = tag.lastIndex;
    if (m[1]) {
      assert.equal(stack.pop().name, m[2], 'closing tag matches');
      continue;
    }
    const element = { name: m[2], attributes: {}, children: [], text: '', parent: stack.at(-1) };
    for (const [, key, value] of m[3].matchAll(/([\w.:-]+)="([^"]*)"/g)) {
      assert.equal(element.attributes[key], undefined, 'no duplicate attribute');
      element.attributes[key] = value;
    }
    stack.at(-1).children.push(element);
    if (!m[4]) stack.push(element);
  }
  assert.equal(stack.length, 1, 'every element is closed');
  assert.equal(root.children.length, 1, 'one document element');
  assert.equal(root.text.trim(), '');
  return root.children[0];
}
const all = (element, name, out = []) => {
  for (const child of element.children) {
    if (child.name === name) out.push(child);
    all(child, name, out);
  }
  return out;
};
const one = (element, name) => {
  const found = element.children.filter((c) => c.name === name);
  assert.equal(found.length, 1, `one <${name}> in <${element.name}>`);
  return found[0];
};
const numbers = (element) => element.text.trim().split(/\s+/).map(Number);

const tile = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0],
  normals: Array.from({ length: 5 }, () => [0, 0, 1]).flat(),
  uvs: [0, 1, 1, 1, 1, 0, 0, 0, 1, 1],
  colors: Array.from({ length: 5 }, () => [0.5, 0.25, 1]).flat(),
  indices: [0, 1, 2, 0, 2, 3, 1, 4, 2],
  faceSizes: [4, 3],
};
const plain = { positions: tile.positions.slice(0, 9), normals: tile.normals.slice(0, 9), indices: [0, 1, 2] };
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0);
const texture = {
  image: png,
  mimeType: 'image/png',
  name: 'tile set',
  magFilter: 'nearest',
  minFilter: 'nearest',
  mipmaps: false,
  wrapS: 'clamp',
};

function scene() {
  const grass = { name: 'grass', baseColorTexture: texture },
    glass = { name: 'glass pane', color: [0.2, 0.4, 0.6, 0.5], alphaMode: 'BLEND', roughness: 0.5, metalness: 0.25 },
    flat = { name: 'flat', unlit: true, color: [1, 0, 0] };
  return {
    nodes: [
      {
        name: 'level 1',
        translation: [1, 2, 3],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        geometry: tile,
        material: grass,
        children: [
          { name: 'pane', scale: [2, 2, 2], geometry: tile, material: glass },
          { name: 'marker', geometry: plain, material: flat, children: [{ name: 'empty' }] },
        ],
      },
      { name: 'loose', geometry: plain },
    ],
  };
}

test('DAE is well-formed COLLADA 1.4.1 with resolvable references, counts, strides and index ranges', () => {
  const { dae, textures } = exportDAE(scene(), { texturePrefix: 'textures/' }),
    collada = readXML(dae);
  assert.equal(collada.name, 'COLLADA');
  assert.equal(collada.attributes.xmlns, 'http://www.collada.org/2005/11/COLLADASchema');
  assert.equal(collada.attributes.version, '1.4.1');
  // Schema order: asset first, libraries, then scene.
  assert.deepEqual(
    collada.children.map((c) => c.name),
    [
      'asset',
      'library_images',
      'library_effects',
      'library_materials',
      'library_geometries',
      'library_visual_scenes',
      'scene',
    ],
  );
  const asset = one(collada, 'asset');
  assert.deepEqual(
    asset.children.map((c) => c.name),
    ['contributor', 'created', 'modified', 'unit', 'up_axis'],
  );
  assert.match(one(asset, 'created').text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(one(asset, 'up_axis').text, 'Y_UP');
  assert.deepEqual(one(asset, 'unit').attributes, { name: 'meter', meter: '1' });

  // Every id is unique and every #url, source and target resolves.
  const ids = new Map();
  const walk = (element) => {
    if (element.attributes.id) {
      assert.ok(!ids.has(element.attributes.id), `duplicate id ${element.attributes.id}`);
      assert.match(element.attributes.id, /^[A-Za-z_][\w.-]*$/);
      ids.set(element.attributes.id, element);
    }
    if (element.attributes.name !== undefined && element.name !== 'param' && element.name !== 'unit')
      assert.match(element.attributes.name, /^[A-Za-z_][\w.-]*$/, 'names are NCNames');
    element.children.forEach(walk);
  };
  walk(collada);
  const resolve = (ref) => {
    assert.match(ref, /^#/);
    const target = ids.get(ref.slice(1));
    assert.ok(target, `unresolved ${ref}`);
    return target;
  };
  for (const name of ['instance_effect', 'instance_geometry', 'instance_visual_scene'])
    for (const e of all(collada, name)) resolve(e.attributes.url);
  for (const e of [...all(collada, 'input'), ...all(collada, 'accessor')]) resolve(e.attributes.source);

  // Images: relative paths with the prefix; the bytes come back once.
  const images = all(collada, 'image');
  assert.equal(images.length, 1);
  assert.equal(one(images[0], 'init_from').text, 'textures/tile_set.png');
  assert.deepEqual([...textures], [['textures/tile_set.png', png]]);

  // Effects: textured lambert with its sampler, phong with transparency, constant for unlit.
  const effect = (material) => resolve(one(ids.get(material), 'instance_effect').attributes.url);
  const technique = (material) => one(one(effect(material), 'profile_COMMON'), 'technique').children[0];
  const byName = (name) => all(collada, 'material').find((m) => m.attributes.name === name).attributes.id;
  const grass = technique(byName('grass'));
  assert.equal(grass.name, 'lambert');
  const textureRef = one(one(grass, 'diffuse'), 'texture');
  assert.equal(textureRef.attributes.texcoord, 'UVSET0');
  const params = all(effect(byName('grass')), 'newparam'),
    sampler = params.find((p) => p.attributes.sid === textureRef.attributes.texture);
  assert.ok(sampler, 'texture names a sampler newparam');
  const sampler2D = one(sampler, 'sampler2D');
  assert.deepEqual(
    sampler2D.children.map((c) => [c.name, c.text]),
    [
      ['source', params[0].attributes.sid],
      ['wrap_s', 'CLAMP'],
      ['wrap_t', 'WRAP'],
      ['minfilter', 'NEAREST'],
      ['magfilter', 'NEAREST'],
    ],
  );
  assert.equal(one(one(params[0], 'surface'), 'init_from').text, images[0].attributes.id);
  const glass = technique(byName('glass_pane'));
  assert.equal(glass.name, 'phong');
  assert.deepEqual(
    glass.children.map((c) => c.name),
    ['diffuse', 'specular', 'shininess', 'transparent', 'transparency'],
  );
  assert.equal(one(glass, 'transparent').attributes.opaque, 'A_ONE');
  assert.equal(numbers(one(one(glass, 'transparent'), 'color'))[3], 0.5);
  assert.equal(numbers(one(one(glass, 'shininess'), 'float'))[0], 30, '2 / 0.5^4 - 2');
  const flat = technique(byName('flat'));
  assert.equal(flat.name, 'constant');
  assert.deepEqual(numbers(one(one(flat, 'emission'), 'color')), [1, 0, 0, 1]);

  // Geometries: one per shared geometry; accessor count * stride = float_array count; indices in range.
  const geometries = all(collada, 'geometry');
  assert.equal(geometries.length, 2);
  for (const geometry of geometries) {
    const mesh = one(geometry, 'mesh');
    for (const source of all(mesh, 'source')) {
      const array = one(source, 'float_array'),
        accessor = one(one(source, 'technique_common'), 'accessor'),
        values = numbers(array);
      assert.equal(Number(array.attributes.count), values.length);
      assert.ok(values.every(Number.isFinite));
      assert.equal(Number(accessor.attributes.count) * Number(accessor.attributes.stride), values.length);
      assert.equal(all(accessor, 'param').length, Number(accessor.attributes.stride));
      assert.equal(resolve(accessor.attributes.source), array);
    }
    const primitive = mesh.children.at(-1),
      inputs = primitive.children.filter((c) => c.name === 'input'),
      p = numbers(one(primitive, 'p'));
    assert.deepEqual(mesh.children.map((c) => c.name).slice(-2), ['vertices', primitive.name]);
    assert.ok(inputs.every((input) => input.attributes.offset === '0'));
    const vertexCount = Number(all(mesh, 'accessor')[0].attributes.count);
    for (const input of inputs.slice(1))
      assert.equal(Number(all(resolve(input.attributes.source), 'accessor')[0].attributes.count), vertexCount);
    assert.ok(p.every((i) => Number.isInteger(i) && i >= 0 && i < vertexCount));
    if (primitive.name === 'polylist') {
      const vcount = numbers(one(primitive, 'vcount'));
      assert.deepEqual(vcount, [4, 3]);
      assert.equal(Number(primitive.attributes.count), vcount.length);
      assert.equal(
        vcount.reduce((a, b) => a + b),
        p.length,
      );
      assert.deepEqual(p, [0, 1, 2, 3, 1, 4, 2]);
      assert.deepEqual(
        inputs.map((i) => i.attributes.semantic),
        ['VERTEX', 'NORMAL', 'TEXCOORD', 'COLOR'],
      );
      // t = 1 - v and sRGB vertex colors by default.
      const uvs = numbers(one(resolve(inputs[2].attributes.source), 'float_array')),
        colors = numbers(one(resolve(inputs[3].attributes.source), 'float_array'));
      assert.deepEqual(uvs.slice(0, 4), [0, 0, 1, 0]);
      assert.ok(Math.abs(colors[0] - 0.7353569) < 1e-6);
    } else {
      assert.equal(primitive.name, 'triangles');
      assert.equal(Number(primitive.attributes.count) * 3, p.length);
    }
  }

  // Visual scene: the hierarchy, row-major matrices and material bindings.
  const top = one(one(collada, 'library_visual_scenes'), 'visual_scene').children[0];
  assert.equal(top.attributes.name, 'level_1');
  const matrix = numbers(one(top, 'matrix'));
  assert.deepEqual([matrix[3], matrix[7], matrix[11]], [1, 2, 3], 'translation in the last column of row-major rows');
  assert.ok(Math.abs(matrix[2] - 1) < 1e-6 && Math.abs(matrix[8] + 1) < 1e-6, '+90 degrees about y');
  assert.deepEqual(
    top.children.map((c) => c.name),
    ['matrix', 'instance_geometry', 'node', 'node'],
  );
  assert.deepEqual(
    all(top, 'node').map((n) => n.attributes.name),
    ['pane', 'marker', 'empty'],
  );
  for (const instance of all(collada, 'instance_geometry')) {
    const bound = all(instance, 'instance_material');
    if (!bound.length) continue;
    const geometry = resolve(instance.attributes.url),
      primitive = one(geometry, 'mesh').children.at(-1);
    assert.equal(bound[0].attributes.symbol, primitive.attributes.material);
    resolve(bound[0].attributes.target);
  }
  assert.equal(
    all(collada.children.at(-2).children[0].children.at(-1), 'instance_material').length,
    0,
    'unbound geometry',
  );
});

test('DAE options: linear vertex colors, triangles without faceSizes, and invalid input', () => {
  const linear = readXML(exportDAE({ nodes: [{ geometry: tile }] }, { colorSpace: 'linear' }).dae);
  const colors = all(linear, 'float_array').find((a) => a.attributes.id.endsWith('colors-array'));
  assert.deepEqual(numbers(colors).slice(0, 3), [0.5, 0.25, 1]);
  const triangles = readXML(exportDAE({ nodes: [{ geometry: { ...tile, faceSizes: undefined } }] }).dae);
  assert.equal(all(triangles, 'polylist').length, 0);
  assert.equal(all(triangles, 'triangles')[0].attributes.count, '3');
  assert.throws(() => exportDAE({ nodes: [] }), TypeError);
  assert.throws(() => exportDAE({ nodes: [{ geometry: plain }] }, { colorSpace: 'srgb8' }), TypeError);
  assert.throws(() => exportDAE({ nodes: [{ geometry: plain }] }, { texturePrefix: 'a b/' }), TypeError);
  assert.throws(
    () => exportDAE({ nodes: [{ geometry: plain, material: { baseColorTexture: texture } }] }),
    /need geometry with uvs/,
  );
});

test('three.js ColladaLoader (test oracle) reads the hierarchy, polygons and shading models', async () => {
  const { JSDOM } = await import('jsdom');
  globalThis.DOMParser = new JSDOM('').window.DOMParser;
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
  const data = scene();
  data.nodes[0].material = { name: 'grass' }; // untextured: the oracle would fetch image files
  const { log, warn, debug } = console;
  console.log = console.warn = console.debug = () => {};
  let result;
  try {
    result = new ColladaLoader().parse(exportDAE(data).dae, '');
  } finally {
    Object.assign(console, { log, warn, debug });
  }
  const level = result.scene.getObjectByName('level_1'),
    own = level.children.find((o) => o.isMesh && !o.name),
    pane = result.scene.getObjectByName('pane'),
    marker = result.scene.getObjectByName('marker');
  assert.deepEqual(
    level.position.toArray().map((v) => Math.round(v * 1e6) / 1e6),
    [1, 2, 3],
  );
  assert.equal(own.material.type, 'MeshLambertMaterial');
  assert.equal(own.geometry.attributes.position.count, 9, 'the quad and the triangle become three triangles');
  assert.deepEqual(Object.keys(own.geometry.attributes).sort(), ['color', 'normal', 'position', 'uv']);
  assert.equal(pane.material.type, 'MeshPhongMaterial');
  assert.ok(pane.material.transparent);
  assert.deepEqual(pane.scale.toArray(), [2, 2, 2]);
  assert.equal(marker.children.find((o) => o.isMesh).material.type, 'MeshBasicMaterial');
  assert.equal(result.scene.getObjectByName('empty').parent, marker);
  assert.equal(result.scene.getObjectByName('loose').geometry.attributes.position.count, 3);
});
