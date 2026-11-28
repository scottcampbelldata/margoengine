// Checks @margoengine/optics against closed-form solutions and published measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snell,
  criticalAngle,
  brewsterAngle,
  fresnelReflectance,
  sellmeierIndex,
  FUSED_SILICA,
  N_BK7,
  cauchyFromAbbe,
  cauchyIndex,
  prismDeviation,
  minimumDeviation,
  minimumDeviationIncidence,
  hexagonalHaloProfile,
  traceGradedRay,
  ciddorRefractivity,
  heatedAirLayer,
  layeredElevation,
  refractVector,
  tracePolygon,
} from '../dist/refraction.js';
import { malus, JonesVector, JonesMatrix, photoelasticTransmission, photoelasticColors } from '../dist/polarization.js';
import {
  thinFilmReflectance,
  multilayerReflectance,
  quarterWaveStack,
  thinFilmColor,
  michelsonFringes,
  michelsonIntensity,
  moireSpacing,
} from '../dist/interference.js';
import {
  gratingOrders,
  gratingAngle,
  besselJ,
  airyIntensity,
  airyFirstZero,
  AIRY_FIRST_ZERO,
  fresnelNumber,
  circularPointSpread,
} from '../dist/diffraction.js';
import {
  thinLens,
  pinholeImage,
  relativeIllumination,
  astigmaticFoci,
  designFresnelLens,
  cornerCubeReflect,
  knifeEdgeTransmission,
} from '../dist/imaging.js';
import { cieXYZ, planckRelative, spectralColor, SpectralIntegrator, wavelengthToLinearSRGB } from '../dist/spectrum.js';
import * as root from '../dist/index.js';

const deg = Math.PI / 180;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

test('Snell and total internal reflection', () => {
  close(snell(1, 1.5, 30 * deg), Math.asin(0.5 / 1.5), 1e-15, 'air to glass');
  close(criticalAngle(1.5, 1), Math.asin(1 / 1.5), 1e-15, 'critical angle');
  assert.equal(criticalAngle(1, 1.5), null);
  assert.equal(snell(1.5, 1, 42 * deg), null, 'past 41.8 deg the ray is reflected');
  assert.notEqual(snell(1.5, 1, 41 * deg), null);
  assert.deepEqual(fresnelReflectance(1.5, 1, 60 * deg), { s: 1, p: 1, average: 1 });
});

test('Fresnel: p reflectance is zero at Brewster, normal incidence ((n1-n2)/(n1+n2))^2', () => {
  const b = brewsterAngle(1, 1.5);
  close(b, Math.atan(1.5), 1e-15, 'Brewster');
  close(fresnelReflectance(1, 1.5, b).p, 0, 1e-30, 'Rp at Brewster');
  const r0 = fresnelReflectance(1, 1.5, 0);
  close(r0.s, 0.04, 1e-15, 'Rs normal');
  close(r0.p, 0.04, 1e-15, 'Rp normal');
  // Energy conservation at grazing approach: R tends to 1.
  assert.ok(fresnelReflectance(1, 1.5, 89.999 * deg).average > 0.999);
});

test('Sellmeier: Malitson 1965 fused silica and SCHOTT N-BK7 data sheet values', () => {
  // Malitson 1965, Table 1 (measured, 20 C): 0.5875618 um 1.45846; 0.6328 um 1.45702; 0.4861327 um 1.46313.
  close(sellmeierIndex(587.5618, FUSED_SILICA), 1.45846, 2e-5, 'fused silica d line');
  close(sellmeierIndex(632.8, FUSED_SILICA), 1.45702, 2e-5, 'fused silica 632.8 nm');
  close(sellmeierIndex(486.1327, FUSED_SILICA), 1.46313, 2e-5, 'fused silica F line');
  // N-BK7: n_d 1.5168, n_F 1.52238, n_C 1.51432 (data sheet).
  close(sellmeierIndex(587.56, N_BK7), 1.5168, 1e-4, 'BK7 d');
  close(sellmeierIndex(486.13, N_BK7), 1.52238, 1e-4, 'BK7 F');
  close(sellmeierIndex(656.27, N_BK7), 1.51432, 1e-4, 'BK7 C');
});

test('Cauchy through n_d and the Abbe number reproduces both', () => {
  const c = cauchyFromAbbe(1.5168, 64.17);
  close(cauchyIndex(587.56, c), 1.5168, 1e-12, 'n_d');
  const v = (cauchyIndex(587.56, c) - 1) / (cauchyIndex(486.13, c) - cauchyIndex(656.27, c));
  close(v, 64.17, 1e-9, 'Abbe');
});

test('Prism: minimum deviation is the symmetric passage; ice n = 1.31 gives the 22 degree halo', () => {
  const apex = 60 * deg;
  close(minimumDeviation(apex, 1.31) / deg, 21.84, 0.01, 'ice minimum deviation');
  const i0 = minimumDeviationIncidence(apex, 1.31);
  const ray = prismDeviation(apex, i0, 1.31);
  close(ray.deviation, minimumDeviation(apex, 1.31), 1e-12, 'trace at minimum');
  close(ray.exit, ray.incidence, 1e-12, 'symmetric');
  for (const d of [-5, -1, 1, 5]) assert.ok(prismDeviation(apex, i0 + d * deg, 1.31).deviation > ray.deviation);
  assert.equal(prismDeviation(apex, 5 * deg, 1.31), null, 'grazing exit is reflected inside');
  const profile = hexagonalHaloProfile({ indices: [1.31], minAngle: 17, maxAngle: 33, bins: 161 });
  let best = 0;
  for (let i = 1; i < 161; i++) if (profile[i] > profile[best]) best = i;
  const peakAngle = 17 + (16 * best) / 160;
  close(peakAngle, 21.84, 0.35, 'halo peak at minimum deviation');
  // Nothing inside the halo (the dark sky inside the ring).
  assert.ok(profile[Math.round(((20.5 - 17) / 16) * 160)] < 0.05);
});

test('Graded index: n cos(theta) is conserved and a hot layer turns a falling ray (inferior mirage)', () => {
  const n0 = 1.000277,
    k = 1e-4;
  const medium = { index: (y) => n0 - k * Math.exp(-y / 0.05), gradient: (y) => (k / 0.05) * Math.exp(-y / 0.05) };
  const ray = traceGradedRay(medium, { height: 0.5, elevation: -0.25 * deg, distance: 400, ceiling: 0.5, path: true });
  assert.equal(ray.kind, 'ceiling');
  assert.ok(ray.turn, 'turned');
  close(medium.index(ray.height) * Math.cos(ray.elevation), ray.invariant, 1e-9, 'invariant at the end');
  close(medium.index(ray.turn.height), ray.invariant, 2e-8, 'n at the turning point equals the invariant');
  const steep = traceGradedRay(medium, { height: 0.5, elevation: -3 * deg, distance: 400 });
  assert.equal(steep.kind, 'ground');
});

test('heated air layer: Ciddor refractivity, exact gradient and inverse, exact mirage turning point', () => {
  // Ciddor 1996 equation (1) at 550 nm: n - 1 = 2.77838e-4 for standard air; the refractivity falls with wavelength.
  close(ciddorRefractivity(550), 2.77838e-4, 1e-9, 'Ciddor 550 nm');
  assert.ok(ciddorRefractivity(450) > ciddorRefractivity(550) && ciddorRefractivity(550) > ciddorRefractivity(700));
  const air = heatedAirLayer({ ambient: 26, surface: 58, depth: 0.02 });
  close(air.farIndex, 1 + (ciddorRefractivity(550) * 288.15) / 299.15, 1e-16, 'far index');
  assert.ok(air.index(0) < air.index(0.01) && air.index(0.01) < air.farIndex, 'hot air is optically thinner');
  for (const y of [0.001, 0.01, 0.03, 0.1]) {
    const h = 1e-7;
    close(air.gradient(y), (air.index(y + h) - air.index(y - h)) / (2 * h), 1e-9, `gradient at ${y}`);
    close(air.heightAt(air.index(y)), y, 1e-9, `inverse at ${y}`);
  }
  assert.ok(Number.isNaN(heatedAirLayer({ ambient: 20, surface: 20, depth: 0.02 }).heightAt(1.0003)), 'no layer, no inverse');
  // With the inverse the turning point lies exactly where n equals the invariant (Born and Wolf 3.2.1), not between steps.
  const deg = Math.PI / 180;
  const ray = traceGradedRay(air, { height: 0.5, elevation: -0.3 * deg, distance: 640, ceiling: 0.5 });
  assert.equal(ray.kind, 'ceiling');
  assert.ok(ray.turn, 'turned');
  close(air.index(ray.turn.height), ray.invariant, 1e-15, 'n at the turn is the invariant');
  // The layer's own step controller is used by default: fine at the surface, coarse far above it.
  close(air.step(0, -0.05), 0.065, 1e-15, 'fine at the surface');
  close(air.step(5, 0.01), 8, 1e-12, 'coarse far above');
  const fixed = traceGradedRay(air, { height: 0.5, elevation: -0.3 * deg, distance: 640, ceiling: 0.5, step: () => 1.25 });
  assert.notEqual(fixed.distance, ray.distance, 'an explicit step overrides the medium');
  // It leaves into still air at the elevation the invariant gives: symmetric with the start for a ray that started there.
  close(layeredElevation(ray.invariant, air.index(0.5)), 0.3 * deg, 1e-12, 'leaves at the start elevation');
  close(layeredElevation(1, 1), 0, 0, 'horizontal');
  assert.throws(() => heatedAirLayer({ ambient: 26, surface: 58, depth: 0 }), RangeError);
});

test('SpectralIntegrator luminance: white is 1, a cut keeps the Y-weighted share', () => {
  const integrator = new SpectralIntegrator({ min: 380, max: 740, step: 4 });
  close(integrator.luminance(() => 1), 1, 1e-14, 'white');
  close(integrator.luminance(() => 0.25), 0.25, 1e-14, 'grey');
  // A long-pass edge at 555 nm (the Y peak) keeps about half the luminance; Y = sum ybar w R / sum ybar w by hand.
  let num = 0, den = 0;
  for (let i = 0; i < integrator.wavelengths.length; i++) {
    const nm = integrator.wavelengths[i], w = planckRelative(nm, 6504) * (i === 0 || i === 90 ? 0.5 : 1), y = cieXYZ(nm)[1] * w;
    num += (nm >= 555 ? 1 : 0) * y;
    den += y;
  }
  close(integrator.luminance((nm) => (nm >= 555 ? 1 : 0)), num / den, 1e-14, 'long-pass');
});

test('refractVector obeys Snell in 2D and 3D; tracePolygon through an equilateral prism matches prismDeviation', () => {
  const deg = Math.PI / 180;
  for (const a of [0, 20, 45, 70]) {
    const d = [Math.sin(a * deg), -Math.cos(a * deg)];
    const t = refractVector(d, [0, 1], 1 / 1.5);
    close(Math.asin(t[0]), snell(1, 1.5, a * deg), 1e-14, `2D ${a}`);
    close(Math.hypot(...t), 1, 1e-15, 'unit');
    // The normal may face either way.
    assert.deepEqual(refractVector(d, [0, -1], 1 / 1.5), t);
    const t3 = refractVector([d[0], d[1], 0], [0, 1, 0], 1 / 1.5);
    close(t3[0], t[0], 1e-15, '3D x');
  }
  assert.equal(refractVector([Math.sin(60 * deg), -Math.cos(60 * deg)], [0, 1], 1.5), null, 'total internal reflection');
  // Equilateral prism (apex up), ray from the left at 50 deg incidence on the left face.
  const prism = [[-0.5, 0], [0.5, 0], [0, Math.sqrt(3) / 2]];
  const n = 1.6, incidence = 50 * deg;
  // The left face's inward normal points 30 deg below horizontal; turning it 50 deg up gives a 20 deg ray toward the apex.
  const dir = [Math.cos(20 * deg), Math.sin(20 * deg)];
  const hit = [-0.25, Math.sqrt(3) / 4];
  const ray = tracePolygon(prism, [hit[0] - dir[0], hit[1] - dir[1]], dir, n);
  assert.ok(ray, 'traced');
  close(ray.entry[0], hit[0], 1e-12, 'entry x');
  assert.equal(ray.entryEdge, 2);
  assert.equal(ray.exitEdge, 1);
  const turned = Math.acos(dir[0] * ray.direction[0] + dir[1] * ray.direction[1]);
  close(turned, prismDeviation(60 * deg, incidence, n).deviation, 1e-12, 'deviation');
  assert.equal(tracePolygon(prism, [5, 5], [1, 0], n), null, 'miss');
});

test('Malus cos^2 and Jones calculus', () => {
  for (const a of [0, 15, 45, 60, 90]) close(malus(a * deg), Math.cos(a * deg) ** 2, 1e-15, `Malus ${a}`);
  const v = JonesVector.linear(0);
  for (const a of [0, 30, 45, 90])
    close(JonesMatrix.polarizer(a * deg).apply(v).intensity, Math.cos(a * deg) ** 2, 1e-15, `Jones ${a}`);
  // Quarter-wave plate at 45 deg makes circular light: equal halves through x and y polarisers.
  const circ = JonesMatrix.retarder(45 * deg, Math.PI / 2).apply(v);
  close(JonesMatrix.polarizer(0).apply(circ).intensity, 0.5, 1e-15, 'x half');
  close(JonesMatrix.polarizer(Math.PI / 2).apply(circ).intensity, 0.5, 1e-15, 'y half');
  // Half-wave plate at 45 deg rotates x to y; crossed polarisers then pass everything.
  const sys = JonesMatrix.polarizer(Math.PI / 2).after(JonesMatrix.retarder(45 * deg, Math.PI));
  close(sys.apply(v).intensity, 1, 1e-15, 'half wave rotates');
  // Retarder at theta between crossed polarisers: sin^2(2 theta) sin^2(phase / 2).
  const t = 20 * deg,
    phase = 1.3;
  const crossed = JonesMatrix.polarizer(Math.PI / 2)
    .after(JonesMatrix.retarder(t, phase))
    .apply(v).intensity;
  close(crossed, Math.sin(2 * t) ** 2 * Math.sin(phase / 2) ** 2, 1e-15, 'photoelastic law');
  close(photoelasticTransmission(550, 550 * (phase / (2 * Math.PI)), Math.sin(2 * t) ** 2), crossed, 1e-15, 'same law');
});

test('Michel-Levy colours: zero retardation is black, first-order white near 250 nm', () => {
  const lut = photoelasticColors(1000, 101, { step: 4, max: 740 });
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(lut[c]) < 1e-12);
  const white = lut.slice(25 * 3, 25 * 3 + 3);
  for (const v of white) assert.ok(v > 0.5, `grey-white at 250 nm: ${[...white]}`);
});

test('Thin film: a quarter-wave layer of index sqrt(n_s) has zero reflectance at its design wavelength', () => {
  const ns = 1.52,
    nf = Math.sqrt(ns),
    film = { filmIndex: nf, thickness: 550 / (4 * nf), substrateIndex: ns };
  close(thinFilmReflectance(film, 550), 0, 1e-15, 'AR coat');
  // Half-wave layer is absent: bare-substrate reflectance.
  const half = { ...film, thickness: 550 / (2 * nf) };
  close(thinFilmReflectance(half, 550), ((ns - 1) / (ns + 1)) ** 2, 1e-15, 'half-wave absentee');
  // Zero thickness gives the bare Fresnel reflectance at any angle and polarisation.
  for (const a of [0, 30, 60]) {
    const bare = fresnelReflectance(1, ns, a * deg);
    close(thinFilmReflectance({ ...film, thickness: 0 }, 500, a * deg, 's'), bare.s, 1e-14, `bare s ${a}`);
    close(thinFilmReflectance({ ...film, thickness: 0 }, 500, a * deg, 'p'), bare.p, 1e-14, `bare p ${a}`);
  }
});

test('Transfer matrix agrees with the two-interface closed form and the quarter-wave mirror formula', () => {
  for (const a of [0, 25, 50, 70])
    for (const pol of ['s', 'p'])
      for (const nm of [420, 550, 690]) {
        const film = { filmIndex: 2.32, thickness: 310, substrateIndex: 1.52 };
        const tm = multilayerReflectance(
          { layers: [{ index: 2.32, thickness: 310 }], substrateIndex: 1.52 },
          nm,
          a * deg,
          pol,
        );
        close(tm, thinFilmReflectance(film, nm, a * deg, pol), 1e-13, `${pol} ${a} ${nm}`);
      }
  // (HL)^N H at normal incidence: R = ((1 - Y) / (1 + Y))^2 with Y = (nH/nL)^(2N) nH^2 / ns (Macleod 2010, 5.2).
  const nH = 2.35,
    nL = 1.38,
    ns = 1.52,
    N = 4;
  const Y = ((nH / nL) ** (2 * N) * (nH * nH)) / ns;
  const R = multilayerReflectance({ layers: quarterWaveStack(nH, nL, N, 600), substrateIndex: ns }, 600);
  close(R, ((1 - Y) / (1 + Y)) ** 2, 1e-12, 'quarter-wave mirror');
  // Frustrated total internal reflection: past the critical angle a thick air gap reflects almost all, a thin one less.
  const gap = (t) =>
    multilayerReflectance(
      { ambientIndex: 1.5, layers: [{ index: 1, thickness: t }], substrateIndex: 1.5 },
      550,
      60 * deg,
      's',
    );
  assert.ok(gap(2000) > 0.999 && gap(50) < 0.9 && gap(0) < 1e-20, `${gap(2000)} ${gap(50)} ${gap(0)}`);
});

test('Film colour: zero thickness is the grey bare reflectance; white integrates to white', () => {
  const integrator = new SpectralIntegrator({ step: 4, max: 740 });
  const white = integrator.color(() => 1);
  for (const v of white) close(v, 1, 1e-12, 'white');
  const grey = thinFilmColor({ filmIndex: 2.32, thickness: 0, substrateIndex: 1.52 }, 0, integrator);
  for (const v of grey) close(v, 0.04257, 1e-4, 'bare glass grey');
});

test('Michelson: 2d / lambda fringes; one fringe per half wavelength of travel', () => {
  close(michelsonFringes(632.8 / 2, 632.8), 1, 1e-15, 'half wavelength');
  close(michelsonFringes(10000, 500), 40, 1e-12, '10 um');
  const o = { wavelength: 632.8, fringeSpacing: 0.026, visibility: 1 };
  close(michelsonIntensity(0, 0, o), 1, 1e-15, 'bright centre');
  close(michelsonIntensity(0, 632.8 / 4, o), 0, 1e-15, 'dark after a quarter wave');
});

test('Moire spacing: two equal gratings at small angle p / (2 sin(theta / 2))', () => {
  const p = 0.0105;
  for (const a of [1, 5, 20])
    close(moireSpacing(p, p, a * deg), p / (2 * Math.sin((a * deg) / 2)), 1e-12, `moire ${a}`);
  assert.equal(moireSpacing(p, p, 0), Infinity);
  close(moireSpacing(1, 1.1, 0), 11, 1e-12, 'vernier beat');
});

test('Grating equation: orders, symmetry and the evanescent cut', () => {
  const orders = gratingOrders(500, 600);
  assert.deepEqual(
    orders.map((o) => o.order),
    [-3, -2, -1, 0, 1, 2, 3],
  );
  close(orders[4].angle, Math.asin(0.3), 1e-15, 'first order');
  close(orders[2].angle, -orders[4].angle, 1e-15, 'symmetric');
  assert.equal(gratingAngle(4, 500, 600), null);
  assert.deepEqual(
    gratingOrders(500, 600, 0, 40 * deg).map((o) => o.order),
    [-2, -1, 0, 1, 2],
  );
});

test('Bessel and Airy: first zero 1.22 lambda / D; J0(2.4048) = 0', () => {
  close(besselJ(0, 0), 1, 1e-15, 'J0(0)');
  close(besselJ(0, 2.404825557695773), 0, 1e-14, 'J0 zero');
  close(besselJ(1, AIRY_FIRST_ZERO), 0, 1e-14, 'J1 zero');
  close(besselJ(1, 1), 0.44005058574493355, 1e-14, 'J1(1)');
  close(besselJ(0, 30), -0.08636798358104, 1e-12, 'J0(30)');
  close(airyIntensity(AIRY_FIRST_ZERO), 0, 1e-26, 'Airy dark ring');
  close(airyIntensity(1e-12), 1, 1e-12, 'Airy centre');
  close(airyFirstZero(550e-9, 1e-3), Math.asin(1.2196698912665 * 550e-6), 1e-12, '1.22 lambda / D');
});

test('Point spread: in focus it is the Airy disc and holds the transmitted flux', () => {
  const a = 0.3e-3,
    lambda = 532e-9,
    z = 0.28;
  const zero = (AIRY_FIRST_ZERO * lambda * z) / (2 * Math.PI * a);
  const psf = circularPointSpread({ radius: a, wavelength: lambda, distance: z, maxRadius: 6 * zero, samples: 601 });
  close(psf.peak, ((Math.PI * a * a) / (lambda * z)) ** 2, psf.peak * 1e-6, 'peak = (pi a^2 / lambda z)^2');
  const at = (r) => psf.values[Math.round((r / (6 * zero)) * 600)];
  assert.ok(at(zero) / psf.peak < 2e-4, `dark ring ${at(zero) / psf.peak}`);
  close(at(zero / 2) / psf.peak, airyIntensity(AIRY_FIRST_ZERO / 2), 1e-4, 'Airy shape');
  assert.ok(psf.fluxFraction > 0.95 && psf.fluxFraction < 1.0001, `flux ${psf.fluxFraction}`);
  close(fresnelNumber(a, lambda, 0.88, 0.28), (a * a * (1 / 0.88 + 1 / 0.28)) / lambda, 1e-12, 'Fresnel number');
});

test('Thin lens, pinhole and cos^4', () => {
  const img = thinLens(0.1, 0.3);
  close(img.imageDistance, 0.15, 1e-15, 'image distance');
  close(img.magnification, -0.5, 1e-15, 'magnification');
  assert.equal(thinLens(0.1, 0.1).imageDistance, Infinity);
  close(thinLens(0.1, 0.05).imageDistance, -0.1, 1e-15, 'virtual image');
  assert.deepEqual(pinholeImage(1, 2, 4, 2), [-0.5, -1]);
  close(relativeIllumination(Math.tan(30 * deg)), Math.cos(30 * deg) ** 4, 1e-15, 'cos^4');
});

test('Astigmatism: least confusion at the harmonic mean, and its spot is round', () => {
  const f = astigmaticFoci(0.42, 0.06);
  close(f.leastConfusion, (2 * 0.39 * 0.45) / 0.84, 1e-15, 'harmonic mean');
  const ru = Math.abs(1 - f.leastConfusion / f.sagittal),
    rv = Math.abs(1 - f.leastConfusion / f.tangential);
  close(ru, rv, 1e-15, 'circle of least confusion');
});

test('Fresnel lens: a source at the focus leaves parallel; nearer diverges, farther converges', () => {
  const lens = designFresnelLens({
    index: 1.49,
    focalDistance: 0.45,
    centerRadius: 0.024,
    ringWidth: 0.0176,
    rings: 10,
    baseDepth: 0.0046,
  });
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(lens.trace(0.45, i).exterior) < 1e-6, `facet ${i} parallel`);
  assert.ok(lens.trace(0.35, 9).exterior > 0.01);
  assert.ok(lens.trace(0.6, 9).exterior < -0.01);
});

test('Corner cube: every ray that meets all three mirrors returns antiparallel', () => {
  for (const d of [
    [-0.5, -0.55, -0.67],
    [-0.62, -0.55, -0.56],
    [-0.577, -0.577, -0.577],
  ]) {
    const n = Math.hypot(...d),
      dir = d.map((v) => v / n);
    const t = cornerCubeReflect([0.3, 0.3, 0.3], dir, 0.9);
    assert.equal(t.hits.length, 3);
    for (let i = 0; i < 3; i++) close(t.direction[i], -dir[i], 1e-15, 'antiparallel');
  }
});

test('Knife edge: half cut gives mid grey; deflection brightens or darkens linearly', () => {
  const o = { cutoff: 0.5, focalLength: 0.46, sourceWidth: 4.7e-5 };
  close(knifeEdgeTransmission(0, o), 0.5, 1e-15, 'undisturbed');
  close(knifeEdgeTransmission(1e-5, o), 0.5 + (1e-5 * 0.46) / 4.7e-5, 1e-15, 'linear');
  assert.equal(knifeEdgeTransmission(1, o), 1);
});

test('CIE fit: ybar peaks at 555 nm, spectral colours have the right hue', () => {
  let best = 380,
    peak = 0;
  for (let nm = 380; nm <= 780; nm += 0.5) {
    const y = cieXYZ(nm)[1];
    if (y > peak) [peak, best] = [y, nm];
  }
  close(best, 557, 3, 'ybar peak');
  close(peak, 1, 0.03, 'ybar peak value');
  // CIE 1931 table values (2 deg): 450 nm (0.3362, 0.0380, 1.7721), 600 nm (1.0622, 0.6310, 0.0008).
  const b = cieXYZ(450),
    o = cieXYZ(600);
  close(b[0], 0.3362, 0.02, 'x 450');
  close(b[2], 1.7721, 0.06, 'z 450');
  close(o[0], 1.0622, 0.03, 'x 600');
  close(o[1], 0.631, 0.02, 'y 600');
  const red = spectralColor(650),
    green = spectralColor(530),
    blue = spectralColor(460);
  assert.ok(red[0] === 1 && red[1] < 0.2 && red[2] < 0.05, `red ${red}`);
  assert.ok(green[1] === 1 && green[0] < 0.5 && green[2] < 0.3, `green ${green}`);
  assert.ok(blue[2] === 1 && blue[1] < 0.5, `blue ${blue}`);
  assert.equal(wavelengthToLinearSRGB(550, new Float32Array(3)).length, 3);
});

test('argument errors are RangeErrors; the root entry re-exports every entry', () => {
  assert.throws(() => snell(0, 1, 0), RangeError);
  assert.throws(() => sellmeierIndex(-1, FUSED_SILICA), RangeError);
  assert.throws(() => gratingAngle(1, NaN, 600), RangeError);
  for (const name of ['snell', 'malus', 'thinFilmReflectance', 'gratingOrders', 'thinLens', 'cieXYZ'])
    assert.equal(typeof root[name], 'function');
});
