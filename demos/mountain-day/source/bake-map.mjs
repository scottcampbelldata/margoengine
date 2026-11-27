import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { columns, openingColumns, origin, extent, heightUnit, heightAt } from './relief.mjs';

const heights = new Uint16Array(columns * columns);
for (let z = 0; z < columns; z++) {
  for (let x = 0; x < columns; x++) {
    const east = origin[0] + extent[0] * x / (columns - 1);
    const west = origin[1] + extent[1] * z / (columns - 1);
    heights[z * columns + x] = Math.round(heightAt(east, west) / heightUnit);
  }
}

function pack(samples, size) {
  // Reversible two-dimensional differencing and byte planes keep the original samples.
  const encoded = Buffer.alloc(samples.length * 2);
  for (let z = 0, i = 0; z < size; z++) {
    for (let x = 0; x < size; x++, i++) {
      const left = x ? samples[i - 1] : 0;
      const above = z ? samples[i - size] : 0;
      const diagonal = x && z ? samples[i - size - 1] : 0;
      const wrapped = (samples[i] - left - above + diagonal) << 16 >> 16;
      const difference = (wrapped << 1) ^ (wrapped >> 31);
      encoded[i] = difference & 255;
      encoded[samples.length + i] = difference >>> 8;
    }
  }
  return gzipSync(encoded, {level:9});
}

const stride = (columns - 1) / (openingColumns - 1);
const subset = Uint16Array.from({length:openingColumns ** 2}, (_,i) => {
  const x = i % openingColumns;
  const z = Math.floor(i / openingColumns);
  return heights[stride * (z * columns + x)];
});
await Promise.all([
  writeFile(new URL('./silverpass.height',import.meta.url),pack(heights,columns)),
  writeFile(new URL('./silverpass-opening.height',import.meta.url),pack(subset,openingColumns)),
]);