// Ground-fade start: what sets it? The same 16-cube from radius 60 and 180, and four 8-cubes spread over 64 x 64.
const { writeVox, rcam } = require('./voxwrite.cjs');
const render = {
  _env: { _mode: '0' },
  _uni: { _i: '0.5', _k: '100 150 255' },
  _inf: { _i: '0.3', _k: '255 255 255', _angle: '40 60', _area: '0.07', _disk: '0' },
  _fog_uni: { _d: '0' },
  _film: { _expo: '1', _vig: '0', _aces: '0', _gam: '2.2' },
  _ground: { _color: '80 80 80', _hor: '0.5' },
  _lens: { _proj: '0', _fov: '35', _aperture: '0' },
  _setting: { _ground: '1', _grid: '0', _edge: '0' },
};
const cube = (n, ox = 0, oy = 0) => {
  const v = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) v.push([ox + x, oy + y, z, 1]);
  return v;
};
const palette = new Map([[1, [230, 230, 230]]]),
  materials = new Map([[1, { _type: '_diffuse' }]]);
for (const R of [60, 180])
  writeVox(`${process.cwd()}/H-r${R}.vox`, {
    size: [16, 16, 16],
    voxels: cube(16),
    palette,
    materials,
    render,
    camera: rcam({ focus: [0, 0, 8], pitch: -4, yaw: 20, radius: R, fov: 35 }),
  });
writeVox(`${process.cwd()}/H-corners.vox`, {
  size: [64, 64, 8],
  voxels: [...cube(8, 0, 0), ...cube(8, 56, 0), ...cube(8, 0, 56), ...cube(8, 56, 56)],
  palette,
  materials,
  render,
  camera: rcam({ focus: [0, 0, 4], pitch: -4, yaw: 20, radius: 90, fov: 35 }),
});
console.log('written');
