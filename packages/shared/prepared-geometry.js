// CPU-only validation shared by the PBR runtime and offline .margo decoder.
export function validatePreparedGeometry(data) {
  const { vertices, indices } = data,
    count = vertices?.length / 20;
  if (
    !(vertices instanceof Float32Array) ||
    !(indices instanceof Uint32Array) ||
    !Number.isInteger(count) ||
    count < 3 ||
    count > 1_000_000 ||
    !indices.length ||
    indices.length % 3
  )
    throw new RangeError('Invalid prepared PBR geometry');
  for (let i = 0; i < indices.length; i++)
    if (indices[i] >= count) throw new RangeError('Invalid prepared PBR geometry');
  checkPreparedVertices(vertices, 0, count);
}

export function checkPreparedVertices(vertices, from, to) {
  for (let i = from * 20; i < to * 20; i++)
    if (!Number.isFinite(vertices[i])) throw new RangeError('Non-finite prepared PBR vertex');
  for (let i = from * 20; i < to * 20; i += 20) {
    const sign = vertices[i + 11];
    if (
      vertices[i + 3] !== 1 ||
      vertices[i + 7] !== 0 ||
      Math.abs(Math.hypot(vertices[i + 4], vertices[i + 5], vertices[i + 6]) - 1) > 1e-3 ||
      (sign !== 0 && sign !== -1 && sign !== 1)
    )
      throw new RangeError('Invalid prepared PBR normal/tangent');
    if (vertices[i + 11] && Math.abs(Math.hypot(vertices[i + 8], vertices[i + 9], vertices[i + 10]) - 1) > 1e-3)
      throw new RangeError('Invalid prepared PBR tangent');
    for (let c = 16; c < 20; c++)
      if (vertices[i + c] < 0 || vertices[i + c] > 1) throw new RangeError('Invalid prepared PBR color');
  }
}
