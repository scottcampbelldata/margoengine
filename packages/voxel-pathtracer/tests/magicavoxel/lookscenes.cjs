// Background colour, vignette, edges and grid: what MagicaVoxel's display settings do. `node lookscenes.cjs`.
const { writeVox, rcam } = require('./voxwrite.cjs');
const base = {
  _env: { _mode: '0' },
  _uni: { _i: '0.5', _k: '255 255 255' },
  _inf: { _i: '0.3', _k: '255 255 255', _angle: '40 60', _area: '0.07', _disk: '0' },
  _fog_uni: { _d: '0' },
  _film: { _expo: '1', _vig: '0', _aces: '0', _gam: '2.2' },
  _ground: { _color: '80 80 80', _hor: '0.1' },
  _lens: { _proj: '0', _fov: '35', _aperture: '0' },
  _bloom: { _mix: '0' },
  _setting: { _ground: '1', _grid: '0', _edge: '0', _bg_c: '0', _bg_a: '0' },
};
const S = (o) => {
  const r = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(o)) r[k] = { ...(r[k] ?? {}), ...v };
  return r;
};
const box = (n, ox, oy, oz, c) => {
  const v = [];
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) v.push([ox + x, oy + y, oz + z, c]);
  return v;
};
// A 32 x 32 x 1 slab (palette 1, light grey) with an 8-cube (palette 2, white) and a 4-cube (palette 3, orange) on it.
const slab = [];
for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) slab.push([x, y, 0, 1]);
const voxels = [...slab, ...box(8, 4, 4, 1, 2), ...box(4, 20, 18, 1, 3)];
const palette = new Map([
    [1, [200, 200, 200]],
    [2, [255, 255, 255]],
    [3, [255, 140, 40]],
  ]),
  materials = new Map([
    [1, { _type: '_diffuse' }],
    [2, { _type: '_diffuse' }],
    [3, { _type: '_diffuse' }],
  ]);
const size = [32, 32, 9];
const oblique = rcam({ focus: [0, 0, 4], pitch: -12, yaw: 30, radius: 110, fov: 35 });
const top = rcam({ focus: [0, 0, 1], pitch: -90, yaw: 0, radius: 120, fov: 35 });
const up = rcam({ focus: [0, 0, 100], pitch: 89, yaw: 0, radius: 10, fov: 35 });
const out = {
  'L-bg-off': [oblique, S({})],
  'L-bg-on': [oblique, S({ _bg: { _color: '200 100 50' }, _setting: { _bg_c: '1' } })],
  'L-vig-05': [up, S({ _film: { _vig: '0.5' } })],
  'L-vig-10': [up, S({ _film: { _vig: '1' } })],
  'L-vig-10-fov70': [up, S({ _film: { _vig: '1' }, _lens: { _fov: '70' } })],
  'L-edge-02': [top, S({ _edge: { _color: '255 0 0', _width: '0.2' }, _setting: { _edge: '1' } })],
  'L-edge-05': [oblique, S({ _edge: { _color: '0 0 255', _width: '0.5' }, _setting: { _edge: '1' } })],
  'L-grid-a': [
    top,
    S({ _grid: { _color: '255 0 0', _spacing: '1', _width: '0.02', _display: '0' }, _setting: { _grid: '1' } }),
  ],
  'L-grid-b': [
    oblique,
    S({ _grid: { _color: '0 0 255', _spacing: '4', _width: '0.1', _display: '1' }, _setting: { _grid: '1' } }),
  ],
  'L-grid-c': [
    oblique,
    S({ _grid: { _color: '0 0 255', _spacing: '4', _width: '0.1', _display: '0' }, _setting: { _grid: '1' } }),
  ],
  'I-lit': [
    oblique,
    S({
      _env: { _mode: '2' },
      _inf: { _i: '0' },
      _ibl: { _path: `${process.cwd()}/ramp.hdr`.split(String.fromCharCode(92)).join('/'), _i: '0.5', _angle: '0 40' },
    }),
  ],
  'L-grid-d': [
    top,
    S({ _grid: { _color: '255 0 0', _spacing: '1', _width: '0.02', _display: '1' }, _setting: { _grid: '1' } }),
  ],
};
for (const [name, [camera, render]] of Object.entries(out))
  writeVox(`${process.cwd()}/${name}.vox`, { size, voxels, palette, materials, render, camera });
console.log(Object.keys(out).join(' '));
