import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PointCloud } from '../dist/index.js';
import { boxClipVolume, polygonClipVolume, clipPoints, createClippedCloud, elevationProfile } from '../dist/clip.js';

test('boxes combine union/intersection, include boundaries, invert selection and transform both spaces', () => {
  const data = { positions: [-2, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, NaN, 0, 0] };
  const left = boxClipVolume([-2, -1, -1], [0, 1, 1]),
    right = boxClipVolume([0, -1, -1], [2, 1, 1]);
  assert.deepEqual([...clipPoints(data, { volumes: [left, right] })], [0, 1, 2, 3, 4]);
  assert.deepEqual([...clipPoints(data, { volumes: [left, right], operation: 'intersection' })], [2]);
  assert.deepEqual([...clipPoints(data, { volumes: [left], keep: 'outside' })], [3, 4]);
  assert.equal(clipPoints(data, { volumes: [], keep: 'outside' }).length, 5);
  const rotate = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.ok(boxClipVolume([-2, -0.1, -1], [2, 0.1, 1], rotate).contains(0, 2, 0));
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
  assert.deepEqual(
    [...clipPoints({ ...data, matrix }, { volumes: [boxClipVolume([9, -1, -1], [11, 1, 1])] })],
    [1, 2, 3],
  );
});

test('concave polygon, winding, repeated closing vertex, edge/vertex boundaries and depth', () => {
  const ring = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
    [0, 0],
  ];
  for (const vertices of [ring, [...ring].reverse()]) {
    const volume = polygonClipVolume(vertices, { depth: [-1, 1] });
    for (const p of [
      [0, 0, 0],
      [1, 1, 0],
      [0.5, 2, 1],
      [2, 0.5, -1],
    ])
      assert.ok(volume.contains(...p));
    for (const p of [
      [2, 2, 0],
      [-0.01, 1, 0],
      [0.5, 0.5, 1.01],
    ])
      assert.ok(!volume.contains(...p));
  }
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0];
  const volume = polygonClipVolume(
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
    { worldToLocal: projection, positiveW: true },
  );
  assert.ok(volume.contains(0, 0, -2));
  assert.ok(!volume.contains(0, 0, 2));
});

test('renderable extraction preserves packed/HDR colour, normals, sizes, material and source indices', () => {
  for (const colorFormat of ['rgba8', 'float']) {
    const source = new PointCloud({
      positions: [-2, 0, 0, 0, 0, 0, 2, 0, 0],
      colors: [1, 0, 0, 0, 2, 0, 0, 0, 1],
      normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      sizes: [1, 2, 3],
      colorFormat,
    });
    const { cloud, indices } = createClippedCloud(source, { volumes: [boxClipVolume([-1, -1, -1], [1, 1, 1])] });
    assert.deepEqual([...indices], [1]);
    assert.deepEqual([...cloud.positions], [0, 0, 0]);
    assert.deepEqual([...cloud.normals], [0, 1, 0]);
    assert.deepEqual([...cloud.sizes], [2]);
    assert.equal(cloud.material, source.material);
    if (colorFormat === 'float') assert.deepEqual([...cloud.floatColors], [0, 2, 0, 1]);
    else assert.equal(cloud.colors[0], source.colors[1]);
    assert.equal(createClippedCloud(source, { volumes: [boxClipVolume([10, 10, 10], [11, 11, 11])] }).cloud.count, 0);
  }
});

test('polyline profile has horizontal mileage, elevations, square caps, joins, deduplication and axis choice', () => {
  const data = { positions: [-1, 8, 0, 0, 2, 0, 2, 4, 0.5, 4, 9, 0, 4, 10, 2, 4, 20, 5, 2, 1, 2] };
  const result = elevationProfile(data, {
    path: [
      [0, 0, 0],
      [4, 30, 0],
      [4, -20, 4],
    ],
    width: 2,
  });
  assert.deepEqual([...result.indices], [1, 2, 3, 4]);
  assert.deepEqual([...result.distance], [0, 2, 4, 6]);
  assert.deepEqual([...result.elevation], [2, 4, 9, 10]);
  assert.deepEqual([...result.segment], [0, 0, 0, 1]);
  assert.equal(result.length, 8);
  const zup = elevationProfile(
    { positions: [1, 0, 42] },
    {
      path: [
        [0, 0, 0],
        [2, 0, 0],
      ],
      width: 0,
      upAxis: 2,
    },
  );
  assert.deepEqual([...zup.elevation], [42]);
});

test('survey APIs reject invalid input and support cancellation', () => {
  assert.throws(() => boxClipVolume([1, 0, 0], [0, 1, 1]), RangeError);
  assert.throws(
    () =>
      polygonClipVolume([
        [0, 0],
        [1, 0],
      ]),
    TypeError,
  );
  assert.throws(() => clipPoints({ positions: [1] }, { volumes: [] }), TypeError);
  assert.throws(
    () =>
      elevationProfile(
        { positions: [] },
        {
          path: [
            [0, 0, 0],
            [0, 1, 0],
          ],
          width: 1,
        },
      ),
    RangeError,
  );
  const signal = AbortSignal.abort();
  assert.throws(() => clipPoints({ positions: [0, 0, 0] }, { volumes: [], signal }), { name: 'AbortError' });
  const source = new PointCloud({ positions: [0, 0, 0] });
  source.attach({});
  assert.throws(() => clipPoints(source, { volumes: [] }), /worldMatrix/);
});

test('real Stanford scan: profile and box counts match independent scalar references', async () => {
  const text = await readFile(new URL('./fixtures/bunny.pcd', import.meta.url), 'utf8');
  const positions = text
    .split('\n')
    .slice(10)
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  const expected = [];
  for (let i = 0; i < positions.length / 3; i++)
    if (positions[3 * i] >= -0.05 && positions[3 * i] <= 0 && Math.abs(positions[3 * i + 2]) <= 0.02) expected.push(i);
  const clipped = clipPoints({ positions }, { volumes: [boxClipVolume([-0.05, -1, -0.02], [0, 1, 0.02])] });
  const profile = elevationProfile(
    { positions },
    {
      path: [
        [-0.05, 0, 0],
        [0, 0, 0],
      ],
      width: 0.04,
    },
  );
  assert.ok(expected.length > 0);
  assert.deepEqual([...clipped], expected);
  assert.deepEqual(
    [...profile.indices].sort((a, b) => a - b),
    expected,
  );
});
