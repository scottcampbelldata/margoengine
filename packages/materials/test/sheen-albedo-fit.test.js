// The shipped sheen albedo table (materialLobesSheenAlbedo, from scripts/sheen-albedo-fit.mjs) run through
// tests/support/wgsl-eval.js against a coarse, independent integration of our own sheen BRDF (materialLobesSheenBRDF in
// lobe-shader.ts) and against the fit script's tanh-sinh quadrature where the midpoint rule is too coarse.
// scripts/sheen-albedo-gpu-check.js runs the same WGSL on a GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheen } from '../dist/index.js';
import { readFileSync } from 'node:fs';
import { closedFormAlbedoWGSL, sheenAlbedo as tanhSinhAlbedo } from '../../../scripts/sheen-albedo-fit.mjs';
import { wgslConst, wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

// The fit script measured the table on its validation grid against min(E, 1): at most 0.01426 for roughness 0.03 and
// up, 0.03070 for n.v 0.01 and up, 0.04109 anywhere (n.v 0.00056 at roughness 1e-4).
const tolerance = 0.015,
  anywhere = 0.0411;

function shippedAlbedo() {
  const source = sheen({ colorFactor: [1, 1, 1] }).declarations,
    table = wgslConst(source, 'materialLobesSheenAlbedoTable'),
    fn = wgslFunction(source, 'materialLobesSheenAlbedo');
  assert.ok(table && fn, 'materialLobesSheenAlbedo and its table are in the sheen declarations');
  const module = wgslModule(table + '\n' + fn);
  return (mu, roughness) => module.call('materialLobesSheenAlbedo', mu, roughness);
}

// Estevez and Kulla 2017, eq. 3 and Table 1 (alpha = roughness^2 is the paper's roughness).
function lambda(cos, alpha) {
  const t = (1 - alpha) ** 2,
    [a, b, c, d, e] = [
      [25.3245, 21.5473],
      [3.32435, 3.82987],
      [0.16801, 0.19823],
      [-1.27393, -1.9776],
      [-4.85967, -4.32054],
    ].map(([p0, p1]) => t * p0 + (1 - t) * p1),
    L = (x) => a / (1 + b * x ** c) + d * x + e;
  return Math.exp(cos < 0.5 ? L(cos) : 2 * L(0.5) - L(1 - cos));
}

// Charlie distribution (alpha = roughness^2) times its correlated shadowing, as in materialLobesSheenBRDF.
function brdf(roughness, nl, mu, phi) {
  const alpha = Math.max(roughness, 1e-4) ** 2,
    sv = Math.sqrt(1 - mu * mu),
    sl = Math.sqrt(1 - nl * nl),
    tangential = sv * sv + sl * sl + 2 * sv * sl * Math.cos(phi),
    sin2 = tangential / (tangential + (mu + nl) ** 2);
  return (
    ((2 + 1 / alpha) * sin2 ** (0.5 / alpha)) /
    (2 * Math.PI) /
    ((1 + lambda(mu, alpha) + lambda(nl, alpha)) * 4 * nl * mu)
  );
}

/** Midpoint rule over n.l in [0, 1] and azimuth in [0, pi] (the integrand is even in azimuth). */
function integrate(mu, roughness, n = 400) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const nl = (i + 0.5) / n;
    for (let j = 0; j < n; j++) sum += nl * brdf(roughness, nl, mu, (Math.PI * (j + 0.5)) / n);
  }
  return (2 * sum * Math.PI) / (n * n);
}

test('the coarse midpoint integration agrees with the fit script tanh-sinh quadrature', () => {
  for (const [mu, roughness] of [
    [1, 0.3],
    [1, 1],
    [0.5, 0.5],
    [0.3, 0.8],
  ])
    assert.ok(
      Math.abs(integrate(mu, roughness) - tanhSinhAlbedo(mu, roughness)) < 2e-3,
      `mu ${mu} roughness ${roughness}`,
    );
});

test('the shipped table stays within its measured error of the integrated albedo', () => {
  const albedo = shippedAlbedo();
  for (const [mu, roughness] of [
    [1, 1],
    [0.5, 1],
    [0.05, 1],
    [0.7, 0.75],
    [0.3, 0.6],
    [0.9, 0.5],
    [0.5, 0.5],
    [0.15, 0.5],
    [0.3, 0.3],
    [0.6, 0.35],
    [0.2, 0.2],
    [0.12, 0.1],
    [0.08, 0.08],
  ]) {
    const expected = Math.min(1, integrate(mu, roughness)),
      actual = albedo(mu, roughness);
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `mu ${mu} roughness ${roughness}: fit ${actual.toFixed(4)}, integral ${expected.toFixed(4)}`,
    );
  }
});

test('the table holds its stated bound at small roughness and grazing views, where E is a cliff in n.v', () => {
  const albedo = shippedAlbedo();
  for (const [mu, roughness] of [
    [0.02, 0.01],
    [0.03, 0.01],
    [0.05, 0.02],
    [0.1, 0.03],
    [0.06, 0.03],
    [0.01, 1],
    [0.002, 0.8],
    [0.005, 0.5],
    [0.001, 0.0005],
  ]) {
    const expected = Math.min(1, tanhSinhAlbedo(mu, roughness)),
      actual = albedo(mu, roughness),
      bound = roughness >= 0.03 ? tolerance : anywhere;
    assert.ok(
      Math.abs(actual - expected) <= bound,
      `mu ${mu} roughness ${roughness}: table ${actual.toFixed(4)}, integral ${expected.toFixed(4)}`,
    );
  }
});

test('the table is a finite energy fraction, 1 at grazing for smooth sheen and near 0 at normal view', () => {
  const albedo = shippedAlbedo();
  for (const roughness of [0, 1e-4, 0.01, 0.1, 0.25, 0.5, 0.75, 1, 1.5])
    for (let i = 0; i <= 200; i++) {
      const value = albedo(i / 200, roughness);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `roughness ${roughness} mu ${i / 200}`);
    }
  // E(0, r) passes 1 for small r (clamped to 1); smooth sheen reflects nothing back along the normal.
  assert.equal(albedo(0, 0), 1);
  assert.ok(albedo(0.01, 0) < 1e-6 && albedo(1, 0) < 1e-6);
  // Rough sheen keeps the integral's rise just before grazing (E(0.01, 1) 0.940 against E(0.2, 1) 0.584).
  assert.ok(albedo(0.01, 1) > albedo(0.2, 1) + 0.3);
});

// The GPU check compares the shipped table with the closed form it replaced. That reference was once taken as the
// parent of the last commit touching packages/shared/sheen.js, so a later, unrelated sheen fix to that file made the
// reference the shipped table itself and the check failed on a correct tree. It is now pinned: its coefficients are
// polynomials in roughness and a knee, a fit of the sheen albedo E of Estevez and Kulla 2017. It is held here too
// because the commit that held it is not in every checkout's history, and a test must not need history. Never edit
// it to follow the script: it is the reference the script's copy is checked against.
const original = `fn materialLobesSheenAlbedo(mu:f32,roughness:f32)->f32 {
  let sheenR2=roughness*roughness;let sheenKnee=sheenR2/(sheenR2+0.046698);
  let sheenBasis=vec4f(1.0,sheenKnee,roughness,sheenKnee*roughness);let sheenX=mu/max(roughness,0.0001);
  return clamp(exp(dot(sheenBasis,vec4f(0.67486,-1.0569,1.2955,-1.6596))-sheenX*(dot(sheenBasis,vec4f(0.78851,0.09914,-0.27042,0.61309))+sheenX*dot(sheenBasis,vec4f(0.072685,0.29184,-0.084342,-0.10518)))),0.0,1.0);
}
`;

test('the GPU check reference is the pinned closed form the table replaced, not a revision found from history', () => {
  const root = new URL('../../../', import.meta.url);
  assert.equal(closedFormAlbedoWGSL('materialLobesSheenAlbedo'), original);
  assert.ok(
    !sheen({ colorFactor: [1, 1, 1] }).declarations.includes(original.trim()),
    'shipped is not the closed form',
  );
  const script = readFileSync(new URL('scripts/sheen-albedo-gpu-check.js', root), 'utf8');
  assert.match(script, /closedFormAlbedoWGSL\(name\)/);
  assert.doesNotMatch(script, /'log'/, 'the check must not pick its reference from the history of shared/sheen.js');
});
