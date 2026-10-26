// CRC-32 (ISO 3309, reflected polynomial 0xEDB88320): the exporters ZIP, USDZ and PNG writers, the decoders PNG reader,
// the loaders ZIP reader (its public crc32), the voxel-pathtracer PNG writer and machinery's CAD tessellation hash.

/** Eight 256-entry tables: table k advances a byte through k further zero bytes ("slicing-by-8"). */
let tables;

function build() {
  tables = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tables[n] = c;
  }
  for (let n = 0; n < 256; n++)
    for (let k = 1; k < 8; k++) {
      const previous = tables[(k - 1) * 256 + n];
      tables[k * 256 + n] = (previous >>> 8) ^ tables[previous & 255];
    }
  return tables;
}

/**
 * CRC-32 of `bytes`, continuing from `crc` (the result of a previous call) when given. Eight bytes per step through
 * the sliced tables (about 4x the byte-at-a-time loop: the USDZ writer spent 8 of its 20 ms here), the tail a byte at a
 * time; the result is the same.
 */
export function crc32(bytes, crc = 0) {
  const t = tables ?? build(),
    n = bytes.length,
    end = n - (n & 7);
  let c = ~crc,
    i = 0;
  for (; i < end; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c =
      t[1792 + (c & 255)] ^
      t[1536 + ((c >>> 8) & 255)] ^
      t[1280 + ((c >>> 16) & 255)] ^
      t[1024 + (c >>> 24)] ^
      t[768 + bytes[i + 4]] ^
      t[512 + bytes[i + 5]] ^
      t[256 + bytes[i + 6]] ^
      t[bytes[i + 7]];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
