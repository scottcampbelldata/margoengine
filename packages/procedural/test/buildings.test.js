import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBuildingGenerator } from '../dist/buildings.js';

function verify(
  m,
  {
    width: w = 12,
    depth: d = 8,
    floorHeights = [3, 3, 3],
    bayWidth = 3,
    window: [wx, wy] = [0.55, 0.6],
    roof = 'flat',
    roofHeight = 2,
    origin = [0, 0, 0],
  } = {},
) {
  const height = floorHeights.reduce((a, b) => a + b, 0),
    rise = roof === 'gable' ? roofHeight : 0;
  assert.equal(m.bays.length / 8, 2 * (Math.ceil(w / bayWidth) + Math.ceil(d / bayWidth)) * floorHeights.length);
  let bottom = 0;
  for (let i = 0; i < floorHeights.length; i++) {
    assert.equal(m.floors[i * 2], bottom);
    assert.equal(m.floors[i * 2 + 1], floorHeights[i]);
    bottom += floorHeights[i];
    for (let side = 0; side < 4; side++) {
      let end = 0,
        count = 0;
      const length = side % 2 ? d : w;
      for (let j = 0; j < m.bays.length; j += 8)
        if (m.bays[j] === i && m.bays[j + 1] === side) {
          const [, , start, y, bw, bh, ww, wh] = m.bays.subarray(j, j + 8);
          assert.ok(Math.abs(start - end) < 1e-10);
          assert.equal(y, m.floors[i * 2]);
          assert.equal(bh, floorHeights[i]);
          assert.ok(Math.abs(ww - bw * wx) < 1e-10);
          assert.ok(Math.abs(wh - bh * wy) < 1e-10);
          end = start + bw;
          count++;
        }
      assert.equal(count, Math.ceil(length / bayWidth));
      assert.ok(Math.abs(end - length) < 1e-10);
    }
  }
  let volume = 0;
  const areas = [0, 0, 0, 0];
  for (let i = 0; i < m.indices.length; i += 3) {
    const p = Array.from(m.indices.subarray(i, i + 3), (v) =>
      Array.from(m.positions.subarray(v * 3, v * 3 + 3), (x, k) => x - origin[k]),
    );
    const [a, b, c] = p,
      u = b.map((v, k) => v - a[k]),
      v = c.map((v, k) => v - a[k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      len = Math.hypot(...n);
    assert.ok(Number.isFinite(len) && len > 0, 'nondegenerate finite triangle');
    for (const index of m.indices.subarray(i, i + 3))
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(m.normals[index * 3 + k] - n[k] / len) < 2e-7, 'outward normals agree with winding');
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1])) / 6 +
      (a[1] * (b[2] * c[0] - b[0] * c[2])) / 6 +
      (a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    areas[m.materials[i / 3]] += len / 2;
  }
  const close = (a, b) => assert.ok(Math.abs(a - b) <= Math.max(1, b) * 2e-8, `${a} vs ${b}`);
  close(volume, w * d * (height + rise / 2));
  close(areas[3], w * d);
  close(areas[0], 2 * (w + d) * height * (1 - wx * wy));
  close(areas[1], 2 * (w + d) * height * wx * wy);
  close(areas[2], rise ? 2 * d * Math.hypot(w / 2, rise) + w * rise : w * d);
  assert.equal(m.transformEvaluations, 2);
}
test('split grammar partitions floors, bays and panes; outward shell area and volume match analytic oracles', async () => {
  using g = await createBuildingGenerator();
  verify(g.generate());
  for (const roof of ['flat', 'gable'])
    for (const yaw of [-Math.PI * 2, -1.27, 0, Math.PI / 2, Math.PI * 2]) {
      const o = {
        width: 13.7,
        depth: 7.1,
        floorHeights: [2.7, 3.1, 0.1],
        bayWidth: 2.3,
        window: [0.17, 0.93],
        roof,
        roofHeight: 4.1,
        yaw,
        origin: [113, 29, -74],
      };
      const m = g.generate(o);
      verify(m, o);
      assert.deepEqual(m, g.generate(o));
      const local = g.generate({ ...o, yaw: 0, origin: [0, 0, 0] });
      let evaluations = 0;
      for (let i = 0; i < m.positions.length; i += 3) {
        const c = Math.cos(yaw),
          s = Math.sin(yaw);
        evaluations += 2;
        const [x, y, z] = local.positions.subarray(i, i + 3),
          expected = [o.origin[0] + c * x + s * z, o.origin[1] + y, o.origin[2] - s * x + c * z];
        for (let k = 0; k < 3; k++) assert.equal(m.positions[i + k], expected[k]);
      }
      assert.ok(
        evaluations > m.transformEvaluations * 100,
        'same output, two trig evaluations instead of two per vertex',
      );
    }
});
test('real downloaded Montreal CityJSON bounds drive envelope models; facade rules remain stand-in', async () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/buildings/reference.json', import.meta.url)));
  const bytes = readFileSync(new URL('./fixtures/buildings/twobuildings.city.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
  const city = JSON.parse(bytes);
  assert.equal(reference.buildings.length, 2);
  assert.match(reference.sha256, /^[0-9a-f]{64}$/);
  using g = await createBuildingGenerator();
  for (const b of reference.buildings) {
    const ids = new Set(city.CityObjects[b.id].geometry.flatMap((g) => g.boundaries.flat(Infinity)));
    const source = [...ids].map((i) =>
      city.vertices[i].map((v, k) => v * city.transform.scale[k] + city.transform.translate[k]),
    );
    const spans = [0, 1, 2].map((k) => Math.max(...source.map((p) => p[k])) - Math.min(...source.map((p) => p[k])));
    assert.deepEqual(spans, [b.width, b.depth, b.height]);
    assert.ok(b.vertexCount > 10);
    const o = { width: b.width, depth: b.depth, floorHeights: [b.height], bayWidth: 3 };
    const m = g.generate(o);
    verify(m, o);
    for (const [axis, extent] of [
      [0, b.width],
      [1, b.height],
      [2, b.depth],
    ]) {
      const values = Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[i * 3 + axis]);
      assert.ok(Math.abs(Math.max(...values) - Math.min(...values) - extent) < 1e-12);
    }
  }
});
test('tiny, maximal and hostile rules, sparse arrays, aborts, output ownership and disposal', async () => {
  const g = await createBuildingGenerator(),
    coded = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const o of [
    { width: 0 },
    { depth: -1 },
    { width: NaN },
    { width: Infinity },
    { width: 1e20 },
    { floorHeights: [] },
    { floorHeights: [0] },
    { floorHeights: [NaN] },
    { floorHeights: Array(2) },
    { floorHeights: Array(65).fill(1) },
    { floorHeights: Array(64).fill(100) },
    { bayWidth: 0 },
    { bayWidth: NaN },
    { width: 1000, bayWidth: 0.1 },
    { floorHeights: Array(64).fill(1), width: 100, depth: 100, bayWidth: 1 },
    { window: [] },
    { window: [0, 1] },
    { window: Array(2) },
    { origin: Array(3) },
    { origin: [0, Infinity, 0] },
    { origin: [0, 0] },
    { yaw: Infinity },
    { roof: 'hip' },
    { roofHeight: 0 },
    { roofHeight: NaN },
  ])
    assert.throws(() => g.generate(o), coded);
  for (const o of [
    { width: 0.1, depth: 0.1, floorHeights: [0.1], window: [0.05, 0.95], roof: 'gable', roofHeight: 0.1 },
    {
      width: 1000,
      depth: 1000,
      bayWidth: 1000,
      floorHeights: Array(50).fill(100),
      roof: 'gable',
      roofHeight: 100,
      origin: [10000, 10000, -10000],
    },
    { width: 256, depth: 256, bayWidth: 1, floorHeights: [1, 1, 1, 1], window: [0.95, 0.05] },
  ])
    verify(g.generate(o), o);
  const reason = new Error('cancel building'),
    signal = AbortSignal.abort(reason);
  await assert.rejects(createBuildingGenerator({ signal }), (e) => e === reason);
  assert.throws(
    () => g.generate({ signal }),
    (e) => e === reason,
  );
  const m = g.generate(),
    copy = structuredClone(m);
  g.generate({ width: 256, depth: 256, bayWidth: 1, floorHeights: [1, 1, 1, 1] });
  assert.deepEqual(m, copy);
  g.dispose();
  g[Symbol.dispose]();
  assert.deepEqual(m, copy);
  assert.throws(() => g.generate(), { code: 'disposed' });
});

test('four real CMP facade annotations fit a calibrated split/repeat window region within two source pixels', async () => {
  const r = JSON.parse(readFileSync(new URL('./fixtures/buildings/facade-reference.json', import.meta.url)));
  using g = await createBuildingGenerator();
  const o = {
    width: 2 * r.pitchX,
    depth: 3,
    floorHeights: r.floorHeights,
    bayWidth: r.pitchX,
    window: [r.windowWidth / r.pitchX, r.windowHeight / r.pitchY],
  };
  const m = g.generate(o);
  verify(m, o);
  let n = 0,
    maxError = 0;
  for (let i = 0; i < m.bays.length; i += 8)
    if (m.bays[i + 1] === 0) {
      const [, , start, bottom, width, height, ww, wh] = m.bays.subarray(i, i + 8);
      const expected = [
        r.left + start + (width - ww) / 2,
        r.top + bottom + (height - wh) / 2,
        r.left + start + (width + ww) / 2,
        r.top + bottom + (height + wh) / 2,
      ];
      for (let k = 0; k < 4; k++) {
        const e = Math.abs(expected[k] - r.windows[n][k]);
        assert.ok(e <= r.tolerancePixels, `${n}/${k}: ${e} pixels`);
        maxError = Math.max(maxError, e);
      }
      n++;
    }
  assert.equal(n, 4);
  console.log(
    JSON.stringify({
      facadeReference: 'CMP cmp_b0001 annotated 2x2 region',
      maxErrorPixels: maxError,
      boundPixels: r.tolerancePixels,
    }),
  );
});
