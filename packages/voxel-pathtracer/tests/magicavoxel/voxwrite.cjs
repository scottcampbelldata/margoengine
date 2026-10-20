// Writes a MagicaVoxel .vox (one model) with palette, MATL, rOBJ and rCAM chunks, from our own format notes.
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

// MagicaVoxel's own default render dictionaries, as it saved them (scratch.vox).
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
    ...robjs.map((d) => chunk('rOBJ', dict(d))),
    ...cams.map((c) => chunk('rCAM', Buffer.concat([i32(c.cam), dict(c.dict)]))),
  ];
  const body = Buffer.concat(children),
    main = Buffer.alloc(12);
  main.write('MAIN', 0, 'latin1');
  main.writeInt32LE(0, 4);
  main.writeInt32LE(body.length, 8);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('VOX ', 'latin1'), i32(200), main, body]));
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
module.exports = { writeVox, rcam, defaults };
