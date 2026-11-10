// Clean-room MRC2014/EMDB mode-2 reduction, from the EMDB map format specification.
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const source = process.argv[2];
if (!source) throw new TypeError('Pass the original emd_8117.map.gz path');
const original = await readFile(source),
  hash = (b) => createHash('sha256').update(b).digest('hex');
if (hash(original) !== '586c2f9297682366755bfdccee354b704f2984dee51b72c9283cc2f78f2a34e2')
  throw new TypeError('EMD-8117 original checksum differs');
const bytes = gunzipSync(original),
  view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const integer = (i) => view.getInt32(i * 4, true),
  real = (i) => view.getFloat32(i * 4, true);
const originalDims = [integer(0), integer(1), integer(2)],
  axes = [integer(16), integer(17), integer(18)];
if (integer(3) !== 2 || axes.some((a, i) => a !== i + 1) || [real(13), real(14), real(15)].some((a) => a !== 90))
  throw new TypeError('This reproducer requires an orthogonal XYZ mode-2 EMDB map');
const offset = 1024 + integer(23),
  stride = Math.ceil(Math.max(...originalDims) / 64);
const dims = originalDims.map((n) => Math.ceil(n / stride)),
  data = new Float32Array(dims.reduce((a, b) => a * b));
let min = Infinity,
  max = -Infinity;
for (let z = 0; z < dims[2]; z++)
  for (let y = 0; y < dims[1]; y++)
    for (let x = 0; x < dims[0]; x++) {
      const v = view.getFloat32(offset + 4 * stride * (x + originalDims[0] * (y + originalDims[1] * z)), true);
      data[x + dims[0] * (y + dims[1] * z)] = v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
const bounds = dims.flatMap((n, a) => [
  real(49 + a),
  real(49 + a) + ((n - 1) * stride * real(10 + a)) / integer(7 + a),
]);
const output = gzipSync(new Uint8Array(data.buffer)),
  root = 'examples/assets/sciviz/';
await writeFile(root + 'emdb-8117.bin', output);
await writeFile(
  root + 'emdb-8117.json',
  JSON.stringify(
    {
      dataset: 'EMD-8117, TRPV1 with DkTx and RTX in a lipid nanodisc, 2.95 Angstrom',
      source: 'https://ftp.ebi.ac.uk/pub/databases/emdb/structures/EMD-8117/map/emd_8117.map.gz',
      license: 'CC0-1.0',
      licenseURL: 'https://www.ebi.ac.uk/pdbe/about/public-data-access-statement',
      format: 'https://files.wwpdb.org/pub/emdb/doc/Map-format/current/EMDB_map_format.pdf',
      originalSHA256: hash(original),
      sha256: hash(output),
      originalDims,
      dims,
      stride,
      bounds,
      range: [min, max],
      units: 'Angstrom',
      encoding: 'gzip little-endian float32, x fastest',
      reduction: 'Original scalar samples at uniform integer stride; no interpolation or intensity scaling.',
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ originalDims, dims, stride, bounds, range: [min, max], bytes: output.length }));
