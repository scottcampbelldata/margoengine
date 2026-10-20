// Fog calibration: grey tiles seen from 190 above through uniform fog (sky only, sun only), and a horizon view.
const { writeVox, rcam } = require('./voxwrite.cjs');
const S = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]))]),
  );
const box = (v, x0, y0, z0, sx, sy, sz, c) => {
  for (let x = x0; x < x0 + sx; x++)
    for (let y = y0; y < y0 + sy; y++) for (let z = z0; z < z0 + sz; z++) v.push([x, y, z, c]);
};
const tiles = [],
  pal = new Map(),
  mat = new Map();
for (let k = 0; k < 16; k++) {
  const i = k % 8,
    j = Math.floor(k / 8);
  box(tiles, 8 * i + 1, 8 * j + 1, 0, 6, 6, 1, k + 1);
  pal.set(k + 1, [17 * k, 17 * k, 17 * k]);
  mat.set(k + 1, { _type: '_diffuse' });
}
const top = rcam({ focus: [0, -24, 1], pitch: -90, yaw: 0, radius: 190, fov: 20 });
const base = { _lens: { _aperture: 0, _fov: 20 }, _bloom: { _mix: 0 }, _film: { _aces: 0 } };
const merge = (...p) => {
  const r = {};
  for (const x of p) for (const [k, v] of Object.entries(x)) r[k] = { ...(r[k] ?? {}), ...v };
  return S(r);
};
const out = {};
for (const [tag, d, light] of [
  ['F-sky-2', 0.002, { _uni: { _i: 0.5 }, _inf: { _i: 0 } }],
  ['F-sky-5', 0.005, { _uni: { _i: 0.5 }, _inf: { _i: 0 } }],
  ['F-sun-5', 0.005, { _uni: { _i: 0 }, _inf: { _i: 1, _angle: '60 90' } }],
])
  out[tag] = {
    size: [64, 64, 1],
    voxels: tiles,
    palette: pal,
    materials: mat,
    camera: top,
    render: merge(base, light, { _fog_uni: { _d: d, _k: '255 255 255', _g: 0 } }),
  };
const cube = [];
box(cube, 0, 0, 0, 16, 16, 16, 1);
out['F-hor'] = {
  size: [16, 16, 16],
  voxels: cube,
  palette: new Map([[1, [230, 230, 230]]]),
  materials: new Map([[1, { _type: '_diffuse' }]]),
  camera: rcam({ focus: [0, 0, 8], pitch: -4, yaw: 20, radius: 90, fov: 35 }),
  render: merge(base, {
    _lens: { _fov: 35 },
    _uni: { _i: 0.5, _k: '100 150 255' },
    _inf: { _i: 0.3, _angle: '40 60' },
    _fog_uni: { _d: 0.01, _k: '255 200 150', _g: 0.3 },
  }),
};
for (const [n, f] of Object.entries(out)) writeVox(`${__dirname}/${n}.vox`, f);
console.log(Object.keys(out).join(' '));
