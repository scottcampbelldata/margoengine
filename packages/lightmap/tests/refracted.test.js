import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeRefractedLightmap as bake } from '../dist/refracted.js';

const close = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) <= t, `${a} != ${b} ± ${t}`);
const floor = (skew = 0) => ({ positions: Float32Array.from([-5, 0, -5, -5 + skew, 0, 5, 5 + skew, 0, 5, 5, 0, -5]) });
function box(y0 = 1, y1 = 2, x0 = -10, x1 = 10, z0 = -10, z1 = 10) {
  return {
    positions: Float32Array.from([
      ...[x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1],
      ...[x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0],
    ]),
    indices: Uint32Array.from([
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 3, 5, 0, 5, 4, 1, 7, 6, 1, 6, 2, 0, 4, 7, 0, 7, 1, 3, 2, 6, 3, 6, 5,
    ]),
  };
}
function prism() {
  // A shallow triangular prism whose two lower facets bend parallel light inward.
  return {
    positions: Float32Array.from([-1, 2, -1, 1, 2, -1, 0, 1.5, -1, -1, 2, 1, 1, 2, 1, 0, 1.5, 1]),
    indices: Uint32Array.from([0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]),
  };
}
const aperture = (corner = [-0.5, 3, -0.5], edgeU = [1, 0, 0], edgeV = [0, 0, 1]) => ({ corner, edgeU, edgeV });
/** A 1 W beam straight down through a 1 x 1 aperture at y = 3. */
const beam = (more = {}) => ({ type: 'directional', direction: [0, 1, 0], aperture: aperture(), ...more });
const opts = (volumes = [box()], more = {}) => ({
  glassVolumes: volumes,
  emitters: [beam()],
  photons: 8192,
  seed: 27,
  texelsPerUnit: 4,
  maxAtlasSize: 128,
  ...more,
});
/** The six terminal terms add up to the emitted power. */
function ledger(result) {
  const d = result.diagnostics,
    terms = ['deposited', 'escaped', 'absorbed', 'truncated', 'unrefracted', 'blocked'];
  for (let c = 0; c < 3; c++)
    close(
      d.emitted[c],
      terms.reduce((s, k) => s + d[k][c], 0),
      1e-8,
    );
}
/** Flux over chart q (irradiance times texel area), the irradiance-weighted x of a floor chart, and the peak. */
function moment(result, q = 0, area = 100) {
  const { atlas, irradiance } = result,
    c = atlas.charts[q];
  let sum = 0,
    x = 0,
    peak = 0;
  for (let j = 0; j < c.height; j++)
    for (let i = 0; i < c.width; i++) {
      const e = irradiance[((c.y + j) * atlas.width + c.x + i) * 3];
      sum += e;
      x += e * (-5 + ((j + 0.5) * 10) / c.height); // chart rows follow the floor's p0 -> p3 edge, along +x
      peak = Math.max(peak, e);
    }
  return { flux: (sum * area) / (c.width * c.height), x: x / sum, peak };
}

test('index-matched glass passes a beam unchanged into a physical irradiance atlas with white AO', async () => {
  const result = await bake(floor(), opts([{ ...box(), ior: 1 }], { photons: 4096 }));
  ledger(result);
  close(result.diagnostics.emitted[0], 1);
  close(result.diagnostics.deposited[0], 1);
  close(moment(result).flux, 1);
  assert.equal(result.atlas.radiometry, 'physical');
  assert.ok(result.atlas.textures.lightmap.some((v) => v > 0));
  const { ao, width } = result.atlas.textures.ao ? { ao: result.atlas.textures.ao, width: result.atlas.width } : {},
    c = result.atlas.charts[0];
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++)
      assert.equal(ao[((c.y + y) * width + c.x + x) * 4], 255, 'no AO rays, no AO noise');
});

test('an oblique slab shifts the beam by Snell and absorbs along the bent path', async () => {
  const light = beam({ direction: [-0.6, 0.8, 0], aperture: aperture([-0.4, 2.7, -0.5], [0.8, 0.6, 0]) }),
    result = await bake(
      floor(),
      opts([{ ...box(), ior: 1.5, attenuationColor: [0.5, 1, 1], attenuationDistance: 1 }], {
        emitters: [light],
        photons: 65536,
        texelsPerUnit: 8,
      }),
    );
  ledger(result);
  const ct = Math.sqrt(1 - (0.6 / 1.5) ** 2),
    rs = ((0.8 - 1.5 * ct) / (0.8 + 1.5 * ct)) ** 2,
    rp = ((ct - 1.5 * 0.8) / (ct + 1.5 * 0.8)) ** 2,
    R = (rs + rp) / 2,
    a = 0.5 ** (1 / ct);
  close(result.diagnostics.deposited[0], ((1 - R) ** 2 * a) / (1 - R * R * a * a), 0.012);
  close(moment(result).x, 1.5 + 0.4 / ct, 0.035);
  assert.ok(result.diagnostics.deposited[0] < result.diagnostics.deposited[1]);
});

test('a prism focuses the beam; total internal reflection and the event cap are accounted', async () => {
  const light = beam({ aperture: aperture([-0.9, 3, -0.5], [1.8, 0, 0]) }),
    run = (ior) =>
      bake(
        floor(),
        opts([{ ...prism(), ior }], { emitters: [light], photons: 32768, texelsPerUnit: 12, maxAtlasSize: 256 }),
      ),
    focused = await run(1.5),
    control = await run(1);
  ledger(focused);
  assert.ok(moment(focused).peak > moment(control).peak * 1.4);
  close(moment(focused).x, 0, 0.08);
  const trapped = await bake(floor(), opts([{ ...prism(), ior: 2.5 }], { maxEvents: 2, photons: 4096 }));
  ledger(trapped);
  assert.ok(trapped.diagnostics.totalInternalReflections > 0);
  assert.ok(trapped.diagnostics.truncated[0] > 0);
});

test('nested glass: each medium absorbs only its own part of the path; equal IORs do not reflect', async () => {
  const outer = { ...box(1, 3), ior: 1.5, attenuationColor: [0.5, 0.5, 0.5], attenuationDistance: 1 },
    inner = { ...box(1.5, 2.5, -2, 2, -2, 2), ior: 1.5, attenuationColor: [0.25, 0.25, 0.25], attenuationDistance: 1 },
    nested = await bake(floor(), opts([outer, inner], { emitters: [beam({ aperture: aperture([-0.5, 4, -0.5]) })] })),
    R = 0.04,
    a = 0.5 * 0.25; // one unit in the outer medium only, one in the inner only
  ledger(nested);
  close(nested.diagnostics.deposited[0], ((1 - R) ** 2 * a) / (1 - R * R * a * a), 0.01);
  const matched = await bake(
    floor(),
    opts(
      [
        { ...box(), ior: 1 },
        { ...box(1.2, 1.8, -1, 1, -1, 1), ior: 1 },
      ],
      { photons: 64 },
    ),
  );
  close(matched.diagnostics.deposited[0], 1);
  assert.equal(matched.diagnostics.refractions, 4 * 64);
  // Per photon: outside 1 cast + outer test, in outer 1 + 2, in inner 1 + 1, in outer 1 + 2, outside 1 + 1.
  assert.equal(matched.diagnostics.rays, 12 * 64, 'only the boundary tests actually made are counted');
  await assert.rejects(() => bake(floor(), opts([box(1, 2), box(1.5, 2.5, -1, 1, -1, 1)])), /apart or nested/);
});

test('point and area lights emit their full power', async () => {
  // Receivers: a closed cube facing inward around the light; no glass.
  const cube = [0, 1, 2].flatMap((axis) =>
      [-2, 2].flatMap((side) => {
        // Corners p0..p3 of the face at `side` on `axis`, wound so the face looks inward.
        const [a, b] = [(axis + 1) % 3, (axis + 2) % 3],
          corner = (u, v) => {
            const p = [0, 0, 0];
            p[axis] = side;
            p[a] = u;
            p[b] = v;
            return p;
          },
          ring = [corner(-2, -2), corner(2, -2), corner(2, 2), corner(-2, 2)];
        return (side < 0 ? ring : ring.reverse()).flat();
      }),
    ),
    run = (emitter) =>
      bake(
        { positions: Float32Array.from(cube) },
        opts([], { emitters: [emitter], includeDirect: true, photons: 4096, texelsPerUnit: 2 }),
      );
  const point = await run({ type: 'point', position: [0.1, 0.2, 0.3], color: [1, 0.5, 0.25], intensity: 2 });
  ledger(point);
  point.diagnostics.unrefracted.forEach((w, c) => close(w, 8 * Math.PI * [1, 0.5, 0.25][c], 1e-9));
  let flux = 0;
  for (let q = 0; q < 6; q++) flux += moment(point, q, 16).flux;
  close(flux, 8 * Math.PI, 1e-6);
  const area = await run({
    type: 'area',
    position: [0, 0, 0],
    direction: [0, 1, 0],
    width: 1,
    height: 0.5,
    intensity: 3,
    twoSided: true,
  });
  ledger(area);
  close(area.diagnostics.unrefracted[0], 2 * Math.PI * 3 * 0.5, 1e-9);
});

test('a thin skewed receiver keeps its texel mapping and true texel area', async () => {
  const result = await bake(floor(3), opts([{ ...box(), ior: 1 }])),
    { atlas, irradiance } = result,
    c = atlas.charts[0];
  close(result.diagnostics.deposited[0], 1);
  close(moment(result).flux, 1, 1e-9);
  let centre = 0,
    weight = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const e = irradiance[((c.y + y) * atlas.width + c.x + x) * 3];
      centre += e * (-5 + (3 * (x + 0.5)) / c.width + (10 * (y + 0.5)) / c.height);
      weight += e;
    }
  close(centre / weight, 0, 0.08);
});

test('light that never touches glass stays out of the atlas unless includeDirect', async () => {
  const caustics = await bake(floor(), opts([])),
    all = await bake(floor(), opts([], { includeDirect: true }));
  close(caustics.diagnostics.unrefracted[0], 1);
  close(caustics.diagnostics.deposited[0], 0);
  close(moment(caustics).flux, 0);
  close(moment(all).flux, 1, 1e-9);
});

test('results are seeded and inputs copied; bad input and budgets fail before work', async () => {
  const geometry = floor(),
    volume = { ...box(), ior: 1.5 },
    light = beam(),
    o = opts([volume], { emitters: [light], photons: 1024 }),
    pending = bake(geometry, o);
  geometry.positions.fill(99);
  volume.positions.fill(99);
  light.direction[1] = -1;
  o.photons = 9;
  const expected = await bake(floor(), opts([{ ...box(), ior: 1.5 }], { photons: 1024 }));
  assert.deepEqual((await pending).irradiance, expected.irradiance);
  const reversed = box();
  for (let i = 0; i < reversed.indices.length; i += 3)
    [reversed.indices[i + 1], reversed.indices[i + 2]] = [reversed.indices[i + 2], reversed.indices[i + 1]];
  await assert.rejects(() => bake(floor(), opts([reversed])), /outward winding/);
  await assert.rejects(() => bake(floor(), opts([{ ...box(), indices: box().indices.slice(3) }])), /closed/);
  await assert.rejects(() => bake(floor(), opts(undefined, { emitters: [{ ...beam(), type: 'spot' }] })), TypeError);
  await assert.rejects(
    () => bake(floor(), opts(undefined, { emitters: [beam({ aperture: aperture([-0.5, 1.5, -0.5]) })] })),
    /outside glass/,
  );
  let progress = 0;
  await assert.rejects(() => bake(floor(), opts(undefined, { maxRays: 1, onProgress: () => progress++ })), /maxRays/);
  await assert.rejects(() => bake(floor(), opts(undefined, { maxBytes: 1, onProgress: () => progress++ })), /maxBytes/);
  assert.equal(progress, 0);
  const active = new AbortController();
  await assert.rejects(
    () =>
      bake(floor(), opts(undefined, { signal: active.signal, onProgress: (done) => done >= 256 && active.abort() })),
    { name: 'AbortError' },
  );
});
