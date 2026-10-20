// Fit a single-scattering atmosphere (Rayleigh + Mie + ozone absorption, exponential density, spherical planet) to
// MagicaVoxel's sky panoramas (equal-angle, 0.225 degrees per pixel, centre column = camera yaw 0 = +y, sun from +x).
const { decode, sample } = require('./measure.cjs');
const lin = (v) => (v / 255) ** 2.2;

const R0 = 6360; // km (p.R, p.top override)
function sky(view, sun, p) {
  // view, sun: unit vectors (z up). Returns linear RGB.
  const R = p.R ?? R0,
    RA = R + (p.top ?? 100),
    h0 = p.h0 ?? 0.001,
    o = [0, 0, R + h0];
  const hitSphere = (pos, d, r) => {
    const b = pos[0] * d[0] + pos[1] * d[1] + pos[2] * d[2],
      c = pos[0] ** 2 + pos[1] ** 2 + pos[2] ** 2 - r * r,
      disc = b * b - c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    const t1 = -b - s,
      t2 = -b + s;
    return t1 > 1e-6 ? t1 : t2 > 1e-6 ? t2 : -1;
  };
  const tGround = hitSphere(o, view, R);
  if (tGround > 0) return null; // below the horizon
  const tTop = hitSphere(o, view, RA),
    N = p.steps ?? 48,
    M = 16,
    ds = tTop / N;
  const mu = view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2];
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu),
    g = p.g,
    pM =
      p.phase === 'cs'
        ? ((3 / (8 * Math.PI)) * (1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * (1 + g * g - 2 * g * mu) ** 1.5)
        : (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * mu) ** 1.5);
  const bR = p.rayK.map((k) => k * p.sR),
    bM = p.mieK.map((k) => k * p.sM),
    bO = p.o3K.map((k) => k * p.sO);
  let tauR = 0,
    tauM = 0,
    tauO = 0;
  const L = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * ds,
      pos = [o[0] + view[0] * t, o[1] + view[1] * t, o[2] + view[2] * t],
      h = Math.hypot(...pos) - R;
    const dR = Math.exp(-h / p.HR) * ds,
      dM = Math.exp(-h / p.HM) * ds,
      dO = (p.o3Profile === 'rayleigh' ? Math.exp(-h / p.HR) : Math.max(0, 1 - Math.abs(h - 25) / 15)) * ds;
    tauR += dR;
    tauM += dM;
    tauO += dO;
    // light ray to the sun
    if (hitSphere(pos, sun, R) > 0) continue;
    const tl = hitSphere(pos, sun, RA),
      dl = tl / M;
    let lR = 0,
      lM = 0,
      lO = 0;
    for (let j = 0; j < M; j++) {
      const q = [pos[0] + sun[0] * (j + 0.5) * dl, pos[1] + sun[1] * (j + 0.5) * dl, pos[2] + sun[2] * (j + 0.5) * dl],
        hh = Math.hypot(...q) - R;
      lR += Math.exp(-hh / p.HR) * dl;
      lM += Math.exp(-hh / p.HM) * dl;
      lO += (p.o3Profile === 'rayleigh' ? Math.exp(-hh / p.HR) : Math.max(0, 1 - Math.abs(hh - 25) / 15)) * dl;
    }
    for (let c = 0; c < 3; c++) {
      const T = Math.exp(
        -(
          bR[c] * (tauR - dR / 2 + lR) +
          bM[c] * (p.mieExtScale ?? 1.11) * (tauM - dM / 2 + lM) +
          bO[c] * (tauO - dO / 2 + lO)
        ),
      );
      L[c] += T * (bR[c] * dR * pR + bM[c] * dM * pM) * p.E;
    }
  }
  return L.map((v) => v + (p.amb ?? 0));
}
const dir = (azDeg, elDeg) => {
  const a = (azDeg * Math.PI) / 180,
    e = (elDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
};
// Samples: MagicaVoxel azimuth from +x toward +y; pano x = 480 + (90 - az) / 0.225, y = 400 - el / 0.225.
function samples(name, sunEl) {
  const img = decode(`${process.cwd()}/A-pano-${name}-mv.png`),
    out = [],
    sun = dir(0, sunEl);
  for (let az = -120; az <= 120; az += 15)
    for (const el of [2, 4, 8, 12, 18, 25, 35, 50, 65, 80]) {
      const x = 480 + (90 - az) / 0.225,
        y = 400 - el / 0.225;
      if (x < 3 || x > 956) continue;
      const v = dir(az, el),
        cosToSun = v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2];
      if (cosToSun > Math.cos((12 * Math.PI) / 180)) continue; // skip the sun and its halo core
      const s = sample(img, x, y, 2);
      if (Math.max(...s) > 245) continue;
      out.push({ az, el, v, rgb: s.map(lin) });
    }
  return { name, sun, out };
}
function error(p, sets) {
  let e = 0,
    n = 0;
  for (const set of sets)
    for (const s of set.out) {
      const m = sky(s.v, set.sun, { ...p, ...(set.over ?? {}) });
      if (!m) continue;
      for (let c = 0; c < 3; c++) {
        const d = Math.log((m[c] + 0.003) / (s.rgb[c] + 0.003));
        e += d * d;
        n++;
      }
    }
  return Math.sqrt(e / n);
}
function nelder(f, x0, step, iters = 400) {
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step[j] : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    pts.sort((a, b) => a.f - b.f);
    const n = x0.length,
      c = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n),
      w = pts[n];
    const r = c.map((v, j) => v + (v - w.x[j])),
      fr = f(r);
    if (fr < pts[0].f) {
      const ex = c.map((v, j) => v + 2 * (v - w.x[j])),
        fe = f(ex);
      pts[n] = fe < fr ? { x: ex, f: fe } : { x: r, f: fr };
    } else if (fr < pts[n - 1].f) pts[n] = { x: r, f: fr };
    else {
      const k = c.map((v, j) => v + 0.5 * (w.x[j] - v)),
        fk = f(k);
      if (fk < w.f) pts[n] = { x: k, f: fk };
      else
        pts = pts.map((p, i) =>
          i === 0
            ? p
            : {
                x: p.x.map((v, j) => pts[0].x[j] + 0.5 * (v - pts[0].x[j])),
                f: f(p.x.map((v, j) => pts[0].x[j] + 0.5 * (v - pts[0].x[j]))),
              },
        );
    }
  }
  pts.sort((a, b) => a.f - b.f);
  return pts[0];
}
module.exports = { sky, samples, error, nelder, dir };
if (require.main === module) {
  const sets = [samples('e5', 5), samples('e20', 20), samples('e45', 45), samples('e90', 90)];
  console.log('samples', sets.map((s) => s.out.length).join(' '));
  const base = { rayK: [45 / 255, 104 / 255, 1], mieK: [1, 1, 1], o3K: [105 / 255, 1, 110 / 255], sO: 0, g: 0.85 };
  const unpack = (x) => ({
    ...base,
    E: Math.exp(x[0]),
    sR: Math.exp(x[1]),
    sM: Math.exp(x[2]),
    HR: Math.exp(x[3]),
    HM: Math.exp(x[4]),
    amb: Math.exp(x[5]),
  });
  const f = (x) => error(unpack(x), sets);
  const x0 = [Math.log(3.5), Math.log(0.033), Math.log(0.02), Math.log(8), Math.log(1.2), Math.log(0.002)];
  console.log('start', f(x0).toFixed(4));
  const best = nelder(f, x0, [0.5, 0.5, 0.5, 0.3, 0.3, 1], Number(process.argv[2] ?? 300));
  const p = unpack(best.x);
  console.log(
    'rms log error',
    best.f.toFixed(4),
    JSON.stringify({ E: p.E, sR: p.sR, sM: p.sM, HR: p.HR, HM: p.HM, amb: p.amb }),
  );
  for (const set of sets) {
    const s = set.out.filter((q) => q.az === 90 || q.az === -90 || q.az === 0).slice(0, 8);
    for (const q of s) {
      const m = sky(q.v, set.sun, p);
      console.log(
        set.name,
        'az',
        q.az,
        'el',
        q.el,
        'mv',
        q.rgb.map((v) => v.toFixed(3)).join('/'),
        'fit',
        m.map((v) => v.toFixed(3)).join('/'),
      );
    }
  }
}
