// Public-spec generic framing, including historical E17 fields established previously.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const wide = process.argv.includes('--wide'),
  output = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'test-results/draco-generic-inputs.json';
mkdirSync(dirname(output), { recursive: true });
const rows = [],
  versions = wide
    ? [
        [1, 1],
        [2, 2],
        [2, 3],
      ]
    : [
        [1, 0],
        [1, 1],
        [1, 2],
        [2, 0],
        [2, 1],
        [2, 2],
        [2, 3],
      ],
  widths = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 8, 8: 8, 9: 4, 10: 8, 11: 1 },
  varint = (n) => {
    let a = [];
    do {
      a.push((n & 127) | (n > 127 ? 128 : 0));
      n >>>= 7;
    } while (n);
    return a;
  },
  le = (n, w) => Array.from({ length: w }, (_, i) => (n / 2 ** (i * 8)) & 255);
for (const version of versions)
  for (const mesh of [0, 1]) {
    if (mesh && version[0] === 2 && version[1] === 3) continue;
    for (let semantic = wide ? 4 : 0; semantic < 5; semantic++)
      for (let type = 1; type <= 11; type++)
        for (const width of wide ? [17, 31, 64, 127, 255] : [1, 2, 3, 4, 7, 16])
          for (const normalized of [0, 1]) {
            const header = [...Buffer.from('DRACO'), ...version, mesh, 0, 0, 0],
              count = 3,
              v = version[0] * 256 + version[1],
              geometry = mesh
                ? [...(v < 514 ? le(1, 4) : varint(1)), ...(v < 514 ? le(count, 4) : varint(count)), 1, 0, 1, 2]
                : le(count, 4),
              desc = [
                1,
                ...(v < 512 ? le(1, 4) : [1]),
                semantic,
                type,
                width,
                normalized,
                ...(v < 512 ? le(300, 2) : varint(300)),
                0,
              ],
              data = Buffer.alloc(count * width * widths[type]);
            for (let i = 0; i < count * width; i++) {
              const value = type === 11 ? i % 2 : (i * 7 + 3) % 29;
              const offset = i * widths[type];
              if (type === 9) data.writeFloatLE(value + 0.25, offset);
              else if (type === 10) data.writeDoubleLE(value + 0.125, offset);
              else if (type === 7) data.writeBigInt64LE(BigInt(value), offset);
              else if (type === 8) data.writeBigUInt64LE(BigInt(value), offset);
              else for (let k = 0; k < widths[type]; k++) data[offset + k] = (value >>> (8 * k)) & 255;
            }
            rows.push({
              name: `historical-generic-v${version.join('.')}-mesh${mesh}-s${semantic}-t${type}-c${width}-n${normalized}`,
              inventory: { version: version.join('.'), mesh, semantic, type, width, normalized, encoding: 'generic' },
              bytes: [...header, ...geometry, ...desc, ...data],
            });
          }
  }
writeFileSync(output, JSON.stringify(rows));
console.log(rows.length);
