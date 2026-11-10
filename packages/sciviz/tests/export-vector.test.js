import test from 'node:test';
import assert from 'node:assert/strict';
import { exportVectorScene } from '@margoengine/sciviz/export-vector';
import { JSDOM } from 'jsdom';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const triangle = (positions, rgb) => ({ kind: 'triangles', positions, colors: [...rgb, 1, ...rgb, 1, ...rgb, 1] });
const scene = (geometry) => ({ width: 200, height: 200, matrix: identity, geometry });
const dom = (svg) => new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
const paths = (svg) => [...dom(svg).querySelectorAll('path')];
function contains(path, x, y) {
  const xy = path
    .getAttribute('d')
    .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)
    .map(Number);
  let inside = false;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2)
    if (xy[i + 1] > y !== xy[j + 1] > y && x < ((xy[j] - xy[i]) * (y - xy[i + 1])) / (xy[j + 1] - xy[i + 1]) + xy[i])
      inside = !inside;
  return inside;
}
const at = (svg, x, y) =>
  paths(svg)
    .filter((p) => contains(p, x, y))
    .at(-1)
    ?.getAttribute('fill');

test('BSP splits intersecting triangles instead of sorting their centroids', async () => {
  const a = triangle([-0.9, -0.8, 0.1, 0.9, -0.8, 0.9, 0, 0.9, 0.5], [1, 0, 0]);
  const b = triangle([-0.9, -0.8, 0.9, 0.9, -0.8, 0.1, 0, 0.9, 0.5], [0, 0, 1]);
  for (const input of [
    [a, b],
    [b, a],
  ]) {
    const r = await exportVectorScene(scene(input));
    assert.equal(r.mode, 'vector');
    assert.ok(r.fragments > 2);
    assert.equal(at(r.svg, 60, 140), 'rgb(0 0 255)');
    assert.equal(at(r.svg, 140, 140), 'rgb(255 0 0)');
    assert.equal(dom(r.svg).querySelectorAll('image').length, 0);
  }
});
test('three crossing planes obey an independent analytic depth oracle on a grid', async () => {
  const base = [
      [-0.95, -0.9],
      [0.95, -0.9],
      [0, 0.95],
    ],
    equations = [
      [0.2, 0.1],
      [0, -0.3],
      [-0.2, 0.15],
    ],
    rgb = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  const geometry = equations.map(([a, b], i) =>
    triangle(
      base.flatMap(([x, y]) => [x, y, 0.5 + a * x + b * y]),
      rgb[i],
    ),
  );
  const r = await exportVectorScene(scene(geometry));
  const shapes = paths(r.svg);
  for (let y = -0.7; y < 0.7; y += 0.17)
    for (let x = -0.8; x < 0.8; x += 0.17) {
      if (Math.abs(x) > ((0.95 - y) * 0.95) / 1.85 - 0.01) continue;
      const z = equations.map(([a, b]) => 0.5 + a * x + b * y),
        sorted = z.toSorted((a, b) => b - a);
      if (sorted[0] - sorted[1] < 1e-6) continue;
      const expected = `rgb(${rgb[z.indexOf(sorted[0])].map((c) => c * 255).join(' ')})`;
      assert.equal(
        shapes
          .filter((p) => contains(p, (x + 1) * 100, (1 - y) * 100))
          .at(-1)
          .getAttribute('fill'),
        expected,
      );
    }
});
test('homogeneous frustum clipping, degenerate faces and missing data holes', async () => {
  const r = await exportVectorScene(
    scene([
      triangle([-2, -0.8, 0.4, 2, -0.8, 0.4, 0, 2, 0.4], [1, 0, 0]),
      triangle([0, 0, -1, 0.4, 0, -1, 0, 0.4, -1], [0, 1, 0]),
      triangle([0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5], [0, 0, 1]),
      { kind: 'triangles', positions: [NaN, 0, 0.5, 0.4, 0, 0.5, 0, 0.4, 0.5] },
    ]),
  );
  // Clipping this triangle against all four viewport edges leaves a hexagon (four fan triangles).
  assert.equal(paths(r.svg).length, 4);
  for (const p of paths(r.svg))
    for (const n of p
      .getAttribute('d')
      .match(/-?\d+(?:\.\d+)?/g)
      .map(Number))
      assert.ok(n >= -1e-10 && n <= 200 + 1e-10);
});
test('vertex colours become explicit facets; uniform colours avoid needless subdivision', async () => {
  const p = [-0.8, -0.8, 0.5, 0.8, -0.8, 0.5, 0, 0.8, 0.5];
  const varying = await exportVectorScene(
    scene([{ kind: 'triangles', positions: p, colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1] }]),
  );
  assert.equal(paths(varying.svg).length, 16);
  assert.ok(new Set(paths(varying.svg).map((p) => p.getAttribute('fill'))).size > 3);
  const uniform = await exportVectorScene(scene([triangle(p, [1, 0, 0])]));
  assert.equal(paths(uniform.svg).length, 1);
});
test('line ribbons and point discs participate in depth splitting', async () => {
  const r = await exportVectorScene(
    scene([
      triangle([-1, -1, 0.5, 1, -1, 0.5, 0, 1, 0.5], [0, 0, 1]),
      { kind: 'line', positions: [-0.8, 0, 0.2, 0.8, 0, 0.8], colors: [1, 0, 0, 1, 1, 0, 0, 1], width: 8 },
      { kind: 'points', positions: [-0.3, -0.3, 0.3, 0.3, -0.3, 0.7], colors: [0, 1, 0, 1, 0, 1, 0, 1], width: 14 },
    ]),
  );
  assert.equal(at(r.svg, 60, 100), 'rgb(0 0 255)');
  assert.equal(at(r.svg, 140, 100), 'rgb(255 0 0)');
  assert.equal(at(r.svg, 70, 130), 'rgb(0 0 255)');
  assert.equal(at(r.svg, 130, 130), 'rgb(0 255 0)');
});
test('all budget exits embed the complete fallback and state the reason', async () => {
  const geometry = [
    triangle([-0.9, -0.8, 0.1, 0.9, -0.8, 0.9, 0, 0.9, 0.5], [1, 0, 0]),
    triangle([-0.9, -0.8, 0.9, 0.9, -0.8, 0.1, 0, 0.9, 0.5], [0, 0, 1]),
  ];
  let calls = 0;
  const raster = async () => {
    calls++;
    return '<svg><image href="data:image/png;base64,complete"/></svg>';
  };
  for (const options of [{ maxTriangles: 1 }, { maxFragments: 2 }]) {
    const r = await exportVectorScene(scene(geometry), { ...options, raster });
    assert.equal(r.mode, 'raster');
    assert.ok(r.reason);
    assert.match(r.svg, /data-sciviz-fallback=/);
    assert.match(r.svg, /base64,complete/);
  }
  assert.equal(calls, 2);
  await assert.rejects(exportVectorScene(scene(geometry), { maxTriangles: 1 }), (e) => e.code === 'unsupported');
});
test('rejects malformed inputs and preserves cancellation reasons including during work', async () => {
  for (const options of [{ maxTriangles: 0 }, { maxMarks: NaN }, { maxFragments: 1.5 }, { colorDepth: 5 }])
    await assert.rejects(exportVectorScene(scene([]), options), RangeError);
  await assert.rejects(exportVectorScene(scene([{ kind: 'points', positions: [0, 0, 0], colors: [1] }])), RangeError);
  const controller = new AbortController(),
    reason = new Error('cancel vector publication');
  const promise = exportVectorScene(scene([{ kind: 'points', positions: new Float32Array(30000) }]), {
    signal: controller.signal,
  });
  controller.abort(reason);
  await assert.rejects(promise, (e) => e === reason);
});

test('near edge-on faces use normalized planes and always remove their splitter', async () => {
  // The old z=ax+by+c plane falsely put its own second vertex 9.31e-10 in front,
  // repeatedly partitioning the same polygon set without removing its splitter.
  const p = [
    -0.35090585122816265, -0.13709320630878208, 0.6976062364410609, -0.35090584866036234, -0.13709320615806955,
    0.7143418285995722, -0.3509058505449859, -0.137093199156154, 0.05907185026444495,
  ];
  const result = await exportVectorScene(scene([triangle(p, [1, 0, 0]), triangle(p, [0, 0, 1])]));
  assert.equal(result.mode, 'vector');
  assert.equal(result.fragments, 2);
});

test('large coplanar colour-facet sets do not use function argument spreading', async () => {
  const positions = new Float32Array(9000 * 9),
    colors = new Float32Array(9000 * 12);
  for (let i = 0; i < 9000; i++) {
    positions.set([-0.8, -0.8, 0.5, 0.8, -0.8, 0.5, 0, 0.8, 0.5], i * 9);
    colors.set([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1], i * 12);
  }
  const r = await exportVectorScene(scene([{ kind: 'triangles', positions, colors }]));
  assert.equal(r.mode, 'vector');
  assert.equal(r.fragments, 144000);
  assert.equal([...r.svg.matchAll(/<path /g)].length, 144000);
});
