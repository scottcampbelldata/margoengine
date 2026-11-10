import assert from 'node:assert/strict';
import test from 'node:test';
import { PointCloud } from '../../points/dist/index.js';
import { PBRInstances } from '../../gltf-pro/dist/instancing.js';
import { TilesStyle } from '../dist/style.js';
import { BatchTable, FeatureTable } from '../dist/index.js';

const value = (source, properties = {}) => new TilesStyle({ meta: { value: source } }).evaluate(properties).meta.value;
test('OGC styling: ordered conditions, defines, property paths and metadata', () => {
  const style = new TilesStyle({
    defines: { Height: '${Height}/2' },
    show: '${Height} > 10',
    pointSize: 'clamp(${Height}, 1, 12)',
    color: {
      conditions: [
        ['${Height} > 100', "color('blue')"],
        ['true', "color('red', 0.5)"],
      ],
    },
    meta: { name: '`Building ${feature["building:name"]}, ${address.street}`' },
  });
  assert.deepEqual(style.evaluate({ Height: 40, 'building:name': 'A', address: { street: 'Main' } }), {
    color: [1, 0, 0, 0.5],
    show: true,
    pointSize: 12,
    meta: { name: 'Building A, Main' },
  });
  assert.equal(value('${missing}'), undefined);
  assert.equal(value('${feature}'), undefined);
  assert.equal(value('${feature["address.street"]}', { 'address.street': 'flat' }), 'flat');
  assert.equal(new TilesStyle({ color: { conditions: [] } }).evaluate().color, undefined);
});
test('OGC styling: precedence and short circuit without host access', () => {
  assert.equal(value('1 + 2 * 3 === 7 && !false'), true);
  assert.equal(value('false && unknown()'), false);
  assert.equal(value('true ? 4 : unknown()'), 4);
  assert.equal(value('false ? unknown() : true ? 5 : 6'), 5);
  assert.equal(value('Math.PI > 3 && Math.E > 2'), true);
  for (const source of [
    'globalThis',
    'new Function("return 1")',
    '${x}.constructor()',
    '1; process.exit()',
    'Math.random()',
    '${x[foo()]}',
  ])
    assert.throws(() => value(source, { x: {} }), /Tile style/);
});
test('OGC styling: vectors, CSS colours, numeric functions and conversions', () => {
  assert.equal(value('vec3(1) === vec3(1,1,1)'), true);
  assert.equal(value('vec3(1) !== vec4(1)'), true);
  assert.equal(value('dot(vec3(1,2,3),vec3(2,3,4))'), 20);
  assert.equal(value('cross(vec3(1,0,0),vec3(0,1,0)).z'), 1);
  assert.equal(value('length(normalize(vec2(3,4)))'), 1);
  assert.equal(value('distance(vec2(1,1),vec2(4,5))'), 5);
  assert.equal(value('color("LIGHTSLATEGREY").r'), 119 / 255);
  assert.equal(value('hsl(0,1,0.5) === rgb(255,0,0)'), true);
  assert.equal(value('vec4(vec2(1,2),3,4).a'), 4);
  assert.equal(value('String(vec2(1,2))'), '(1, 2)');
  assert.equal(value('String([1,2])'), '[1, 2]');
  assert.equal(value('fract(-1.25) + min(2,3) * max(1,2)'), 4.75);
  assert.equal(value('mix(vec2(0),vec2(2),0.5).x'), 1);
  assert.equal(value('Boolean(1) && isNaN(Number("bad")) && !isFinite(Infinity)'), true);
  for (const name of [
    'abs',
    'sqrt',
    'cos',
    'sin',
    'tan',
    'acos',
    'asin',
    'atan',
    'sign',
    'floor',
    'ceil',
    'round',
    'exp',
    'log',
    'exp2',
    'log2',
    'radians',
    'degrees',
  ])
    assert.equal(typeof value(`${name}(0.5)`), 'number');
});
test('OGC styling: regular expressions are repeatable, captured strings and both match orders', () => {
  assert.equal(value("regExp('a(.)', 'i').exec('Abc')"), 'b');
  assert.equal(value("'abc' =~ regExp('a')"), true);
  assert.equal(value("regExp('a') !~ 'bcd'"), true);
  const style = new TilesStyle({ show: "regExp('^Building', 'g').test(${name})" });
  for (let i = 0; i < 3; i++) assert.equal(style.evaluate({ name: 'Building 1' }).show, true);
});
test('style outputs reject incorrect types, malformed input and excessive nesting', () => {
  for (const style of [
    { show: '1' },
    { color: 'vec3(1)' },
    { pointSize: '-1' },
    { pointSize: 'NaN' },
    { show: { conditions: [['1', 'true']] } },
  ])
    assert.throws(() => new TilesStyle(style).evaluate(), /Style|style/);
  for (const source of ['1 +', 'vec2(1', 'true false', '('.repeat(130) + '1' + ')'.repeat(130)])
    assert.throws(() => value(source), /Tile style/);
});
test('point styling changes colour, visibility and pixel size and restores authored arrays', () => {
  const cloud = new PointCloud({
    positions: [0, 0, 0, 1, 0, 0],
    colors: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 128]),
    colorComponents: 4,
    sizes: [2, 3],
    material: { size: 4 },
  });
  const original = cloud.colors.slice();
  const binding = new TilesStyle({
    color: '${id} === 0 ? color("red") : color("blue")',
    show: '${id} === 0',
    pointSize: '${id} + 8',
  }).bindPoints(cloud, (i) => ({ id: i }));
  assert.deepEqual([...cloud.sizes], [8, 0]);
  assert.deepEqual([...new Uint8Array(cloud.colors.buffer)], [255, 0, 0, 255, 0, 0, 255, 0]);
  assert.equal(cloud.material.minPixelSize, 0);
  binding.update(new TilesStyle({ pointSize: 2 }));
  assert.deepEqual([...cloud.sizes], [2, 2]);
  binding.dispose();
  binding.dispose();
  assert.deepEqual(cloud.colors, original);
  assert.deepEqual([...cloud.sizes], [2, 3]);
  assert.equal(cloud.material.size, 4);
  assert.equal(cloud.material.minPixelSize, 1);
  assert.throws(() => binding.update(new TilesStyle()), /disposed/);
});
test('instance styling retains row IDs, hides geometry and restores transforms and tint', () => {
  const rows = new PBRInstances(2),
    original = rows.data.slice();
  const binding = new TilesStyle({ show: '${id} === 0', color: 'color("red")' }).bindInstances(rows, (i) => ({
    id: i,
  }));
  assert.equal(rows.count, 2);
  assert.equal(rows.getMatrixAt(1)[0], 0);
  assert.deepEqual([...rows.data.slice(16, 20)], [1, 0, 0, 1]);
  binding.update(new TilesStyle());
  assert.equal(rows.getMatrixAt(1)[0], 1);
  binding.dispose();
  assert.deepEqual(rows.data, original);
});
test('point styling handles large point sets without a function argument spread', () => {
  const cloud = new PointCloud({ positions: new Float32Array(262144 * 3) });
  const binding = new TilesStyle({ pointSize: 300 }).bindPoints(cloud, () => ({}));
  assert.equal(cloud.sizes.length, 262144);
  assert.equal(cloud.material.maxPixelSize, 300);
  binding.dispose();
  assert.equal(cloud.sizes, null);
});
test('streaming point decorator resolves reordered batch IDs and budgets only the added GPU buffers', () => {
  const content = {
    type: 'pnts',
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    batchIds: new Uint32Array([1, 0]),
    batchTable: new BatchTable({ height: [1, 10] }, new Uint8Array(), 2),
    featureTable: new FeatureTable({}, new Uint8Array()),
    byteLength: 24,
  };
  const cloud = new PointCloud({ positions: content.positions });
  const decoration = new TilesStyle({ show: '${height} > 5', pointSize: '${height}' }).decorate({
    kind: 'points',
    cloud,
    content,
    tile: {},
  });
  assert.deepEqual([...cloud.sizes], [10, 0]);
  assert.equal(decoration.bytes, 16);
  decoration.dispose();
  assert.equal(cloud.colors, null);
  assert.equal(cloud.sizes, null);
});
test('model binding is atomic, non-accumulating and restores materials and extensions', () => {
  const vertices = new Float32Array(60);
  for (let i = 0; i < 3; i++) vertices.set([1, 1, 1, 1], i * 20 + 16);
  const material = { settings: [0, 0.5, 0] },
    extension = { wgsl: '// prior' };
  const primitive = { vertices, indices: new Uint32Array([0, 1, 2]), material, extension };
  const model = {
    primitives: [primitive],
    writeGeometry(values) {
      values.forEach((g, i) => Object.assign(this.primitives[i], { vertices: g.vertices, indices: g.indices }));
    },
  };
  const binding = new TilesStyle({ show: '${id} !== 1', color: 'color("red",0.5)' }).bindModel(model, (_, i) => ({
    id: i,
  }));
  assert.equal(primitive.vertices[19], 0.5);
  assert.equal(primitive.vertices[39], 0);
  assert.equal(primitive.material.settings[0], 2);
  assert.match(primitive.extension.wgsl, /discard/);
  const previous = primitive.vertices;
  assert.throws(() => binding.update(new TilesStyle({ color: 'vec3(1)' })), /color/);
  assert.equal(primitive.vertices, previous);
  binding.update(new TilesStyle({ color: 'color("blue")' }));
  assert.equal(primitive.vertices[18], 1);
  binding.dispose();
  assert.equal(primitive.material, material);
  assert.equal(primitive.extension, extension);
  assert.deepEqual(primitive.vertices, vertices);
});
