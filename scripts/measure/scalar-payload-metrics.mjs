// Exact scalar SSE against the same payload's normative RGBA8 decode.
// EAC reconstruction remains 11-bit UNORM; never round it to a byte.
export function scalarPayloadMetrics(target, actual, rgba) {
  const channels = target === 1 ? [3] : [4, 20].includes(target) ? [0] : [0, 1];
  const reference = target === 1 ? [3] : channels.length === 1 ? [0] : [0, 3];
  if (![1, 4, 5, 20, 21].includes(target) || actual.length !== rgba.length || rgba.length % 4)
    throw new Error('Invalid scalar payload metric input');
  const scale = target >= 20 ? 2047 : 1;
  let total = 0n;
  let chunk = 0;
  let count = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    for (let c = 0; c < channels.length; c++) {
      const v = actual[p + channels[c]];
      const value = scale === 1 ? v : Math.round((v * scale) / 255) * 255;
      const d = value - rgba[p + reference[c]] * scale;
      if (!Number.isSafeInteger(d) || !Number.isSafeInteger(d * d)) throw new Error('Invalid scalar sample');
      chunk += d * d;
      if (++count % 4096 === 0) {
        total += BigInt(chunk);
        chunk = 0;
      }
    }
  }
  total += BigInt(chunk);
  return { numeratorSse: String(total), denominator: scale * scale, sampleCount: count };
}
