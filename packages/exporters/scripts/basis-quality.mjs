// Matched-rate correctness comparison. Run under a caller-owned hard deadline.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { encodeKTX2 } from '../../../packages/exporters/dist/ktx2.js';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { decodeJPEG } from '../../../packages/exporters/dist/jpeg-read.js';
import { transcodeKTX2 } from '../../../packages/decoders/dist/codec.js';
import { createHash } from 'node:crypto';
assert.ok(process.argv[2] && process.argv[3], 'Pass the outside oracle path prefix and output JSON path');
const output = resolve(process.argv[3]);
mkdirSync(dirname(output), { recursive: true });
const require = createRequire(import.meta.url),
  outside = resolve(process.argv[2]).replaceAll('\\', '/');
const transcoder = await require(outside + 'oracle-built/basis_transcoder.js')({
  wasmBinary: readFileSync(outside + 'oracle-built/basis_transcoder.wasm'),
});
transcoder.initializeBasis();
const old = await require(outside + 'encoder/basis_encoder.cjs')({
  wasmBinary: readFileSync(outside + 'encoder/basis_encoder.wasm'),
  print() {},
  printErr() {},
});
old.initializeBasis();
const bytes = readFileSync(
  new URL(
    '../../../packages/exporters/native/basis/target/wasm32-unknown-unknown/release/margoengine_basis_encoder.wasm',
    import.meta.url,
  ),
);
const {
  instance: { exports: api },
} = await WebAssembly.instantiate(bytes, {});
function original(image, mode, quality = 128, options = {}) {
  const e = new old.BasisEncoder();
  try {
    e.setCreateKTX2File(true);
    e.setKTX2UASTCSupercompression(true);
    e.setKTX2SRGBTransferFunc(Boolean(options.srgb));
    e.setSliceSourceImage(0, image.data, image.width, image.height, false);
    e.setPerceptual(Boolean(options.srgb));
    e.setMipSRGB(Boolean(options.srgb));
    e.setMipGen(Boolean(options.mipmaps));
    if (options.normalMap) {
      e.setNormalMap();
      e.setMipRenormalize(true);
    }
    e.setQualityLevel(quality);
    e.setCompressionLevel(2);
    e.setUASTC(mode === 'uastc');
    e.setPackUASTCFlags(2);
    const out = new Uint8Array(image.data.length * 2 + 65536),
      n = e.encode(out);
    assert.ok(n);
    return out.slice(0, n);
  } finally {
    e.delete();
  }
}
function psnr(source, decoded) {
  let sse = 0;
  for (let i = 0; i < source.length; i++) if ((i & 3) !== 3) sse += (source[i] - decoded[i]) ** 2;
  return sse ? 10 * Math.log10(255 ** 2 / (sse / ((source.length * 3) / 4))) : null;
}
function ssim(a, b, width, height) {
  // Wang et al. 2004: 11x11, sigma=1.5 Gaussian, K1=.01, K2=.03.
  const weights = Array.from({ length: 11 }, (_, i) => Math.exp(-((i - 5) ** 2) / (2 * 1.5 ** 2))),
    sum = weights.reduce((a, b) => a + b);
  for (let i = 0; i < 11; i++) weights[i] /= sum;
  const conv = (source) => {
    const temp = new Float64Array(width * height),
      out = new Float64Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 5; x < width - 5; x++)
        for (let j = 0; j < 11; j++) temp[y * width + x] += source[y * width + x + j - 5] * weights[j];
    for (let y = 5; y < height - 5; y++)
      for (let x = 5; x < width - 5; x++)
        for (let j = 0; j < 11; j++) out[y * width + x] += temp[(y + j - 5) * width + x] * weights[j];
    return out;
  };
  let score = 0;
  for (let c = 0; c < 3; c++) {
    const x = Float64Array.from({ length: width * height }, (_, i) => a[i * 4 + c]),
      y = Float64Array.from({ length: width * height }, (_, i) => b[i * 4 + c]);
    const mx = conv(x),
      my = conv(y),
      xx = conv(x.map((v) => v * v)),
      yy = conv(y.map((v) => v * v)),
      xy = conv(x.map((v, i) => v * y[i]));
    let local = 0,
      count = 0;
    for (let y = 5; y < height - 5; y++)
      for (let x = 5; x < width - 5; x++) {
        const i = y * width + x,
          u = mx[i],
          v = my[i],
          vx = xx[i] - u * u,
          vy = yy[i] - v * v,
          cov = xy[i] - u * v;
        local += ((2 * u * v + 6.5025) * (2 * cov + 58.5225)) / ((u * u + v * v + 6.5025) * (vx + vy + 58.5225));
        count++;
      }
    score += local / count;
  }
  return score / 3;
}
function mipImages(source, srgb, normal) {
  const out = [source];
  while (out.at(-1).width > 1 || out.at(-1).height > 1) {
    const image = out.at(-1),
      w = Math.max(1, image.width >> 1),
      h = Math.max(1, image.height >> 1),
      n = w * h * 4,
      p = api.allocate(image.data.length),
      q = api.allocate(n);
    try {
      new Uint8Array(api.memory.buffer, p, image.data.length).set(image.data);
      assert.equal(api.mip_rgba(p, q, image.width, image.height, Number(srgb), Number(normal)), 0);
      out.push({ width: w, height: h, data: new Uint8Array(api.memory.buffer, q, n).slice() });
    } finally {
      api.release(p, image.data.length);
      api.release(q, n);
    }
  }
  return out;
}
const corpus = [
    ['color', 'aerial_rocks_02_diff_1k.jpg', true, false],
    ['data', 'aerial_rocks_02_arm_1k.jpg', false, false],
    ['normal', 'aerial_rocks_02_nor_gl_1k.jpg', false, true],
  ],
  records = [];
for (const mode of ['etc1s', 'uastc'].filter((m) => !process.argv[4] || m === process.argv[4]))
  for (const [role, name, srgb, normalMap] of corpus.filter((r) => !process.argv[5] || r[0] === process.argv[5])) {
    const path = 'packages/terrain/test/fixtures/aerial-rocks-02/' + name,
      source = readFileSync(path),
      image = decodeJPEG(source),
      options = { srgb, normalMap, mipmaps: true },
      reference = mipImages(image, srgb, normalMap),
      oldFile = original(image, mode, 128, options),
      budget = oldFile.length;
    const quality = mode === 'etc1s' ? { color: 43, data: 41, normal: 69 }[role] : 128,
      lambda = mode === 'uastc' ? { color: 0, data: 0.09375, normal: 0.5 }[role] : 0;
    const file = await encodeKTX2(image, {
        mode,
        quality,
        uastcRDO: lambda,
        normalMap,
        mipmaps: true,
        colorSpace: srgb ? 'srgb' : 'linear',
      }),
      best = { quality, lambda, file };
    const ours = transcodeKTX2(transcoder, best.file, 'rgba8'),
      oldDecoded = transcodeKTX2(transcoder, oldFile, 'rgba8'),
      levels = [];
    assert.equal(ours.mipmaps.length, reference.length);
    assert.equal(oldDecoded.mipmaps.length, reference.length);
    for (let i = 0; i < reference.length; i++) {
      const ref = reference[i],
        a = ours.mipmaps[i],
        b = oldDecoded.mipmaps[i];
      assert.deepEqual([a.width, a.height], [ref.width, ref.height]);
      levels.push({
        width: ref.width,
        height: ref.height,
        psnr: psnr(ref.data, a.data),
        oldPSNR: psnr(ref.data, b.data),
        ssim: ref.width >= 11 && ref.height >= 11 ? ssim(ref.data, a.data, ref.width, ref.height) : null,
        oldSSIM: ref.width >= 11 && ref.height >= 11 ? ssim(ref.data, b.data, ref.width, ref.height) : null,
      });
    }
    const pass =
      best.file.length <= budget &&
      levels.every((l) => (l.psnr ?? Infinity) >= (l.oldPSNR ?? Infinity) && (l.ssim === null || l.ssim >= l.oldSSIM));
    const record = {
      mode,
      role,
      path,
      sourceSHA256: createHash('sha256').update(source).digest('hex'),
      options,
      quality,
      lambda,
      bytes: file.length,
      oldBytes: budget,
      levels,
      pass,
    };
    records.push(record);
    writeFileSync(
      output,
      JSON.stringify(
        {
          encoderSHA256: createHash('sha256').update(bytes).digest('hex'),
          records,
          pass: records.every((r) => r.pass),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(JSON.stringify({ mode, role, bytes: file.length, oldBytes: budget, pass }));
  }
if (!records.length || !records.every((r) => r.pass)) process.exitCode = 1;
