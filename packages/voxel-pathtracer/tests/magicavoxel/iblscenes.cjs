// Image sky calibration: our own equirectangular HDR (Radiance RGBE, flat scanlines) whose red channel ramps with the
// column and green with the row (blue constant), seen through MagicaVoxel's panorama projection.
const fs = require('fs');
const { writeVox, rcam } = require('./voxwrite.cjs');
const W = 512,
  H = 256;
function rgbe(r, g, b) {
  const m = Math.max(r, g, b);
  if (m < 1e-32) return [0, 0, 0, 0];
  const e = Math.ceil(Math.log2(m)) + (m === 2 ** Math.ceil(Math.log2(m)) ? 1 : 0);
  const s = 256 / 2 ** e;
  return [Math.floor(r * s), Math.floor(g * s), Math.floor(b * s), e + 128];
}
const body = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W,
      v = (y + 0.5) / H;
    body.set(rgbe(0.02 + 0.46 * u, 0.02 + 0.46 * (1 - v), 0.25), 4 * (y * W + x));
  }
const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`, 'latin1');
const path = `${process.cwd()}/ramp.hdr`.split(String.fromCharCode(92)).join('/');
fs.writeFileSync(path, Buffer.concat([header, body]));
const S = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, String(b)]))]),
  );
const merge = (...p) => {
  const r = {};
  for (const x of p) for (const [k, v] of Object.entries(x)) r[k] = { ...(r[k] ?? {}), ...v };
  return S(r);
};
const base = {
  _env: { _mode: 2 },
  _inf: { _i: 0 },
  _ibl: { _path: path, _i: 1, _angle: '0 0' },
  _setting: { _ground: 0 },
  _bloom: { _mix: 0 },
  _film: { _aces: 0, _gam: 2.2, _expo: 1 },
  _lens: { _aperture: 0, _fov: 90, _proj: 2 },
};
const cam = rcam({ focus: [0, 0, 40], pitch: 0, yaw: 0, radius: 0.01, fov: 90 });
for (const [tag, v] of Object.entries({
  a00: {},
  a900: { _ibl: { _angle: '90 0' } },
  a030: { _ibl: { _angle: '0 30' } },
  i2: { _ibl: { _i: 2 } },
  i025: { _ibl: { _i: 0.25, _angle: '45 120' } },
}))
  writeVox(`${process.cwd()}/I-pano-${tag}.vox`, {
    size: [1, 1, 1],
    voxels: [[0, 0, 0, 1]],
    palette: new Map([[1, [128, 128, 128]]]),
    materials: new Map([[1, { _type: '_diffuse' }]]),
    render: merge(base, v),
    camera: cam,
  });
console.log(path);
