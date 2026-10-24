// CRC-32 (ISO 3309, reflected polynomial 0xEDB88320): the exporters ZIP, USDZ and PNG writers and the decoders PNG reader.

let table;

/** CRC-32 of `bytes`, continuing from `crc` (the result of a previous call) when given. */
export function crc32(bytes, crc = 0) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
