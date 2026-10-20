// Second calibration batch: sun penumbra (_area), horizon blend (_hor), depth of field (_aperture), bloom, metal
// roughness seen in reflections, isolated _ldr emitters and emissive media. `node xboards.cjs` writes X-*.vox.
const { writeVox, rcam } = require('./voxwrite.cjs');
const grey = (v) => [v, v, v];
const S = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]))]),
  );
const base = { _lens: { _aperture: 0 }, _bloom: { _mix: 0 }, _film: { _aces: 0 } };
const merge = (...p) => {
  const r = {};
  for (const x of p) for (const [k, v] of Object.entries(x)) r[k] = { ...(r[k] ?? {}), ...v };
  return S(r);
};
const top = rcam({ focus: [0, 0, 1], pitch: -90, yaw: 0, radius: 190, fov: 20 });
const files = {};
function scene(name, size, fill, palette, materials, render, camera = top) {
  const voxels = [];
  fill(voxels);
  files[name] = { size, voxels, palette, materials, render, camera };
}
const box = (v, x0, y0, z0, sx, sy, sz, c) => {
  for (let x = x0; x < x0 + sx; x++)
    for (let y = y0; y < y0 + sy; y++) for (let z = z0; z < z0 + sz; z++) v.push([x, y, z, c]);
};

// Sun penumbra: a white wall (x 40, y 16-47, 24 tall) on a white ground, sun from +x at 45 degrees.
const wallPal = new Map([[1, grey(230)]]),
  wallMat = new Map([[1, { _type: '_diffuse' }]]);
for (const area of [0, 0.07, 0.2])
  scene(
    `X-sun-a${String(area * 100).padStart(2, '0')}`,
    [64, 64, 24],
    (v) => box(v, 40, 16, 0, 1, 32, 24, 1),
    wallPal,
    wallMat,
    merge(base, {
      _uni: { _i: 0 },
      _inf: { _i: 0.4, _angle: '45 90', _area: area },
      _ground: { _color: '255 255 255' },
    }),
    rcam({ focus: [-4, 0, 0], pitch: -90, yaw: 0, radius: 190, fov: 20 }),
  );

// Horizon: a low perspective view across the ground toward the horizon, bluish sky, a white cube for reference.
for (const hor of [0.1, 0.5])
  scene(
    `X-hor-${String(hor * 10)}`,
    [16, 16, 16],
    (v) => box(v, 0, 0, 0, 16, 16, 16, 1),
    wallPal,
    wallMat,
    merge(base, { _uni: { _i: 0.5, _k: '100 150 255' }, _inf: { _i: 0.3, _angle: '40 60' }, _ground: { _hor: hor } }),
    rcam({ focus: [0, 0, 8], pitch: -4, yaw: 20, radius: 90, fov: 45 }),
  );

// Depth of field: the diffuse board seen obliquely and close.
const tiles = (v) => {
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) box(v, 8 * i + 1, 8 * j + 1, 0, 6, 6, 1 + ((i + j) % 3), 1 + ((i + j) % 2));
};
const checkPal = new Map([
    [1, grey(230)],
    [2, [200, 40, 40]],
  ]),
  checkMat = new Map([
    [1, { _type: '_diffuse' }],
    [2, { _type: '_diffuse' }],
  ]);
for (const ap of [0.25, 2])
  scene(
    `X-dof-${String(ap).replace('.', '')}`,
    [64, 64, 3],
    tiles,
    checkPal,
    checkMat,
    merge(base, { _uni: { _i: 0.5 }, _inf: { _i: 0 }, _lens: { _aperture: ap, _fov: 40 } }),
    rcam({ focus: [0, 0, 1], pitch: -25, yaw: 0, radius: 60, fov: 40 }),
  );

// Bloom: bright emitters in the dark with MagicaVoxel's default bloom (mix 0.5, scale 0) and with scale 0.5.
const emitPal = new Map([
  [1, grey(255)],
  [2, [255, 128, 0]],
]);
const emitMat = new Map([
  [1, { _type: '_emit', _emit: '1', _flux: '2' }],
  [2, { _type: '_emit', _emit: '1', _flux: '1' }],
]);
for (const [tag, bloom] of [
  ['def', { _mix: 0.5, _scale: 0 }],
  ['s5', { _mix: 0.5, _scale: 0.5 }],
])
  scene(
    `X-bloom-${tag}`,
    [64, 64, 1],
    (v) => {
      box(v, 12, 28, 0, 8, 8, 1, 1);
      box(v, 44, 28, 0, 8, 8, 1, 2);
    },
    emitPal,
    emitMat,
    merge(base, { _uni: { _i: 0 }, _inf: { _i: 0 }, _film: { _expo: 0.05 }, _bloom: bloom }),
  );

// Metal roughness in reflection: eight grey metal tiles (roughness 0 to 1) reflect the top edge of an emissive wall.
const roughs = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1];
const metalPal = new Map([[9, grey(255)], ...roughs.map((_, k) => [k + 1, grey(204)])]);
const metalMat = new Map([
  [9, { _type: '_emit', _emit: '1', _flux: '0' }],
  ...roughs.map((r, k) => [k + 1, { _type: '_metal', _metal: '1', _rough: String(r), _sp: '1' }]),
]);
scene(
  'X-rough',
  [64, 48, 16],
  (v) => {
    roughs.forEach((_, k) => box(v, 8 * k + 1, 0, 0, 6, 6, 1, k + 1));
    box(v, 0, 40, 0, 64, 1, 14, 9);
  },
  metalPal,
  metalMat,
  merge(base, { _uni: { _i: 0 }, _inf: { _i: 0 }, _film: { _expo: 0.3 } }),
  rcam({ focus: [0, -21, 1], pitch: -20, yaw: 0, radius: 80, fov: 30 }),
);

// _ldr emitters (flux 1) and emissive media, each isolated, in the dark.
const ldrPal = new Map([
  [1, grey(255)],
  [2, grey(255)],
  [3, grey(255)],
  [4, grey(255)],
  [5, grey(255)],
  [6, grey(255)],
  [7, grey(255)],
  [8, grey(255)],
]);
const ldrMat = new Map([
  ...[0, 0.25, 0.5, 1].map((l, k) => [k + 1, { _type: '_emit', _emit: '1', _flux: '1', _ldr: String(l) }]),
  ...[0.01, 0.05, 0.2, 1].map((d, k) => [k + 5, { _type: '_media', _d: String(d), _media_type: '_emit', _g: '0' }]),
]);
scene(
  'X-ldr',
  [64, 64, 6],
  (v) => {
    for (let k = 0; k < 4; k++) {
      box(v, 16 * k + 5, 8, 0, 6, 6, 1, k + 1);
      box(v, 16 * k + 5, 42, 0, 6, 6, 6, k + 5);
    }
  },
  ldrPal,
  ldrMat,
  merge(base, { _uni: { _i: 0 }, _inf: { _i: 0 }, _film: { _expo: 0.01 } }),
);

for (const [name, f] of Object.entries(files)) writeVox(`${__dirname}/${name}.vox`, f);
console.log(Object.keys(files).join(' '));
