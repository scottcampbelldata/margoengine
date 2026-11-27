// Decodes every JPEG file of the NEMA DICOM WG04 compressed sample set and checks each lossless one, sample for sample,
// against the set's own uncompressed reference. The set (74 MB) is not redistributed: fetch compsamples_jpeg.tar and
// compsamples_refanddir.tar.bz2 from ftp://medical.nema.org/MEDICAL/Dicom/DataSets/WG04/, unpack both into one folder
// outside the repository and run, after `npm run build --workspace=@margoengine/decoders`:
//   node packages/decoders/tests/jpeg-nema-corpus.mjs <folder>
// A lossy file has no exact reference. With a second folder of <name>.samples files (another decoder's 16-bit words) the
// largest difference from them is printed and must be at most 1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJPEGSamples } from '@margoengine/decoders/jpeg';
import { encapsulatedFrame, nativePixels } from './support/dicom-pixels.js';

const [folder, others] = process.argv.slice(2);
assert.ok(folder, 'usage: node packages/decoders/tests/jpeg-nema-corpus.mjs <folder> [reference samples folder]');
const images = join(folder, 'IMAGES'),
  words = (bytes) => new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
for (const kind of ['JPLL', 'JPLY'])
  for (const name of readdirSync(join(images, kind)).sort()) {
    const decoded = decodeJPEGSamples(encapsulatedFrame(new Uint8Array(readFileSync(join(images, kind, name))))),
      stem = name.split('_')[0],
      digest = createHash('sha256').update(new Uint8Array(decoded.data.buffer)).digest('hex');
    let note = `${decoded.width} x ${decoded.height}, ${decoded.precision} bits, sha256 ${digest}`;
    if (kind === 'JPLL') {
      const expected = words(nativePixels(new Uint8Array(readFileSync(join(images, 'REF', `${stem}_UNC`)))));
      assert.equal(decoded.lossless, true);
      assert.equal(decoded.data.length, decoded.width * decoded.height);
      let differ = 0;
      for (let i = 0; i < decoded.data.length; i++) if (decoded.data[i] !== expected[i]) differ++;
      assert.equal(differ, 0, `${name}: ${differ} samples differ from the reference`);
      note += ', every sample equals the reference';
    } else if (others && existsSync(join(others, `${name}.samples`))) {
      const expected = words(new Uint8Array(readFileSync(join(others, `${name}.samples`))));
      assert.equal(expected.length, decoded.data.length);
      let worst = 0,
        differ = 0;
      for (let i = 0; i < expected.length; i++) {
        const difference = Math.abs(decoded.data[i] - expected[i]);
        if (difference) differ++;
        worst = Math.max(worst, difference);
      }
      assert.ok(worst <= 1, `${name}: differs by ${worst}`);
      note += `, within ${worst} of the other decoder (${differ} of ${expected.length} differ)`;
    }
    console.log(`${name}: ${note}`);
  }
