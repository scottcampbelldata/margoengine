// hair()'s fibre against the papers it is built from: Marschner et al. 2003 (lobe shifts, widths, TT's azimuthal spread
// on a smooth fibre), d'Eon et al. 2011 (energy conservation, melanin absorption) and Chiang et al. 2016 (colour to
// absorption). hairScattering is the CPU twin of the shader; the GPU check draws the same numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { colorAbsorption, hairScattering, melaninAbsorption } from '../dist/hair.js';

const T = [0, 1, 0];
/** A direction at longitudinal angle `theta` (from the plane across the fibre) and azimuth `phi` about it. */
const dir = (theta, phi) => [Math.cos(theta) * Math.sin(phi), Math.sin(theta), Math.cos(theta) * Math.cos(phi)];

/**
 * Light scattered out over the whole sphere for light arriving from (thetaI, 0): the integral of S cos(theta_r) over
 * d omega_r = cos(theta_r) d theta_r d phi, since a fibre seen at theta_r shows cos(theta_r) of its width (Marschner Eq. 1).
 */
function furnace(thetaI, options, color = [1, 1, 1]) {
  const l = dir(thetaI, 0),
    nt = 360,
    np = 360,
    out = [0, 0, 0];
  for (let i = 0; i < nt; i++) {
    const theta = -Math.PI / 2 + ((i + 0.5) * Math.PI) / nt;
    for (let j = 0; j < np; j++) {
      const phi = -Math.PI + ((j + 0.5) * 2 * Math.PI) / np,
        s = hairScattering(l, dir(theta, phi), T, color, options),
        w = Math.cos(theta) ** 2 * (Math.PI / nt) * ((2 * Math.PI) / np);
      for (let c = 0; c < 3; c++) out[c] += s[c] * w;
    }
  }
  return out;
}

test("with no absorption the fibre loses no light: the white furnace of d'Eon et al. 2011", () => {
  for (const thetaI of [0, 0.4, -0.4, 0.8, -0.8]) {
    const [e] = furnace(thetaI, { absorption: [0, 0, 0] });
    assert.ok(e > 0.95 && e < 1.03, `scattered energy ${e} at theta_i ${thetaI}`);
  }
  // Near grazing the wide lobes reach past the pole and lose some light (docs/limits.md), but none is ever made.
  for (const thetaI of [1.1, -1.1]) {
    const [e] = furnace(thetaI, { absorption: [0, 0, 0] });
    assert.ok(e > 0.8 && e < 1.03, `scattered energy ${e} at theta_i ${thetaI}`);
  }
  // Absorbing hair returns less, darker hair less again.
  const blond = furnace(0.3, { absorption: melaninAbsorption(0.3) })[0],
    black = furnace(0.3, { absorption: melaninAbsorption(8) })[0];
  assert.ok(blond < 0.95 && black < blond && black > 0.04, `blond ${blond}, black ${black}`);
});

test("lobes sit where Marschner's cuticle tilt puts them: R at alpha, TT at -alpha / 2", () => {
  const shift = 0.09,
    peak = (phi, absorption) => {
      let best = -Infinity,
        at = 0;
      // theta_i = 0; theta_r scanned, so theta_h = theta_r / 2.
      for (let k = -2000; k <= 2000; k++) {
        const tr = k * 0.0005,
          s = hairScattering(dir(0, 0), dir(tr, phi), T, [1, 1, 1], { shift, absorption, roughness: 0.3 })[0];
        if (s > best) [best, at] = [s, tr / 2];
      }
      return at;
    };
  // Front, black hair: only R is left. It peaks shift toward the root (theta_h = -shift).
  assert.ok(Math.abs(peak(0, melaninAbsorption(20)) + shift) < 0.003, 'R');
  // Back light, blond: TT dominates and peaks shift / 2 the other way.
  assert.ok(Math.abs(peak(Math.PI, melaninAbsorption(0.3)) - shift / 2) < 0.003, 'TT');
});

test('light through the fibre spreads round it as a smooth fibre bends it (Marschner 2003, Eq. 8)', () => {
  // Reference: a smooth fibre's TT leaves at phi(h) = 2 gamma_t - 2 gamma_i + pi, sin gamma_i = h, sin gamma_t = h / eta,
  // h even over [-1, 1]. The share of it within `reach` radians of phi = pi:
  const eta = 1.55,
    n = 200000,
    share = (reach) => {
      let inside = 0;
      for (let k = 0; k < n; k++) {
        const h = -1 + (2 * (k + 0.5)) / n;
        if (Math.abs(2 * Math.asin(h / eta) - 2 * Math.asin(h)) < reach) inside++;
      }
      return inside / n;
    };
  // The model's TT at theta 0, on a near smooth fibre: all light less what is left with total absorption (R alone),
  // less the even lobes (read at phi = 0, where TT is nothing).
  const at = (phi, absorption) =>
      hairScattering(dir(0, 0), dir(0, phi), T, [1, 1, 1], { absorption, roughness: 1e-3 })[0],
    tt = (phi) => at(phi, [0, 0, 0]) - at(phi, [1e3, 1e3, 1e3]) - (at(0, [0, 0, 0]) - at(0, [1e3, 1e3, 1e3])),
    integral = (a, b) => {
      let sum = 0;
      for (let k = 0; k < 4000; k++) sum += tt(a + ((k + 0.5) * (b - a)) / 4000) * ((b - a) / 4000);
      return sum;
    },
    all = integral(0, 2 * Math.PI);
  for (const reach of [0.2, 0.4, 0.8]) {
    const got = integral(Math.PI - reach, Math.PI + reach) / all,
      want = share(reach);
    assert.ok(
      Math.abs(got - want) < 0.06,
      `TT within ${reach} rad of the back: ${got}, the smooth fibre gives ${want}`,
    );
  }
});

test('backlit blond glows warm, backlit black hair hardly at all', () => {
  const l = dir(0, 0),
    v = dir(-0.045, Math.PI),
    blond = hairScattering(l, v, T, [1, 1, 1], { absorption: melaninAbsorption(0.3) }),
    black = hairScattering(l, v, T, [1, 1, 1], { absorption: melaninAbsorption(8) });
  assert.ok(blond[0] > blond[1] && blond[1] > blond[2], `blond is warm: ${blond}`);
  assert.ok(blond[0] > 20 * black[0], `blond ${blond[0]} against black ${black[0]}`);
});

test("colour and melanin give absorption by Chiang et al. 2016's and d'Eon et al. 2011's numbers", () => {
  assert.deepEqual(melaninAbsorption(1), [0.419, 0.697, 1.37]);
  assert.deepEqual(melaninAbsorption(0, 1), [0.187, 0.4, 1.05]);
  // Chiang's fit inverts their Eq. 9: at azimuthal roughness 0.3 a colour of e^-5.888 has absorption 1.
  const c = Math.exp(-5.888),
    [a] = colorAbsorption([c, c, c], 0.3);
  assert.ok(Math.abs(a - 1) < 0.002, `${a}`);
  // White hair absorbs nothing; darker colours absorb more.
  assert.deepEqual(colorAbsorption([1, 1, 1]), [0, 0, 0]);
  const [r, g, b] = colorAbsorption([0.6, 0.35, 0.15]);
  assert.ok(r < g && g < b);
  assert.throws(() => melaninAbsorption(-1), RangeError);
});
