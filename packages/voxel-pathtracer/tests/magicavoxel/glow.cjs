// One flat emitter tile (6 x 6 x 1, flux 2) and one emissive pillar (2 x 2 x 8, flux 1), far apart, in the dark.
const { writeVox, rcam } = require('./voxwrite.cjs');
const box = (v, x0, y0, z0, sx, sy, sz, c) => {
  for (let x = x0; x < x0 + sx; x++)
    for (let y = y0; y < y0 + sy; y++) for (let z = z0; z < z0 + sz; z++) v.push([x, y, z, c]);
};
const voxels = [];
box(voxels, 13, 29, 0, 6, 6, 1, 1);
box(voxels, 47, 31, 0, 2, 2, 8, 2);
const S = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]))]),
  );
for (const [tag, expo] of [
  ['a', 0.2],
  ['b', 0.01],
])
  writeVox(`${__dirname}/X-glow-${tag}.vox`, {
    size: [64, 64, 8],
    voxels,
    palette: new Map([
      [1, [255, 255, 255]],
      [2, [255, 255, 255]],
    ]),
    materials: new Map([
      [1, { _type: '_emit', _emit: '1', _flux: '2' }],
      [2, { _type: '_emit', _emit: '1', _flux: '1' }],
    ]),
    render: S({
      _lens: { _aperture: 0, _fov: 35 },
      _bloom: { _mix: 0 },
      _film: { _aces: 0, _expo: expo },
      _uni: { _i: 0 },
      _inf: { _i: 0 },
    }),
    camera: rcam({ focus: [0, 0, 0], pitch: -90, yaw: 0, radius: 130, fov: 35 }),
  });
console.log('ok');
