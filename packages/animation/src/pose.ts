// The deformation shader's arithmetic (shader.ts, linear blend) on the CPU, for positions and normals only, so a
// synchronous CPU query tests the pose the GPU pass draws: a GPU buffer cannot be read back synchronously.

/**
 * Writes the pose of `bind` (20 floats per vertex) into `out`. Morph targets are added first: `deltas` holds 12 floats
 * per vertex and target (position at 0, normal at 4) and `weights` one value per target. Then comes the weighted blend
 * of `palette` (16 floats per bone) by `influences`: `words` per vertex, four joint indices then four float weights,
 * twice for eight influences. Everything but position and normal is copied from `bind`.
 */
export function poseVertices(
  bind: Float32Array,
  out: Float32Array,
  deltas: Float32Array,
  weights: ArrayLike<number>,
  influences: Uint32Array,
  words: number,
  palette: Float32Array,
): void {
  const count = bind.length / 20,
    targets = count ? deltas.length / (count * 12) : 0,
    shares = new Float32Array(influences.buffer, influences.byteOffset, influences.length),
    m = new Float64Array(16);
  out.set(bind);
  for (let i = 0, o = 0; i < count; i++, o += 20) {
    let x = bind[o],
      y = bind[o + 1],
      z = bind[o + 2],
      nx = bind[o + 4],
      ny = bind[o + 5],
      nz = bind[o + 6];
    for (let t = 0; t < targets; t++) {
      const w = weights[t],
        d = (t * count + i) * 12;
      x += deltas[d] * w;
      y += deltas[d + 1] * w;
      z += deltas[d + 2] * w;
      nx += deltas[d + 4] * w;
      ny += deltas[d + 5] * w;
      nz += deltas[d + 6] * w;
    }
    if (influences.length) {
      m.fill(0);
      for (let k = i * words, end = k + words; k < end; k += 8)
        for (let c = 0; c < 4; c++) {
          const w = shares[k + 4 + c],
            at = influences[k + c] * 16;
          if (w) for (let j = 0; j < 16; j++) m[j] += w * palette[at + j];
        }
      const px = m[0] * x + m[4] * y + m[8] * z + m[12],
        py = m[1] * x + m[5] * y + m[9] * z + m[13];
      z = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = px;
      y = py;
      // The cofactor columns (the blend's inverse transpose times its determinant), flipped for a mirroring blend.
      const ax = m[5] * m[10] - m[6] * m[9],
        ay = m[6] * m[8] - m[4] * m[10],
        az = m[4] * m[9] - m[5] * m[8],
        bx = m[9] * m[2] - m[10] * m[1],
        by = m[10] * m[0] - m[8] * m[2],
        bz = m[8] * m[1] - m[9] * m[0],
        cx = m[1] * m[6] - m[2] * m[5],
        cy = m[2] * m[4] - m[0] * m[6],
        cz = m[0] * m[5] - m[1] * m[4],
        hand = m[0] * ax + m[1] * ay + m[2] * az >= 0 ? 1 : -1,
        tx = (ax * nx + bx * ny + cx * nz) * hand,
        ty = (ay * nx + by * ny + cy * nz) * hand,
        tz = (az * nx + bz * ny + cz * nz) * hand,
        bent = tx * tx + ty * ty + tz * tz > 0;
      nx = bent ? tx : 0;
      ny = bent ? ty : 1;
      nz = bent ? tz : 0;
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 4] = nx / length;
    out[o + 5] = ny / length;
    out[o + 6] = nz / length;
  }
}
