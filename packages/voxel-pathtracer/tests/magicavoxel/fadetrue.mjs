// MagicaVoxel's fade weight per ground pixel against our render with the fade off: a = (L_mv - G) / (H - G).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decode } = require('./measure.cjs'); // run in test-results/mv-calib (atmosphere views in ../pt-compare/atm)
const pt = await import('../../dist/index.js');
const aces = (x) => {
  x *= 0.6;
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
};
const invA = (v) => {
  const t = (v / 255) ** 2.2;
  let lo = 0,
    hi = 50;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (aces(m) < t) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
};
const lin = (v) => (v / 255) ** 2.2;
const atmS = {
  rayleigh: 0.4,
  rayleighColor: [45 / 255, 104 / 255, 1],
  mie: 0.4,
  mieColor: [1, 1, 1],
  mieG: 0.85,
  ozone: 0,
  ozoneColor: [0, 0, 0],
};
const scenes = [
  {
    n: 'X-hor-5',
    dir: '.',
    R: 90,
    fz: 8,
    pitch: -4,
    yaw: 20,
    fov: 35,
    hor: 0.5,
    boxes: [[-8, -8, 0, 8, 8, 16]],
    acesOn: false,
    H: () => [100, 150, 255].map((c) => lin(c) * 0.5),
  },
  {
    n: 'X-hor-1',
    dir: '.',
    R: 90,
    fz: 8,
    pitch: -4,
    yaw: 20,
    fov: 35,
    hor: 0.1,
    boxes: [[-8, -8, 0, 8, 8, 16]],
    acesOn: false,
    H: () => [100, 150, 255].map((c) => lin(c) * 0.5),
  },
  {
    n: 'H-r180',
    dir: '.',
    R: 180,
    fz: 8,
    pitch: -4,
    yaw: 20,
    fov: 35,
    hor: 0.5,
    boxes: [[-8, -8, 0, 8, 8, 16]],
    acesOn: false,
    H: () => [100, 150, 255].map((c) => lin(c) * 0.5),
  },
  ...[
    ['atm-sky-e5', 5, -130],
    ['atm-sky-e20', 20, 50],
  ].map(([n, el, yaw]) => ({
    n,
    dir: '../pt-compare/atm',
    R: 122.3,
    fz: 8,
    focusX: -2,
    pitch: -6,
    yaw,
    fov: 35,
    hor: 0.1,
    boxes: [[-32, -32, 0, 32, 32, 32]],
    acesOn: true,
    sunEl: el,
    H: (az, dv) => {
      const e = (el * Math.PI) / 180,
        s = (-40 * Math.PI) / 180;
      return pt
        .atmosphereRadiance(dv, [Math.cos(e) * Math.cos(s), Math.cos(e) * Math.sin(s), Math.sin(e)], atmS)
        .map((v) => v * 0.7);
    },
  })),
];
const hitBox = (o, d, b) => {
  let t0 = 0,
    t1 = 1e9;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < b[k] || o[k] > b[k + 3]) return false;
      continue;
    }
    let a = (b[k] - o[k]) / d[k],
      c = (b[k + 3] - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
  }
  return t0 <= t1;
};
for (const s of scenes) {
  const mv = decode(`${s.dir}/${s.n}-mv.png`),
    of = decode(`${s.dir}/${s.n}-ours-nofade.png`),
    inv = s.acesOn ? invA : lin;
  const f = 400 / Math.tan(((s.fov / 2) * Math.PI) / 180),
    p = (s.pitch * Math.PI) / 180,
    y0 = ((90 + s.yaw) * Math.PI) / 180;
  const fwd = [Math.cos(p) * Math.cos(y0), Math.cos(p) * Math.sin(y0), Math.sin(p)],
    right = [Math.sin(y0), -Math.cos(y0), 0],
    up = [-Math.sin(p) * Math.cos(y0), -Math.sin(p) * Math.sin(y0), Math.cos(p)];
  const eye = [s.focusX ?? 0, 0, s.fz].map((v, k) => v - s.R * fwd[k]);
  const bins = new Map();
  for (let y = 0; y < 800; y += 2)
    for (let x = 0; x < 960; x += 2) {
      const d0 = [0, 1, 2].map((k) => fwd[k] + right[k] * ((x + 0.5 - 480) / f) + up[k] * ((400 - y - 0.5) / f)),
        dn = Math.hypot(...d0),
        d = d0.map((v) => v / dn);
      if (d[2] >= -0.003) continue;
      const D = -eye[2] / d[2];
      if (
        s.boxes.some((b) =>
          hitBox(
            eye,
            d.map((v) => v * D),
            b,
          ),
        )
      )
        continue;
      const i = 4 * (y * 960 + x),
        H = s.H(Math.atan2(d[1], d[0]), d);
      const L = [0, 1, 2].map((k) => inv(mv.data[i + k])),
        G = [0, 1, 2].map((k) => inv(of.data[i + k]));
      // weight by the channel with the biggest H - G
      const k = [0, 1, 2].reduce((a, b) => (H[b] - G[b] > H[a] - G[a] ? b : a), 0);
      if (H[k] - G[k] < 0.02) continue;
      const a = (L[k] - G[k]) / (H[k] - G[k]),
        bin = Math.round(Math.log(D) * 4);
      if (!bins.has(bin)) bins.set(bin, []);
      bins.get(bin).push(a);
    }
  let line = `${s.n} (hor ${s.hor}):`;
  for (const [bin, v] of [...bins].sort((a, b) => a[0] - b[0])) {
    if (v.length < 40) continue;
    v.sort((a, b) => a - b);
    const a = v[v.length >> 1],
      D = Math.exp(bin / 4);
    line += `\n   D ${D.toFixed(0).padStart(5)} n ${String(v.length).padStart(5)} a ${a.toFixed(4)}  c=K*hor ${((-D / Math.log(1 - a)) * s.hor).toFixed(0)}`;
  }
  console.log(line);
}
