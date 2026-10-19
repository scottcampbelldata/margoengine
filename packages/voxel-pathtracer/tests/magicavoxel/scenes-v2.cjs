// The six comparison scenes with MagicaVoxel 0.99.7 material keys, its default render settings and camera slot 1.
const fs = require('fs');
const { read } = require('../../mv-calib/voxchunks.cjs');
const { writeVox, rcam } = require('../../mv-calib/voxwrite.cjs');
const mats = {
  diffuse: {},
  'metal-r0.2': { 5: { _type: '_metal', _metal: '1', _rough: '0.2', _sp: '1.5' } },
  'metal-r0.8': { 5: { _type: '_metal', _metal: '1', _rough: '0.8', _sp: '1.5' } },
  glass: { 6: { _type: '_glass', _trans: '1', _rough: '0', _ior: '0.5', _d: '0.05', _media_type: '_absorb' } },
  emissive: { 7: { _type: '_emit', _emit: '1', _flux: '1', _ldr: '0' } },
  media: { 8: { _type: '_media', _d: '0.05', _media_type: '_scatter', _g: '0' } },
};
const camera = rcam({ focus: [-2, 0, 8], pitch: -28.3, yaw: 42, radius: 122.3, fov: 35 });
for (const [name, special] of Object.entries(mats)) {
  const v = read(`${__dirname}/../${name}.vox`), size = v.chunks.find((c) => c.id === 'SIZE'), xyzi = v.chunks.find((c) => c.id === 'XYZI'), rgba = v.chunks.find((c) => c.id === 'RGBA');
  const s = [0, 1, 2].map((k) => size.raw.readInt32LE(12 + 4 * k)), n = xyzi.raw.readInt32LE(12), voxels = [], used = new Set();
  for (let i = 0; i < n; i++) { const o = 16 + 4 * i, q = [...xyzi.raw.subarray(o, o + 4)]; voxels.push(q); used.add(q[3]); }
  const palette = new Map(), materials = new Map();
  for (let i = 1; i <= 255; i++) { const o = 12 + 4 * (i - 1); palette.set(i, [rgba.raw[o], rgba.raw[o + 1], rgba.raw[o + 2]]); }
  for (const i of used) materials.set(i, special[i] ?? { _type: '_diffuse', _rough: '0.1', _ior: '0.3', _ri: '1.3', _d: '0.05' });
  writeVox(`${__dirname}/${name}.vox`, { size: s, voxels, palette, materials, camera });
  console.log(name, s.join('x'), n, 'voxels, palette', [...used].join(','));
}
