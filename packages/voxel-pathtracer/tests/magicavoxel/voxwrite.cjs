// Writes a MagicaVoxel .vox (one model) with palette, MATL, rOBJ and rCAM chunks, from the public .vox format notes
// (ephtracy/voxel-model: chunks of id, content size, children size; STRING and DICT; rOBJ a DICT, rCAM a camera id and
// a DICT). `node voxwrite.cjs [file]` writes the defaults below to defaults.vox, the base every scene starts from.
const fs = require('fs');
const { read } = require('./voxchunks.cjs');
const i32 = (...n) => {
  const b = Buffer.alloc(4 * n.length);
  n.forEach((v, k) => b.writeInt32LE(v, 4 * k));
  return b;
};
const str = (s) => {
  const b = Buffer.from(String(s), 'latin1');
  return Buffer.concat([i32(b.length), b]);
};
const dict = (d = {}) => {
  const e = Object.entries(d);
  return Buffer.concat([i32(e.length), ...e.flatMap(([k, v]) => [str(k), str(v)])]);
};
const chunk = (id, content) => {
  const h = Buffer.alloc(12);
  h.write(id, 0, 'latin1');
  h.writeInt32LE(content.length, 4);
  return Buffer.concat([h, content]);
};

// The render settings a new MagicaVoxel 0.99.7 scene starts with (rOBJ, in the order it writes them; the values the
// parity doc's "What MagicaVoxel does" starts from: caps 2/5/5, sun and sky 0.7, sun 50 50, lens 35 degrees, ACES with
// gamma 2.2, ground 80 grey with horizon 0.1, ...). `_ibl _path` is left empty (MagicaVoxel's own default names an
// image it ships); scenes with an image sky set their own.
const DEFAULT_RENDER = [
  { _type: '_bounce', _diffuse: '2', _specular: '5', _scatter: '5', _energy: '3' },
  { _type: '_env', _mode: '0' },
  { _type: '_inf', _i: '0.7', _k: '255 255 255', _angle: '50 50', _area: '0.07', _disk: '0' },
  { _type: '_uni', _i: '0.7', _k: '255 255 255' },
  { _type: '_ibl', _path: '', _i: '1', _angle: '0 0' },
  {
    _type: '_atm',
    _ray_d: '0.4',
    _ray_k: '45 104 255',
    _mie_d: '0.4',
    _mie_k: '255 255 255',
    _mie_g: '0.85',
    _o3_d: '0',
    _o3_k: '105 255 110',
  },
  { _type: '_fog_uni', _d: '0', _k: '255 255 255', _g: '0' },
  { _type: '_lens', _proj: '0', _fov: '35', _aperture: '0.25', _blade_n: '0', _blade_r: '0' },
  { _type: '_film', _expo: '1', _vig: '0', _aces: '1', _gam: '2.2' },
  { _type: '_bloom', _mix: '0.5', _scale: '0', _aspect: '0', _threshold: '1' },
  { _type: '_ground', _color: '80 80 80', _hor: '0.1' },
  { _type: '_bg', _color: '0 0 0' },
  { _type: '_edge', _color: '0 0 0', _width: '0.2' },
  { _type: '_grid', _color: '0 0 0', _spacing: '1', _width: '0.02', _display: '0' },
  { _type: '_setting', _ground: '1', _grid: '0', _edge: '0', _bg_c: '0', _bg_a: '0', _scale: '1 1 1', _cell: '1' },
];
// Ten camera slots: an empty camera (45 degrees, tan 22.5 = 0.414214), and in slot 1 our calibration camera (the v2
// scenes' oblique view).
const DEFAULT_CAMERAS = Array.from({ length: 10 }, (_, cam) => ({
  cam,
  dict:
    cam === 1
      ? { _mode: 'pers', _focus: '-2 0 8', _angle: '-28.3 42 0', _radius: '122.3', _frustum: '0.315299', _fov: '35' }
      : { _mode: 'pers', _focus: '0 0 0', _angle: '0 0 0', _radius: '0', _frustum: '0.414214', _fov: '45' },
}));
/** A .vox file of the given chunks under MAIN (version 200). */
const voxFile = (children) => {
  const body = Buffer.concat(children),
    main = Buffer.alloc(12);
  main.write('MAIN', 0, 'latin1');
  main.writeInt32LE(0, 4);
  main.writeInt32LE(body.length, 8);
  return Buffer.concat([Buffer.from('VOX ', 'latin1'), i32(200), main, body]);
};
const renderChunks = (robjs, cams) => [
  ...robjs.map((d) => chunk('rOBJ', dict(d))),
  ...cams.map((c) => chunk('rCAM', Buffer.concat([i32(c.cam), dict(c.dict)]))),
];
/** Writes the default render settings and cameras (no model) to `file`. */
const writeDefaults = (file = `${__dirname}/defaults.vox`) =>
  fs.writeFileSync(file, voxFile(renderChunks(DEFAULT_RENDER, DEFAULT_CAMERAS)));

// The base every scene starts from: defaults.vox, as written by writeDefaults.
const base = read(__dirname + '/defaults.vox');
const defaults = () => base.chunks.filter((c) => c.id === 'rOBJ').map((c) => ({ ...c.dict }));
const cameras = () => base.chunks.filter((c) => c.id === 'rCAM').map((c) => ({ cam: c.cam, dict: { ...c.dict } }));

/**
 * size [x, y, z] (z up); voxels [[x, y, z, index], ...]; palette Map index -> [r, g, b]; materials Map index -> dict;
 * render: { _type: {key: value} } overrides merged into MagicaVoxel's defaults; camera: rCAM slot 1 dict.
 */
function writeVox(file, { size, voxels, palette, materials = new Map(), render = {}, camera }) {
  const rgba = Buffer.alloc(1024);
  for (let i = 1; i <= 255; i++) {
    const c = palette.get(i) ?? [128, 128, 128];
    rgba.writeUInt8(c[0], 4 * (i - 1));
    rgba.writeUInt8(c[1], 4 * (i - 1) + 1);
    rgba.writeUInt8(c[2], 4 * (i - 1) + 2);
    rgba.writeUInt8(255, 4 * (i - 1) + 3);
  }
  const xyzi = Buffer.alloc(4 + 4 * voxels.length);
  xyzi.writeInt32LE(voxels.length, 0);
  voxels.forEach(([x, y, z, c], k) => {
    xyzi.writeUInt8(x, 4 + 4 * k);
    xyzi.writeUInt8(y, 5 + 4 * k);
    xyzi.writeUInt8(z, 6 + 4 * k);
    xyzi.writeUInt8(c, 7 + 4 * k);
  });
  const robjs = defaults().map((d) => ({ ...d, ...(render[d._type] ?? {}) }));
  const cams = cameras().map((c) => (c.cam === 1 && camera ? { ...c, dict: camera } : c));
  const children = [
    chunk('SIZE', i32(...size)),
    chunk('XYZI', xyzi),
    chunk('nTRN', Buffer.concat([i32(0), dict(), i32(1, -1, -1, 1), dict()])),
    chunk('nGRP', Buffer.concat([i32(1), dict(), i32(1, 2)])),
    chunk('nTRN', Buffer.concat([i32(2), dict(), i32(3, -1, 0, 1), dict({ _t: `0 0 ${Math.floor(size[2] / 2)}` })])),
    chunk('nSHP', Buffer.concat([i32(3), dict(), i32(1, 0), dict()])),
    chunk('RGBA', rgba),
    ...[...materials].map(([i, d]) => chunk('MATL', Buffer.concat([i32(i), dict(d)]))),
    ...renderChunks(robjs, cams),
  ];
  fs.writeFileSync(file, voxFile(children));
}

/** rCAM dict for a camera at `pitch` (degrees, negative looks down), `yaw`, `radius` from `focus` [x, y, zFromBottom]. */
const rcam = ({ focus, pitch, yaw, radius, fov }) => ({
  _mode: 'pers',
  _focus: focus.join(' '),
  _angle: `${pitch} ${yaw} 0`,
  _radius: String(radius),
  _frustum: String(Math.tan((fov * Math.PI) / 360).toFixed(6)),
  _fov: String(fov),
});
module.exports = { writeVox, writeDefaults, rcam, defaults, DEFAULT_RENDER, DEFAULT_CAMERAS };
if (require.main === module) writeDefaults(process.argv[2]);
