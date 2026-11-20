// CPU checks of @margoengine/shader/black-hole: the Kerr radii, Page-Thorne flux, redshift, jet Doppler factor and
// black-body colour against published values, and the Kerr ray integrator (the twin of the shader's) against the known
// shadow edges, its null condition and the spin axis crossing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shaderCommentsLeft } from '../../../scripts/shader-comments.mjs';
import {
  ESCAPE_RADIUS,
  POLE_BAND,
  blackHoleShader,
  blackbodyColor,
  crossesEquator,
  diskRedshift,
  jetDoppler,
  kerrHorizon,
  kerrIsco,
  kerrLapse,
  kerrPhotonOrbit,
  novikovThorneFlux,
  traceGeodesic,
} from '../dist/black-hole.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('Kerr radii match Bardeen, Press and Teukolsky (1972)', () => {
  near(kerrHorizon(0), 2, 1e-12, 'horizon a=0');
  near(kerrIsco(0), 6, 1e-12, 'ISCO a=0');
  near(kerrPhotonOrbit(0), 3, 1e-12, 'photon orbit a=0');
  near(kerrHorizon(0.998), 1.0632, 1e-4, 'horizon a=0.998');
  near(kerrIsco(0.998), 1.2370, 1e-3, 'ISCO a=0.998');
});

test('Page-Thorne flux: zero at the ISCO, peak at 9.55 M for a = 0, Newtonian far out', () => {
  near(novikovThorneFlux(6, 0), 0, 1e-12, 'flux at the ISCO');
  assert.equal(novikovThorneFlux(4, 0.5), 0);
  let peak = 0,
    at = 0;
  for (let r = 6.001; r < 30; r += 0.001) {
    const f = novikovThorneFlux(r, 0);
    if (f > peak) [peak, at] = [f, r];
  }
  near(at, 9.55, 0.02, 'peak radius');
  // F -> 3 / (8 pi r^3) (1 - sqrt(r_in / r)) far out.
  const r = 1e6;
  near((novikovThorneFlux(r, 0.5) * 8 * Math.PI * r ** 3) / 3, 1 - Math.sqrt(kerrIsco(0.5) / r), 2e-3, 'Newtonian limit');
});

test('disk redshift and jet Doppler factor', () => {
  // A photon with no angular momentum from r = 6M (a = 0): g = 1 / u^t = sqrt(1 - 3M / r).
  near(diskRedshift(6, 0, 0), Math.sqrt(0.5), 1e-9, 'g at the ISCO, lambda 0');
  // Light sent forward along the orbit is blue shifted, backward red shifted.
  assert.ok(diskRedshift(10, 0, 7) > 1 && diskRedshift(10, 0, -7) < diskRedshift(10, 0, 0));
  near(jetDoppler(5, 0), 0.2, 1e-12, 'side-on D at Gamma 5');
  near(jetDoppler(5, 1), 5 + Math.sqrt(24), 1e-9, 'head-on D at Gamma 5');
});

test('black-body colour follows the Planckian locus', () => {
  const white = blackbodyColor(6500);
  assert.ok(Math.max(...white) / Math.min(...white) < 1.15, `6500 K ${white}`);
  const warm = blackbodyColor(3000);
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2], `3000 K ${warm}`);
  const hot = blackbodyColor(20000);
  assert.ok(hot[2] > hot[0], `20000 K ${hot}`);
});

// A ray sent from far out along -z with x offset X has axial angular momentum b = -2X (M); its fate gives the shadow edge.
const fate = (x, spin) => traceGeodesic([x, 0, 400], [0, 0, -1], { spin, steps: 600 });

test('the shadow edges: 3 sqrt(3) M without spin, 2 M prograde and 7 M retrograde near a = 1', () => {
  assert.equal(fate(-2.55, 0).fate, 'horizon');
  assert.equal(fate(-2.65, 0).fate, 'escape');
  assert.equal(fate(2.55, 0).fate, 'horizon');
  assert.equal(fate(-0.95, 0.998).fate, 'horizon');
  assert.equal(fate(-1.3, 0.998).fate, 'escape');
  assert.equal(fate(3.4, 0.998).fate, 'horizon');
  assert.equal(fate(3.6, 0.998).fate, 'escape');
});

test('rays stay null: |H| under 1e-5 on escaping rays', () => {
  for (const [x, a] of [[-3.6, 0.998], [3.6, 0.998], [-2.7, 0]]) {
    const g = fate(x, a);
    assert.equal(g.fate, 'escape');
    assert.ok(g.drift < 1e-5, `drift ${g.drift} at x ${x}, a ${a}`);
  }
});

test('a ray over the spin axis goes on to the far side (regression: the pole notch)', () => {
  // Rays from a camera on the z axis aimed just either side of the axis above the hole: both pass the pole and must
  // leave in nearly the same direction. Before the reflection at theta = 0 they bounced back at the clamped pole.
  const a = traceGeodesic([0.001, 0.5, 12], [-0.001, 4.5, -12], { spin: 0.9 }),
    b = traceGeodesic([-0.001, 0.5, 12], [0.001, 4.5, -12], { spin: 0.9 });
  assert.equal(a.fate, 'escape');
  const dot = a.direction.reduce((s, v, i) => s + v * b.direction[i], 0);
  assert.ok(dot > 0.999, `directions differ: ${a.direction} vs ${b.direction}`);
  assert.ok(a.direction[2] < 0, `the ray must go on past the hole: ${a.direction}`);
});

test('a captured ray still crosses the disk on its way in (regression: the stepped inner rim)', () => {
  // Aimed just above the near inner rim from an inclined camera: the ray is already known to be captured (falling inside
  // r = 4 M) when it crosses the disk between the ISCO and 2 r_s, and it must still meet the disk there. Before the fix
  // the march stopped as soon as a ray was known to be captured, so the inner rim showed steps.
  const g = traceGeodesic([0, 0.95, 11.8], [0, -0.0925, -1], { spin: 0.9 });
  assert.equal(g.fate, 'horizon');
  assert.equal(g.disk.length, 1, `no disk crossing: ${JSON.stringify(g.disk)}`);
  assert.ok(g.disk[0] > kerrIsco(0.9) / 2 && g.disk[0] < 2, `crossing at ${g.disk[0]} r_s`);
});

test('the shader filters by footprint and draws stars as points', () => {
  // The three audit defects, at their roots: disk octaves fade by ray-differential footprint (no fine banding), stars
  // map through the inverse footprint jacobian with their magnification (no dashes), the jet is sampled four times a
  // step with D^(2 + alpha) beaming (no pale side-on columns), and no atan2 sets the camera frame.
  assert.match(blackHoleShader, /dpdx\(q00\)/);
  assert.match(blackHoleShader, /smoothstep\(0\.25, 0\.5, f\)/);
  assert.match(blackHoleShader, /fr\.inv \* vec2f/);
  // The escape radius in the WGSL (in M) is twice ESCAPE_RADIUS (in r_s), written out in the literal.
  assert.ok(blackHoleShader.includes(`if (r > ${(ESCAPE_RADIUS * 2).toFixed(1)} && k1.d.x > 0.0)`), 'escape radius out of step');
  assert.match(blackHoleShader, /pow\(lapse \* D, 2\.7\)/);
  // The axis band in the WGSL matches POLE_BAND (axial rays turn within a third of it), written out in the literal.
  assert.ok(blackHoleShader.includes(`select(0.0, ${POLE_BAND}, tMin <= ${(POLE_BAND / 3).toFixed(8)})`), 'axis band out of step');
  // The disk-plane crossing is half open, as crossesEquator.
  assert.ok(blackHoleShader.includes('if ((y.y < 1.5707963) != (yn.y < 1.5707963))'), 'disk crossing not half open');
  assert.doesNotMatch(blackHoleShader, /atan2\(-cm/);
});

test('no ray-dependent branch is the only user of a derivative (regression: the star ring on the WebGL2 layer)', () => {
  // A compiler may sink a derivative into the one branch that uses it; with other invocations of the quad outside the
  // branch the result is undefined (WGSL derivatives, GLSL ES 3.00 section 8.9). ANGLE Direct3D 11 on an NVIDIA RTX
  // A6000 returned 0 for dpdx(rd) inside `if (escaped)`: the shadow's edge drew unblended stars at the magnification
  // cap (black-hole-check.mjs, median axis ratio 2.06) and `if (k < crossings)` lost the disk's footprint. From the
  // first derivative to the output, the fragment branches only to keep e1 finite, which uses no derivative.
  const fragment = blackHoleShader.slice(blackHoleShader.indexOf('@fragment fn fragment'));
  const tail = fragment.slice(fragment.indexOf('dpdx('), fragment.indexOf('return margoDisplay('));
  assert.ok(tail.length > 0, 'derivatives or the output not found');
  const branches = [...tail.matchAll(/\bif \(/g)].map((m) => {
    let depth = 1,
      end = m.index + m[0].length;
    while (depth > 0) depth += { '(': 1, ')': -1 }[tail[end++]] ?? 0;
    return tail.slice(m.index + m[0].length, end - 1);
  });
  assert.deepEqual(branches, ['dot(e1, e1) < 1e-8'], `branches between the derivatives and the output: ${branches}`);
  assert.doesNotMatch(tail, /\b(while|loop|break|return)\b/, 'a ray-dependent exit between the derivatives and the output');
});

test('the shipped shader dist carries no shader comment text (KB-WGSL1: the build strips black-hole and noise)', () => {
  // The WGSL sources keep their comments for readers; the build strips them from dist, so none ships.
  for (const name of ['black-hole', 'noise']) {
    const file = new URL(`../dist/${name}.js`, import.meta.url);
    const left = shaderCommentsLeft(readFileSync(file, 'utf8'), file.pathname);
    assert.deepEqual([left.comments, left.kept.length], [0, 0], `${name}: comments left in its shader strings`);
  }
});

test('rays a hair either side of the spin axis leave together (regression: the dashed seam over the pole)', () => {
  // Rays in and just beside the camera's meridian pass over the spin axis with a tiny axial angular momentum b. Before
  // the axis band and step limit (kerrAxial, kerrAxisStep) their turn near the axis took one unresolved step, so rays a
  // hundredth of a pixel apart left in unrelated directions: a dashed line through the sky and over the far disk.
  const norm = (v) => v.map((x) => x / Math.hypot(...v));
  // The opening view, 46 r_s out: rays pass the axis 16 r_s above the hole and must go on almost straight.
  const cam = [-6.5, 5.2, 95],
    aim = [0.068, 0.123, -0.99],
    side = norm([0.99, 0, 0.068]);
  const dirs = [0, 1e-5, 1e-4, 4e-4, 1e-3, 3e-3].map((o) => {
    const g = traceGeodesic(cam, norm(aim.map((v, i) => v + side[i] * o)), { spin: 0.9 });
    assert.equal(g.fate, 'escape');
    return g.direction;
  });
  for (const d of dirs) {
    const angle = Math.acos(Math.min(1, d.reduce((s, v, i) => s + v * dirs[0][i], 0)));
    assert.ok(angle < 0.004, `direction off by ${angle} rad: ${d} vs ${dirs[0]}`);
  }
  // Looking down at 70 degrees latitude: rays over the pole to the far disk meet it where their neighbours do.
  const pole = [2.3, 11.7, 3.4],
    f = norm(pole.map((v) => -v)),
    r = norm([-f[2], 0, f[0]]),
    u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  for (const t of [0.25, 0.3, 0.35, 0.4]) {
    const hits = [0, 1e-5, 1e-4, 1e-3, 3e-3].map((o) => {
      const g = traceGeodesic(pole, norm(f.map((v, i) => v + u[i] * t + r[i] * o)), { spin: 0.9 });
      assert.ok(g.disk.length > 0, `no disk crossing at t ${t}, offset ${o}`);
      return g.disk[0];
    });
    for (const h of hits) near(h, hits[0], 0.12, `far-disk crossing at t ${t}`);
  }
});

test('the jet light is redshifted by the lapse, so its base fades at the horizon (regression: the dot in the shadow)', () => {
  // Schwarzschild: alpha = sqrt(1 - 2M / r).
  for (const r of [2.5, 3, 6, 50]) near(kerrLapse(r, 1, 0), Math.sqrt(1 - 2 / r), 1e-12, `lapse a=0 at r ${r}`);
  // Kerr: 0 on the horizon at any angle, rising to 1 far out.
  for (const th of [0.05, 1, Math.PI / 2]) near(kerrLapse(kerrHorizon(0.9), th, 0.9), 0, 1e-6, `lapse on the horizon at ${th}`);
  near(kerrLapse(1e6, 0.3, 0.9), 1, 1e-5, 'lapse far out');
  // Over the pole, 0.5 M above the horizon, the jet's light keeps under 40% of its frequency: alpha^2.7 under 0.1.
  assert.ok(kerrLapse(kerrHorizon(0.9) + 0.5, 0, 0.9) ** 2.7 < 0.1, 'jet base not dimmed');
});

test('a step ending exactly on the disk plane still crosses it once (regression: dark specks on the disk)', () => {
  // The product test (theta0 - pi/2) * (theta1 - pi/2) < 0 is false for a step that ends on the plane and for the step
  // after it, so the crossing was lost and the sky showed through the disk in single pixels.
  const h = Math.PI / 2;
  assert.equal(crossesEquator(h - 0.01, h), true);
  assert.equal(crossesEquator(h, h + 0.01), false);
  assert.equal(crossesEquator(h + 0.01, h), false);
  assert.equal(crossesEquator(h, h - 0.01), true);
  assert.equal(crossesEquator(h - 0.01, h + 0.01), true);
  assert.equal(crossesEquator(h - 0.02, h - 0.01), false);
});
