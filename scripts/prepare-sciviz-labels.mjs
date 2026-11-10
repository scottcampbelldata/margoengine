// Uses Margo's format reader. Run after build:packages with the directory containing the three original MSD files.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseNIfTI } from '../packages/sciviz/dist/formats.js';
const directory = process.argv[2];
if (!directory)
  throw new TypeError('Pass a directory containing BRATS_457.nii.gz, label-BRATS_457.nii.gz and dataset.json');
const hash = (x) => createHash('sha256').update(x).digest('hex');
const imageBytes = await readFile(resolve(directory, 'BRATS_457.nii.gz')),
  labelBytes = await readFile(resolve(directory, 'label-BRATS_457.nii.gz'));
if (
  hash(imageBytes) !== '9860667a745293f449e0885e95fc5627f4f65efd52597ff7d1c41801c9bc34fc' ||
  hash(labelBytes) !== 'ab30e8774ef7a679531eb95dec3adb8aa9aef0e109c0207eb4d435da184c4249'
)
  throw new Error('Original MSD checksums differ');
const image = await parseNIfTI(imageBytes),
  labels = await parseNIfTI(labelBytes),
  description = JSON.parse(await readFile(resolve(directory, 'dataset.json'), 'utf8'));
const stride = 4,
  dims = image.dims.map((n) => Math.ceil(n / stride)),
  count = dims.reduce((a, b) => a * b),
  originalCount = image.dims.reduce((a, b) => a * b);
if (image.frames !== 4 || image.components !== 1 || labels.dims.some((n, a) => n !== image.dims[a]))
  throw new Error('Unexpected MSD shape');
const data = new Float32Array(count * 4),
  categories = new Uint8Array(count),
  ranges = Array.from({ length: 4 }, () => [Infinity, -Infinity]);
for (let z = 0; z < dims[2]; z++)
  for (let y = 0; y < dims[1]; y++)
    for (let x = 0; x < dims[0]; x++) {
      const i = x + dims[0] * (y + dims[1] * z),
        j = stride * x + image.dims[0] * (stride * y + image.dims[1] * stride * z);
      categories[i] = labels.data[j];
      for (let c = 0; c < 4; c++) {
        const v = image.all[c * originalCount + j];
        data[4 * i + c] = v;
        ranges[c][0] = Math.min(ranges[c][0], v);
        ranges[c][1] = Math.max(ranges[c][1], v);
      }
    }
const transform = Array.from(image.matrix);
for (let a = 0; a < 3; a++) for (let r = 0; r < 4; r++) transform[a * 4 + r] *= stride * (dims[a] - 1);
const root = 'examples/assets/sciviz/',
  imageOut = gzipSync(new Uint8Array(data.buffer)),
  labelsOut = gzipSync(categories);
await writeFile(root + 'msd-brain.bin', imageOut);
await writeFile(root + 'msd-labels.bin', labelsOut);
const record = {
  source: 'https://msd-for-monai.s3.us-west-2.amazonaws.com/Task01_BrainTumour.tar',
  dataset: 'Medical Segmentation Decathlon Task01_BrainTumour, BRATS_457',
  citation:
    'Antonelli et al., The Medical Segmentation Decathlon, Nature Communications 13, 4128 (2022), https://doi.org/10.1038/s41467-022-30695-9',
  license: 'CC-BY-SA-4.0',
  licenseURL: 'https://creativecommons.org/licenses/by-sa/4.0/',
  demoOnly: true,
  originalImageSHA256: hash(imageBytes),
  originalLabelSHA256: hash(labelBytes),
  dims,
  originalDims: image.dims,
  transform,
  stride: [stride, stride, stride],
  reduction:
    'Retain original voxel samples at stride 4 on every axis, no interpolation or intensity scaling. Interleave four modalities; gzip little-endian float32. Labels are gzip uint8. Output data remains CC BY-SA 4.0; engine source is independently authored.',
  modalities: description.modality,
  labels: description.labels,
  ranges,
  imageSHA256: hash(imageOut),
  labelSHA256: hash(labelsOut),
  imageBytes: imageOut.length,
  labelBytes: labelsOut.length,
};
await writeFile(root + 'msd-brain.json', JSON.stringify(record, null, 2) + '\n');
console.log(
  JSON.stringify({
    dims,
    ranges,
    imageBytes: imageOut.length,
    labels: Object.fromEntries([...new Set(categories)].map((id) => [id, categories.filter((x) => x === id).length])),
  }),
);
