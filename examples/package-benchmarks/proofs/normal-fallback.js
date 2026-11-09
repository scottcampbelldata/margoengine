// Exact correction of historical normal fallback expectations. Candidate traces are never rewritten.
// RGBA8 128/255 has a tangent-space tilt; the repaired fallback is exactly 0.5 in RGBA16F.
export function neutralNormalExpectations(log) {
  if (!Array.isArray(log)) return log;
  const corrected = structuredClone(log);
  for (let i = 0; i < corrected.length; i++) {
    const row = corrected[i];
    if (
      !Array.isArray(row) ||
      row[0] !== 'texture' ||
      row[2]?.format !== 'rgba8unorm' ||
      row[2]?.size?.join(',') !== '1,1' ||
      row[2]?.mipLevelCount !== 1 ||
      row[2]?.usage !== 22
    )
      continue;
    const upload = corrected[i + 1];
    if (
      !Array.isArray(upload) ||
      upload[0] !== 'writeTexture' ||
      upload[1]?.texture !== row[1] ||
      upload[2] !== 'Uint8Array:8080ffff' ||
      upload[3]?.bytesPerRow !== 4 ||
      upload[4]?.join(',') !== '1,1'
    )
      continue;
    row[2].format = 'rgba16float';
    upload[2] = 'Uint16Array:00380038003c003c';
    upload[3].bytesPerRow = 8;
  }
  return corrected;
}
