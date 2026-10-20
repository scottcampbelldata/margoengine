// Calibration boards for MagicaVoxel parity: 8 x 8 tiles (6 x 6 voxels, pitch 8) on a 64 x 64 model, seen straight
// down. Each board carries its lighting in rOBJ and a top-down camera in rCAM slot 1. `node boards.cjs` writes them all
// plus boards.json (tile layout and materials) for the tracer side and the analysis.
const fs = require('fs');
const { writeVox, rcam } = require('./voxwrite.cjs');

const grey = (v) => [v, v, v];
const diffuse = (color) => ({ color, mat: { _type: '_diffuse' } });
const metal = (color, m, rough, sp = 1.5, ior) => ({
  color,
  mat: { _type: '_metal', _metal: m, _rough: rough, _sp: sp, ...(ior === undefined ? {} : { _ior: ior }) },
});
const glass = (color, { trans = 1, rough = 0, n = 1.3, d = 0, type = '_absorb', g = 0 } = {}) => ({
  color,
  mat: {
    _type: '_glass',
    _trans: trans,
    _rough: rough,
    _ior: +(n - 1).toFixed(4),
    _ri: n,
    _d: d,
    _media_type: type,
    _g: g,
  },
  height: 3,
});
const cloud = (color, d, { type = '_scatter', g = 0 } = {}) => ({
  color,
  mat: { _type: '_media', _d: d, _media_type: type, _g: g },
  height: 6,
});
const emit = (color, e, flux, ldr = 0) => ({ color, mat: { _type: '_emit', _emit: e, _flux: flux, _ldr: ldr } });

const D = [
  ...Array.from({ length: 16 }, (_, k) => diffuse(grey(17 * k))),
  ...[
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 191, 77],
    [255, 128, 0],
    [128, 64, 192],
    [200, 200, 60],
    [60, 200, 200],
  ].map(diffuse),
  ...[0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1].map((r) => metal(grey(204), 1, r)),
  ...[[255, 191, 77], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 128, 0], grey(255), grey(128), grey(32)].map((c) =>
    metal(c, 1, 0.2),
  ),
  metal(grey(204), 0, 0.2, 1, 0.3),
  metal(grey(204), 0, 0.2, 1.5, 0.3),
  metal(grey(204), 0, 0.2, 2, 0.3),
  metal(grey(204), 0, 0.2, 1.5, 0),
  metal(grey(204), 0, 0.2, 1.5, 0.6),
  metal(grey(204), 0.25, 0.2, 1.5, 0.3),
  metal(grey(204), 0.5, 0.2, 1.5, 0.3),
  metal(grey(204), 0.75, 0.2, 1.5, 0.3),
  ...[
    [0, 0.2],
    [0.5, 0.2],
    [1, 0.2],
    [0, 0.6],
    [0.5, 0.6],
    [1, 0.6],
    [0, 0],
    [1, 0],
  ].map(([m, r]) => metal([255, 0, 0], m, r, 1.5, 0.3)),
  ...[grey(255), grey(192), grey(64), [255, 0, 255], [0, 128, 0], [128, 0, 0], [0, 0, 128], [255, 255, 128]].map(
    diffuse,
  ),
];
const red = [255, 60, 60];
const G = [
  ...[1.1, 1.3, 1.5, 2].map((n) => glass(grey(255), { n })),
  glass(grey(255), { trans: 0.5 }),
  glass(grey(255), { trans: 0.25 }),
  glass(grey(255), { rough: 0.2 }),
  glass(grey(255), { rough: 0.5 }),
  ...[0, 0.01, 0.05, 0.1, 0.3].map((d) => glass(red, { d })),
  glass([60, 60, 255], { d: 0.05 }),
  glass([60, 255, 60], { d: 0.05 }),
  glass(grey(255), { d: 0.05 }),
  ...[0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].map((d) => cloud(grey(255), d)),
  ...[0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].map((d) => cloud(grey(255), d)),
  ...[-0.5, 0, 0.5, 0.9].map((g) => cloud(grey(255), 0.05, { g })),
  cloud(red, 0.05),
  cloud([60, 60, 255], 0.05),
  cloud(grey(255), 0.05, { type: '_absorb' }),
  cloud([255, 160, 60], 0.05, { type: '_emit' }),
  glass(grey(255), { n: 1.3 }),
  glass(grey(255), { n: 1.5 }),
  glass(grey(255), { n: 2 }),
  glass(grey(255), { n: 1.3, rough: 0.3 }),
  glass(red, { n: 1.3, d: 0.05 }),
  cloud(grey(255), 0.05, { type: '_sss' }),
  glass(grey(255), { n: 1.3, d: 0.05, type: '_scatter' }),
  glass(grey(255), { n: 1.3, d: 0.05, type: '_sss' }),
  ...Array.from({ length: 8 }, () => diffuse(grey(230))),
];
// Base under each glass/cloud tile: white, except rows 3 and 5 (black) to separate scattering from transmission.
const gBase = (j) => (j === 3 || j === 5 ? 20 : 230);
const E = [
  ...[0, 1, 2, 3, 4].map((f) => emit(grey(255), 1, f)),
  emit(grey(255), 0.5, 0),
  emit(grey(255), 0.25, 0),
  emit(grey(255), 0.1, 0),
  ...[[255, 128, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], grey(128), grey(64), [255, 191, 77], grey(200)].map((c) =>
    emit(c, 1, 0),
  ),
  ...[0, 0.25, 0.5, 1].map((l) => emit(grey(255), 1, 1, l)),
  ...[0, 0.25, 0.5, 1].map((l) => emit([255, 128, 0], 1, 1, l)),
  emit(grey(255), 0.1, 1),
  emit(grey(255), 0.1, 2),
  emit(grey(255), 0.01, 3),
  emit(grey(255), 0.01, 4),
  emit(grey(255), 0.5, 1),
  emit(grey(255), 0.5, 2),
  emit(grey(255), 0.2, 3),
  emit(grey(255), 0.05, 4),
];

function build(tiles, base) {
  const voxels = [],
    palette = new Map(),
    materials = new Map(),
    layout = [];
  let next = 1;
  const index = (color, mat) => {
    const i = next++;
    palette.set(i, color);
    materials.set(i, Object.fromEntries(Object.entries(mat).map(([k, v]) => [k, String(v)])));
    return i;
  };
  const baseIndex = new Map();
  tiles.forEach((t, k) => {
    const i = k % 8,
      j = Math.floor(k / 8),
      ti = index(t.color, t.mat),
      x0 = 8 * i + 1,
      y0 = 8 * j + 1,
      h = t.height ?? 0;
    if (h && !baseIndex.has(base(j))) baseIndex.set(base(j), null);
    layout.push({ i, j, index: ti, color: t.color, mat: t.mat, height: h, base: h ? base(j) : null });
    for (let x = x0; x < x0 + 6; x++)
      for (let y = y0; y < y0 + 6; y++) {
        if (!h) voxels.push([x, y, 0, ti]);
        else {
          voxels.push([x, y, 0, `base${base(j)}`]);
          for (let z = 1; z <= h; z++) voxels.push([x, y, z, ti]);
        }
      }
  });
  for (const b of baseIndex.keys()) baseIndex.set(b, index(grey(b), { _type: '_diffuse' }));
  for (const v of voxels) if (typeof v[3] === 'string') v[3] = baseIndex.get(Number(v[3].slice(4)));
  return { voxels, palette, materials, layout, bases: Object.fromEntries(baseIndex) };
}

const camera = rcam({ focus: [0, 0, 1], pitch: -90, yaw: 0, radius: 190, fov: 20 });
const common = { _lens: { _fov: 20, _aperture: 0 }, _bloom: { _mix: 0 } };
const light = {
  sky: { _uni: { _i: 0.5 }, _inf: { _i: 0 } },
  sun: { _uni: { _i: 0 }, _inf: { _i: 1, _angle: '90 0' } },
  sun60: { _uni: { _i: 0 }, _inf: { _i: 1, _angle: '60 90' } },
  dark: { _uni: { _i: 0 }, _inf: { _i: 0 } },
};
const film = { lin: { _film: { _aces: 0 } }, aces: { _film: { _aces: 1 } } };
const merge = (...parts) => {
  const r = {};
  for (const p of parts)
    for (const [k, v] of Object.entries(p))
      r[k] = { ...(r[k] ?? {}), ...Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)])) };
  return r;
};

const boards = { D: build(D, () => 0), G: build(G, gBase), E: build(E, () => 0) };
const renders = {
  'D-sky-lin': ['D', merge(common, light.sky, film.lin)],
  'D-sky-aces': ['D', merge(common, light.sky, film.aces)],
  'D-sun-lin': ['D', merge(common, light.sun, film.lin)],
  'D-sky-expo': ['D', merge(common, light.sky, film.lin, { _film: { _expo: 0.5 } })],
  'D-sun-aces': ['D', merge(common, light.sun, film.aces)],
  'G-sky-lin': ['G', merge(common, light.sky, film.lin)],
  'G-sun60-lin': ['G', merge(common, light.sun60, film.lin)],
  'E-dark-lin': ['E', merge(common, light.dark, film.lin)],
  'E-dark-e1': ['E', merge(common, light.dark, film.lin, { _film: { _expo: 0.1 } })],
  'E-dark-e3': ['E', merge(common, light.dark, film.lin, { _film: { _expo: 0.001 } })],
  'E-dark-e5': ['E', merge(common, light.dark, film.lin, { _film: { _expo: 0.00001 } })],
};
const size = { D: [64, 64, 1], G: [64, 64, 7], E: [64, 64, 1] };
for (const [name, [board, render]] of Object.entries(renders)) {
  const b = boards[board];
  writeVox(`${__dirname}/${name}.vox`, {
    size: size[board],
    voxels: b.voxels,
    palette: b.palette,
    materials: b.materials,
    render,
    camera,
  });
}
fs.writeFileSync(
  `${__dirname}/boards.json`,
  JSON.stringify(
    {
      camera,
      size,
      renders,
      boards: Object.fromEntries(
        Object.entries(boards).map(([k, b]) => [
          k,
          { layout: b.layout, bases: b.bases, palette: [...b.palette], materials: [...b.materials] },
        ]),
      ),
    },
    null,
    1,
  ),
);
console.log(
  Object.keys(renders).join(' '),
  Object.values(boards).map((b) => b.palette.size),
);
