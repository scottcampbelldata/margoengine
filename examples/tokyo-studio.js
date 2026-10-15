/**
 * Procedural studio lighting cube for @margoengine/environment: Margo's stand-in for three.js RoomEnvironment.
 * Layers +X, -X, +Y, -Y, +Z, -Z (WebGPU order), row 0 at the top, linear RGBA.
 * @param {number} [size]
 * @returns {{size: number, faces: Float32Array[]}}
 */
export function studioCube(size = 64) {
  if (!Number.isInteger(Math.log2(size)) || size < 8) throw new RangeError('studioCube size must be a power of two >= 8');
  const faces = [];
  for (let face = 0; face < 6; face++) {
    const data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1, i = (y * size + x) * 4;
      let value = face === 2 ? 0.9 : face === 3 ? 0.18 : 0.45 - 0.25 * v; // walls brighten toward the ceiling
      if (face === 2 && Math.abs(u) < 0.45 && Math.abs(v) < 0.2) value = 6;   // ceiling softbox
      if (face === 0 && Math.abs(u) < 0.35 && v > -0.6 && v < 0.1) value = 3; // +X key panel
      if (face === 5 && Math.abs(u) < 0.5 && v > -0.5 && v < 0) value = 2;    // -Z fill panel
      data[i] = value; data[i + 1] = value * 0.98; data[i + 2] = value * 0.95; data[i + 3] = 1;
    }
    faces.push(data);
  }
  return {size, faces};
}
