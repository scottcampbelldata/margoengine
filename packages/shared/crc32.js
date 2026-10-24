// CRC-32 (ISO 3309, reflected polynomial 0xEDB88320): the exporters ZIP, USDZ and PNG writers, the decoders PNG reader,
// the loaders ZIP reader (its public crc32), the voxel-pathtracer PNG writer and machinery's CAD tessellation hash.

let table;

/** CRC-32 of `bytes`, continuing from `crc` (the result of a previous call) when given. */
export function crc32(bytes, crc = 0) {
  if (!table) {
    // Four 256-entry tables (slicing by four): table k advances a byte that is k positions further from the end.
    table = new Int32Array(1024);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    for (let n = 256; n < 1024; n++) {
      const c = table[n - 256];
      table[n] = table[c & 255] ^ (c >>> 8);
    }
  }
  const t = table,
    whole = bytes.length - 3;
  let c = ~crc,
    i = 0;
  for (; i < whole; i += 4) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t[768 + (c & 255)] ^ t[512 + ((c >>> 8) & 255)] ^ t[256 + ((c >>> 16) & 255)] ^ t[c >>> 24];
  }
  for (; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
