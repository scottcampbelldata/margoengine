// Skin against measured data and the published models: Jensen et al. 2001 (measured skin), Prahl's hemoglobin
// spectra, the ColorChecker skin patches, Donner and Jensen 2006 (the two-layer spectral model) and Christensen and
// Burley 2015 (diffusion profiles fitted to Monte Carlo).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffusionReflectance,
  skin,
  skinColor,
  skinFrequency,
  skinProfileOf,
  skinPublishedProfile,
  skinReflectance,
  skinWavelengths,
} from '../dist/skin.js';

// Bessel J1, Abramowitz and Stegun 9.4.4 and 9.4.6 (error below 1e-7).
function j1(x) {
  const ax = Math.abs(x);
  if (ax <= 3) {
    const y = (x / 3) ** 2;
    return (
      x *
      (0.5 +
        y *
          (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))))
    );
  }
  const y = 3 / ax,
    f =
      0.79788456 +
      y * (0.00000156 + y * (0.01659667 + y * (0.00017105 + y * (-0.00249511 + y * (0.00113653 - y * 0.00020033))))),
    t =
      ax -
      2.35619449 +
      y * (0.12499612 + y * (0.0000565 + y * (-0.00637879 + y * (0.00074348 + y * (0.00079824 - y * 0.00029166)))));
  return (Math.sign(x) * f * Math.cos(t)) / Math.sqrt(ax);
}
// The share of a radial profile's light within radius r, from its frequency profile F (F(0) = 1): r int F(k) J1(k r) dk.
function enclosedFrom(samples, dk, r) {
  let s = 0;
  samples.forEach((v, i) => (s += v * j1((i + 0.5) * dk * r) * dk));
  return r * s;
}
const gaussiansEnclosed = (profile, c, r) =>
  profile.reduce((s, row) => s + row[1 + c] * (1 - Math.exp((-r * r) / (2 * row[0]))), 0);
const median = (f) => {
  let lo = 0,
    hi = 50;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < 0.5) lo = m;
    else hi = m;
  }
  return lo;
};

test('the diffusion reflectance gives the Rd that Jensen et al. 2001 list for their measured skin', () => {
  // Their Figure 5(b): reduced scattering and absorption in 1 / mm, red, green, blue, index 1.3, and the Rd measured.
  const measured = {
    skin1: [
      [0.74, 0.88, 1.01],
      [0.032, 0.17, 0.48],
      [0.44, 0.22, 0.13],
    ],
    skin2: [
      [1.09, 1.59, 1.79],
      [0.013, 0.07, 0.145],
      [0.63, 0.44, 0.34],
    ],
  };
  for (const [name, [scatter, absorb, rd]] of Object.entries(measured))
    for (let c = 0; c < 3; c++) {
      const got = diffusionReflectance(scatter[c], absorb[c], 1.3);
      assert.ok(Math.abs(got - rd[c]) < 0.012, `${name} channel ${c}: ${got} against ${rd[c]}`);
    }
  assert.throws(() => diffusionReflectance(0, 0.1), RangeError);
});

test("skin's spectrum carries hemoglobin's measured bands and darkens with melanin", () => {
  assert.equal(skinWavelengths.length, 101);
  assert.equal(skinWavelengths[0], 380);
  assert.equal(skinWavelengths[100], 780);
  // Blood-rich fair skin: oxy-hemoglobin's two Q bands (542 and 576 nm in Prahl's data) are dips in what skin reflects,
  // the "W" of measured skin spectra, with the band between them reflecting more. The first dip sits at 548 nm, as
  // scattering falls with wavelength across the band and a quarter of the blood is deoxy-hemoglobin (peak 556 nm).
  const r = skinReflectance({ melanin: 0.002, hemoglobin: 0.05 }),
    at = (w) => r[(w - 380) / 4],
    minima = [];
  for (let w = 520; w <= 600; w += 4) if (at(w) < at(w - 4) && at(w) < at(w + 4)) minima.push(w);
  assert.ok(
    minima.some((w) => Math.abs(w - 542) <= 8) && minima.some((w) => Math.abs(w - 576) <= 4),
    `minima at ${minima}`,
  );
  assert.ok(at(556) > at(548) && at(556) > at(576));
  // Red passes blood: skin reflects more at 650 nm than at 550 nm, and melanin darkens every wavelength. Up to a
  // melanin of 0.05 it darkens blue most (Eq. 3 and 4); past that the epidermis's own scattering is most of what is
  // left, so the blue to red ratio stays near 0.54 (docs/limits.md).
  let last = Infinity,
    ratio = Infinity;
  for (const melanin of [0.002, 0.01, 0.05, 0.1, 0.3, 0.5]) {
    const s = skinReflectance({ melanin }),
      red = s[(648 - 380) / 4],
      blue = s[(452 - 380) / 4];
    assert.ok(
      red < last && (melanin > 0.05 ? Math.abs(blue / red - 0.54) < 0.03 : blue / red < ratio),
      `melanin ${melanin}`,
    );
    assert.ok(red > s[(548 - 380) / 4]);
    last = red;
    ratio = blue / red;
  }
  assert.throws(() => skinReflectance({ melanin: 0.6 }), RangeError);
  assert.throws(() => skinReflectance({ hemoglobin: 0 }), RangeError);
});

test('skin colour reaches the ColorChecker skin patches within the published parameter ranges', () => {
  // The light skin and dark skin patches of the ColorChecker (McCamy, Marcus and Davidson 1976, made to match the
  // reflectance of skin), the manufacturer's sRGB (194, 150, 130) and (115, 82, 68), decoded to linear.
  const linear = (v) => ((v / 255 + 0.055) / 1.055) ** 2.4,
    lab = ([r, g, b]) => {
      const x = 0.4124 * r + 0.3576 * g + 0.1805 * b,
        y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
        z = 0.0193 * r + 0.1192 * g + 0.9505 * b,
        f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116),
        [fx, fy, fz] = [f(x / 0.9505), f(y), f(z / 1.089)];
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    },
    patches = { light: [194, 150, 130].map(linear), dark: [115, 82, 68].map(linear) },
    best = {};
  for (const [name, rgb] of Object.entries(patches)) {
    const target = lab(rgb);
    best[name] = Infinity;
    for (const melanin of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5])
      for (const melaninBlend of [0, 0.3, 0.7, 1])
        for (const hemoglobin of [0.002, 0.005, 0.02, 0.05]) {
          const got = lab(skinColor({ melanin, melaninBlend, hemoglobin }));
          best[name] = Math.min(best[name], Math.hypot(got[0] - target[0], got[1] - target[1], got[2] - target[2]));
        }
  }
  // Measured: about 8.6 and 6.1 CIELAB units; the model's skin is less red than the patches (docs/limits.md).
  assert.ok(best.light < 10 && best.dark < 8, JSON.stringify(best));
  const fair = skinColor(),
    dark = skinColor({ melanin: 0.3 });
  assert.ok(fair[0] > fair[1] && fair[1] > fair[2], 'skin is red over green over blue');
  assert.ok(dark[0] < fair[0] / 4);
});

// The two-layer profile in real space, from its frequency profile, and the fit skin() draws with.
const dk = 0.01,
  kmax = 300,
  radii = [0.05, 0.1, 0.2, 0.4, 0.7, 1, 1.5, 2, 3];
function realProfile(physiology) {
  const samples = [[], [], []];
  for (let k = dk / 2; k < kmax; k += dk) {
    const f = skinFrequency(physiology, k);
    for (let c = 0; c < 3; c++) samples[c].push(f[c]);
  }
  return (c, r) => enclosedFrom(samples[c], dk, r);
}
const skins = { 'very fair': 0.002, fair: 0.01, olive: 0.05, dark: 0.3 },
  profiles = Object.fromEntries(Object.entries(skins).map(([name, melanin]) => [name, realProfile({ melanin })]));

test("skin's fitted Gaussians hold the Donner and Jensen 2006 two-layer profile", () => {
  for (const [name, melanin] of Object.entries(skins)) {
    const fit = skinProfileOf({ melanin }),
      real = profiles[name];
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(fit.reduce((s, row) => s + row[1 + c], 0) - 1) < 1e-9);
      for (const r of radii) {
        const want = real(c, r),
          got = gaussiansEnclosed(fit, c, r);
        assert.ok(Math.abs(got - want) < 0.025, `${name} channel ${c} at ${r} mm: ${got} against ${want}`);
      }
    }
  }
});

test('the published profile holds fair skin and misses melanin-rich skin, which skin({ melanin }) fixes', () => {
  // Fair: the published fit's median radius is within a factor of 2 of the model's in every colour (measured: red 1.9,
  // green 0.8, blue 1.0 times).
  const fair = profiles.fair;
  for (let c = 0; c < 3; c++) {
    const ratio = median((r) => gaussiansEnclosed(skinPublishedProfile, c, r)) / median((r) => fair(c, r));
    assert.ok(ratio > 0.5 && ratio < 2, `fair channel ${c}: ${ratio}`);
  }
  // Dark (melanin 0.3): the epidermis absorbs what the dermis would spread, so half the red leaves within about 0.1 mm;
  // the published fit spreads it more than five times as far. The physiology's own fit keeps it.
  const dark = profiles.dark,
    want = median((r) => dark(0, r));
  assert.ok(median((r) => gaussiansEnclosed(skinPublishedProfile, 0, r)) > 5 * want);
  assert.ok(Math.abs(median((r) => gaussiansEnclosed(skinProfileOf({ melanin: 0.3 }), 0, r)) - want) < 0.25 * want);
  // The material carries its physiology, and draws with that profile through thin parts too.
  const feature = skin({ melanin: 0.3, hemoglobin: 0.01 });
  assert.deepEqual(feature.serialization(), { unitsPerMeter: 1, thickness: 0.004, melanin: 0.3, hemoglobin: 0.01 });
  assert.deepEqual(skin().serialization(), { unitsPerMeter: 1, thickness: 0.004 });
  assert.throws(() => skin({ oxygenation: 2 }), RangeError);
});

test("the two-layer profile against Christensen and Burley 2015's Monte Carlo fit for the same dermis", () => {
  // Their searchlight curve for surface albedo A and volume mean free path l (here the dermis's 1 / sigma_t', Donner
  // and Jensen's Eq. 5 and 8, isotropic by similarity): s = 1.85 - A + 7 |0.8 - A|^3, and the share within r is
  // 1 - e^(-s r / l) / 4 - 3 e^(-s r / 3 l) / 4. Diffusion is known to spread light further than Monte Carlo near
  // the source; the medians of the model stay within a factor of 2.5 of the fit's (measured 1.2 to 2.3).
  const fair = profiles.fair,
    colour = skinColor(),
    wavelength = [648, 548, 452];
  for (let c = 0; c < 3; c++) {
    const w = wavelength[c],
      base = 0.0244 + 8.53 * Math.exp(-(w - 154) / 66.2),
      scatter = (14.74 * w ** -0.22 + 2.2e11 * w ** -4) / 2,
      length = 1 / (scatter + base),
      a = colour[c],
      s = 1.85 - a + 7 * Math.abs(0.8 - a) ** 3,
      burley = median((r) => 1 - Math.exp((-s * r) / length) / 4 - (3 * Math.exp((-s * r) / (3 * length))) / 4),
      ratio = median((r) => fair(c, r)) / burley;
    assert.ok(ratio > 1 / 2.5 && ratio < 2.5, `channel ${c}: ${ratio}`);
  }
});
