import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { physicalLobes } from '../dist/physical-lobes.js';
import { MAX_SHAPE_LIGHTS, ShapeLights, radianceFromPower, shapeLightArea } from '../dist/shapes.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { formFactor } from './ltc-reference.js';
import {
  basis,
  coneVector,
  discFormFactor,
  frame,
  ltcQuadrature,
  shapeBruteForce,
  shapes,
} from './shapes-reference.js';

const pack = (...list) => {
  const s = new ShapeLights({ lights: { setLights() {} } });
  s.setLights(list);
  return list.map((_, i) => Array.from(s.data.subarray(4 + i * 12, 16 + i * 12)));
};
const identity = (q) => q,
  o = [0, 0, 0],
  n = [0, 0, 1],
  view = (degrees) => [Math.sin((degrees * Math.PI) / 180), 0, Math.cos((degrees * Math.PI) / 180)],
  grey = [0.8, 0.8, 0.8];

test('shaped lights pack position, axis or end, radius, radiance and the two-sided flag; bad input changes nothing', () => {
  const [sphere, disc, tube, dot] = pack(
    { shape: 'sphere', position: [1, 2, 3], radius: 0.5, color: [1, 0.5, 0], intensity: 4 },
    { shape: 'disc', position: [0, 3, 0], direction: [0, -2, 0], radius: 0.25, twoSided: true },
    { shape: 'tube', start: [-1, 2, 0], end: [1, 2, 0], radius: 0.05, intensity: 2 },
    { shape: 'tube', start: [0, 1, 0], end: [0, 1, 0], radius: 0.1 },
  );
  assert.deepEqual(sphere, [1, 2, 3, 0, 0, 0, 0, 0.5, 4, 2, 0, 0]);
  assert.deepEqual(disc, [0, 3, 0, 1, 0, -1, 0, 0.25, 1, 1, 1, 1]);
  assert.deepEqual(
    tube.map((v) => Math.fround(v)),
    [-1, 2, 0, 2, 1, 2, 0, Math.fround(0.05), 2, 2, 2, 0],
  );
  assert.deepEqual(dot.slice(0, 4), [0, 1, 0, 0], 'a zero-length tube is a sphere');
  const s = new ShapeLights({ lights: { setLights() {} } }),
    good = [{ shape: 'sphere', position: [0, 1, 0], radius: 1 }];
  s.setLights(good);
  const before = Array.from(s.data);
  for (const bad of [
    { shape: 'cone', position: [0, 0, 0], radius: 1 },
    { shape: 'sphere', position: [0, 0, 0], radius: 0 },
    { shape: 'sphere', position: [0, 0, 0], radius: -1 },
    { shape: 'sphere', position: [0, 0, 0], radius: 1, intensity: -1 },
    { shape: 'sphere', position: [0, 0, 0], radius: 1, color: [-1, -1, -1] },
    { shape: 'disc', position: [0, 0, 0], direction: [0, 0, 0], radius: 1 },
    null,
  ])
    assert.throws(() => s.setLights([good[0], bad]), RangeError, JSON.stringify(bad));
  for (const bad of [
    { shape: 'sphere', position: [0, Number.NaN, 0], radius: 1 },
    { shape: 'tube', start: [0, 0, 0], end: [0, Infinity, 0], radius: 1 },
  ])
    assert.throws(() => s.setLights([good[0], bad]), TypeError, JSON.stringify(bad));
  assert.throws(
    () => s.setLights([{ shape: 'disc', position: [0, 0, 0], direction: [0, 1, 0], radius: 1, twoSided: 1 }]),
    TypeError,
  );
  assert.throws(() => s.setLights(Array(MAX_SHAPE_LIGHTS + 1).fill(good[0])), RangeError);
  assert.deepEqual(Array.from(s.data), before);
  assert.deepEqual(s.list, good);
  assert.ok(Object.isFrozen(s.list));
});

test('radianceFromPower spreads a power over the emitting area of each shape', () => {
  const sphere = { shape: 'sphere', position: [0, 0, 0], radius: 0.5 },
    disc = { shape: 'disc', position: [0, 0, 0], direction: [0, 1, 0], radius: 0.5 },
    tube = { shape: 'tube', start: [0, 0, 0], end: [0, 2, 0], radius: 0.5 };
  assert.equal(shapeLightArea(sphere), Math.PI);
  assert.equal(shapeLightArea(disc), Math.PI / 4);
  assert.equal(shapeLightArea({ ...disc, twoSided: true }), Math.PI / 2);
  assert.equal(shapeLightArea(tube), 2 * Math.PI + Math.PI);
  assert.equal(radianceFromPower(sphere, 1000), 1000 / (Math.PI * Math.PI));
  assert.throws(() => radianceFromPower(sphere, -1), RangeError);
  assert.throws(() => radianceFromPower({ ...sphere, radius: 0 }, 1), RangeError);
});

test('shaped lights add shader code, binding 150 and one buffer only while there are lights', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 1], range: 6 }]);
  h.engine.use(lights);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers,
      pbr = lights.pbr(2).declarations;
    const shaped = new ShapeLights({ lights });
    h.engine.use(shaped);
    assert.deepEqual(frame(), plain, 'attached without lights');
    assert.equal(h.counts.buffers, buffers);
    assert.equal(lights.shapes, undefined);
    shaped.setLights([{ shape: 'tube', start: [-1, 2, 0], end: [1, 2, 0], radius: 0.05, intensity: 5 }]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(150\) var<storage,read> shapeLights/);
    assert.match(
      lit.shader,
      /\(result\+clusterShapeLighting\(position,n,v,nv,base,roughness,metal,dielectricF0,dielectricF90\)\)\*clusterFrame/,
    );
    assert.deepEqual(lit.bindings, [...plain.bindings, 150]);
    assert.equal(h.counts.buffers, buffers + 1);
    assert.match(lights.pbr(2).declarations, /@group\(2\) @binding\(150\)/);
    const words = new Uint32Array(shaped.bindings()[0].resource.buffer.data);
    assert.equal(words[0], 1);
    assert.ok(
      words.subarray(4 + MAX_SHAPE_LIGHTS * 12).some((v) => v !== 0),
      'LTC table uploaded',
    );
    // The physical lobes put the clearcoat under the shaped lights too.
    const coat = physicalLobes.finish(`fn layers(){}\nfn clusterShapeLighting(){}\ncolor=layers(s,v,l,color);`);
    assert.match(
      coat,
      /color=layers\(s,v,l,color\);if\(s\.cc>0\.0\)\{clusterLobeLight\+=s\.cc\*clusterShapeLighting\(i\.position,s\.cn,/,
    );
    assert.doesNotMatch(coat, /clusterAreaLighting\(i\.position/);
    shaped.setLights([]);
    assert.deepEqual(frame(), plain, 'emptied');
    assert.equal(lights.pbr(2).declarations, pbr);
    shaped.setLights([{ shape: 'sphere', position: [0, 2, 0], radius: 0.1 }]);
    const buffer = shaped.bindings()[0].resource.buffer;
    shaped.onDeviceRestored(h.engine);
    assert.ok(buffer.destroyed);
    assert.ok(frame().bindings.includes(150));
    shaped.dispose();
    assert.deepEqual(frame(), plain, 'disposed');
    assert.equal(lights.shapes, undefined);
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('the elliptic cone form factor equals the exact form factor of the disc as a fine polygon', () => {
  // A regular N-gon inscribed in the disc misses (2 pi / N)^2 / 6 of its area: 4e-7 relative at N = 4096.
  const N = 4096;
  for (const [c, normal, r] of [
    [[0.3, 0.2, 2], [0.3, -0.5, -0.8], 0.7],
    [[1, 0, 0.5], [-1, 0, -0.2], 0.3],
    [[0, 0, 30], [0, 0.6, -0.8], 0.5],
    [[0.01, -0.02, 400], [0.1, 0.2, -1], 0.02],
    [[0.2, 0.1, 0.6], [0, 0, -1], 3],
  ]) {
    const length = Math.hypot(...normal),
      [t1, t2] = basis(normal.map((v) => v / length)),
      points = Array.from({ length: N }, (_, i) => {
        const a = (2 * Math.PI * i) / N;
        return c.map((v, k) => v + r * (Math.cos(a) * t1[k] + Math.sin(a) * t2[k]));
      });
    const exact = Math.abs(formFactor(points)),
      f = coneVector(
        identity,
        c,
        t1.map((v) => v * r),
        t2.map((v) => v * r),
      );
    assert.ok(Math.abs(f[2] / exact - 1) < 1e-5, `${c}: cone ${f[2]} vs polygon ${exact}`);
  }
});

test('a sphere light lights a surface exactly as its closed form; a small one as a point light of radiance x pi r^2', () => {
  for (const [centre, r] of [
    [[0.3, 0.2, 2], 0.4],
    [[1, 0.5, 2], 1],
    [[0, 0, 50], 0.01],
  ]) {
    const [l] = pack({ shape: 'sphere', position: centre, radius: r }),
      d = Math.hypot(...centre),
      want = (grey[0] * (centre[2] / d) * r * r) / (d * d),
      got = shapes(l, o, n, view(30), grey, 0.5, 0).diffuse[0];
    // Exact but for float64 rounding in the cubic's root (a few 1e-8 relative).
    assert.ok(Math.abs(got / want - 1) < 1e-6, `${centre}: ${got} vs ${want}`);
  }
});

const cases = {
  sphere: { shape: 'sphere', position: [0.5, 0.3, 2], radius: 0.4 },
  'grazing sphere': { shape: 'sphere', position: [2, 0, 0.2], radius: 0.6 },
  disc: { shape: 'disc', position: [0.2, 0.1, 1.5], direction: [-0.1, 0, -1], radius: 0.5 },
  'tilted disc': { shape: 'disc', position: [-1, 0.4, 1], direction: [1, -0.2, -0.3], radius: 0.6 },
  'straddling disc': { shape: 'disc', position: [1.2, 0, 0.1], direction: [-1, 0, 0.2], radius: 0.5 },
  tube: { shape: 'tube', start: [-1, 0.3, 1], end: [1, 0.3, 1.2], radius: 0.1 },
  'thin tube': { shape: 'tube', start: [0, -0.5, 0.6], end: [0, 0.5, 0.6], radius: 0.08 },
  'end-on tube': { shape: 'tube', start: [0, 0, 3], end: [0.05, 0, 1.5], radius: 0.2 },
};

test('diffuse matches quadrature over the real shape', () => {
  // Exact for discs and spheres wholly above the horizon; clipped discs and tubes integrate polygons whose error is
  // O(step^4) (0.2% here). The quadrature (600^2 directions) is itself within 2e-3 here.
  for (const [name, light] of Object.entries(cases)) {
    const [l] = pack(light),
      got = shapes(l, o, n, view(30), grey, 0.5, 0).diffuse[0],
      want = shapeBruteForce(l, o, n, view(30), grey, 0.5, 0, 600).diffuse[0];
    assert.ok(Math.abs(got / want - 1) < 4e-3, `${name}: ${got} vs ${want}`);
  }
});

test('a disc is dark from behind unless two-sided, and two-sided lights both faces alike', () => {
  const front = { shape: 'disc', position: [0, 0, 2], direction: [0, 0, -1], radius: 0.5 },
    back = { ...front, direction: [0, 0, 1] },
    [lf] = pack(front),
    [lb] = pack(back),
    [l2] = pack({ ...back, twoSided: true });
  assert.ok(shapes(lf, o, n, view(20), grey, 0.4, 0).total[0] > 0);
  assert.deepEqual(shapes(lb, o, n, view(20), grey, 0.4, 0).total, [0, 0, 0]);
  assert.deepEqual(shapes(l2, o, n, view(20), grey, 0.4, 0).total, shapes(lf, o, n, view(20), grey, 0.4, 0).total);
});

test('the specular cones integrate the LTC distribution over each shape, clipped to the horizon or not', () => {
  // Quadrature of the LTC distribution itself (400^2 directions; 1200^2 for tubes, whose glossy peak is a thin
  // strip of their bounding cone) against the shading: exact for spheres and discs whose mapped disc stays above
  // the horizon; clipped discs and tubes integrate polygons (within 0.3% of the quadrature here).
  for (const [name, light] of Object.entries(cases))
    for (const degrees of [0, 30, 60, 80])
      for (const roughness of [0.2, 0.5, 0.9]) {
        const [l] = pack(light),
          { magnitude } = frame(n, view(degrees), roughness),
          got = shapes(l, o, n, view(degrees), [1, 1, 1], roughness, 1).specular[0] / magnitude,
          want = ltcQuadrature(l, o, n, view(degrees), roughness, light.shape === 'tube' ? 1200 : 400);
        assert.ok(Math.abs(got - want) <= 5e-3 * want, `${name} ${degrees} r${roughness}: ${got} vs ${want}`);
      }
});

test('a disc wholly above the horizon takes the closed form; across it, the arc converges to the same value', () => {
  const disc = { c: [0.4, 0, 0.3], t1: [0, 0.5, 0], t2: [0, 0, 0.2], weight: 1 },
    lifted = { ...disc, c: [0.4, 0, 0.2000001] };
  assert.equal(
    discFormFactor((q) => q, lifted),
    coneVector((q) => q, lifted.c, lifted.t1, lifted.t2)[2],
  );
  // Rim touching the horizon from above vs just across it: the clipped arc spans the whole rim.
  const across = { ...disc, c: [0.4, 0, 0.1999999] };
  assert.ok(Math.abs(discFormFactor((q) => q, across) / discFormFactor((q) => q, lifted) - 1) < 2e-3);
});

test('LTC GGX specular follows quadrature of the BRDF over the shape as the rectangle lights do', () => {
  // The LTC table's own fit to GGX dominates, the same error the rectangle lights carry: within 8% for every shape seen
  // from 0 and 30 degrees at roughness 0.3 and 0.8 (60 degrees at roughness 0.3 is about 30% low for rectangles and
  // shapes alike; limits.md).
  // Lights across the horizon are left out: there the table's fit is worse (as for rectangles), and the clipping
  // itself is checked against the LTC distribution above.
  for (const [name, light] of Object.entries(cases)) {
    if (name === 'grazing sphere' || name === 'straddling disc') continue;
    for (const degrees of [0, 30])
      for (const roughness of [0.3, 0.8]) {
        const [l] = pack(light),
          got = shapes(l, o, n, view(degrees), grey, roughness, 1).specular[0],
          want = shapeBruteForce(l, o, n, view(degrees), grey, roughness, 1, 400).specular[0];
        assert.ok(Math.abs(got / want - 1) < 0.08, `${name} ${degrees} r${roughness}: ${got} vs ${want}`);
      }
  }
});

test('the light stays finite on the light, inside a sphere, on a disc plane and on a tube axis', () => {
  for (const [light, p] of [
    [{ shape: 'sphere', position: [0, 0, 0.5], radius: 0.5 }, [0, 0, 0]],
    [{ shape: 'sphere', position: [0, 0, 0.2], radius: 0.5 }, [0, 0, 0]],
    [{ shape: 'disc', position: [1, 0, 0], direction: [0, 1, 0], radius: 0.5 }, [0, 0, 0]],
    [{ shape: 'disc', position: [0, 0, 1], direction: [0, 0, -1], radius: 0.5 }, [0, 0, 1]],
    [{ shape: 'tube', start: [0, 0, 1], end: [0, 0, 2], radius: 0.1 }, [0, 0, 0]],
    [{ shape: 'tube', start: [-1, 0, 0.1], end: [1, 0, 0.1], radius: 0.1 }, [0, 0, 0]],
  ]) {
    const [l] = pack(light);
    for (const degrees of [0, 45, 89.9])
      for (const roughness of [0, 0.5, 1])
        assert.ok(
          shapes(l, p, n, view(degrees), grey, roughness, 0.5).total.every((v) => Number.isFinite(v) && v >= 0),
          `${JSON.stringify(light)} ${degrees}`,
        );
  }
});
