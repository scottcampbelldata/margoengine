import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN, bounceIrradiance, bounceLightSource, bounceViews, packBounce, pointFalloff, reduceBounce, texelRay } from '../dist/bounce.js';
import { IESLights, iesCandela, parseIES } from '../dist/ies.js';
import { ProjectorLights } from '../dist/projector.js';
import { CubeProjectorLights } from '../dist/cube-projector.js';
import { LightLayers } from '../dist/layers.js';
import { iesFile, range } from './ies-reference.js';
import { image, projectorColor } from './projector-reference.js';

// KB-BOUNCE-TERMS1: a lamp's bounce is the bounce of the light it casts. Its IES profile, projector image, cube cookie
// and layers shape what each captured surface gets, as they shape its direct light, so the one-bounce irradiance at a
// receiver is the quadrature of the lamp's own direct term over the floor: E(x) = sum over floor elements of
// (albedo / pi) E_direct(y) cos_y cos_x / r^2 dA, E_direct(y) = I(y) falloff(y) cos(theta_y) with I(y) the term's
// factor from an independent reference (the profile's own candela, the projector reference built on the spot's
// shadow camera, a cube face's colour).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit = (a) => {
    const l = Math.hypot(...a);
    return a.map((x) => x / l);
  };
// The floor: x -2 to 2, z -1 to 3 at y 0, albedo 0.8, seen from both sides.
const floor = { c: [0, 0, 1], u: [2, 0, 0], v: [0, 0, 2], albedo: [0.8, 0.8, 0.8], n: [0, 1, 0] },
  receiver = [[0, 1, -1.2], [0, 0, 1]],
  lampAt = [0, 2, 1];
/** The floor's capture from `source`, as the GPU writes it: albedo and distance per texel. */
function capture(source, resolution = 48) {
  const views = bounceViews(source),
    texels = new Float32Array(views.length * resolution * resolution * 4);
  views.forEach((view, f) => {
    for (let j = 0; j < resolution; j++)
      for (let i = 0; i < resolution; i++) {
        const d = texelRay(view, resolution, i, j),
          denom = dot(d, floor.n);
        if (Math.abs(denom) < 1e-12) continue;
        const t = dot(sub(floor.c, view.eye), floor.n) / denom;
        if (!(t > 1e-6)) continue;
        const p = view.eye.map((o, k) => o + d[k] * t);
        if (Math.abs(p[0] - floor.c[0]) > 2 || Math.abs(p[2] - floor.c[2]) > 2) continue;
        texels.set([...floor.albedo, t], ((f * resolution + j) * resolution + i) * 4);
      }
  });
  return { views, resolution, texels };
}
/** The receiver's bounce (rgb, per unit intensity) from light 0 of `lights` through 32 VPLs. */
function bounce(lights) {
  const source = bounceLightSource(lights, 0),
    { vpls } = reduceBounce(capture(source), source, { vpls: 32, near: 0.15 }),
    data = packBounce([[1, 1, 1]], vpls, new Float32Array(vpls.length * 1024).fill(OPEN), 32);
  return bounceIrradiance(data, ...receiver);
}
/** The quadrature of the bounce of the lamp's own direct term `factor(y)` (rgb) times its plain falloff, 4 cm elements. */
function quadrature(plain, factor) {
  const step = 0.04,
    [x, n] = receiver,
    out = [0, 0, 0];
  for (let a = -2 + step / 2; a < 2; a += step)
    for (let b = -1 + step / 2; b < 3; b += step) {
      const y = [a, 0, b],
        toLamp = unit(sub(plain.position, y)),
        direct = pointFalloff(plain, y) * Math.max(toLamp[1], 0),
        w = sub(x, y),
        r2 = dot(w, w),
        d = w.map((c) => c / Math.sqrt(r2)),
        form = (Math.max(d[1], 0) * Math.max(-dot(n, d), 0) * step * step) / r2,
        f = factor(y);
      for (let k = 0; k < 3; k++) out[k] += (floor.albedo[k] / Math.PI) * direct * f[k] * form;
    }
  return out;
}
const near = (got, want, label, tolerance = 0.05) => {
  for (let k = 0; k < 3; k++)
    if (want[k] > 1e-9) assert.ok(Math.abs(got[k] / want[k] - 1) < tolerance, `${label} channel ${k}: ${got[k]} vs the quadrature's ${want[k]}`);
    else assert.ok(Math.abs(got[k]) < 1e-9, `${label} channel ${k}: ${got[k]} where the quadrature gives 0`);
};
const fakeLights = (list) => ({ list, setLights() {} });

test("an IES lamp bounces the light its profile casts, not a plain point light's", () => {
  // Dark straight down, bright from 30 to 60 degrees, and twice as bright toward phi 90 (the receiver's side, -z).
  const profile = parseIES(
      iesFile(range(0, 180, 5), range(0, 360, 15), (t, p) => (t < 20 ? 50 : t <= 60 ? 1000 : 200) * (1 + Math.max(0, Math.sin((p * Math.PI) / 180)))),
    ),
    light = { position: lampAt, range: 0, intensity: 1 },
    host = fakeLights([light]),
    ies = new IESLights({ lights: host }).setProfiles([{ profile, rotation: 0.3 }]),
    lights = { list: [light], ies },
    plain = bounceLightSource({ list: [light] }, 0),
    // The documented frame: axis down, horizontal angle 0 along +x, phi counterclockwise seen from behind the light.
    candela = (y) => {
      const d = unit(sub(y, lampAt)),
        axis = [0, -1, 0],
        ex = [1, 0, 0],
        ey = cross(ex, axis),
        theta = (Math.acos(dot(d, axis)) * 180) / Math.PI,
        phi = ((Math.atan2(dot(d, ey), dot(d, ex)) - 0.3) * 180) / Math.PI;
      return iesCandela(profile, theta, ((phi % 360) + 360) % 360) / profile.peak;
    },
    want = quadrature(plain, (y) => [candela(y), candela(y), candela(y)]),
    got = bounce(lights),
    old = bounce({ list: [light] });
  near(got, want, 'IES');
  assert.ok(Math.abs(old[0] / want[0] - 1) > 0.3, `the plain point light's bounce ${old[0]} is not the profile's ${want[0]}`);
});

test("a projector spot bounces the colours of its image; a cube cookie a point light's", () => {
  // A red | blue image on a 50-degree spot straight down: the floor toward the receiver (-z) is one colour.
  const picture = image(2, 2, (x) => (x === 0 ? [255, 40, 0, 255] : [0, 60, 255, 255])),
    light = { position: lampAt, direction: [0, -1, 0], angle: 0.9, penumbra: 0.2, range: 0, intensity: 1 },
    projector = new ProjectorLights({ lights: fakeLights([light]) }).setProjectors([{ image: picture, colorSpace: 'linear' }]),
    plain = bounceLightSource({ list: [light] }, 0),
    want = quadrature(plain, (y) => projectorColor({ ...light, outerAngle: light.angle }, y, { image: picture, colorSpace: 'linear' })),
    got = bounce({ list: [light], projector });
  near(got, want, 'projector');
  const old = bounce({ list: [light] });
  assert.ok(Math.abs(old[2] / want[2] - 1) > 0.3, `the plain spot's blue ${old[2]} is not the image's ${want[2]}`);

  // A point light with a cube cookie whose -Y face is orange and the others black: only the floor below 45 degrees.
  const side = 64,
    face = (rgba) => image(side, side, () => rgba),
    black = face([0, 0, 0, 255]),
    orange = face([255, 128, 26, 255]),
    point = { position: lampAt, range: 0, intensity: 1 },
    cubes = new CubeProjectorLights({ lights: fakeLights([point]) }).setCubes([
      { image: { faces: [black, black, black, orange, black, black] }, colorSpace: 'linear' },
    ]),
    tint = [1, 128 / 255, 26 / 255],
    below = (y) => {
      const d = sub(y, lampAt);
      return -d[1] >= Math.max(Math.abs(d[0]), Math.abs(d[2])) ? tint : [0, 0, 0];
    },
    cookie = bounce({ list: [point], projector: cubes });
  // The filter blends across a face's edge over one texel, 1/32 of the face: within 5% of the hard-edged quadrature.
  near(cookie, quadrature(bounceLightSource({ list: [point] }, 0), below), 'cube cookie');
});

test("a lamp off layer 0 bounces nothing off core meshes; on it, all of its light", () => {
  const light = { position: lampAt, range: 0, intensity: 1 },
    plain = bounce({ list: [light] }),
    layers = (mask) => new LightLayers({ lights: fakeLights([light]) }).setLayers([mask]);
  assert.deepEqual(bounce({ list: [light], layers: layers(2) }), [0, 0, 0]);
  assert.deepEqual(bounce({ list: [light], layers: layers(3) }), plain);
  assert.ok(plain[0] > 0);
});

test('a spot of half angle pi / 2 bounces off what is in front of it only, as the light loop lights it', () => {
  const light = { position: lampAt, direction: [0, 1, 0], angle: Math.PI / 2, range: 0, intensity: 1 },
    source = bounceLightSource({ list: [light] }, 0);
  assert.deepEqual(source.direction, [0, 1, 0]);
  // Pointing up, away from the floor: the floor is behind its cone.
  assert.deepEqual(bounce({ list: [light] }), [0, 0, 0]);
  const down = { ...light, direction: [0, -2, 0] };
  assert.ok(bounce({ list: [down] })[0] > 0);
});

