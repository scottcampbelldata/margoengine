// Writes tests/fixtures/sun_sky.hdr, a Margo-made 1024 x 512 equirectangular Radiance file: a dim sky gradient over
// a darker ground, a soft sun disc with a small hot core (peak about 1000, RGBE exponent byte 138), and a
// 24-pixel dither strip so every scanline carries both run and literal packets of the adaptive RLE. The RGBE bytes
// are computed here, so the file and its reference digest in tests/fixtures/reference.json come from the same
// arrays: `node packages/environment/scripts/make-hdr-fixture.js` rewrites both.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKY = { width: 1024, height: 512, sun: { x: 300, elevation: 35, radius: 6, core: 0.45 } };

/** Shared-exponent encoding of one linear RGB colour: mantissas scaled by 2^(e - 136). */
function toRGBE(r, g, b) {
  const peak = Math.max(r, g, b);
  if (peak < 1e-32) return [0, 0, 0, 0];
  const exponent = Math.ceil(Math.log2(peak + Number.EPSILON * peak)),
    scale = 256 / 2 ** exponent;
  return [Math.floor(r * scale), Math.floor(g * scale), Math.floor(b * scale), exponent + 128];
}
// Integer hash for the dither strip (no clock, no global state).
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** The sky's linear radiance at pixel (x, y), y = 0 being the zenith row. */
export function radiance(x, y) {
  const { width, height, sun } = SKY,
    elevation = 90 - ((y + 0.5) / height) * 180,
    azimuth = ((x + 0.5) / width) * 360;
  let color;
  if (elevation >= 0) {
    const t = elevation / 90,
      tint = 1 + 0.03 * Math.sin((azimuth * Math.PI) / 90);
    color = [0.55 - 0.35 * t, 0.6 - 0.25 * t, 0.7 + 0.1 * t].map((c) => c * tint);
  } else color = [0.11, 0.095, 0.08].map((c) => c * (1 + elevation / 180));
  // Angular distance to the sun centre on the sphere.
  const toRad = Math.PI / 180,
    sunAzimuth = ((sun.x + 0.5) / width) * 360,
    cosine =
      Math.sin(elevation * toRad) * Math.sin(sun.elevation * toRad) +
      Math.cos(elevation * toRad) * Math.cos(sun.elevation * toRad) * Math.cos((azimuth - sunAzimuth) * toRad),
    angle = Math.acos(Math.min(1, Math.max(-1, cosine))) / toRad;
  if (angle < sun.core) color = [1000, 960, 880];
  else if (angle < sun.radius) {
    const falloff = 1 - (angle / sun.radius) ** 2;
    color = color.map((c, i) => c + [40, 36, 30][i] * falloff);
  }
  if (x < 24) color = color.map((c, i) => c * (0.9 + 0.2 * hash(x * 3 + i, y)));
  return color;
}

/** RGBE bytes of the whole image, row-major from the top row, 4 bytes per pixel. */
export function skyRGBE() {
  const { width, height } = SKY,
    out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out.set(toRGBE(...radiance(x, y)), (y * width + x) * 4);
  return out;
}

/** Decodes RGBE bytes to linear RGBA floats (alpha 1), the way the Radiance format defines them. */
export function decodeRGBE(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const e = bytes[i + 3],
      scale = e ? 2 ** (e - 136) : 0;
    out[i] = bytes[i] * scale;
    out[i + 1] = bytes[i + 1] * scale;
    out[i + 2] = bytes[i + 2] * scale;
    out[i + 3] = 1;
  }
  return out;
}

// One channel of one scanline: runs of 3 or more equal bytes become (128 + n, value) packets of up to 127; the
// rest become literal packets (n, bytes...) of up to 128.
function packChannel(values, out) {
  for (let x = 0; x < values.length; ) {
    let run = 1;
    while (x + run < values.length && run < 127 && values[x + run] === values[x]) run++;
    if (run >= 3) {
      out.push(128 + run, values[x]);
      x += run;
      continue;
    }
    const start = x;
    while (x < values.length && x - start < 128) {
      if (x + 2 < values.length && values[x] === values[x + 1] && values[x] === values[x + 2]) break;
      x++;
    }
    out.push(x - start, ...values.slice(start, x));
  }
}

/** The Radiance file for `rgbe` (new-style adaptive RLE on every scanline). */
export function encodeHDR(rgbe) {
  const { width, height } = SKY,
    out = [
      ...Buffer.from(`#?RADIANCE\n# Margo sun and sky fixture\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`),
    ];
  for (let y = 0; y < height; y++) {
    out.push(2, 2, width >> 8, width & 255);
    for (let c = 0; c < 4; c++) {
      const values = [];
      for (let x = 0; x < width; x++) values.push(rgbe[(y * width + x) * 4 + c]);
      packChannel(values, out);
    }
  }
  return Uint8Array.from(out);
}

/** SHA-256 of float RGBA data with NaNs canonicalised, as tests/environment.test.js computes it. */
export function digest(data) {
  const copy = new Float32Array(data),
    bits = new Uint32Array(copy.buffer);
  for (let i = 0; i < copy.length; i++) if (Number.isNaN(copy[i])) bits[i] = 0x7fc00000;
  return createHash('sha256').update(new Uint8Array(copy.buffer)).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = fileURLToPath(new URL('../tests/fixtures/', import.meta.url)),
    rgbe = skyRGBE(),
    bytes = encodeHDR(rgbe),
    data = decodeRGBE(rgbe);
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
  writeFileSync(`${fixtures}sun_sky.hdr`, bytes);
  const reference = JSON.parse(readFileSync(`${fixtures}reference.json`, 'utf8'));
  reference['sun_sky.hdr'] = { width: SKY.width, height: SKY.height, sha256: digest(data), max };
  writeFileSync(`${fixtures}reference.json`, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`sun_sky.hdr ${bytes.length} bytes, max ${max}`);
}
