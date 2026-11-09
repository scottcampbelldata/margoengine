// Own fixture generation; the encoder is executed opaquely outside the repository.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decodePNG } from '../dist/png.js';
import assert from 'node:assert/strict';
if (!process.env.MARGO_BASIS134_FIXTURE_CHILD) {
  const p = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    timeout: 300000,
    env: { ...process.env, MARGO_BASIS134_FIXTURE_CHILD: '1' },
  });
  if (p.error) throw p.error;
  if (p.status !== 0) throw Error('Fixture generator failed');
  process.exit(0);
}
const out = new URL('../tests/fixtures/basis134/', import.meta.url);
const pinned = JSON.parse(readFileSync(new URL('manifest.json', out)));
if (!process.argv[2]) throw Error('Pass an outside folder containing basis_encoder.cjs and basis_encoder.wasm');
mkdirSync(out, { recursive: true });
const outside = resolve(process.argv[2]).replaceAll('\\', '/') + '/';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const location = relative(repo, outside);
assert.ok(location.startsWith('..') || isAbsolute(location), 'Encoder must execute outside the repository');
const factory = createRequire(import.meta.url)(outside + 'basis_encoder.cjs');
const m = await factory({ wasmBinary: readFileSync(outside + 'basis_encoder.wasm') });
m.initializeBasis();
const sourceName = 'KhronosGroup-Models_FlightHelmet_glTF_FlightHelmet_Materials_GlassPlasticMat_BaseColor.png';
const sourceBytes = readFileSync(new URL('flighthelmet-cc0.png', out));
const source = decodePNG(sourceBytes);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const manifest = [];
for (const [old, name, width, height, uastc, alpha] of [
  [
    'Binomial150-webgl_gltf_assets_textureAtlasImage.basis',
    'cc0-flighthelmet-atlas-etc1s.basis',
    1024,
    1024,
    false,
    false,
  ],
  ['Binomial150-webgl_texture_test_assets_alpha3.basis', 'cc0-flighthelmet-alpha-etc1s.basis', 768, 512, false, true],
  ['Binomial150-webgl_texture_test_assets_kodim03_uastc.basis', 'cc0-flighthelmet-uastc.basis', 768, 512, true, false],
]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const src =
        (Math.floor((y * source.height) / height) * source.width + Math.floor((x * source.width) / width)) * 4;
      const dst = (y * width + x) * 4;
      rgba.set(source.data.subarray(src, src + 3), dst);
      rgba[dst + 3] = alpha ? Math.round(255 * ((x % 128) / 127) * ((y % 128) / 127)) : 255;
    }
  const e = new m.BasisEncoder();
  let data;
  try {
    e.setCreateKTX2File(false);
    e.setUASTC(uastc);
    e.setPerceptual(true);
    e.setMipGen(false);
    e.setQualityLevel(128);
    e.setCompressionLevel(1);
    e.setPackUASTCFlags(2);
    e.setSliceSourceImage(0, rgba, width, height, false);
    const output = new Uint8Array(width * height * 8 + 1048576);
    const n = e.encode(output);
    assert.ok(n > 0);
    data = output.slice(0, n);
  } finally {
    e.delete();
  }
  writeFileSync(new URL(name, out), data);
  writeFileSync(new URL(name + '.rgba8.gz', out), gzipSync(rgba));
  manifest.push({
    replaces: old,
    file: name,
    width,
    height,
    uastc,
    alpha,
    levels: 1,
    sha256: hash(data),
    sourceSha256: hash(rgba),
    license: 'CC0-1.0',
    source: sourceName,
    originalSourceSha256: hash(sourceBytes),
    sourceTransform:
      'Nearest source-pixel resampling; alpha variant adds a deterministic 128-pixel product ramp. Full source RGBA8 retained.',
    reason: 'Original source/derivative image grant unproven; manager ordered replacement without waiting.',
  });
  console.log(JSON.stringify(manifest.at(-1)));
}
// HDR source is an own analytic six-face light field, dedicated CC0-1.0.
const size = 96,
  e = new m.BasisEncoder(),
  faces = [];
try {
  e.setCreateKTX2File(true);
  e.setHDR(true);
  e.setTexType(2);
  e.setMipGen(true);
  e.setMipSRGB(false);
  e.setPerceptual(false);
  for (let face = 0; face < 6; face++) {
    const rgba = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        rgba[i] = 2 ** (face - 3) * (0.0625 + x / 16);
        rgba[i + 1] = 0.125 + y / 24;
        rgba[i + 2] = 0.25 + ((x * y) % 197) / 32;
        rgba[i + 3] = 1;
      }
    const bytes = new Uint8Array(rgba.buffer);
    faces.push({ face, sha256: hash(bytes) });
    writeFileSync(new URL('cc0-hdr-face' + face + '.rgba32f.gz', out), gzipSync(bytes));
    e.setSliceSourceImageHDR(face, bytes, size, size, m.hdr_image_type.cHITRGBAFloat.value, false);
  }
  const buffer = new Uint8Array(16 * 1024 * 1024),
    n = e.encode(buffer);
  assert.ok(n > 0);
  const data = buffer.slice(0, n),
    file = 'cc0-cube-uastc-hdr.ktx2';
  writeFileSync(new URL('../ktx2-hdr/cube-uastc-hdr.ktx2', out), data);
  manifest.push({
    replaces: 'Margo-ktx2-hdr-cube-uastc-hdr.ktx2',
    file,
    sha256: hash(data),
    width: size,
    height: size,
    faces,
    levels: 7,
    license: 'CC0-1.0',
    source: 'Margo analytic light-field generator in generate-basis134.mjs',
    reason:
      'Memorial Church image-use grant unproven; replace with six distinct analytic HDR faces at the same size and mip count.',
  });
  console.log(JSON.stringify(manifest.at(-1)));
} finally {
  e.delete();
}
assert.equal(hash(readFileSync(outside + 'basis_encoder.wasm')), pinned.encoder.wasmSha256);
for (const entry of manifest) {
  const pin = pinned.files.find((x) => x.file === entry.file);
  assert.ok(pin);
  assert.equal(entry.sha256, pin.sha256, 'Generated fixture differs');
  if (entry.sourceSha256) assert.equal(entry.sourceSha256, pin.sourceSha256);
  if (entry.faces) assert.deepEqual(entry.faces, pin.faces);
}
console.log('Four pinned licensed fixtures regenerated without byte changes');
