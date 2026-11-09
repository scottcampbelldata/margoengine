// Own standard .vox calibration scenes. Run with a temporary output directory.
// Binary reference tools and their rendered images stay outside this repository.
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { writeVox, rcam } = require('./voxwrite.cjs');
const directory = process.argv[2];
if (!directory) throw new TypeError('Pass a temporary output directory for the parity fixtures');
mkdirSync(directory, { recursive: true });
const plane = [];
for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) plane.push([x, y, 0, 1]);
for (const gamma of [1, 1.8, 2.2, 5]) {
  writeVox(join(directory, `gamma-${gamma}.vox`), {
    size: [16, 16, 1],
    voxels: plane,
    palette: new Map([[1, [128, 128, 128]]]),
    materials: new Map([[1, { _type: '_diffuse' }]]),
    camera: rcam({ focus: [0, 0, 0], pitch: -90, yaw: 0, radius: 40, fov: 35 }),
    render: {
      _env: { _mode: '0' },
      _uni: { _i: '0' },
      _inf: { _i: '0.1', _angle: '90 0', _area: '0' },
      _lens: { _aperture: '0' },
      _bloom: { _mix: '0' },
      _film: { _aces: '0', _gam: String(gamma), _expo: '1' },
      _setting: { _ground: '0' },
    },
  });
}
writeVox(join(directory, 'colored-sky.vox'), {
  size: [16, 16, 1],
  voxels: plane,
  palette: new Map([[1, [255, 255, 255]]]),
  materials: new Map([[1, { _type: '_diffuse' }]]),
  camera: rcam({ focus: [0, 0, 0], pitch: -90, yaw: 0, radius: 40, fov: 35 }),
  render: {
    _env: { _mode: '0' },
    _uni: { _i: '0.5', _k: '128 128 128' },
    _inf: { _i: '0', _angle: '90 0', _area: '0' },
    _lens: { _aperture: '0' },
    _bloom: { _mix: '0' },
    _film: { _aces: '0', _gam: '1', _expo: '1' },
    _setting: { _ground: '0' },
  },
});
const voxels = [...plane];
for (let x = 4; x < 12; x++) for (let y = 4; y < 12; y++) for (let z = 1; z < 7; z++) voxels.push([x, y, z, 2]);
for (const [name, material] of Object.entries({
  subsurface: { _type: '_media', _media_type: '_sss', _d: '0.05', _g: '0' },
  glass: { _type: '_glass', _trans: '1', _ior: '0.5', _d: '0', _media_type: '_absorb' },
  atmosphere: { _type: '_diffuse' },
})) {
  writeVox(join(directory, `${name}.vox`), {
    size: [16, 16, 7],
    voxels,
    palette: new Map([
      [1, [128, 128, 128]],
      [2, [230, 160, 100]],
    ]),
    materials: new Map([
      [1, { _type: '_diffuse' }],
      [2, material],
    ]),
    camera: rcam({ focus: [0, 0, 4], pitch: -28.3, yaw: 42, radius: 40, fov: 35 }),
    render: {
      _bounce: { _diffuse: '4', _specular: '5', _scatter: '5' },
      _env: { _mode: name === 'atmosphere' ? '1' : '0' },
      _lens: { _aperture: '0' },
      _bloom: { _mix: '0' },
      _film: { _aces: '0', _gam: '1', _expo: '1' },
      _ground: { _color: '0 0 0', _hor: '0' },
      _inf: { _i: '0.7', _angle: name === 'atmosphere' ? '5 50' : '60 50', _area: '0' },
      _uni: { _i: '0.7' },
    },
  });
}
