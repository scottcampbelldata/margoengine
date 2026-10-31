// An application rotation writer for the animator tests: the same finite Float32 guard, normalization and Euler
// synchronization as Mesh.setQuaternion, written from outside core, with no allocation.
function hypot4Into(value, out, slot = 0) {
  const x = Math.abs(value[0]),
    y = Math.abs(value[1]),
    z = Math.abs(value[2]),
    w = Math.abs(value[3]);
  if (x === Infinity || y === Infinity || z === Infinity || w === Infinity) {
    out[slot] = Infinity;
    return;
  }
  const largest = Math.max(Math.max(x, y), Math.max(z, w));
  if (largest !== largest) {
    out[slot] = NaN;
    return;
  }
  if (largest === 0) {
    out[slot] = 0;
    return;
  }
  let sum = 0,
    correction = 0;
  for (let i = 0; i < 4; i++) {
    const component = (i === 0 ? x : i === 1 ? y : i === 2 ? z : w) / largest,
      adjusted = component * component - correction,
      next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  out[slot] = Math.sqrt(sum) * largest;
}

export class MeshRotationWriter {
  lengths = new Float64Array(1);
  setQuaternion(mesh, value) {
    mesh.check();
    if (value.length !== 4) throw new TypeError('Quaternion: 4 values; see https://margoengine.com/errors#transform');
    for (let i = 0; i < 4; i++)
      if (typeof value[i] !== 'number' || !Number.isFinite(Math.fround(value[i])))
        throw new RangeError('Quaternion: finite values; see https://margoengine.com/errors#transform');
    hypot4Into(value, this.lengths);
    const length = this.lengths[0];
    if (!length) throw new RangeError('Quaternion nonzero; see https://margoengine.com/errors#transform');
    const x = value[0] / length,
      y = value[1] / length,
      z = value[2] / length,
      w = value[3] / length,
      t = mesh.engine.store.transforms,
      id = mesh.id;
    t.qx[id] = x;
    t.qy[id] = y;
    t.qz[id] = z;
    t.qw[id] = w;
    const lanes = mesh.engine.store.rotations,
      at = id * 3;
    lanes[at + 1] = Math.asin(Math.max(-1, Math.min(1, 2 * (x * z + w * y))));
    lanes[at] = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y));
    lanes[at + 2] = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z));
  }
}
