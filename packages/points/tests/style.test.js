// Attribute filters and 3D Tiles style expressions on point clouds (margoengine/points/style). Every expected value is
// computed here independently, with plain loops over the same columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PointCloud } from '../dist/index.js';
import { buildOctree } from '../dist/octree.js';
import { parseLAS, writeLAS } from '../dist/las.js';
import { PointStyle, bindPointStyle, createStyledCloud, styleNode, styleSource } from '../dist/style.js';

const table = {
  positions: new Float32Array([0, 0, 0, 1, 2, 3, 2, 4, 6, 3, 6, 9, 4, 8, 12]),
  classification: new Uint8Array([2, 2, 6, 7, 6]),
  intensity: new Uint16Array([0, 1000, 30000, 65535, 500]),
  return_number: new Uint8Array([1, 2, 1, 1, 3]),
  numberOfReturns: new Uint8Array([1, 3, 1, 2, 3]),
  gpsTime: new Float64Array([10, 20, 30, 40, 50]),
  pointSourceId: new Uint16Array([7, 7, 8, 9, 7]),
};

test('Potree filters: classes, return number, number of returns, GPS time, source and any range, inclusive', () => {
  const run = (filter) => [...new PointStyle({ filter }).evaluate(table).show];
  assert.deepEqual(run({ classification: [2, 6] }), [1, 1, 1, 0, 1]);
  // The filter name is camelCase; the column is snake_case: names match ignoring case and separators.
  assert.deepEqual(run({ returnNumber: [1, 1] }), [1, 0, 1, 1, 0]);
  assert.deepEqual(run({ numberOfReturns: [2, 3] }), [0, 1, 0, 1, 1]);
  assert.deepEqual(run({ gpsTime: [20, 40] }), [0, 1, 1, 1, 0]);
  assert.deepEqual(run({ pointSourceId: [7, 7] }), [1, 1, 0, 0, 1]);
  assert.deepEqual(run({ ranges: { intensity: [500, Infinity] } }), [0, 1, 1, 1, 1]);
  assert.deepEqual(run({ classification: [6], gpsTime: [-Infinity, 45] }), [0, 0, 1, 0, 0]);
  const result = new PointStyle({ filter: { pointSourceId: [8, 9] } }).evaluate(table);
  assert.equal(result.shown, 2);
  assert.equal(result.colors, null);
  assert.equal(result.sizes, null);
  assert.throws(() => new PointStyle({ filter: { gpsTime: [5, 1] } }), RangeError);
  assert.throws(() => new PointStyle({ filter: { classification: [2.5] } }), RangeError);
  assert.throws(() => new PointStyle({ filter: { ranges: { scan: [0, NaN] } } }), RangeError);
  assert.throws(() => new PointStyle({ filter: { userData: [0, 1] } }).evaluate(table), /no userData column/);
});

test('3D Tiles style: show, conditions, colour functions, defines and point size', () => {
  const style = new PointStyle({
    defines: { bright: '${intensity} / 65535' },
    show: '${Classification} !== 7',
    color: {
      conditions: [
        ['${classification} === 2', "color('#ff0000')"],
        ['${bright} > 0.4', 'rgba(0, 0, 255, 0.5)'],
        ['${ReturnNumber} === 3', 'hsl(0.0, 1.0, 0.5)'],
      ],
    },
    pointSize: '${POSITION}.y > 3.0 ? 4.0 : 2.0',
  });
  const r = style.evaluate(table);
  assert.deepEqual([...r.show], [1, 1, 1, 0, 1]);
  assert.deepEqual([...r.colors.subarray(0, 8)], [1, 0, 0, 1, 1, 0, 0, 1]);
  // Point 2 matches no colour condition... intensity 30000 / 65535 = 0.458 > 0.4: the second condition.
  assert.deepEqual([...r.colors.subarray(8, 12)], [0, 0, 1, 0.5]);
  // Point 4: return 3, hue 0: red. Hidden point 3 keeps zeros.
  assert.deepEqual([...r.colors.subarray(16, 20)], [1, 0, 0, 1]);
  assert.deepEqual([...r.colors.subarray(12, 16)], [0, 0, 0, 0]);
  assert.deepEqual([...r.sizes], [2, 2, 4, Number.NaN, 4]);
});

test('no matching condition keeps the point colour; ${COLOR}, POSITION_ABSOLUTE and vectors follow the spec', () => {
  const colored = {
    ...table,
    colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 51, 51, 51, 255, 102, 204, 0, 255]),
    origin: [100, 0, 0],
  };
  const r = new PointStyle({
    color: { conditions: [['${gpsTime} > 45', 'vec4(${COLOR}.r * 0.5, ${COLOR}.g * 0.5, ${COLOR}.b * 0.5, 1.0)']] },
  }).evaluate(colored);
  assert.deepEqual([...r.colors.subarray(4, 8)], [0, 1, 0, 1]);
  assert.deepEqual([...r.colors.subarray(16, 20)], [0.2, 0.4, 0, 1].map(Math.fround));
  const absolute = new PointStyle({ show: '${POSITION_ABSOLUTE}.x > 102.5' }).evaluate(colored, {
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  });
  assert.deepEqual([...absolute.show], [0, 0, 0, 1, 1]);
  // A vector column (3 values a point) reads as a vec3.
  const normals = { ...table, up: new Float32Array(15).map((_, i) => (i % 3 === 1 ? i / 3 : 0)) };
  assert.deepEqual([...new PointStyle({ show: 'length(${up}) > 1.0' }).evaluate(normals).show], [0, 1, 1, 1, 1]);
});

test('wrong types and syntax throw coded errors; nothing evaluates host JavaScript', () => {
  assert.throws(() => new PointStyle({ show: '${classification} ==' }), { name: 'MargoError', code: 'state' });
  assert.throws(() => new PointStyle({ show: '${classification}' }).evaluate(table), /show must return a boolean/);
  assert.throws(() => new PointStyle({ color: '${intensity}' }).evaluate(table), /four finite components/);
  assert.throws(() => new PointStyle({ pointSize: '-1.0' }).evaluate(table), /pointSize/);
  assert.throws(() => new PointStyle({ show: 'constructor.constructor("return 1")()' }), /Style: /);
  // A missing property is undefined, which a comparison refuses, as the specification says.
  assert.throws(() => new PointStyle({ show: '${nothing} > 1' }).evaluate(table), /expected a number/);
});

test('an aborted signal stops an evaluation', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => new PointStyle({ show: 'true' }).evaluate(table, { signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('bindPointStyle writes colours, sizes and a filter mask, updates, and restores exactly', () => {
  const cloud = new PointCloud({
    positions: table.positions,
    colors: new Uint8Array([9, 8, 7, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
    material: { size: 2 },
  });
  const before = cloud.colors.slice();
  cloud.setMask([1, 0, 1, 0, 1], { mode: 'highlight' });
  const binding = bindPointStyle(cloud, table, {
    filter: { classification: [2, 6] },
    color: { conditions: [['${classification} === 6', "color('blue')"]] },
    pointSize: '6.0',
  });
  assert.equal(binding.result.shown, 4);
  // Point 0 has no matching condition: it keeps its own colour.
  assert.equal(cloud.colors[0], before[0]);
  assert.equal(cloud.colors[2], 0xffff0000);
  assert.deepEqual([...cloud.sizes], [3, 3, 3, 1, 3]);
  assert.equal(cloud.maskStyle.mode, 'filter');
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => cloud.isSelected(i)),
    [true, true, true, false, true],
  );
  binding.update({ filter: { returnNumber: [1, 1] } });
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => cloud.isSelected(i)),
    [true, false, true, true, false],
  );
  assert.deepEqual([...cloud.colors], [...before]);
  assert.equal(cloud.sizes, null);
  // A style that throws leaves the cloud as the last good style wrote it.
  assert.throws(() => binding.update({ show: '${intensity}' }), /boolean/);
  assert.equal(cloud.isSelected(1), false);
  binding.dispose();
  assert.deepEqual([...cloud.colors], [...before]);
  assert.equal(cloud.maskStyle.mode, 'highlight');
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => cloud.isSelected(i)),
    [true, false, true, false, true],
  );
  assert.throws(() => binding.update(), { code: 'disposed' });
});

test('a reordered cloud reads its table through sourceIndex; float linear colours convert from sRGB', () => {
  const n = 2000,
    positions = new Float32Array(n * 3),
    classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    positions.set([(i * 7919) % 1000, (i * 104729) % 997, i % 13], i * 3);
    classification[i] = i % 3;
  }
  const cloud = new PointCloud({ positions: positions.slice(), reorder: true, blockSize: 64, colorFormat: 'float' });
  assert.ok(cloud.sourceIndex);
  {
    using binding = bindPointStyle(
      cloud,
      { classification },
      { show: '${classification} === 1', color: "color('#808080')" },
    );
    for (let i = 0; i < n; i++) assert.equal(cloud.isSelected(i), classification[cloud.sourceIndex[i]] === 1);
    // #808080 is sRGB 0.502; linear 0.2158. A hidden point keeps its own colour (white: the cloud had none).
    const shown = classification.findIndex((c, i) => c === 1 && i >= 0),
      at = cloud.sourceIndex.indexOf(shown),
      hidden = cloud.sourceIndex.indexOf(0);
    assert.ok(Math.abs(cloud.floatColors[at * 4] - 0.21586) < 1e-4, String(cloud.floatColors[at * 4]));
    assert.equal(cloud.floatColors[hidden * 4], 1);
    assert.equal(binding.result.shown, classification.filter((c) => c === 1).length);
  }
  assert.equal(cloud.colors, null);
  assert.equal(cloud.mask, null);
});

test('createStyledCloud keeps only shown points, styled, with their source indices', () => {
  const source = new PointCloud({ positions: table.positions, material: { size: 1 } });
  const { cloud, indices } = createStyledCloud(source, table, {
    filter: { classification: [6] },
    color: "color('lime')",
    pointSize: '${return_number} * 2.0',
  });
  assert.deepEqual([...indices], [2, 4]);
  assert.equal(cloud.count, 2);
  assert.deepEqual([...cloud.positions], [2, 4, 6, 4, 8, 12]);
  assert.deepEqual([...cloud.colors], [0xff00ff00, 0xff00ff00]);
  assert.deepEqual([...cloud.sizes], [2, 6]);
});

test('styleSource styles every octree node as it loads: hidden points dropped, colours and attributes kept aligned', async () => {
  const n = 600,
    positions = new Float32Array(n * 3),
    classification = new Uint8Array(n),
    gps = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    positions.set([i % 10, Math.floor(i / 10) % 6, Math.floor(i / 60)], i * 3);
    classification[i] = i % 5;
    gps[i] = i;
  }
  const memory = buildOctree({ positions, attributes: { classification, gps_time: gps } }, { maxPointsPerNode: 64 });
  const styled = styleSource(memory, {
    filter: { classification: [0, 4], gpsTime: [100, 499] },
    color: "color('red')",
  });
  assert.equal(styled.root, memory.root);
  const controller = new AbortController();
  let kept = 0;
  const visit = async (node) => {
    if (!node) return;
    const data = await styled.load(node, controller.signal);
    const count = data.positions.length / 3;
    kept += count;
    for (let i = 0; i < count; i++) {
      const c = data.attributes.classification[i],
        t = data.attributes.gps_time[i];
      assert.ok((c === 0 || c === 4) && t >= 100 && t <= 499, `point ${t} passes the filter`);
      assert.deepEqual([...data.positions.subarray(i * 3, i * 3 + 3)], [...positions.subarray(t * 3, t * 3 + 3)]);
      assert.deepEqual([...data.colors.subarray(i * 4, i * 4 + 4)], [255, 0, 0, 255]);
    }
    assert.equal(data.colorComponents, 4);
    for (const child of node.children) await visit(child);
  };
  await visit(memory.root);
  let expected = 0;
  for (let i = 0; i < n; i++)
    if ((classification[i] === 0 || classification[i] === 4) && i >= 100 && i <= 499) expected++;
  assert.equal(kept, expected);
  // A node data object the style keeps whole comes back unchanged.
  const whole = { positions: new Float32Array([0, 0, 0]), attributes: { classification: new Uint8Array([1]) } };
  assert.equal(styleNode(whole, { filter: { classification: [1] } }), whole);
});

test('a LAS file styles directly: its LASPoints is the table', async () => {
  const n = 300,
    world = new Float64Array(n * 3),
    classification = new Uint8Array(n),
    returnNumber = new Uint8Array(n),
    numberOfReturns = new Uint8Array(n),
    gpsTime = new Float64Array(n),
    pointSourceId = new Uint16Array(n),
    intensity = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    world.set([500000 + i, 4000000 + (i % 17), 100 + (i % 5)], i * 3);
    classification[i] = [1, 2, 6, 9][i % 4];
    numberOfReturns[i] = 1 + (i % 3);
    returnNumber[i] = 1 + (i % numberOfReturns[i]);
    gpsTime[i] = 1e5 + i * 0.25;
    pointSourceId[i] = 10 + (i % 4);
    intensity[i] = i * 200;
  }
  const las = await parseLAS(
    writeLAS({ positions: world, classification, returnNumber, numberOfReturns, gpsTime, pointSourceId, intensity }),
  );
  const filter = { classification: [2, 6], returnNumber: [1, 1], gpsTime: [100010, 100060], pointSourceId: [11, 12] };
  const r = new PointStyle({ filter, show: '${POSITION_ABSOLUTE}.z >= 101.0' }).evaluate(las);
  for (let i = 0; i < n; i++) {
    const want =
      [2, 6].includes(classification[i]) &&
      returnNumber[i] === 1 &&
      gpsTime[i] >= 100010 &&
      gpsTime[i] <= 100060 &&
      pointSourceId[i] >= 11 &&
      pointSourceId[i] <= 12 &&
      world[i * 3 + 2] >= 101;
    assert.equal(r.show[i], +want, `point ${i}`);
  }
  assert.ok(r.shown > 0 && r.shown < n);
});

test('a real USGS lidar tile: ground-only and first-return filters match an independent count', async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz', import.meta.url)),
  );
  const las = await parseLAS(bytes);
  const ground = new PointStyle({ filter: { classification: [2] } }).evaluate(las),
    first = new PointStyle({ show: '${ReturnNumber} === 1 && ${NumberOfReturns} > 1' }).evaluate(las);
  let g = 0,
    f = 0;
  for (let i = 0; i < las.count; i++) {
    if (las.classification[i] === 2) g++;
    if (las.returnNumber[i] === 1 && las.numberOfReturns[i] > 1) f++;
  }
  assert.equal(ground.shown, g);
  assert.equal(first.shown, f);
  assert.ok(g > 1000 && g < las.count, `ground points ${g} of ${las.count}`);
  assert.ok(f > 0, 'the tile holds multi-return pulses');
});

test('a filter key that is not a LAS filter throws and names filter.ranges, rather than filtering nothing', () => {
  assert.throws(
    () => new PointStyle({ filter: { colorIndex: [0, 1] } }),
    /colorIndex is not a LAS filter; put other columns under filter\.ranges/,
  );
  const style = new PointStyle({ filter: { ranges: { colorIndex: [0.5, Infinity] } } });
  assert.deepEqual([...style.evaluate({ colorIndex: new Float32Array([0.2, 0.5, 3]) }).show], [0, 1, 1]);
});
