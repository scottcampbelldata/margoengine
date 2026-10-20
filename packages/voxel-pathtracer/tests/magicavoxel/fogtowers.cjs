// Fog extent: white towers of heights 1-48 seen from above through uniform fog (sky only); density and camera distance.
const { writeVox, rcam } = require('./voxwrite.cjs');
const S = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]))]),
  );
const box = (v, x0, y0, z0, sx, sy, sz, c) => {
  for (let x = x0; x < x0 + sx; x++)
    for (let y = y0; y < y0 + sy; y++) for (let z = z0; z < z0 + sz; z++) v.push([x, y, z, c]);
};
const H = [1, 4, 8, 16, 32, 48],
  voxels = [];
H.forEach((h, k) => box(voxels, 10 * k + 2, 29, 0, 6, 6, h, 1));
const base = {
  _lens: { _aperture: 0, _fov: 20 },
  _bloom: { _mix: 0 },
  _film: { _aces: 0 },
  _uni: { _i: 0.5 },
  _inf: { _i: 0 },
};
const merge = (...p) => {
  const r = {};
  for (const x of p) for (const [k, v] of Object.entries(x)) r[k] = { ...(r[k] ?? {}), ...v };
  return S(r);
};
for (const [tag, d, radius] of [
  ['T0', 0, 190],
  ['T5', 0.005, 190],
  ['T20', 0.02, 190],
  ['T5far', 0.005, 400],
])
  writeVox(`${__dirname}/F-${tag}.vox`, {
    size: [64, 64, 48],
    voxels,
    palette: new Map([[1, [255, 255, 255]]]),
    materials: new Map([[1, { _type: '_diffuse' }]]),
    camera: rcam({ focus: [0, 0, 0], pitch: -90, yaw: 0, radius, fov: 20 }),
    render: merge(base, { _fog_uni: { _d: d, _k: '255 255 255', _g: 0 } }),
  });
console.log('ok');
