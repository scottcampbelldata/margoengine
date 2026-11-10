// Prepare the openly licensed photographic source for the independent native OpenEXR fixture writer.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseHDR } from '../../../dist/index.js';
const image = parseHDR(readFileSync(new URL('../venice_sunset_1k.hdr', import.meta.url)));
const data = new Float32Array(37 * 45 * 4);
for (let y = 0; y < 45; y++)
  for (let x = 0; x < 37; x++)
    for (let c = 0; c < 4; c++)
      data[(y * 37 + x) * 4 + c] = Math.min(65504, image.data[(y * 9 * image.width + x * 27) * 4 + c]);
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/venice-codecs.f32', new Uint8Array(data.buffer));
